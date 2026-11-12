#!/usr/bin/env node
'use strict';
/**
 * Vistapool / Hayward AquaRite - Discovery (read only)
 *
 * NUR LESEND. Dieses Skript sendet keinerlei Befehle an die Anlage.
 *
 * Es meldet sich mit dem Vistapool-Konto an, liest alle Pools des Kontos,
 * gleicht jedes Feld mit dem Datenpunkt-Katalog ab und schreibt einen
 * (standardmaessig anonymisierten) Bericht. Im Watch-Modus protokolliert es,
 * welche Felder sich aendern, waehrend man in der App Einstellungen aendert.
 *
 * Voraussetzung: Node.js >= 18 (keine weiteren Pakete noetig).
 *
 * Aufruf:
 *   node poc.js                       Bestandsaufnahme
 *   node poc.js --stats               zusaetzlich Verlaufsdaten (getStats) pruefen
 *   node poc.js --watch 15            danach 15 Minuten Aenderungen protokollieren
 *   node poc.js --interval 10         Abfrageintervall im Watch-Modus (Sekunden)
 *   node poc.js --raw                 NICHT anonymisieren (nur fuer dich lokal!)
 *   node poc.js --out ./ordner        Ausgabeordner (Standard ./vistapool-output)
 *
 * Zugangsdaten: Umgebungsvariablen VISTAPOOL_EMAIL / VISTAPOOL_PASSWORD,
 * sonst fragt das Skript interaktiv (Passwort wird nicht angezeigt).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { datapoints, SENSITIVE_KEYS } = require('./datapoints');

// --------------------------------------------------------------------------- Konstanten
// Oeffentlicher Firebase-Web-Key der Hayward-Web-App (hayward-europe.web.app),
// identisch mit aioaquarite/const.py. Kein Geheimnis, er steht in der Web-App.
const API_KEY = 'AIzaSyBLaxiyZ2nS1KgRBqWe-NY4EG7OzG5fKpE';
const IDENTITY_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const SECURETOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
const REFERRER = 'https://hayward-europe.web.app/';
const ORIGIN = 'https://hayward-europe.web.app';
const PROJECT = 'hayward-europe';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FUNCTIONS = `https://europe-west1-${PROJECT}.cloudfunctions.net`;
const STATS_TYPES = ['temp', 'ph', 'rx', 'cl', 'cd', 'filtration', 'aux1', 'aux2', 'aux3', 'aux4', 'light', 'production', 'salt'];
const HTTP_TIMEOUT = 20000;

// --------------------------------------------------------------------------- CLI
function parseArgs(argv) {
    const o = { watch: 0, interval: 20, raw: false, stats: false, out: './vistapool-output' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--raw') o.raw = true;
        else if (a === '--stats') o.stats = true;
        else if (a === '--watch') { const n = Number(argv[i + 1]); if (n > 0) { o.watch = n; i++; } else o.watch = 15; }
        else if (a === '--interval') { o.interval = Math.max(5, Number(argv[++i]) || 20); }
        else if (a === '--out') { o.out = argv[++i]; }
        else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
        else { console.error(`Unbekannte Option: ${a}`); process.exit(2); }
    }
    return o;
}

// --------------------------------------------------------------------------- Hilfen
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('de-DE')}]`, ...a);

function ask(question, hidden = false) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) {
            rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
        }
        rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    });
}

async function http(url, { method = 'GET', headers = {}, body, form } = {}) {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(HTTP_TIMEOUT) };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (form !== undefined) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(form).toString(); }
    let res;
    try { res = await fetch(url, init); } catch (e) {
        throw new Error(`Netzwerkfehler bei ${new URL(url).host}: ${e.cause?.code || e.cause?.message || e.message}`);
    }
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, json, text };
}

/** Firestore-REST-Werte in normales JSON umwandeln. */
function fsValue(v) {
    if (v == null) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('referenceValue' in v) return v.referenceValue;
    if ('bytesValue' in v) return v.bytesValue;
    if ('geoPointValue' in v) return { latitude: v.geoPointValue.latitude, longitude: v.geoPointValue.longitude };
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
    if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
    return v;
}
function fsFields(fields) {
    const o = {};
    for (const [k, v] of Object.entries(fields || {})) o[k] = fsValue(v);
    return o;
}

