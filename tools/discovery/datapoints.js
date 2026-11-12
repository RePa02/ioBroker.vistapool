'use strict';
/**
 * Datenpunkt-Katalog fuer Vistapool / Hayward AquaRite / Sugar Valley.
 *
 * Abgeleitet aus:
 *  - Home Assistant Core, Integration "vistapool" (2026.11.1)
 *  - aioaquarite 0.13.1 (MIT, https://github.com/fdebrus/aioaquarite)
 *
 * Dieser Katalog wird spaeter 1:1 im ioBroker-Adapter verwendet.
 *
 * Felder:
 *  id      Objekt-ID im Adapter (relativ zum Pool-Channel)
 *  path    Pfad im Firestore-Dokument pools/{poolId}
 *  name    { de, en }
 *  type    ioBroker common.type: number | boolean | string
 *  role    ioBroker common.role
 *  unit    Einheit (optional)
 *  scale   Rohwert / scale = Anzeigewert (Default 1)
 *  write   true = steuerbar (sendPoolCommand)
 *  min/max/step  fuer schreibbare Zahlen (Anzeigewerte)
 *  states  Werteliste { rohwert: label } fuer Auswahlfelder
 *  conv    Sonderkonvertierung: 'timeOfDay' (Sekunden seit 0 Uhr <-> "HH:MM"),
 *          'bool01' (0/1 <-> false/true)
 *  exists  Pfad(e), die truthy sein muessen, damit der State angelegt wird
 *  orPaths zusaetzliche Lesepfade, die per ODER verknuepft werden
 *  writeMulti  feste Mehrfach-Schreibwerte je Auswahl (z. B. Lichtmodus)
 *  source  'ha' = in HA produktiv genutzt, 'lib' = nur im Typmodell der
 *          Bibliothek bekannt (Bedeutung noch zu verifizieren)
 */

const SPEED = { 0: 'slow', 1: 'medium', 2: 'high' };

