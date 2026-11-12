'use strict';
/**
 * Erzeugt admin/jsonConfig.json.  Aufruf: node tools/build-jsonconfig.js
 *
 * Aufbau der Instanz-Seite:
 *   Verbindung | Anlage | Pumpe & Heizung | Licht | Relais | Wasserpflege | Rückspülung
 *
 * Anlagen-Felder (d_*) und Ausstattungs-Flags (x_*) werden nicht gespeichert (doNotSave):
 * sie kommen beim Öffnen frisch von der Anlage und gehen per "An Anlage senden" zurück.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SECTIONS } = require('../lib/settings');

const L = (de, en) => ({ de, en: en || de });
const W = { xs: 12, sm: 12, md: 6, lg: 4, xl: 4 };
const W3 = { xs: 12, sm: 4, md: 4, lg: 3, xl: 3 };
const NOT_LOADED = '!data.x_loaded';
const and = (...c) => c.filter(Boolean).map(x => `(${x})`).join(' || ');   // hidden-Bedingungen: ODER

const FREQ_OPTS = [
    [86400, 'täglich', 'daily'], [172800, 'alle 2 Tage', 'every 2 days'], [259200, 'alle 3 Tage', 'every 3 days'],
    [345600, 'alle 4 Tage', 'every 4 days'], [432000, 'alle 5 Tage', 'every 5 days'], [604800, 'wöchentlich', 'weekly'],
    [1209600, 'alle 2 Wochen', 'every 2 weeks'], [1814400, 'alle 3 Wochen', 'every 3 weeks'], [2419200, 'alle 4 Wochen', 'every 4 weeks'],
].map(([value, de, en]) => ({ value, label: L(de, en) }));
const SPEED_OPTS = [[0, 'langsam', 'slow'], [1, 'mittel', 'medium'], [2, 'hoch', 'high']].map(([value, de, en]) => ({ value, label: L(de, en) }));

// ------------------------------------------------------------------ Bausteine
const dev = (key, ctrl) => ({ doNotSave: true, ...ctrl, hidden: and(NOT_LOADED, ctrl.hidden) });
const time = (key, label, extra = {}) => dev(key, { type: 'timePicker', label, returnFormat: 'HH:mm:ss', format: 'HH:mm', views: ['hours', 'minutes'], timeSteps: { hours: 1, minutes: 5 }, ...W3, ...extra });
const check = (key, label, extra = {}) => dev(key, { type: 'checkbox', label, ...W, ...extra });
const num = (key, label, extra = {}) => dev(key, { type: 'number', label, ...W3, ...extra });
const select = (key, label, options, extra = {}) => dev(key, { type: 'select', label, options, ...W3, ...extra });
const radio = (key, label, options, extra = {}) => dev(key, { type: 'select', format: 'radio', horizontal: true, label, options, xs: 12, sm: 12, md: 12, lg: 12, xl: 12, newLine: true, ...extra });
const header = (text, extra = {}) => ({ type: 'header', text, size: 4, newLine: true, ...extra, hidden: and(NOT_LOADED, extra.hidden) });
const info = (text, extra = {}) => ({ type: 'staticText', text, newLine: true, xs: 12, sm: 12, md: 12, lg: 12, xl: 12, style: { opacity: 0.75, fontSize: 13 }, ...extra, hidden: and(NOT_LOADED, extra.hidden) });
const notLoadedBox = { type: 'infoBox', boxType: 'info', closeable: false, title: L('Noch keine Daten von der Anlage', 'No data from the pool yet'),
    text: L('Öffne zuerst den Tab „Anlage“ und lade die Einstellungen. Die Instanz muss dafür laufen und mit deinem Vistapool-Konto verbunden sein.', 'Open the “Pool” tab first and load the settings. The instance must be running and connected.'),
    hidden: 'data.x_loaded', newLine: true, xs: 12, sm: 12, md: 12, lg: 12, xl: 12 };
// Rueckmeldung der letzten Uebertragung (oben und unten im Tab)
const resultBox = attr => ({ type: 'text', label: L('Letzte Übertragung', 'Last transfer'), readOnly: true, minRows: 2, maxRows: 8, doNotSave: true, noClearButton: true,
    newLine: true, xs: 12, sm: 12, md: 12, lg: 8, xl: 8, hidden: `!data.${attr}` });
// Laedt automatisch, sobald ein Anlagen-Tab ohne Daten geoeffnet wird (Tabs werden erst beim Anzeigen aufgebaut).
const autoLoad = { type: 'sendTo', command: 'loadSettings', jsonData: JSON.stringify({ poolId: '${data.poolId}' }), onLoaded: true, useNative: true, showProcess: true, timeout: 30000,
    label: L('Einstellungen von der Anlage laden', 'Load settings from pool'), icon: 'refresh', variant: 'outlined', newLine: true, xs: 12, sm: 12, md: 6, lg: 4, xl: 4,
    hidden: 'data.x_loaded || !_alive' };

function sendButton(section, label, extra = {}) {
    const values = Object.fromEntries(SECTIONS[section].fields.map(f => [f.key, `\${data.${f.key}}`]));
    return {
        type: 'sendTo',
        command: 'applySettings',
        jsonData: JSON.stringify({ poolId: '${data.poolId}', section, values }),
        label,
        icon: 'send',
        variant: 'contained',
        useNative: true,
        showProcess: true,
        timeout: 30000,
        newLine: true,
        xs: 12, sm: 12, md: 6, lg: 4, xl: 4,
        confirm: {
            text: L('Die geänderten Werte werden sofort an die Poolsteuerung gesendet. Nur Felder, die von der Anlage abweichen, werden übertragen.', 'Changed values are sent to the pool controller immediately. Only fields that differ from the controller are transmitted.'),
            title: L('An Anlage senden?', 'Send to pool?'), ok: L('Senden', 'Send'), cancel: L('Abbrechen', 'Cancel'), type: 'warning',
        },
        ...extra,
        hidden: and(NOT_LOADED, extra.hidden),
    };
}
const sendHint = info(L('„Speichern“ unten betrifft nur Adapter-Einstellungen. Werte der Anlage werden ausschließlich über „An Anlage senden“ übertragen.', '“Save” only stores adapter settings. Pool values are only transferred with “Send to pool”.'));

const items = {};

// ================================================================== Tab Verbindung
items.tabConnection = {
    type: 'panel', label: L('Verbindung', 'Connection'),
    items: {
        _alive: { type: 'alive', newLine: true, xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        _hdrAccount: { type: 'header', text: L('Vistapool-Konto', 'Vistapool account'), size: 3, newLine: true },
        email: { type: 'text', label: L('E-Mail'), ...W, newLine: true, help: L('Wie in der Vistapool-App bzw. auf hayward-europe.web.app', 'Same as in the Vistapool app') },
        password: { type: 'password', label: L('Passwort', 'Password'), visible: true, ...W },
        _test: { type: 'sendTo', command: 'testConnection', jsonData: JSON.stringify({ email: '${data.email}', password: '${data.password}' }),
            label: L('Verbindung testen', 'Test connection'), icon: 'auth', variant: 'outlined', showProcess: true, timeout: 30000, ...W, newLine: true, disabled: '!_alive',
            help: L('Funktioniert auch vor dem Speichern.', 'Works before saving, too.') },
        _hdrPoll: { type: 'header', text: L('Aktualisierung', 'Updates'), size: 3, newLine: true },
        push: { type: 'checkbox', label: L('Push-Aktualisierung (empfohlen)', 'Push updates (recommended)'), ...W, newLine: true,
            help: L('Änderungen kommen sofort, wie in der Vistapool-App. Fällt Push aus, fragt der Adapter automatisch im Intervall ab.', 'Changes arrive immediately, like in the Vistapool app. If push fails, the adapter polls automatically.') },
        pollInterval: { type: 'number', label: L('Abfrageintervall ohne Push', 'Poll interval without push'), unit: 's', min: 15, max: 3600, ...W,
            help: L('Nur ohne Push. Mit Push wird zur Sicherheit alle 15 Minuten gelesen.', 'Only without push. With push the adapter reads every 15 minutes as a safety net.') },
        commandMaxAge: { type: 'number', label: L('Unbestätigte Befehle verwerfen nach', 'Discard unconfirmed commands after'), unit: 'min', min: 0, max: 1440, ...W, newLine: true,
            help: L('Ist die Anlage offline (z. B. schlechtes WLAN), wird ein Befehl nach ihrer Rückkehr erneut gesendet – aber nur, wenn er nicht älter ist. 0 = immer nachsenden.', 'Commands are re-sent when the controller is back online, unless older than this. 0 = always.') },
        rawMirror: { type: 'checkbox', label: L('Rohdaten unter raw.* anlegen (Diagnose)', 'Mirror raw fields to raw.* (diagnostics)'), ...W,
            help: L('Jedes Feld der Cloud ungefiltert als Objekt – nur zur Fehlersuche, enthält kurzzeitige Fehlwerte.', 'Every cloud field unfiltered – for troubleshooting only, contains transient garbage values.') },
        _hdrClock: { type: 'header', text: L('Uhrzeit der Steuerung', 'Controller clock'), size: 3, newLine: true },
        clockSync: { type: 'checkbox', label: L('Uhrzeit automatisch synchronisieren', 'Sync clock automatically'), ...W, newLine: true,
            help: L('Die Uhr der Steuerung driftet und kennt keine Sommerzeit. Zeitfenster laufen sonst versetzt.', 'The controller clock drifts and ignores daylight saving time; schedules would run off.') },
        clockMaxDrift: { type: 'number', label: L('Synchronisieren ab Abweichung von', 'Sync when deviation exceeds'), unit: 'min', min: 1, max: 120, ...W, hidden: '!data.clockSync' },
        timeZone: { type: 'text', label: L('Zeitzone der Anlage', 'Time zone of the pool'), placeholder: 'Europe/Berlin', ...W,
            help: L('Leer = Zeitzone des ioBroker-Servers. Nötig, wenn ioBroker in UTC läuft (z. B. Docker ohne TZ).', 'Empty = time zone of the ioBroker host. Required if ioBroker runs in UTC (e.g. Docker without TZ).') },
    },
};

// ================================================================== Tab Anlage
items.tabPool = {
    type: 'panel', label: L('Anlage', 'Pool'),
    items: {
        _howto: { type: 'infoBox', boxType: 'info', closed: false, newLine: true, xs: 12, sm: 12, md: 12, lg: 12, xl: 12,
            title: L('So funktionieren die Anlagen-Tabs', 'How the pool tabs work'),
            text: L('Die Tabs „Pumpe & Heizung“, „Licht“, „Relais“, „Wasserpflege“ und „Rückspülung“ zeigen die aktuellen Einstellungen deiner Poolsteuerung – dieselben wie in der Vistapool-App. Jeder Tab hat einen eigenen Knopf „An Anlage senden“. Übertragen werden nur Werte, die du geändert hast.', 'The pool tabs show the current controller settings. Each tab has its own “Send to pool” button; only changed values are sent.') },
        poolId: { type: 'selectSendTo', command: 'getPools', label: L('Pool'), noTranslation: true, manual: false, ...W, newLine: true,
            help: L('Bei mehreren Pools im Konto: welcher Pool hier bearbeitet wird.', 'If the account has several pools: which pool to edit.') },
        _load: { type: 'sendTo', command: 'loadSettings', jsonData: JSON.stringify({ poolId: '${data.poolId}' }), onLoaded: true, useNative: true, showProcess: true, timeout: 30000,
            label: L('Einstellungen von der Anlage laden', 'Load settings from pool'), icon: 'refresh', variant: 'outlined', ...W, disabled: '!_alive',
            help: L('Passiert beim Öffnen automatisch. Erneut laden, wenn du parallel in der App etwas geändert hast.', 'Runs automatically on open.') },
        _notAlive: { type: 'infoBox', boxType: 'warning', closeable: false, newLine: true, xs: 12, sm: 12, md: 12, lg: 12, xl: 12, hidden: '_alive',
            title: L('Instanz läuft nicht', 'Instance not running'),
            text: L('Starte die Instanz (und trage im Tab „Verbindung“ deine Zugangsdaten ein), damit diese Seite die Einstellungen der Anlage anzeigen kann.', 'Start the instance so this page can show the pool settings.') },
        _equipHdr: header(L('Ausstattung', 'Equipment')),
        x_online: check('x_online', L('Steuerung online', 'Controller online'), { disabled: 'true' }),
        x_hasHidro: check('x_hasHidro', L('Hydrolyse / Elektrolyse', 'Hydrolysis / electrolysis'), { disabled: 'true' }),
        x_hasPH: check('x_hasPH', L('pH-Regelung', 'pH control'), { disabled: 'true' }),
        x_hasRX: check('x_hasRX', L('Redox-Regelung', 'Redox control'), { disabled: 'true' }),
        x_hasCL: check('x_hasCL', L('Chlor-Messung', 'Chlorine probe'), { disabled: 'true' }),
        x_vsp: check('x_vsp', L('Drehzahlgeregelte Pumpe', 'Variable speed pump'), { disabled: 'true' }),
        x_hasSmart: check('x_hasSmart', L('Modus Smart verfügbar', 'Smart mode available'), { disabled: 'true' }),
        x_hasBackwash: check('x_hasBackwash', L('Rückspülung', 'Backwash'), { disabled: 'true' }),
        _heatHdr: header(L('Wo hängt was?', 'What is connected where?')),
        _heatInfo: info(L('Heizung/Wärmepumpe: Die Steuerung hat dafür einen eigenen Heizungsausgang. Er schaltet im Pumpenmodus „Heizen“ abhängig von der Wassertemperatur (Tab „Pumpe & Heizung“). Hängt deine Wärmepumpe stattdessen an einem AUX-Relais, ordne sie im Tab „Relais“ zu.', 'Heating has its own output that switches in “Heat” mode. If your heat pump is wired to an AUX relay, assign it in the “Relays” tab.')),
        _hidroInfo: info(L('Hydrolyse/Elektrolyse: Produktion, Abdeckung und Boost stellst du im Tab „Wasserpflege“ ein.', 'Hydrolysis/electrolysis settings are in the “Water care” tab.'), { hidden: '!data.x_hasHidro' }),
        _clockHdr: header(L('Uhrzeit der Steuerung', 'Controller clock')),
        _sync: { type: 'sendTo', command: 'syncTime', jsonData: JSON.stringify({ poolId: '${data.poolId}' }), label: L('Uhrzeit jetzt synchronisieren', 'Sync clock now'),
            icon: 'send', variant: 'outlined', showProcess: true, ...W, newLine: true, hidden: NOT_LOADED,
            help: L('Zeitfenster laufen nach der Uhr der Steuerung. Die automatische Synchronisation stellst du im Tab „Verbindung“ ein.', 'Schedules run on the controller clock. Automatic sync is configured in the “Connection” tab.') },
    },
};

// ================================================================== Tab Pumpe & Heizung
const mode = v => `data.d_f_mode !== ${v} && !data.d_showAll`;
const modeIn = (...v) => `![${v.join(',')}].includes(data.d_f_mode) && !data.d_showAll`;
const f = {
    _nl: notLoadedBox,
    _autoload: autoLoad,
    d_f_mode: radio('d_f_mode', L('Pumpenmodus', 'Pump mode'), [
        { value: 0, label: L('Manuell', 'Manual'), description: L('Pumpe von Hand ein/aus', 'Pump on/off by hand') },
        { value: 1, label: L('Auto'), description: L('Nach Zeitfenstern', 'By time windows') },
        { value: 2, label: L('Heizen', 'Heat'), hidden: '!data.x_hasHeat', description: L('Zeitfenster + Heizung nach Temperatur', 'Time windows + heating by temperature') },
        { value: 3, label: L('Smart'), hidden: '!data.x_hasSmart', description: L('Laufzeit passt sich der Temperatur an', 'Run time adapts to the temperature') },
        { value: 4, label: L('Intel'), description: L('Filterstunden pro Tag', 'Filtration hours per day') },
    ]),
    d_showAll: dev('d_showAll', { type: 'checkbox', label: L('Einstellungen aller Modi anzeigen', 'Show settings of all modes'), ...W, newLine: true,
        help: L('Sonst siehst du nur die Felder des gewählten Modus.', 'Otherwise only the selected mode is shown.') }),

    _hManual: header(L('Manuell', 'Manual'), { hidden: mode(0) }),
    d_f_status: check('d_f_status', L('Pumpe läuft', 'Pump running'), { hidden: mode(0), newLine: true }),
    d_f_speed: select('d_f_speed', L('Drehzahl', 'Speed'), SPEED_OPTS, { hidden: and(mode(0), '!data.x_vsp') }),

    _hTimes: header(L('Zeitfenster', 'Time windows'), { hidden: modeIn(1, 2, 3) }),
    _tInfo: info(L('Gleiche Start- und Endzeit (z. B. 00:00–00:00) bedeutet: Zeitfenster aus. Gilt in den Modi Auto, Heizen und Smart.', 'Same start and end time = window off.'), { hidden: modeIn(1, 2, 3) }),
};
for (const i of [1, 2, 3]) {
    f[`d_f_i${i}from`] = time(`d_f_i${i}from`, L(`Fenster ${i} von`, `Window ${i} from`), { hidden: modeIn(1, 2, 3), newLine: true });
    f[`d_f_i${i}to`] = time(`d_f_i${i}to`, L(`bis`, 'to'), { hidden: modeIn(1, 2, 3) });
    f[`d_f_i${i}speed`] = select(`d_f_i${i}speed`, L('Drehzahl', 'Speed'), SPEED_OPTS, { hidden: and(modeIn(1, 2, 3), '!data.x_vsp') });
}
Object.assign(f, {
    _hHeat: header(L('Heizung (Modus Heizen)', 'Heating (heat mode)'), { hidden: and(mode(2), '!data.x_hasHeat') }),
    d_f_clima: check('d_f_clima', L('Heizung aktiv', 'Heating enabled'), { hidden: and(mode(2), '!data.x_hasHeat'), newLine: true,
        help: L('Schaltet den Heizungsausgang nach Wassertemperatur.', 'Switches the heating output by water temperature.') }),
    d_f_heatTemp: num('d_f_heatTemp', L('Solltemperatur', 'Target temperature'), { unit: '°C', min: 0, max: 99, step: 1, hidden: and(mode(2), '!data.x_hasHeat', 'data.x_hasHeat === 2'), newLine: true }),
    d_f_heatMin: num('d_f_heatMin', L('Mindesttemperatur', 'Min temperature'), { unit: '°C', min: 0, max: 50, step: 1, hidden: and(mode(2), 'data.x_hasHeat !== 2'), newLine: true }),
    d_f_heatTempHi: num('d_f_heatTempHi', L('Höchsttemperatur', 'Max temperature'), { unit: '°C', min: 0, max: 50, step: 1, hidden: and(mode(2), 'data.x_hasHeat !== 2') }),

    _hSmart: header(L('Smart'), { hidden: and(mode(3), '!data.x_hasSmart') }),
    d_f_smartMin: num('d_f_smartMin', L('Mindesttemperatur', 'Min temperature'), { unit: '°C', min: 1, max: 50, step: 1, hidden: and(mode(3), '!data.x_hasSmart'), newLine: true }),
    d_f_smartMax: num('d_f_smartMax', L('Höchsttemperatur', 'Max temperature'), { unit: '°C', min: 1, max: 50, step: 1, hidden: and(mode(3), '!data.x_hasSmart') }),
    d_f_smartFreeze: check('d_f_smartFreeze', L('Frostschutz', 'Freeze protection'), { hidden: and(mode(3), '!data.x_hasSmart'),
        help: L('Pumpe läuft bei Frostgefahr.', 'Pump runs when there is a risk of frost.') }),

    _hIntel: header(L('Intel'), { hidden: mode(4) }),
    d_f_intelTemp: num('d_f_intelTemp', L('Temperatur', 'Temperature'), { unit: '°C', min: 1, max: 50, step: 1, hidden: mode(4), newLine: true }),
    d_f_intelHours: num('d_f_intelHours', L('Filterstunden pro Tag', 'Filter hours per day'), { unit: 'h', min: 2, max: 23, step: 1, hidden: mode(4) }),

    _send: sendButton('filtration', L('Pumpe & Heizung an Anlage senden', 'Send pump & heating to pool')),
    _hint: sendHint,
    x_res_filtration: resultBox('x_res_filtration'),
});
items.tabFiltration = { type: 'panel', label: L('Pumpe & Heizung', 'Pump & heating'), items: f };

// ================================================================== Tab Licht
items.tabLight = {
    type: 'panel', label: L('Licht', 'Light'),
    items: {
        _nl: notLoadedBox,
        _autoload: autoLoad,
        d_l_mode: radio('d_l_mode', L('Lichtmodus', 'Light mode'), [
            { value: 0, label: L('Manuell', 'Manual') }, { value: 1, label: L('Auto (Zeitplan)', 'Auto (schedule)') }]),
        d_l_status: check('d_l_status', L('Licht an', 'Light on'), { hidden: 'data.d_l_mode !== 0', newLine: true }),
        d_l_from: time('d_l_from', L('Ein um', 'On at'), { hidden: 'data.d_l_mode !== 1', newLine: true }),
        d_l_to: time('d_l_to', L('Aus um', 'Off at'), { hidden: 'data.d_l_mode !== 1' }),
        d_l_freq: select('d_l_freq', L('Wiederholung', 'Repeat'), FREQ_OPTS, { hidden: 'data.d_l_mode !== 1' }),
        _send: sendButton('light', L('Licht an Anlage senden', 'Send light to pool')),
        _hint: sendHint,
        x_res_light: resultBox('x_res_light'),
    },
};

// ================================================================== Tab Relais
const USE_OPTS = [['', '– nicht belegt / frei –', '– unused –'], ['heatpump', 'Wärmepumpe', 'Heat pump'], ['light', 'Beleuchtung', 'Lighting'],
    ['counterflow', 'Gegenstromanlage', 'Counter-current'], ['feature', 'Wasserattraktion (Fontäne, Wasserfall)', 'Water feature'],
    ['dosing', 'Dosierung', 'Dosing'], ['cover', 'Abdeckung', 'Cover'], ['other', 'Sonstiges', 'Other']].map(([value, de, en]) => ({ value, label: L(de, en) }));
const SIGNAL_OPTS = [[0, 'Abdeckung', 'Cover'], [1, 'Durchfluss FL1', 'Flow FL1'], [2, 'Durchfluss FL2', 'Flow FL2'], [3, 'Slave'], [4, 'Tank 1'], [5, 'Tank 2'], [6, 'Stromschleife 1', 'Current loop 1'], [7, 'Stromschleife 2', 'Current loop 2']]
    .map(([value, de, en]) => ({ value, label: L(de, en) }));
const r = {
    _nl: notLoadedBox,
    _autoload: autoLoad,
    _intro: info(L('„Verwendung“ ist nur für ioBroker (Objektnamen) und wird mit „Speichern“ übernommen. Name und Modus liegen in der Steuerung und gehen mit „An Anlage senden“.', '“Usage” is ioBroker-only and is stored with “Save”. Name and mode live in the controller.')),
};
const RM = n => `data.d_r${n}_mode`;
for (const n of [1, 2, 3, 4]) {
    const gone = `data.x_relays < ${n}`;
    r[`_h${n}`] = header(L(`AUX ${n}`), { hidden: gone, size: 3 });
    r[`relayUse${n}`] = { type: 'select', label: L('Verwendung (ioBroker)', 'Usage (ioBroker)'), options: USE_OPTS, ...W3, newLine: true, hidden: and(NOT_LOADED, gone) };
    r[`d_r${n}_name`] = dev(`d_r${n}_name`, { type: 'text', label: L('Name in der Steuerung', 'Name in controller'), maxLength: 10, ...W3, hidden: gone, help: L('max. 10 Zeichen', 'max. 10 characters') });
    r[`d_r${n}_mode`] = radio(`d_r${n}_mode`, L('Modus', 'Mode'), [
        { value: 0, label: L('Manuell', 'Manual') }, { value: 1, label: L('Auto (Zeitplan)', 'Auto (schedule)') },
        { value: 2, label: L('Tempo (Laufzeit)', 'Timer') }, { value: 3, label: L('Gekoppelt (Signal)', 'Linked') },
        { value: 4, label: L('Gekoppelt + Zeitplan', 'Linked + schedule') }], { hidden: gone });
    r[`d_r${n}_onoff`] = check(`d_r${n}_onoff`, L('Relais an', 'Relay on'), { hidden: and(gone, `${RM(n)} !== 0`), newLine: true });
    r[`d_r${n}_from`] = time(`d_r${n}_from`, L('Fenster 1 von', 'Window 1 from'), { hidden: and(gone, `![1,4].includes(${RM(n)})`), newLine: true });
    r[`d_r${n}_to`] = time(`d_r${n}_to`, L('bis', 'to'), { hidden: and(gone, `![1,4].includes(${RM(n)})`) });
    r[`d_r${n}_freq`] = select(`d_r${n}_freq`, L('Wiederholung', 'Repeat'), FREQ_OPTS, { hidden: and(gone, `![1,4].includes(${RM(n)})`) });
    r[`d_r${n}_from2`] = time(`d_r${n}_from2`, L('Fenster 2 von', 'Window 2 from'), { hidden: and(gone, `${RM(n)} !== 1`), newLine: true });
    r[`d_r${n}_to2`] = time(`d_r${n}_to2`, L('bis', 'to'), { hidden: and(gone, `${RM(n)} !== 1`) });
    r[`d_r${n}_freq2`] = select(`d_r${n}_freq2`, L('Wiederholung', 'Repeat'), FREQ_OPTS, { hidden: and(gone, `${RM(n)} !== 1`) });
    r[`d_r${n}_tempo`] = num(`d_r${n}_tempo`, L('Laufzeit', 'Run time'), { unit: 'min', min: 0, max: 180, step: 1, hidden: and(gone, `${RM(n)} !== 2`), newLine: true });
    r[`d_r${n}_key`] = select(`d_r${n}_key`, L('Auslöser (Taster)', 'Trigger key'), [{ value: 0, label: L('keiner', 'none') }, { value: 1, label: L('Taster (+)', 'Key (+)') }, { value: 2, label: L('Taster (−)', 'Key (−)') }], { hidden: and(gone, `${RM(n)} !== 2`) });
    r[`d_r${n}_signal`] = select(`d_r${n}_signal`, L('Gekoppelt an', 'Linked to'), SIGNAL_OPTS, { hidden: and(gone, `![3,4].includes(${RM(n)})`), newLine: true });
    r[`d_r${n}_delay`] = num(`d_r${n}_delay`, L('Verzögerung', 'Delay'), { unit: 's', min: 0, max: 30, step: 1, hidden: and(gone, `![3,4].includes(${RM(n)})`) });
    r[`d_r${n}_polarity`] = select(`d_r${n}_polarity`, L('Kontakt', 'Contact'), [{ value: 0, label: L('Öffner', 'Normally open') }, { value: 1, label: L('Schließer', 'Normally closed') }], { hidden: and(gone, `![3,4].includes(${RM(n)})`) });
    r[`_send${n}`] = sendButton(`relay${n}`, L(`AUX ${n} an Anlage senden`, `Send AUX ${n} to pool`), { hidden: gone });
    r[`x_res_relay${n}`] = resultBox(`x_res_relay${n}`);
}
r._hint = sendHint;
items.tabRelays = { type: 'panel', label: L('Relais', 'Relays'), items: r };

// ================================================================== Tab Wasserpflege
const noHidro = '!data.x_hasHidro';
items.tabWater = {
    type: 'panel', label: L('Wasserpflege', 'Water care'),
    items: {
        _nl: notLoadedBox,
        _autoload: autoLoad,
        _hHidro: header(L('Hydrolyse / Elektrolyse', 'Hydrolysis / electrolysis'), { hidden: noHidro }),
        d_h_levelPct: num('d_h_levelPct', L('Produktion', 'Output'), { unit: '%', min: 0, max: 100, step: 1, newLine: true, hidden: and(noHidro, "data.x_hidroUnit !== '%'") }),
        d_h_levelGh: num('d_h_levelGh', L('Produktion', 'Output'), { unit: 'g/h', min: 0, max: 100, step: 1, newLine: true, hidden: and(noHidro, "data.x_hidroUnit === '%'"),
            validator: 'data.d_h_levelGh <= data.x_hidroMax', validatorErrorText: 'Above the cell maximum' }),
        d_h_cover: check('d_h_cover', L('Abdeckung erkennen', 'Detect cover'), { hidden: noHidro, newLine: true, help: L('Produktion wird reduziert, solange die Abdeckung geschlossen ist.', 'Output is reduced while the cover is closed.') }),
        d_h_reduction: num('d_h_reduction', L('Reduktion bei Abdeckung', 'Reduction with cover'), { unit: '%', min: 1, max: 100, step: 1, hidden: and(noHidro, '!data.d_h_cover') }),
        d_h_shock: check('d_h_shock', L('Boost (Schockchlorung)', 'Boost (shock)'), { hidden: noHidro, newLine: true }),
        boostPauseControl: { type: 'checkbox', label: L('Redox-/Chlorregelung während Boost pausieren', 'Pause redox/chlorine control during boost'), ...W,
            hidden: and(NOT_LOADED, noHidro, '!data.d_h_shock', '!data.x_hasRX && !data.x_hasCL'),
            help: L('Wie die Rückfrage in der Web-App. Wird mit „Speichern“ übernommen.', 'Like the question in the web app. Stored with “Save”.') },
        d_h_tempValue: num('d_h_tempValue', L('Temperaturgrenze', 'Temperature limit'), { unit: '°C', min: 1, max: 100, step: 1, newLine: true, hidden: and(noHidro, '!data.x_hidroTemp') }),
        d_h_control: select('d_h_control', L('Produktion geregelt durch', 'Output controlled by'), [{ value: 0, label: L('Redox') }, { value: 1, label: L('Chlor', 'Chlorine') }], { newLine: true, hidden: and(noHidro, '!data.x_hidroControl') }),

        _hPh: header(L('pH'), { hidden: '!data.x_hasPH' }),
        d_ph_high: num('d_ph_high', L('pH-Sollwert', 'pH setpoint'), { min: 5, max: 9, step: 0.1, newLine: true, hidden: "!data.x_hasPH || data.x_phType === 'BASE'",
            help: L('Bei Säure-Dosierung: oberhalb dieses Werts wird dosiert.', 'Acid dosing above this value.') }),
        d_ph_low: num('d_ph_low', L('pH-Sollwert (Base)', 'pH setpoint (base)'), { min: 5, max: 9, step: 0.1, hidden: "!data.x_hasPH || data.x_phType === 'ACID'",
            help: L('Bei Base-Dosierung: unterhalb dieses Werts wird dosiert.', 'Base dosing below this value.') }),

        _hRx: header(L('Redox'), { hidden: '!data.x_hasRX' }),
        d_rx_set: num('d_rx_set', L('Redox-Sollwert', 'Redox setpoint'), { unit: 'mV', min: 0, max: 1000, step: 5, newLine: true, hidden: '!data.x_hasRX' }),
        _hCl: header(L('Chlor', 'Chlorine'), { hidden: '!data.x_hasCL' }),
        d_cl_set: num('d_cl_set', L('Chlor-Sollwert', 'Chlorine setpoint'), { unit: 'ppm', min: 0, max: 10, step: 0.05, newLine: true, hidden: '!data.x_hasCL' }),
        _hCd: header(L('Leitfähigkeit', 'Conductivity'), { hidden: '!data.x_hasCD' }),
        d_cd_set: num('d_cd_set', L('Leitfähigkeit-Sollwert', 'Conductivity setpoint'), { min: 0, max: 40000, step: 100, newLine: true, hidden: '!data.x_hasCD' }),

        _send: sendButton('water', L('Wasserpflege an Anlage senden', 'Send water care to pool')),
        _hint: sendHint,
        x_res_water: resultBox('x_res_water'),
    },
};

// ================================================================== Tab Rueckspuelung
const noBw = '!data.x_hasBackwash';
items.tabBackwash = {
    type: 'panel', label: L('Rückspülung', 'Backwash'),
    items: {
        _nl: notLoadedBox,
        _autoload: autoLoad,
        _none: { type: 'infoBox', boxType: 'info', closeable: false, newLine: true, xs: 12, sm: 12, md: 12, lg: 12, xl: 12,
            text: L('Diese Anlage hat keine automatische Rückspülung.', 'This pool has no automatic backwash.'), hidden: '!data.x_loaded || data.x_hasBackwash' },
        d_b_mode: radio('d_b_mode', L('Modus', 'Mode'), [{ value: 0, label: L('Manuell', 'Manual') }, { value: 1, label: L('Auto (Zeitplan)', 'Auto (schedule)') }], { hidden: noBw }),
        d_b_status: check('d_b_status', L('Rückspülung jetzt laufen lassen', 'Run backwash now'), { newLine: true, hidden: and(noBw, 'data.d_b_mode !== 0') }),
        d_b_start: time('d_b_start', L('Startzeit', 'Start time'), { newLine: true, hidden: and(noBw, 'data.d_b_mode !== 1') }),
        d_b_interval: num('d_b_interval', L('Dauer', 'Duration'), { unit: 's', min: 0, max: 3600, step: 10, hidden: and(noBw, 'data.d_b_mode !== 1') }),
        d_b_freq: select('d_b_freq', L('Wiederholung', 'Repeat'), FREQ_OPTS, { hidden: and(noBw, 'data.d_b_mode !== 1') }),
        _send: sendButton('backwash', L('Rückspülung an Anlage senden', 'Send backwash to pool'), { hidden: noBw }),
        x_res_backwash: resultBox('x_res_backwash'),
    },
};

// ------------------------------------------------------------------ Schreiben
const config = { type: 'tabs', i18n: false, items }; // texts are inline ({ de, en })
const out = path.join(__dirname, '..', 'admin', 'jsonConfig.json');
fs.writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`geschrieben: ${out}`);