function getPath(obj, p) {
    let cur = obj;
    for (const k of p.split('.')) {
        if (cur == null || typeof cur !== 'object' || !(k in cur)) return undefined;
        cur = cur[k];
    }
    return cur;
}

/** Alle Blattwerte als { 'a.b.c': wert } */
function flatten(obj, prefix = '', out = {}) {
    if (obj !== null && typeof obj === 'object') {
        const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
        if (entries.length === 0) out[prefix] = Array.isArray(obj) ? '[]' : '{}';
        for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    } else {
        out[prefix] = obj;
    }
    return out;
}

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g;

/** Sensible Felder maskieren (rekursiv). */
function anonymize(value, key = '') {
    if (key && SENSITIVE_KEYS.test(key)) {
        if (value === null || value === undefined || value === '' ) return value;
        if (typeof value === 'object') return Array.isArray(value) ? value.map(() => '***') : '{***}';
        return '***';
    }
    if (Array.isArray(value)) return value.map(v => anonymize(v));
    if (value !== null && typeof value === 'object') {
        const o = {};
        for (const [k, v] of Object.entries(value)) o[k] = anonymize(v, k);
        return o;
    }
    if (typeof value === 'string') return value.replace(EMAIL_RE, '***@***');
    return value;
}
function pathIsSensitive(p) { return p.split('.').some(seg => SENSITIVE_KEYS.test(seg)); }

function pad2(n) { return String(n).padStart(2, '0'); }

/** Rohwert -> Anzeigewert gemaess Katalog */
function displayValue(dpDef, doc) {
    let raw = getPath(doc, dpDef.path);
    if (raw === undefined) return { raw, value: undefined };
    if (dpDef.orPaths) {
        const any = [raw, ...dpDef.orPaths.map(p => getPath(doc, p))].some(v => Number(v) === 1 || v === true || v === '1');
        return { raw, value: any };
    }
    if (dpDef.action) return { raw, value: '(Button)' };
    let value = raw;
    if (dpDef.id === 'light.mode') {
        const mode = Number(raw), status = Number(getPath(doc, 'light.status'));
        value = mode === 1 ? 'auto' : status === 1 ? 'on' : 'off';
        return { raw, value };
    }
    if (dpDef.conv === 'bool01') value = raw === true || Number(raw) === 1;
    else if (dpDef.conv === 'timeOfDay') { const s = Number(raw); value = Number.isFinite(s) ? `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}` : raw; }
    else if (dpDef.type === 'number') { const n = Number(raw); value = Number.isFinite(n) ? n / (dpDef.scale || 1) : raw; }
    if (dpDef.states && dpDef.states[raw] !== undefined) value = `${raw} = ${dpDef.states[raw]}`;
    return { raw, value };
}

function existsOk(dpDef, doc) {
    if (!dpDef.exists) return true;
    const req = Array.isArray(dpDef.exists) ? dpDef.exists : [dpDef.exists];
    return req.every(p => { const v = getPath(doc, p); return v === true || Number(v) > 0; });
}

// --------------------------------------------------------------------------- Cloud-Zugriff
class Session {
    constructor(email, password) { this.email = email; this.password = password; this.tokens = null; this.expiry = 0; }

    async login() {
        const r = await http(`${IDENTITY_URL}?key=${API_KEY}`, {
            method: 'POST',
            headers: { Referer: REFERRER, Origin: ORIGIN },
            body: { email: this.email, password: this.password, returnSecureToken: true },
        });
        if (!r.ok) {
            const msg = r.json?.error?.message || r.text.slice(0, 200);
            throw new Error(`Anmeldung fehlgeschlagen (HTTP ${r.status}): ${msg}`);
        }
        this.tokens = { idToken: r.json.idToken, refreshToken: r.json.refreshToken, uid: r.json.localId };
        this.expiry = Date.now() + Number(r.json.expiresIn) * 1000;
    }

