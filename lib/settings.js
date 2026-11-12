'use strict';
/**
 * Einstellungen der Anlage fuer die Instanz-Seite (Admin).
 *
 * Die Felder entsprechen den Einstellmasken der Vistapool-Web-App
 * (hayward-europe.web.app): Filtration, Licht, Relais, Hydrolyse, Sollwerte,
 * Rueckspuelung. Die Formularfelder heissen d_* und werden NICHT in der
 * Instanz gespeichert (doNotSave) - die Anlage ist die einzige Wahrheit.
 *
 *  load(doc)                     -> Formularwerte + Ausstattungs-Flags (x_*)
 *  diff(section, values, doc, o) -> { groups: [{branch, updates}], changes: [text] }
 */
const C = require('./convert');

const FREQ = [86400, 172800, 259200, 345600, 432000, 604800, 1209600, 1814400, 2419200];

// kind: bool | int | num | time | str
const F = (key, path, kind, label, extra = {}) => ({ key, path, kind, label, ...extra });

/**
 * Bilingual text; resolved with tr(text, lang).
 *
 * @param en
 * @param de
 */
const L = (en, de) => ({ en, de });
const tr = (t, lang) => (t && typeof t === 'object' ? t[lang === 'de' ? 'de' : 'en'] : t);

const SECTIONS = {
    filtration: {
        label: L('Filtration', 'Filtration'),
        fields: [
            F('d_f_mode', 'filtration.mode', 'int', L('Pump mode', 'Pumpenmodus'), {
                allowed: [0, 1, 2, 3, 4],
                names: [L('Manual', 'Manuell'), 'Auto', L('Heating', 'Heizen'), 'Smart', 'Intel'],
            }),
            F('d_f_status', 'filtration.status', 'bool', L('Pump (manual)', 'Pumpe (manuell)')),
            F('d_f_speed', 'filtration.manVel', 'int', L('Speed', 'Drehzahl'), {
                allowed: [0, 1, 2],
                names: [L('slow', 'langsam'), L('medium', 'mittel'), L('high', 'hoch')],
            }),
            ...[1, 2, 3].flatMap(i => [
                F(
                    `d_f_i${i}from`,
                    `filtration.interval${i}.from`,
                    'time',
                    L(`Interval ${i} start`, `Zeitfenster ${i} Start`),
                ),
                F(`d_f_i${i}to`, `filtration.interval${i}.to`, 'time', L(`Interval ${i} end`, `Zeitfenster ${i} Ende`)),
                F(
                    `d_f_i${i}speed`,
                    `filtration.timerVel${i}`,
                    'int',
                    L(`Interval ${i} speed`, `Zeitfenster ${i} Drehzahl`),
                    { allowed: [0, 1, 2], names: [L('slow', 'langsam'), L('medium', 'mittel'), L('high', 'hoch')] },
                ),
            ]),
            F('d_f_clima', 'filtration.heating.clima', 'bool', L('Heating active', 'Heizung aktiv')),
            F(
                'd_f_heatTemp',
                'filtration.heating.temp',
                'num',
                L('Heating set temperature', 'Heizung Solltemperatur'),
                { min: 0, max: 99, onlyIf: d => C.num(C.getPath(d, 'filtration.hasHeat')) !== 2 },
            ),
            F(
                'd_f_heatMin',
                'filtration.heating.temp',
                'num',
                L('Heating minimum temperature', 'Heizung Mindesttemperatur'),
                { min: 0, max: 50, onlyIf: d => C.num(C.getPath(d, 'filtration.hasHeat')) === 2 },
            ),
            F(
                'd_f_heatTempHi',
                'filtration.heating.tempHi',
                'num',
                L('Heating maximum temperature', 'Heizung Höchsttemperatur'),
                { min: 0, max: 50 },
            ),
            F('d_f_smartFreeze', 'filtration.smart.freeze', 'bool', L('Smart frost protection', 'Smart Frostschutz')),
            F(
                'd_f_smartMin',
                'filtration.smart.tempMin',
                'num',
                L('Smart minimum temperature', 'Smart Mindesttemperatur'),
                { min: 1, max: 50 },
            ),
            F(
                'd_f_smartMax',
                'filtration.smart.tempHigh',
                'num',
                L('Smart maximum temperature', 'Smart Höchsttemperatur'),
                { min: 1, max: 50 },
            ),
            F('d_f_intelTemp', 'filtration.intel.temp', 'num', L('Intel temperature', 'Intel Temperatur'), {
                min: 1,
                max: 50,
            }),
            F('d_f_intelHours', 'filtration.intel.time', 'num', L('Intel filtration hours', 'Intel Filterstunden'), {
                min: 2,
                max: 23,
                scale: 60,
            }),
        ],
    },
    light: {
        label: L('Light', 'Licht'),
        fields: [
            F('d_l_mode', 'light.mode', 'int', L('Light mode', 'Lichtmodus'), {
                allowed: [0, 1],
                names: [L('Manual', 'Manuell'), 'Auto'],
            }),
            F('d_l_status', 'light.status', 'bool', L('Light (manual)', 'Licht (manuell)')),
            F('d_l_from', 'light.from', 'time', L('Light start', 'Licht Start')),
            F('d_l_to', 'light.to', 'time', L('Light end', 'Licht Ende')),
            F('d_l_freq', 'light.freq', 'int', L('Light repetition', 'Licht Wiederholung'), { allowed: FREQ }),
        ],
    },
    ...Object.fromEntries(
        [1, 2, 3, 4].map(n => [
            `relay${n}`,
            {
                label: L(`Relay ${n}`, `Relais ${n}`),
                branch: `relays.relay${n}`,
                requires: `relays.relay${n}.info`,
                fields: [
                    F(`d_r${n}_name`, `relays.relay${n}.name`, 'str', L('Name', 'Name'), { maxLength: 10 }),
                    F(`d_r${n}_mode`, `relays.relay${n}.info.manAutoTemp`, 'int', L('Mode', 'Modus'), {
                        allowed: [0, 1, 2, 3, 4],
                        names: [
                            L('Manual', 'Manuell'),
                            'Auto',
                            L('Timer', 'Tempo'),
                            L('Linked', 'Gekoppelt'),
                            L('Linked + auto', 'Gekoppelt + Auto'),
                        ],
                    }),
                    F(`d_r${n}_onoff`, `relays.relay${n}.info.onoff`, 'bool', L('State (manual)', 'Zustand (manuell)')),
                    F(
                        `d_r${n}_from`,
                        `relays.relay${n}.info.from`,
                        'time',
                        L('Interval 1 start', 'Zeitfenster 1 Start'),
                    ),
                    F(`d_r${n}_to`, `relays.relay${n}.info.to`, 'time', L('Interval 1 end', 'Zeitfenster 1 Ende')),
                    F(
                        `d_r${n}_freq`,
                        `relays.relay${n}.info.freq`,
                        'int',
                        L('Interval 1 repetition', 'Zeitfenster 1 Wiederholung'),
                        { allowed: FREQ },
                    ),
                    F(
                        `d_r${n}_from2`,
                        `relays.relay${n}.info.from2`,
                        'time',
                        L('Interval 2 start', 'Zeitfenster 2 Start'),
                    ),
                    F(`d_r${n}_to2`, `relays.relay${n}.info.to2`, 'time', L('Interval 2 end', 'Zeitfenster 2 Ende')),
                    F(
                        `d_r${n}_freq2`,
                        `relays.relay${n}.info.freq2`,
                        'int',
                        L('Interval 2 repetition', 'Zeitfenster 2 Wiederholung'),
                        { allowed: FREQ },
                    ),
                    F(`d_r${n}_tempo`, `relays.relay${n}.info.tiempoOn`, 'num', L('Run time (min)', 'Laufzeit (min)'), {
                        min: 0,
                        max: 180,
                    }),
                    F(`d_r${n}_key`, `relays.relay${n}.info.key`, 'int', L('Button', 'Taster'), { allowed: [0, 1, 2] }),
                    F(`d_r${n}_signal`, `relays.relay${n}.info.signal`, 'int', L('Signal', 'Signal'), {
                        allowed: [0, 1, 2, 3, 4, 5, 6, 7],
                    }),
                    F(`d_r${n}_delay`, `relays.relay${n}.info.delay`, 'num', L('Delay (s)', 'Verzögerung (s)'), {
                        min: 0,
                        max: 30,
                    }),
                    F(`d_r${n}_polarity`, `relays.relay${n}.info.polarity`, 'int', L('Polarity', 'Polarität'), {
                        allowed: [0, 1],
                    }),
                ],
            },
        ]),
    ),
    water: {
        label: L('Water care', 'Wasserpflege'),
        fields: [
            F('d_h_levelPct', 'hidro.level', 'num', L('Production (%)', 'Produktion (%)'), {
                min: 0,
                max: 100,
                scale: 10,
                requires: 'main.hasHidro',
                onlyIf: d => hidroUnit(d) === '%',
            }),
            F('d_h_levelGh', 'hidro.level', 'num', L('Production (g/h)', 'Produktion (g/h)'), {
                min: 0,
                max: 100,
                scale: 10,
                requires: 'main.hasHidro',
                onlyIf: d => hidroUnit(d) !== '%',
            }),
            F('d_h_cover', 'hidro.cover_enabled', 'bool', L('Cover detection', 'Abdeckung erkennen'), {
                requires: 'main.hasHidro',
            }),
            F('d_h_reduction', 'hidro.reduction', 'num', L('Reduction with cover (%)', 'Reduktion bei Abdeckung (%)'), {
                min: 1,
                max: 100,
                requires: 'main.hasHidro',
            }),
            F(
                'd_h_shock',
                'hidro.cloration_enabled',
                'bool',
                L('Boost (shock chlorination)', 'Boost (Schockchlorung)'),
                { requires: 'main.hasHidro' },
            ),
            F('d_h_tempValue', 'hidro.temperature_value', 'num', L('Temperature limit', 'Temperaturgrenze'), {
                min: 1,
                max: 100,
                requires: 'hidro.temperature_enabled',
            }),
            F('d_h_control', 'hidro.control', 'int', L('Controlled by', 'Regelung durch'), {
                allowed: [0, 1],
                names: ['Redox', L('Chlorine', 'Chlor')],
                requires: 'hidro.hasHidroControl',
            }),
            F('d_ph_high', 'modules.ph.status.high_value', 'num', L('pH set point (acid)', 'pH-Sollwert (Säure)'), {
                min: 0,
                max: 14,
                scale: 100,
                requires: 'main.hasPH',
            }),
            F('d_ph_low', 'modules.ph.status.low_value', 'num', L('pH set point (base)', 'pH-Sollwert (Base)'), {
                min: 0,
                max: 14,
                scale: 100,
                requires: 'main.hasPH',
            }),
            F('d_rx_set', 'modules.rx.status.value', 'num', L('Redox set point (mV)', 'Redox-Sollwert (mV)'), {
                min: 0,
                max: 1000,
                requires: 'main.hasRX',
            }),
            F('d_cl_set', 'modules.cl.status.value', 'num', L('Chlorine set point (ppm)', 'Chlor-Sollwert (ppm)'), {
                min: 0,
                max: 10,
                scale: 100,
                requires: 'main.hasCL',
            }),
            F('d_cd_set', 'modules.cd.status.value', 'num', L('Conductivity set point', 'Leitfähigkeit-Sollwert'), {
                min: 0,
                max: 40000,
                requires: 'main.hasCD',
            }),
        ],
    },
    backwash: {
        label: L('Backwash', 'Rückspülung'),
        requires: 'main.hasBackwash',
        fields: [
            F('d_b_mode', 'backwash.mode', 'int', L('Backwash mode', 'Rückspülung Modus'), {
                allowed: [0, 1],
                names: [L('Manual', 'Manuell'), 'Auto'],
            }),
            F('d_b_status', 'backwash.status', 'bool', L('Backwash (manual)', 'Rückspülung (manuell)')),
            F('d_b_start', 'backwash.startAt', 'time', L('Start time', 'Startzeit'), { offset: 1 }),
            F('d_b_interval', 'backwash.interval', 'num', L('Duration (s)', 'Dauer (s)'), { min: 0, max: 3600 }),
            F('d_b_freq', 'backwash.frequency', 'int', L('Repetition', 'Wiederholung'), {
                allowed: FREQ,
                scale: 1 / 60,
            }),
        ],
    },
};