const dp = [
    // ---------------------------------------------------------------- Messwerte
    { id: 'measure.temperature', path: 'main.temperature', name: { de: 'Wassertemperatur', en: 'Water temperature' }, type: 'number', role: 'value.temperature', unit: '°C', source: 'ha' },
    { id: 'measure.ph', path: 'modules.ph.current', name: { de: 'pH-Wert', en: 'pH' }, type: 'number', role: 'value', scale: 100, exists: 'main.hasPH', source: 'ha' },
    { id: 'measure.redox', path: 'modules.rx.current', name: { de: 'Redoxpotential', en: 'Redox potential' }, type: 'number', role: 'value.voltage', unit: 'mV', exists: 'main.hasRX', source: 'ha' },
    { id: 'measure.chlorine', path: 'modules.cl.current', name: { de: 'Chlor', en: 'Chlorine' }, type: 'number', role: 'value', unit: 'ppm', scale: 100, exists: 'main.hasCL', source: 'ha' },
    { id: 'measure.conductivity', path: 'modules.cd.current', name: { de: 'Leitfähigkeit', en: 'Conductivity' }, type: 'number', role: 'value', scale: 100, exists: 'main.hasCD', source: 'ha' },
    { id: 'measure.uv', path: 'modules.uv.current', name: { de: 'UV', en: 'UV' }, type: 'number', role: 'value', scale: 100, exists: 'main.hasUV', source: 'ha' },
    { id: 'measure.electrolysis', path: 'hidro.current', name: { de: 'Elektrolyse/Hydrolyse Produktion', en: 'Electrolysis/hydrolysis output' }, type: 'number', role: 'value', unit: 'g/h', scale: 10, exists: 'main.hasHidro', source: 'ha' },
    { id: 'measure.intelTime', path: 'filtration.intel.time', name: { de: 'Intelligente Filterzeit', en: 'Intel filtration time' }, type: 'number', role: 'value.interval', unit: 'min', source: 'ha' },
    { id: 'info.rssi', path: 'main.RSSI', name: { de: 'WLAN-Signalstärke', en: 'Wi-Fi signal' }, type: 'number', role: 'value', unit: 'dBm', source: 'ha' },

    // ---------------------------------------------------------------- Status (nur lesen)
    { id: 'status.filtration', path: 'filtration.status', name: { de: 'Filtration läuft', en: 'Filtration running' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', source: 'ha' },
    { id: 'status.backwash', path: 'backwash.status', name: { de: 'Rückspülung läuft', en: 'Backwash running' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', source: 'ha' },
    { id: 'status.heating', path: 'relays.filtration.heating.status', name: { de: 'Heizung läuft', en: 'Heating running' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', source: 'ha' },
    { id: 'status.chlorinePump', path: 'modules.cl.pump_status', name: { de: 'Chlorpumpe', en: 'Chlorine pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', exists: 'main.hasCL', source: 'ha' },
    { id: 'status.redoxPump', path: 'modules.rx.pump_status', name: { de: 'Redox-Pumpe', en: 'Redox pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', exists: 'main.hasRX', source: 'ha' },
    { id: 'status.phAcidPump', path: 'modules.ph.pump_high_on', name: { de: 'pH-Säure-Pumpe', en: 'pH acid pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', exists: 'main.hasPH', source: 'ha' },
    { id: 'status.phBasePump', path: 'modules.ph.pump_low_on', name: { de: 'pH-Basen-Pumpe', en: 'pH base pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', exists: 'main.hasPH', source: 'ha' },
    { id: 'status.coverReduction', path: 'hidro.cover', name: { de: 'Abdeckungs-Reduktion aktiv', en: 'Cover reduction active' }, type: 'boolean', role: 'indicator', conv: 'bool01', exists: 'main.hasHidro', source: 'ha' },

    // ---------------------------------------------------------------- Alarme
    { id: 'alarm.hidroFlow', path: 'hidro.fl1', name: { de: 'Durchflussalarm Zelle', en: 'Cell flow alarm' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasHidro', source: 'ha' },
    { id: 'alarm.hidroFl2', path: 'hidro.fl2', name: { de: 'Alarm FL2', en: 'FL2 alarm' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: ['main.hasHidro', 'main.hasCL'], source: 'ha' },
    { id: 'alarm.hidroLow', path: 'hidro.low', name: { de: 'Elektrolyse zu gering', en: 'Electrolysis low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasHidro', source: 'ha' },
    { id: 'alarm.phPump', path: 'modules.ph.al3', name: { de: 'pH-Pumpenalarm', en: 'pH pump alarm' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasPH', source: 'ha' },
    { id: 'alarm.tankPh', path: 'modules.ph.tank', name: { de: 'Tank pH leer', en: 'pH tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasPH', source: 'ha' },
    { id: 'alarm.tankRx', path: 'modules.rx.tank', name: { de: 'Tank Redox leer', en: 'Redox tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasRX', source: 'ha' },
    { id: 'alarm.tankCl', path: 'modules.cl.tank', name: { de: 'Tank Chlor leer', en: 'Chlorine tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasCL', source: 'ha' },
    { id: 'alarm.tankCd', path: 'modules.cd.tank', name: { de: 'Tank Leitfähigkeit leer', en: 'Conductivity tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', exists: 'main.hasCD', source: 'ha' },

    // ---------------------------------------------------------------- Filtration (steuerbar)
    { id: 'filtration.on', path: 'filtration.status', name: { de: 'Filtration ein/aus', en: 'Filtration on/off' }, type: 'boolean', role: 'switch', conv: 'bool01', write: true, source: 'ha' },
    { id: 'filtration.mode', path: 'filtration.mode', name: { de: 'Pumpenmodus', en: 'Pump mode' }, type: 'number', role: 'level.mode', write: true, states: { 0: 'manual', 1: 'auto', 2: 'heat', 3: 'smart', 4: 'intel' }, source: 'ha' },
    { id: 'filtration.speed', path: 'filtration.manVel', name: { de: 'Pumpendrehzahl (manuell)', en: 'Pump speed (manual)' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.timer1Speed', path: 'filtration.timerVel1', name: { de: 'Drehzahl Zeitfenster 1', en: 'Timer 1 speed' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.timer2Speed', path: 'filtration.timerVel2', name: { de: 'Drehzahl Zeitfenster 2', en: 'Timer 2 speed' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.timer3Speed', path: 'filtration.timerVel3', name: { de: 'Drehzahl Zeitfenster 3', en: 'Timer 3 speed' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.interval1Start', path: 'filtration.interval1.from', name: { de: 'Zeitfenster 1 Start', en: 'Interval 1 start' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'filtration.interval1End', path: 'filtration.interval1.to', name: { de: 'Zeitfenster 1 Ende', en: 'Interval 1 end' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'filtration.interval2Start', path: 'filtration.interval2.from', name: { de: 'Zeitfenster 2 Start', en: 'Interval 2 start' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'filtration.interval2End', path: 'filtration.interval2.to', name: { de: 'Zeitfenster 2 Ende', en: 'Interval 2 end' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'filtration.interval3Start', path: 'filtration.interval3.from', name: { de: 'Zeitfenster 3 Start', en: 'Interval 3 start' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'filtration.interval3End', path: 'filtration.interval3.to', name: { de: 'Zeitfenster 3 Ende', en: 'Interval 3 end' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'filtration.intelTemp', path: 'filtration.intel.temp', name: { de: 'Intel-Temperatur', en: 'Intel temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 5, max: 40, step: 1, write: true, source: 'ha' },

    // ---------------------------------------------------------------- Heizung / Smart (steuerbar)
    { id: 'heating.climate', path: 'filtration.heating.clima', name: { de: 'Heizungsklima', en: 'Heating climate' }, type: 'boolean', role: 'switch', conv: 'bool01', write: true, exists: 'filtration.hasHeat', source: 'ha' },
    { id: 'heating.tempMin', path: 'filtration.heating.temp', name: { de: 'Heizung Mindesttemperatur', en: 'Heating min temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 5, max: 40, step: 1, write: true, exists: 'filtration.hasHeat', source: 'ha' },
    { id: 'heating.tempMax', path: 'filtration.heating.tempHi', name: { de: 'Heizung Höchsttemperatur', en: 'Heating max temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 5, max: 40, step: 1, write: true, exists: 'filtration.hasHeat', source: 'ha' },
    { id: 'smart.freeze', path: 'filtration.smart.freeze', name: { de: 'Smart-Modus Frostschutz', en: 'Smart mode freeze' }, type: 'boolean', role: 'switch', conv: 'bool01', write: true, exists: 'filtration.hasSmart', source: 'ha' },
    { id: 'smart.tempMin', path: 'filtration.smart.tempMin', name: { de: 'Smart Mindesttemperatur', en: 'Smart min temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 5, max: 40, step: 1, write: true, exists: 'filtration.hasSmart', source: 'ha' },
    { id: 'smart.tempMax', path: 'filtration.smart.tempHigh', name: { de: 'Smart Höchsttemperatur', en: 'Smart max temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 5, max: 40, step: 1, write: true, exists: 'filtration.hasSmart', source: 'ha' },

    // ---------------------------------------------------------------- Elektrolyse / Hydrolyse (steuerbar)
    { id: 'electrolysis.setpoint', path: 'hidro.level', name: { de: 'Elektrolyse-Sollwert', en: 'Electrolysis setpoint' }, type: 'number', role: 'level', unit: 'g/h', scale: 10, min: 0, max: 50, maxPath: 'hidro.maxAllowedValue', step: 0.1, write: true, exists: 'main.hasHidro', source: 'ha' },
    { id: 'electrolysis.boost', path: 'hidro.cloration_enabled', name: { de: 'Elektrolyse-Boost', en: 'Electrolysis boost' }, type: 'boolean', role: 'switch', conv: 'bool01', write: true, exists: 'main.hasHidro', note: 'Schreiben setzt zusaetzlich hidro.reduction=wert und hidro.disable=1 (wie Web-App)', source: 'ha' },
    { id: 'electrolysis.cover', path: 'hidro.cover_enabled', name: { de: 'Abdeckungs-Erkennung', en: 'Cover detection' }, type: 'boolean', role: 'switch', conv: 'bool01', write: true, exists: 'main.hasHidro', source: 'ha' },

    // ---------------------------------------------------------------- Sollwerte Dosierung (steuerbar)
    { id: 'setpoint.redox', path: 'modules.rx.status.value', name: { de: 'Redox-Sollwert', en: 'Redox setpoint' }, type: 'number', role: 'level', unit: 'mV', min: 500, max: 800, step: 1, write: true, exists: 'main.hasRX', source: 'ha' },
    { id: 'setpoint.phMin', path: 'modules.ph.status.low_value', name: { de: 'pH-Minimum', en: 'pH minimum' }, type: 'number', role: 'level', scale: 100, min: 6, max: 8, step: 0.01, write: true, exists: 'main.hasPH', source: 'ha' },
    { id: 'setpoint.phMax', path: 'modules.ph.status.high_value', name: { de: 'pH-Maximum', en: 'pH maximum' }, type: 'number', role: 'level', scale: 100, min: 6, max: 8, step: 0.01, write: true, exists: 'main.hasPH', source: 'ha' },

    // ---------------------------------------------------------------- Relais AUX 1-4 (steuerbar)
    ...[1, 2, 3, 4].map(i => ({
        id: `relay.aux${i}`, path: `relays.relay${i}.info.onoff`, orPaths: [`relays.relay${i}.info.status`],
        name: { de: `Relais ${i}`, en: `Relay ${i}` }, type: 'boolean', role: 'switch', conv: 'bool01', write: true, source: 'ha',
    })),

    // ---------------------------------------------------------------- Licht (steuerbar)
    { id: 'light.on', path: 'light.status', name: { de: 'Licht ein/aus', en: 'Light on/off' }, type: 'boolean', role: 'switch.light', conv: 'bool01', write: true, source: 'ha' },
    { id: 'light.mode', path: 'light.mode', name: { de: 'Beleuchtungsmodus', en: 'Light mode' }, type: 'string', role: 'level.mode', write: true, states: { off: 'off', on: 'on', auto: 'auto' },
        writeMulti: { off: { 'light.mode': 0, 'light.status': 0 }, on: { 'light.mode': 0, 'light.status': 1 }, auto: { 'light.mode': 1 } }, source: 'ha' },
    { id: 'light.scheduleStart', path: 'light.from', name: { de: 'Beleuchtungsplan Start', en: 'Light schedule start' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'light.scheduleEnd', path: 'light.to', name: { de: 'Beleuchtungsplan Ende', en: 'Light schedule end' }, type: 'string', role: 'text', conv: 'timeOfDay', write: true, source: 'ha' },
    { id: 'light.scheduleFrequency', path: 'light.freq', name: { de: 'Beleuchtungsplan Frequenz', en: 'Light schedule frequency' }, type: 'number', role: 'level', write: true, states: { 86400: 'daily', 604800: 'weekly' }, source: 'ha' },

    // ---------------------------------------------------------------- Buttons
    { id: 'button.syncTime', path: 'main.localTime', name: { de: 'Uhrzeit synchronisieren', en: 'Sync controller clock' }, type: 'boolean', role: 'button', write: true, action: 'syncTime', note: 'Schreibt lokale Wanduhrzeit als Epoch-Sekunden (lokal als UTC kodiert)', source: 'ha' },
    { id: 'button.ledNext', path: 'light.status', name: { de: 'LED nächste Farbe', en: 'LED next colour' }, type: 'boolean', role: 'button', write: true, action: 'ledPulse', exists: 'main.hasLED', note: 'Licht an: status 0, 1 s warten, status 1. Licht aus: nur einschalten', source: 'ha' },

    // ---------------------------------------------------------------- Modul-Ausstattung (Info)
    ...[['hasPH', 'pH'], ['hasRX', 'Redox'], ['hasCL', 'Chlor'], ['hasCD', 'Leitfähigkeit'], ['hasUV', 'UV'], ['hasIO', 'E/A'], ['hasHidro', 'Elektrolyse'], ['hasLED', 'LED'], ['hasBackwash', 'Rückspülung']]
        .map(([k, de]) => ({ id: `modules.${k}`, path: `main.${k}`, name: { de: `Modul ${de} vorhanden`, en: `${k} module` }, type: 'boolean', role: 'indicator', conv: 'bool01', source: 'ha' })),

    // ---------------------------------------------------------------- Zusatzwerte aus dem Typmodell (zu verifizieren)
    { id: 'info.firmware', path: 'main.version', name: { de: 'Firmware Steuerung', en: 'Controller firmware' }, type: 'number', role: 'info.firmware', source: 'lib' },
    { id: 'info.wifiFirmware', path: 'main.wifiVersion', name: { de: 'Firmware WLAN-Modul', en: 'Wi-Fi module firmware' }, type: 'number', role: 'info.firmware', source: 'lib' },
    { id: 'info.present', path: 'present', name: { de: 'Anlage online', en: 'Controller online' }, type: 'boolean', role: 'indicator.reachable', conv: 'bool01', source: 'lib' },
    { id: 'info.updatedAt', path: 'updatedAt', name: { de: 'Letzte Aktualisierung (Cloud)', en: 'Last cloud update' }, type: 'number', role: 'value.time', source: 'lib' },
    { id: 'info.controllerTime', path: 'main.localTime', name: { de: 'Uhrzeit der Steuerung', en: 'Controller clock' }, type: 'number', role: 'value.time', source: 'lib' },
    { id: 'electrolysis.isElectrolysis', path: 'hidro.is_electrolysis', name: { de: 'Elektrolyse (statt Hydrolyse)', en: 'Electrolysis (not hydrolysis)' }, type: 'boolean', role: 'indicator', conv: 'bool01', exists: 'main.hasHidro', source: 'ha' },
    { id: 'electrolysis.maxAllowed', path: 'hidro.maxAllowedValue', name: { de: 'Elektrolyse max. zulässig', en: 'Electrolysis max allowed' }, type: 'number', role: 'value', unit: 'g/h', scale: 10, exists: 'main.hasHidro', source: 'lib' },
    { id: 'electrolysis.cellTotalTime', path: 'hidro.cellTotalTime', name: { de: 'Zelle Betriebszeit gesamt', en: 'Cell total runtime' }, type: 'number', role: 'value', exists: 'main.hasHidro', source: 'lib' },
    { id: 'electrolysis.cellPartialTime', path: 'hidro.cellPartialTime', name: { de: 'Zelle Betriebszeit partiell', en: 'Cell partial runtime' }, type: 'number', role: 'value', exists: 'main.hasHidro', source: 'lib' },
    { id: 'backwash.mode', path: 'backwash.mode', name: { de: 'Rückspülung Modus', en: 'Backwash mode' }, type: 'number', role: 'value', source: 'lib' },
    { id: 'backwash.interval', path: 'backwash.interval', name: { de: 'Rückspülung Dauer', en: 'Backwash duration' }, type: 'number', role: 'value', source: 'lib' },
    { id: 'backwash.frequency', path: 'backwash.frequency', name: { de: 'Rückspülung Frequenz', en: 'Backwash frequency' }, type: 'number', role: 'value', source: 'lib' },
    { id: 'backwash.remainingTime', path: 'backwash.remainingTime', name: { de: 'Rückspülung Restzeit', en: 'Backwash remaining' }, type: 'number', role: 'value', source: 'lib' },
];

/** Sensible Felder, die in Dumps maskiert werden. */
const SENSITIVE_KEYS = /^(email|mail|phone|tel|telephone|address|street|city|zip|zipcode|postal|postalCode|cp|lat|lng|lon|latitude|longitude|name|names|owner|owners|user|users|userId|uid|wifi|gateway|serial|serialNumber|mac|ip|token|password|nif|dni|installer|company_name|contact|id|fcmtoken)$/i;

module.exports = { datapoints: dp, SENSITIVE_KEYS };