    async ensureFresh() {
        if (!this.tokens) return this.login();
        if (Date.now() < this.expiry - 5 * 60 * 1000) return;
        const r = await http(`${SECURETOKEN_URL}?key=${API_KEY}`, {
            method: 'POST',
            headers: { Referer: REFERRER, Origin: ORIGIN },
            form: { grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken },
        });
        if (!r.ok) { log('Token-Refresh fehlgeschlagen, melde neu an ...'); return this.login(); }
        this.tokens.idToken = r.json.id_token;
        this.tokens.refreshToken = r.json.refresh_token;
        this.expiry = Date.now() + Number(r.json.expires_in) * 1000;
        log('Token erneuert.');
    }

    async getDoc(docPath) {
        await this.ensureFresh();
        const r = await http(`${FIRESTORE}/${docPath}`, { headers: { Authorization: `Bearer ${this.tokens.idToken}` } });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`Firestore ${docPath}: HTTP ${r.status} ${r.json?.error?.message || ''}`);
        return { data: fsFields(r.json.fields), updateTime: r.json.updateTime };
    }

    async getStats(poolId, type) {
        await this.ensureFresh();
        return http(`${FUNCTIONS}/getStats`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.tokens.idToken}` },
            body: { uuid: poolId, type, period: 30 },
        });
    }
}

// --------------------------------------------------------------------------- Bericht
function buildReport(poolLabel, doc, opts) {
    const flat = flatten(doc);
    const usedPaths = new Set();
    const rows = [], missing = [], hidden = [];

    for (const d of datapoints) {
        [d.path, ...(d.orPaths || []), ...(d.exists ? [].concat(d.exists) : []), ...(d.maxPath ? [d.maxPath] : [])].forEach(p => usedPaths.add(p));
        if (d.writeMulti) Object.values(d.writeMulti).forEach(m => Object.keys(m).forEach(p => usedPaths.add(p)));
        const { raw, value } = displayValue(d, doc);
        if (raw === undefined) { missing.push(d); continue; }
        if (!existsOk(d, doc)) { hidden.push(d); continue; }
        rows.push({ d, raw, value });
    }

    // Felder, die der Katalog nicht kennt
    const unmapped = Object.entries(flat)
        .filter(([p]) => !usedPaths.has(p) && ![...usedPaths].some(u => p === u || p.startsWith(u + '.')))
        .map(([p, v]) => [p, !opts.raw && pathIsSensitive(p) ? '***' : (typeof v === 'string' && !opts.raw ? v.replace(EMAIL_RE, '***@***') : v)]);

    const fmt = v => v === undefined ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\|/g, '\\|');
    const groups = {};
    for (const r of rows) (groups[r.d.id.split('.')[0]] ||= []).push(r);

    let md = `## ${poolLabel}\n\n`;
    const mods = ['hasPH', 'hasRX', 'hasCL', 'hasCD', 'hasUV', 'hasIO', 'hasHidro', 'hasLED', 'hasBackwash']
        .map(k => `${k.slice(3)}: ${getPath(doc, 'main.' + k) ? 'ja' : 'nein'}`).join(' · ');
    md += `Module: ${mods}\n\n`;
    md += `Erkannt: ${rows.length} Datenpunkte (davon ${rows.filter(r => r.d.write).length} steuerbar) · nicht angelegt (Modul fehlt): ${hidden.length} · Pfad fehlt im Dokument: ${missing.length} · unbekannte Felder: ${unmapped.length}\n\n`;
    for (const [g, list] of Object.entries(groups)) {
        md += `### ${g}\n\n| ID | Name | Pfad | Rohwert | Wert | steuerbar | Quelle |\n|---|---|---|---|---|---|---|\n`;
        for (const { d, raw, value } of list) {
            md += `| ${d.id} | ${d.name.de} | ${d.path} | ${fmt(raw)} | ${fmt(value)}${d.unit ? ' ' + d.unit : ''} | ${d.write ? 'ja' : ''} | ${d.source} |\n`;
        }
        md += '\n';
    }
    if (hidden.length) md += `### Nicht angelegt (Modul laut Anlage nicht vorhanden)\n\n${hidden.map(d => `- ${d.id} (${d.path})`).join('\n')}\n\n`;
    if (missing.length) md += `### Im Dokument nicht gefunden\n\n${missing.map(d => `- ${d.id} (${d.path})`).join('\n')}\n\n`;
    md += `### Unbekannte Felder (noch nicht im Katalog)\n\nDiese Felder liefert die Cloud zusaetzlich. Sie werden spaeter im Adapter als Rohdaten unter \`raw.*\` gespiegelt und bei Bedarf in den Katalog uebernommen.\n\n| Pfad | Wert |\n|---|---|\n${unmapped.map(([p, v]) => `| ${p} | ${fmt(v)} |`).join('\n')}\n\n`;

    const csv = ['id;name;path;raw;value;unit;writable;source;status']
        .concat(rows.map(({ d, raw, value }) => [d.id, d.name.de, d.path, fmt(raw), fmt(value), d.unit || '', d.write ? 1 : 0, d.source, 'present'].join(';')))
        .concat(hidden.map(d => [d.id, d.name.de, d.path, '', '', d.unit || '', d.write ? 1 : 0, d.source, 'module-missing'].join(';')))
        .concat(missing.map(d => [d.id, d.name.de, d.path, '', '', d.unit || '', d.write ? 1 : 0, d.source, 'path-missing'].join(';')))
        .concat(unmapped.map(([p, v]) => ['', '', p, fmt(v), '', '', '', '', 'unmapped'].join(';')))
        .join('\n');

    return { md, csv, counts: { present: rows.length, writable: rows.filter(r => r.d.write).length, hidden: hidden.length, missing: missing.length, unmapped: unmapped.length } };
}