function hidroMax(doc) {
    if (hidroUnit(doc) === '%') {
        return 100;
    }
    const m = C.num(C.getPath(doc, 'hidro.maxAllowedValue'));
    return m > 0 ? Math.round(m / 10) : 50;
}

function hidroUnit(doc) {
    return C.getPath(doc, 'hidro.measure') || (C.truthy(C.getPath(doc, 'hidro.is_electrolysis')) ? 'g/h' : '%');
}

// ------------------------------------------------------------------ Konvertierung
function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * Rohwert -> Formularwert
 *
 * @param f
 * @param raw
 */
function toForm(f, raw) {
    if (raw === undefined || raw === null) {
        return f.kind === 'bool' ? false : f.kind === 'time' ? '00:00:00' : f.kind === 'str' ? '' : 0;
    }
    switch (f.kind) {
        case 'bool':
            return C.truthy(raw);
        case 'str':
            return String(raw);
        case 'time': {
            const s = C.num(raw);
            const d = ((Math.floor(s) % 86400) + 86400) % 86400;
            return `${pad2(Math.floor(d / 3600))}:${pad2(Math.floor((d % 3600) / 60))}:00`;
        }
        default: {
            const n = C.num(raw);
            if (Number.isNaN(n)) {
                return 0;
            }
            const v = f.scale ? n / f.scale : n;
            return Math.round(v * 100) / 100;
        }
    }
}

