'use strict';
/**
 * Reine Hilfsfunktionen (ohne ioBroker-Abhaengigkeit, daher testbar):
 * Pfadzugriff, Konvertierung Rohwert <-> State, Plausibilitaet, Befehlsaufbau.
 */

function getPath(obj, p) {
    let cur = obj;
    for (const k of p.split('.')) {
        if (cur == null || typeof cur !== 'object' || !(k in cur)) {
            return undefined;
        }
        cur = cur[k];
    }
    return cur;
}

function setPath(obj, p, value) {
    const keys = p.split('.');
    let cur = obj;
    for (const k of keys.slice(0, -1)) {
        if (cur[k] === null || typeof cur[k] !== 'object') {
            cur[k] = {};
        }
        cur = cur[k];
    }
    cur[keys.at(-1)] = value;
}

function clone(o) {
    return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

/**
 * Alle Blattwerte als { 'a.b.c': wert }
 *
 * @param obj
 * @param prefix
 * @param out
 */
function flatten(obj, prefix = '', out = {}) {
    if (obj !== null && typeof obj === 'object') {
        const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
        for (const [k, v] of entries) {
            flatten(v, prefix ? `${prefix}.${k}` : k, out);
        }
    } else if (prefix) {
        out[prefix] = obj;
    }
    return out;
}

function num(v) {
    if (typeof v === 'boolean') {
        return v ? 1 : 0;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

function truthy(v) {
    return v === true || num(v) > 0;
}

/**
 * Pruefen, ob ein Datenpunkt an dieser Anlage existiert.
 *
 * @param dp
 * @param doc
 */
function exists(dp, doc) {
    if (getPath(doc, dp.path) === undefined) {
        return false;
    }
    if (!dp.exists) {
        return true;
    }
    return [].concat(dp.exists).every(p => {
        const v = getPath(doc, p);
        return v !== null && typeof v === 'object' ? true : truthy(v);
    });
}

/**
 * Ist ein Rohwert plausibel? (filtert Transienten wie interval1.to = -520093692)
 *
 * @param dp
 * @param raw
 */
function isPlausible(dp, raw) {
    if (raw === undefined || raw === null) {
        return true;
    }
    if (dp.states && !dp.writeMulti && dp.states[raw] === undefined && dp.states[String(num(raw))] === undefined) {
        return false;
    }
    if (dp.range) {
        const n = num(raw);
        if (Number.isNaN(n) || n < dp.range[0] || n > dp.range[1]) {
            return false;
        }
    }
    return true;
}

/**
 * Plausibilitaetsfilter fuer ein ganzes Dokument.
 * Unplausible Felder werden durch den letzten guten Wert ersetzt.
 *
 * @param doc
 * @param prevGood
 * @param catalog
 * @returns {{doc: object, transients: string[]}}
 */
function sanitize(doc, prevGood, catalog) {
    const out = clone(doc);
    const transients = [];
    const seen = new Set();
    for (const dp of catalog) {
        for (const p of [dp.path, ...(dp.orPaths || [])]) {
            if (seen.has(p)) {
                continue;
            }
            seen.add(p);
            const raw = getPath(doc, p);
            if (raw === undefined || isPlausible(dp, raw)) {
                continue;
            }
            transients.push(`${p}=${JSON.stringify(raw)}`);
            const prev = prevGood ? getPath(prevGood, p) : undefined;
            if (prev !== undefined) {
                setPath(out, p, prev);
            }
        }
    }
    return { doc: out, transients };
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function secondsToTime(s) {
    const n = num(s);
    if (Number.isNaN(n)) {
        return null;
    }
    const d = ((Math.floor(n) % 86400) + 86400) % 86400;
    return `${pad2(Math.floor(d / 3600))}:${pad2(Math.floor((d % 3600) / 60))}`;
}

function timeToSeconds(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        return Math.round(v);
    }
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(v));
    if (!m) {
        throw new Error(`invalid time "${v}" (expected HH:MM)`);
    }
    const h = Number(m[1]),
        mi = Number(m[2]),
        s = Number(m[3] || 0);
    if (h > 24 || mi > 59 || s > 59 || (h === 24 && (mi || s))) {
        throw new Error(`invalid time "${v}"`);
    }
    return h * 3600 + mi * 60 + s;
}

/**
 * Einheit (dynamisch fuer Elektrolyse/Hydrolyse).
 *
 * @param dp
 * @param doc
 */
function unitOf(dp, doc) {
    if (dp.unit !== 'hidro') {
        return dp.unit;
    }
    const m = getPath(doc, 'hidro.measure');
    if (typeof m === 'string' && m) {
        return m;
    }
    return truthy(getPath(doc, 'hidro.is_electrolysis')) ? 'g/h' : '%';
}

function maxOf(dp, doc) {
    if (dp.maxPath) {
        const raw = num(getPath(doc, dp.maxPath));
        if (!Number.isNaN(raw) && raw > 0) {
            return raw / (dp.scale || 1);
        }
    }
    return dp.max;
}

/**
 * Rohwert(e) aus dem Dokument -> ioBroker-State-Wert
 *
 * @param dp
 * @param doc
 */
function toState(dp, doc) {
    if (dp.action) {
        return false;
    }
    const raw = getPath(doc, dp.path);
    if (raw === undefined || raw === null) {
        return null;
    }

    if (dp.id === 'light.mode') {
        if (num(raw) === 1) {
            return 'auto';
        }
        return num(getPath(doc, 'light.status')) === 1 ? 'on' : 'off';
    }
    if (dp.orPaths) {
        return [raw, ...dp.orPaths.map(p => getPath(doc, p))].some(truthy);
    }
    switch (dp.conv) {
        case 'bool01':
            return truthy(raw);
        case 'timeOfDay':
            return secondsToTime(raw);
        case 'text':
            return String(raw);
        case 'epochMs': {
            const n = num(raw);
            return Number.isNaN(n) ? null : n * 1000;
        }
    }
    if (dp.type === 'number') {
        const n = num(raw);
        if (Number.isNaN(n)) {
            return null;
        }
        return dp.scale ? Math.round((n / dp.scale) * 1000) / 1000 : n;
    }
    if (dp.type === 'boolean') {
        return truthy(raw);
    }
    return String(raw);
}

/**
 * ioBroker-State-Wert -> zu schreibende Rohwerte { pfad: rohwert }
 * Wirft bei ungueltigen Werten.
 *
 * @param dp
 * @param val
 * @param doc
 */
function fromState(dp, val, doc) {
    if (dp.writeMulti) {
        const key = String(val).toLowerCase();
        if (!dp.writeMulti[key]) {
            throw new Error(`invalid value "${val}", allowed: ${Object.keys(dp.writeMulti).join(', ')}`);
        }
        return { ...dp.writeMulti[key] };
    }
    if (dp.conv === 'bool01' || dp.type === 'boolean') {
        const b = typeof val === 'string' ? ['true', '1', 'on', 'ein', 'an'].includes(val.toLowerCase()) : !!val;
        return { [dp.path]: b ? 1 : 0 };
    }
    if (dp.conv === 'timeOfDay') {
        const s = timeToSeconds(val);
        if (dp.range && (s < dp.range[0] || s > dp.range[1])) {
            throw new Error('time out of range');
        }
        return { [dp.path]: s };
    }
    if (dp.states) {
        let raw;
        if (typeof val === 'string' && Number.isNaN(Number(val))) {
            const hit = Object.entries(dp.states).find(([, label]) => label.toLowerCase() === val.toLowerCase());
            if (!hit) {
                throw new Error(`invalid value "${val}", allowed: ${Object.values(dp.states).join(', ')}`);
            }
            raw = Number(hit[0]);
        } else {
            raw = Number(val);
            if (dp.states[raw] === undefined) {
                throw new Error(`invalid value ${val}, allowed: ${Object.keys(dp.states).join(', ')}`);
            }
        }
        return { [dp.path]: raw };
    }
    if (dp.type === 'number') {
        const n = Number(val);
        if (!Number.isFinite(n)) {
            throw new Error(`not a number: ${val}`);
        }
        const max = maxOf(dp, doc);
        if (dp.min !== undefined && n < dp.min) {
            throw new Error(`value ${n} below minimum ${dp.min}`);
        }
        if (max !== undefined && n > max) {
            throw new Error(`value ${n} above maximum ${max}`);
        }
        return { [dp.path]: Math.round(n * (dp.scale || 1)) };
    }
    return { [dp.path]: val };
}

/**
 * Befehlszweig: bei >= 4 Segmenten zwei Ebenen, sonst oberste Ebene (wie aioaquarite).
 *
 * @param p
 */
function branchSignature(p) {
    const k = p.split('.');
    return k.length >= 4 ? `${k[0]}.${k[1]}` : k[0];
}

function extractBranch(doc, p) {
    const k = p.split('.');
    if (k.length >= 4) {
        return { [k[0]]: { [k[1]]: clone(getPath(doc, `${k[0]}.${k[1]}`) || {}) } };
    }
    return { [k[0]]: clone(doc[k[0]] || {}) };
}

/**
 * Baut das sendPoolCommand-Payload.
 *
 * @param {object} doc  aktuelles (plausibilisiertes) Pool-Dokument
 * @param {string} poolId
 * @param {object} updates { pfad: rohwert } - alle im selben Zweig
 * @param opts
 */
function buildCommand(doc, poolId, updates, opts = {}) {
    const paths = Object.keys(updates);
    if (!paths.length) {
        throw new Error('no changes');
    }
    let branch;
    if (opts.branch) {
        if (paths.some(p => !p.startsWith(`${opts.branch}.`))) {
            throw new Error(`changes outside of ${opts.branch}`);
        }
        const [a, b] = opts.branch.split('.');
        branch = { [a]: { [b]: clone(getPath(doc, opts.branch) || {}) } };
    } else {
        const sigs = new Set(paths.map(branchSignature));
        if (sigs.size !== 1) {
            throw new Error(`changes affect several branches: ${[...sigs].join(', ')}`);
        }
        branch = extractBranch(doc, paths[0]);
    }

    const effective = { ...updates };
    // Wie die Vistapool-Web-App: jeder Hydrolyse-Befehl traegt hidro.disable
    // (1 = Redox/Chlor-Regelung waehrend Boost aussetzen, 0 = weiterregeln).
    if (branch.hidro) {
        for (const p of Object.keys(effective)) {
            if (typeof effective[p] === 'boolean') {
                effective[p] = effective[p] ? 1 : 0;
            }
        }
        effective['hidro.disable'] = opts.hidroDisable === 0 ? 0 : 1;
    }
    for (const [p, v] of Object.entries(effective)) {
        setPath(branch, p, v);
    }

    return {
        effective,
        payload: {
            gateway: doc.wifi,
            poolId,
            operation: 'WRP',
            changes: JSON.stringify(branch),
            source: 'web',
        },
    };
}

/**
 * ioBroker-taugliche ID aus einem Pfadsegment
 *
 * @param s
 */
function safeId(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

module.exports = {
    getPath,
    setPath,
    clone,
    flatten,
    num,
    truthy,
    exists,
    isPlausible,
    sanitize,
    secondsToTime,
    timeToSeconds,
    unitOf,
    maxOf,
    toState,
    fromState,
    branchSignature,
    extractBranch,
    buildCommand,
    safeId,
};