function catalogHits(p) {
    return datapoints.filter(d => d.path === p || (d.orPaths || []).includes(p)).map(d => d.id);
}

// --------------------------------------------------------------------------- Ablauf
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 18) { console.error(`Node.js ${process.versions.node} ist zu alt, bitte >= 18 verwenden.`); process.exit(1); }

    console.log('Vistapool PoC (nur lesend)\n');
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });

    // 1. Erreichbarkeit
    const sd = await http(`${FUNCTIONS}/getServerDate`).catch(e => ({ ok: false, text: e.message }));
    log(sd.ok ? `Cloud erreichbar, Serverdatum ${JSON.stringify(sd.json)}` : `Warnung: getServerDate nicht erreichbar (${sd.status || ''} ${sd.text?.slice(0, 80)})`);

    // 2. Anmeldung
    const email = process.env.VISTAPOOL_EMAIL || await ask('Vistapool E-Mail: ');
    const password = process.env.VISTAPOOL_PASSWORD || await ask('Vistapool Passwort: ', true);
    const s = new Session(email, password);
    await s.login();
    log('Anmeldung erfolgreich.');

    // 3. Pools des Kontos
    const user = await s.getDoc(`users/${s.tokens.uid}`);
    if (!user) throw new Error('Benutzerdokument nicht gefunden. Ist im Konto ein Pool registriert?');
    const poolIds = Array.isArray(user.data.pools) ? user.data.pools : [];
    log(`${poolIds.length} Pool(s) im Konto gefunden.`);
    if (!poolIds.length) {
        fs.writeFileSync(path.join(outDir, 'user.json'), JSON.stringify(opts.raw ? user.data : anonymize(user.data), null, 2));
        throw new Error('Keine Pools im Benutzerdokument. user.json wurde zur Analyse gespeichert.');
    }
    const userKeys = Object.keys(user.data);

    // 4. Pool-Dokumente + Bericht
    const labels = new Map(poolIds.map((id, i) => [id, opts.raw ? id : `POOL_${i + 1}`]));
    let report = `# Vistapool Bestandsaufnahme\n\nErstellt: ${new Date().toISOString()} · Node ${process.versions.node} · ${opts.raw ? 'NICHT anonymisiert' : 'anonymisiert'}\n\nFelder im Benutzerdokument: ${userKeys.join(', ')}\n\n`;
    const summary = { created: new Date().toISOString(), anonymized: !opts.raw, userDocKeys: userKeys, pools: [] };
    const lastFlat = new Map();

    for (const id of poolIds) {
        const label = labels.get(id);
        const pool = await s.getDoc(`pools/${id}`);
        if (!pool) { log(`${label}: Dokument nicht gefunden.`); continue; }
        const doc = pool.data;
        lastFlat.set(id, flatten(doc));
        fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(opts.raw ? doc : anonymize(doc), null, 2));
        const { md, csv, counts } = buildReport(label, doc, opts);
        fs.writeFileSync(path.join(outDir, `${label}-datenpunkte.csv`), csv);
        report += md;
        summary.pools.push({ pool: label, firestoreUpdateTime: pool.updateTime, topLevelKeys: Object.keys(doc), ...counts });
        log(`${label}: ${counts.present} Datenpunkte erkannt (${counts.writable} steuerbar), ${counts.unmapped} unbekannte Felder.`);

        // 5. Verlaufsdaten
        if (opts.stats) {
            report += `### Verlaufsdaten (getStats)\n\n| Typ | HTTP | Punkte | erster | letzter | letzter Wert |\n|---|---|---|---|---|---|\n`;
            const statsOut = {};
            for (const t of STATS_TYPES) {
                try {
                    const r = await s.getStats(id, t);
                    const series = Array.isArray(r.json) ? r.json.flat() : [];
                    const withVal = series.filter(p => p && 'field' in p);
                    const first = series[0]?.seconds, last = series.at(-1)?.seconds;
                    const iso = sec => sec ? new Date(sec * 1000).toISOString().slice(0, 16) : '';
                    report += `| ${t} | ${r.status} | ${withVal.length}/${series.length} | ${iso(first)} | ${iso(last)} | ${withVal.at(-1)?.field ?? ''} |\n`;
                    statsOut[t] = { status: r.status, points: series.length, withValue: withVal.length, sample: series.slice(-3) };
                } catch (e) {
                    report += `| ${t} | Fehler | ${e.message} | | | |\n`;
                }
            }
            fs.writeFileSync(path.join(outDir, `${label}-stats.json`), JSON.stringify(statsOut, null, 2));
            report += '\n';
            log(`${label}: Verlaufsdaten geprueft.`);
        }
    }

    fs.writeFileSync(path.join(outDir, 'bericht.md'), report);
    fs.writeFileSync(path.join(outDir, 'zusammenfassung.json'), JSON.stringify(summary, null, 2));
    log(`Bericht gespeichert in ${outDir}`);

    // 6. Watch-Modus: welche Felder aendern sich?
    if (opts.watch > 0) {
        const logFile = path.join(outDir, 'aenderungen.log');
        fs.writeFileSync(logFile, `# Aenderungsprotokoll ab ${new Date().toISOString()}\n`);
        console.log(`\nWatch-Modus: ${opts.watch} min, alle ${opts.interval} s.`);
        console.log('Aendere jetzt nacheinander Einstellungen in der Vistapool-App (Pumpe, Modus, Heizung, Licht, Relais, Sollwerte ...).');
        console.log('Notiere dir dabei kurz, was du wann geaendert hast. Abbruch mit Strg+C.\n');
        const end = Date.now() + opts.watch * 60 * 1000;
        while (Date.now() < end) {
            await new Promise(r => setTimeout(r, opts.interval * 1000));
            for (const id of poolIds) {
                try {
                    const pool = await s.getDoc(`pools/${id}`);
                    if (!pool) continue;
                    const now = flatten(pool.data), before = lastFlat.get(id) || {};
                    const keys = new Set([...Object.keys(before), ...Object.keys(now)]);
                    for (const k of keys) {
                        if (JSON.stringify(before[k]) === JSON.stringify(now[k])) continue;
                        if (k === 'updatedAt' || k.endsWith('.localTime')) continue; // aendern sich staendig
                        const mask = v => (!opts.raw && pathIsSensitive(k)) ? '***' : JSON.stringify(v);
                        const hits = catalogHits(k);
                        const line = `${labels.get(id)} ${k}: ${mask(before[k])} -> ${mask(now[k])}${hits.length ? `   [${hits.join(', ')}]` : '   [NEU, nicht im Katalog]'}`;
                        log(line);
                        fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
                    }
                    lastFlat.set(id, now);
                } catch (e) {
                    log(`Fehler beim Abruf: ${e.message}`);
                }
            }
        }
        log(`Watch-Modus beendet. Protokoll: ${logFile}`);
    }

    console.log('\nFertig. Den Ordner (ohne --raw erzeugt) bitte an ein Issue anhaengen:');
    console.log(`  ${outDir}`);
}

if (require.main === module) {
    main().catch(e => { console.error(`\nFEHLER: ${e.message}`); process.exit(1); });
}

module.exports = { fsValue, fsFields, flatten, anonymize, buildReport, displayValue };