/**
 * Formularwert -> Rohwert (wirft bei ungueltigen Werten)
 *
 * @param f
 * @param val
 * @param lang
 */
function fromForm(f, val, lang) {
    const label = tr(f.label, lang);
    const de = lang === 'de';
    switch (f.kind) {
        case 'bool':
            return val === true || val === 'true' || val === 1 || val === '1' ? 1 : 0;
        case 'str': {
            const s = String(val ?? '');
            if (f.maxLength && s.length > f.maxLength) {
                throw new Error(
                    de ? `${label}: höchstens ${f.maxLength} Zeichen` : `${label}: at most ${f.maxLength} characters`,
                );
            }
            return s;
        }
        case 'time': {
            let s;
            const str = String(val ?? '');
            if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
                const d = new Date(str);
                s = d.getHours() * 3600 + d.getMinutes() * 60;
            } else {
                s = C.timeToSeconds(str.slice(0, 5));
            }
            return s + (f.offset || 0);
        }
        default: {
            const n = Number(val);
            if (!Number.isFinite(n)) {
                throw new Error(de ? `${label}: keine Zahl` : `${label}: not a number`);
            }
            if (f.allowed) {
                if (!f.allowed.includes(n)) {
                    throw new Error(de ? `${label}: ungültiger Wert ${val}` : `${label}: invalid value ${val}`);
                }
                return f.scale ? Math.round(n * f.scale) : n;
            }
            if (f.min !== undefined && n < f.min) {
                throw new Error(de ? `${label}: mindestens ${f.min}` : `${label}: at least ${f.min}`);
            }
            if (f.max !== undefined && n > f.max) {
                throw new Error(de ? `${label}: höchstens ${f.max}` : `${label}: at most ${f.max}`);
            }
            return Math.round(f.scale ? n * f.scale : n);
        }
    }
}

function fmtForm(f, v, lang) {
    if (f.kind === 'bool') {
        return lang === 'de' ? (v ? 'ein' : 'aus') : v ? 'on' : 'off';
    }
    if (f.kind === 'time') {
        return String(v).slice(0, 5);
    }
    if (f.names && f.allowed) {
        const i = f.allowed.indexOf(Number(v));
        if (i >= 0 && f.names[i]) {
            return tr(f.names[i], lang);
        }
    }
    return String(v);
}

function available(req, doc) {
    if (!req) {
        return true;
    }
    const v = C.getPath(doc, req);
    return v !== null && typeof v === 'object' ? true : C.truthy(v);
}

// ------------------------------------------------------------------ Laden
function load(doc) {
    const out = { x_loaded: true };
    for (const sec of Object.values(SECTIONS)) {
        for (const f of sec.fields) {
            out[f.key] = toForm(f, C.getPath(doc, f.path));
        }
    }
    const m = k => C.truthy(C.getPath(doc, `main.${k}`));
    const measure = hidroUnit(doc);
    Object.assign(out, {
        x_online: C.truthy(C.getPath(doc, 'present')),
        x_hasHeat: C.num(C.getPath(doc, 'filtration.hasHeat')) || 0,
        x_hasSmart: C.truthy(C.getPath(doc, 'filtration.hasSmart')),
        x_vsp: C.num(C.getPath(doc, 'filtration.pumpType')) > 0,
        x_hasHidro: m('hasHidro'),
        x_hidroUnit: measure,
        x_hidroMax: hidroMax(doc),
        x_hidroTemp: C.truthy(C.getPath(doc, 'hidro.temperature_enabled')),
        x_hidroControl: m('hasRX') && m('hasCL') && C.truthy(C.getPath(doc, 'hidro.hasHidroControl')),
        x_hasPH: m('hasPH'),
        x_phType: String(C.getPath(doc, 'modules.ph.type') || 'ACID'),
        x_hasRX: m('hasRX'),
        x_hasCL: m('hasCL'),
        x_hasCD: m('hasCD'),
        x_hasBackwash: m('hasBackwash'),
        x_hideLight: m('hideLighting'),
        x_relays: [1, 2, 3, 4].filter(n => available(`relays.relay${n}.info`, doc)).length,
    });
    return out;
}

// ------------------------------------------------------------------ Aenderungen ermitteln
/**
 * @param {string} section
 * @param {object} values  Formularwerte (Strings aus jsonData oder echte Typen)
 * @param {object} doc     aktuelles Pool-Dokument
 * @param {string} [lang]   'de' | 'en' fuer Meldungen
 * @returns {{groups: {branch: string|null, updates: object}[], changes: string[]}}
 */
function diff(section, values, doc, lang = 'en') {
    const de = lang === 'de';
    const sec = SECTIONS[section];
    if (!sec) {
        throw new Error(`Unknown section ${section}`);
    }
    if (sec.requires && !available(sec.requires, doc)) {
        throw new Error(
            de
                ? `${tr(sec.label, lang)} ist an dieser Anlage nicht vorhanden`
                : `${tr(sec.label, lang)} is not available on this controller`,
        );
    }

    const byBranch = new Map();
    const changes = [];
    for (const f of sec.fields) {
        if (!(f.key in values)) {
            continue;
        }
        if (f.requires && !available(f.requires, doc)) {
            continue;
        }
        if (f.onlyIf && !f.onlyIf(doc)) {
            continue;
        }
        const rawCur = C.getPath(doc, f.path);
        if (rawCur === undefined) {
            continue;
        }
        const curForm = toForm(f, rawCur);
        const fx = f.path === 'hidro.level' ? { ...f, max: hidroMax(doc) } : f;
        const newRaw = fromForm(fx, values[f.key], lang);
        const newForm = toForm(f, newRaw);
        if (f.kind === 'str' && !String(newRaw).trim() && String(curForm).trim()) {
            throw new Error(
                de
                    ? `${tr(f.label, lang)}: Die Anlage übernimmt keinen leeren Namen – bitte einen anderen Namen eingeben (max. ${f.maxLength || 10} Zeichen)`
                    : `${tr(f.label, lang)}: the controller does not accept an empty name – please enter another name (max. ${f.maxLength || 10} characters)`,
            );
        }
        const same =
            f.kind === 'time'
                ? String(curForm).slice(0, 5) === String(newForm).slice(0, 5)
                : String(curForm) === String(newForm);
        if (same) {
            continue;
        }
        const branch = sec.branch || C.branchSignature(f.path);
        if (!byBranch.has(branch)) {
            byBranch.set(branch, {});
        }
        byBranch.get(branch)[f.path] = newRaw;
        changes.push(`${tr(f.label, lang)}: ${fmtForm(f, curForm, lang)} → ${fmtForm(f, newForm, lang)}`);
    }
    return {
        groups: [...byBranch].map(([branch, updates]) => ({ branch: sec.branch ? branch : null, updates })),
        changes,
    };
}

module.exports = { SECTIONS, FREQ, load, diff, toForm, fromForm, tr };
