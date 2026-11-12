'use strict';
/**
 * Datenpunkt-Katalog fuer Vistapool / Hayward AquaRite / Sugar Valley.
 *
 * Quellen:
 *  - Home Assistant Core, Integration "vistapool" (2026.11.1)        source: 'ha'
 *  - aioaquarite 0.13.1 (MIT, https://github.com/fdebrus/aioaquarite) source: 'lib'
 *  - Beobachtung an einer echten Anlage (Watch-Protokoll Phase 0)     source: 'observed'
 *  - Einstellmasken der Vistapool-Web-App (hayward-europe.web.app)    source: 'webapp'
 *
 * Felder:
 *  id       Objekt-ID relativ zum Pool-Device
 *  path     Pfad im Firestore-Dokument pools/{poolId}
 *  name     { de, en }
 *  type     number | boolean | string
 *  role     ioBroker-Rolle
 *  unit     Einheit; 'hidro' = dynamisch aus hidro.measure (% oder g/h)
 *  scale    Rohwert / scale = Anzeigewert
 *  write    steuerbar
 *  min/max/step   Grenzen fuer Anzeigewerte
 *  maxPath  Pfad, dessen Wert (skaliert) das Maximum liefert
 *  states   { rohwert: label }
 *  conv     'bool01' | 'timeOfDay' | 'text'
 *  range    [min, max] erlaubter ROHwert (Plausibilitaet gegen Transienten)
 *  exists   Pfad(e), die vorhanden/truthy sein muessen
 *  orPaths  zusaetzliche Lesepfade (ODER)
 *  writeMulti  feste Mehrfach-Schreibwerte je Auswahl
 *  action   Sonderaktion fuer Buttons
 */

const SPEED = { 0: 'slow', 1: 'medium', 2: 'high' };
const DAY = [0, 86400];
const B = [0, 1];
const FREQ_STATES = { 86400: 'täglich', 172800: 'alle 2 Tage', 259200: 'alle 3 Tage', 345600: 'alle 4 Tage', 432000: 'alle 5 Tage', 604800: 'wöchentlich', 1209600: 'alle 2 Wochen', 1814400: 'alle 3 Wochen', 2419200: 'alle 4 Wochen' };
const RELAY_MODES = { 0: 'manual', 1: 'auto', 2: 'tempo', 3: 'linked', 4: 'linked_auto' };

const dp = [
    // ---------------------------------------------------------------- Messwerte
    { id: 'measure.temperature', path: 'main.temperature', name: { de: 'Wassertemperatur', en: 'Water temperature' }, type: 'number', role: 'value.temperature', unit: '°C', range: [-20, 60], source: 'ha' },
    { id: 'measure.ph', path: 'modules.ph.current', name: { de: 'pH-Wert', en: 'pH' }, type: 'number', role: 'value', scale: 100, range: [0, 1400], exists: 'main.hasPH', source: 'ha' },
    { id: 'measure.redox', path: 'modules.rx.current', name: { de: 'Redoxpotential', en: 'Redox potential' }, type: 'number', role: 'value.voltage', unit: 'mV', range: [0, 2000], exists: 'main.hasRX', source: 'ha' },
    { id: 'measure.chlorine', path: 'modules.cl.current', name: { de: 'Chlor', en: 'Chlorine' }, type: 'number', role: 'value', unit: 'ppm', scale: 100, exists: 'main.hasCL', source: 'ha' },
    { id: 'measure.conductivity', path: 'modules.cd.current', name: { de: 'Leitfähigkeit', en: 'Conductivity' }, type: 'number', role: 'value', scale: 100, exists: 'main.hasCD', source: 'ha' },
    { id: 'measure.uv', path: 'modules.uv.current', name: { de: 'UV', en: 'UV' }, type: 'number', role: 'value', scale: 100, exists: 'main.hasUV', source: 'ha' },
    { id: 'measure.electrolysis', path: 'hidro.current', name: { de: 'Elektrolyse/Hydrolyse Produktion', en: 'Electrolysis/hydrolysis output' }, type: 'number', role: 'value', unit: 'hidro', scale: 10, exists: 'main.hasHidro', source: 'ha' },

    // ---------------------------------------------------------------- Status
    { id: 'status.filtration', path: 'filtration.status', name: { de: 'Filtration läuft', en: 'Filtration running' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, source: 'ha' },
    { id: 'status.backwash', path: 'backwash.status', name: { de: 'Rückspülung läuft', en: 'Backwash running' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, exists: 'main.hasBackwash', source: 'ha' },
    { id: 'status.heating', path: 'relays.filtration.heating.status', name: { de: 'Heizung läuft', en: 'Heating running' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, source: 'ha' },
    { id: 'status.chlorinePump', path: 'modules.cl.pump_status', name: { de: 'Chlorpumpe', en: 'Chlorine pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, exists: 'main.hasCL', source: 'ha' },
    { id: 'status.redoxPump', path: 'modules.rx.pump_status', name: { de: 'Redox-Pumpe', en: 'Redox pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, exists: 'main.hasRX', source: 'ha' },
    { id: 'status.phAcidPump', path: 'modules.ph.pump_high_on', name: { de: 'pH-Säure-Pumpe', en: 'pH acid pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, exists: 'main.hasPH', source: 'ha' },
    { id: 'status.phBasePump', path: 'modules.ph.pump_low_on', name: { de: 'pH-Basen-Pumpe', en: 'pH base pump' }, type: 'boolean', role: 'indicator.working', conv: 'bool01', range: B, exists: 'main.hasPH', source: 'ha' },
    { id: 'status.coverReduction', path: 'hidro.cover', name: { de: 'Abdeckungs-Reduktion aktiv', en: 'Cover reduction active' }, type: 'boolean', role: 'indicator', conv: 'bool01', range: B, exists: 'main.hasHidro', source: 'ha' },
    { id: 'status.ioRaw', path: 'modules.io.status', name: { de: 'E/A-Status (Bitfeld)', en: 'I/O status (bitfield)' }, type: 'number', role: 'value', source: 'observed' },

    // ---------------------------------------------------------------- Alarme
    { id: 'alarm.hidroFlow', path: 'hidro.fl1', name: { de: 'Durchfluss Zelle (FL1)', en: 'Cell flow (FL1)' }, type: 'boolean', role: 'indicator', conv: 'bool01', range: B, exists: 'main.hasHidro', source: 'ha', note: 'Beobachtet: 1 bei laufender Filtration, 0 bei Stillstand' },
    { id: 'alarm.hidroFl2', path: 'hidro.fl2', name: { de: 'FL2', en: 'FL2' }, type: 'boolean', role: 'indicator', conv: 'bool01', range: B, exists: ['main.hasHidro', 'main.hasCL'], source: 'ha' },
    { id: 'alarm.hidroLow', path: 'hidro.low', name: { de: 'Elektrolyse zu gering', en: 'Electrolysis low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', range: B, exists: 'main.hasHidro', source: 'ha' },
    { id: 'alarm.phPump', path: 'modules.ph.al3', name: { de: 'pH-Pumpenalarm', en: 'pH pump alarm' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', range: B, exists: 'main.hasPH', source: 'ha' },
    { id: 'alarm.tankPh', path: 'modules.ph.tank', name: { de: 'Tank pH leer', en: 'pH tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', range: B, exists: 'main.hasPH', source: 'ha' },
    { id: 'alarm.tankRx', path: 'modules.rx.tank', name: { de: 'Tank Redox leer', en: 'Redox tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', range: B, exists: 'main.hasRX', source: 'ha' },
    { id: 'alarm.tankCl', path: 'modules.cl.tank', name: { de: 'Tank Chlor leer', en: 'Chlorine tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', range: B, exists: 'main.hasCL', source: 'ha' },
    { id: 'alarm.tankCd', path: 'modules.cd.tank', name: { de: 'Tank Leitfähigkeit leer', en: 'Conductivity tank low' }, type: 'boolean', role: 'indicator.alarm', conv: 'bool01', range: B, exists: 'main.hasCD', source: 'ha' },

    // ---------------------------------------------------------------- Filtration
    { id: 'filtration.on', path: 'filtration.status', name: { de: 'Filtration ein/aus', en: 'Filtration on/off' }, type: 'boolean', role: 'switch', conv: 'bool01', range: B, write: true, source: 'ha' },
    { id: 'filtration.mode', path: 'filtration.mode', name: { de: 'Pumpenmodus', en: 'Pump mode' }, type: 'number', role: 'level.mode', write: true, states: { 0: 'manual', 1: 'auto', 2: 'heat', 3: 'smart', 4: 'intel' }, source: 'ha' },
    { id: 'filtration.speed', path: 'filtration.manVel', name: { de: 'Pumpendrehzahl (manuell)', en: 'Pump speed (manual)' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.timer1Speed', path: 'filtration.timerVel1', name: { de: 'Drehzahl Zeitfenster 1', en: 'Timer 1 speed' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.timer2Speed', path: 'filtration.timerVel2', name: { de: 'Drehzahl Zeitfenster 2', en: 'Timer 2 speed' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    { id: 'filtration.timer3Speed', path: 'filtration.timerVel3', name: { de: 'Drehzahl Zeitfenster 3', en: 'Timer 3 speed' }, type: 'number', role: 'level', write: true, states: SPEED, source: 'ha' },
    ...[1, 2, 3].flatMap(i => [
        { id: `filtration.interval${i}Start`, path: `filtration.interval${i}.from`, name: { de: `Zeitfenster ${i} Start`, en: `Interval ${i} start` }, type: 'string', role: 'text', conv: 'timeOfDay', range: DAY, write: true, source: 'ha' },
        { id: `filtration.interval${i}End`, path: `filtration.interval${i}.to`, name: { de: `Zeitfenster ${i} Ende`, en: `Interval ${i} end` }, type: 'string', role: 'text', conv: 'timeOfDay', range: DAY, write: true, source: 'ha' },
    ]),
    { id: 'filtration.intelHours', path: 'filtration.intel.time', name: { de: 'Intel Filterstunden pro Tag', en: 'Intel filtration hours per day' }, type: 'number', role: 'level', unit: 'h', scale: 60, min: 2, max: 23, step: 1, range: [0, 1440], write: true, source: 'webapp' },
    { id: 'filtration.intelTemp', path: 'filtration.intel.temp', name: { de: 'Intel-Temperatur', en: 'Intel temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 1, max: 50, step: 1, range: [0, 60], write: true, source: 'ha' },
    { id: 'filtration.isVSP', path: 'pump.isVSP', name: { de: 'Drehzahlgeregelte Pumpe', en: 'Variable speed pump' }, type: 'boolean', role: 'indicator', conv: 'bool01', range: B, source: 'observed' },

    // ---------------------------------------------------------------- Heizung / Smart
    { id: 'heating.climate', path: 'filtration.heating.clima', name: { de: 'Heizung aktiv (Modus Heizen)', en: 'Heating enabled (heat mode)' }, type: 'boolean', role: 'switch', conv: 'bool01', range: B, write: true, exists: 'filtration.hasHeat', source: 'ha' },
    { id: 'heating.tempMin', path: 'filtration.heating.temp', name: { de: 'Heizung Soll-/Mindesttemperatur', en: 'Heating setpoint/min temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 0, max: 99, step: 1, range: [0, 60], write: true, exists: 'filtration.hasHeat', source: 'ha' },
    { id: 'heating.tempMax', path: 'filtration.heating.tempHi', name: { de: 'Heizung Höchsttemperatur', en: 'Heating max temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 0, max: 50, step: 1, range: [0, 60], write: true, exists: 'filtration.hasHeat', source: 'ha' },
    { id: 'smart.freeze', path: 'filtration.smart.freeze', name: { de: 'Smart-Modus Frostschutz', en: 'Smart mode freeze' }, type: 'boolean', role: 'switch', conv: 'bool01', range: B, write: true, exists: 'filtration.hasSmart', source: 'ha' },
    { id: 'smart.tempMin', path: 'filtration.smart.tempMin', name: { de: 'Smart Mindesttemperatur', en: 'Smart min temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 1, max: 50, step: 1, range: [0, 60], write: true, exists: 'filtration.hasSmart', source: 'ha' },
    { id: 'smart.tempMax', path: 'filtration.smart.tempHigh', name: { de: 'Smart Höchsttemperatur', en: 'Smart max temperature' }, type: 'number', role: 'level.temperature', unit: '°C', min: 1, max: 50, step: 1, range: [0, 60], write: true, exists: 'filtration.hasSmart', source: 'ha' },

    // ---------------------------------------------------------------- Elektrolyse / Hydrolyse
    { id: 'electrolysis.setpoint', path: 'hidro.level', name: { de: 'Elektrolyse/Hydrolyse Sollwert', en: 'Electrolysis/hydrolysis setpoint' }, type: 'number', role: 'level', unit: 'hidro', scale: 10, min: 0, max: 100, maxPath: 'hidro.maxAllowedValue', step: 1, write: true, exists: 'main.hasHidro', source: 'ha' },
    { id: 'electrolysis.boost', path: 'hidro.cloration_enabled', name: { de: 'Boost (Superchlorierung)', en: 'Boost' }, type: 'boolean', role: 'switch', conv: 'bool01', range: B, write: true, exists: 'main.hasHidro', source: 'ha', note: 'Jeder Hydrolyse-Befehl traegt hidro.disable (wie Web-App), siehe Instanz-Option' },
    { id: 'electrolysis.cover', path: 'hidro.cover_enabled', name: { de: 'Abdeckungs-Erkennung', en: 'Cover detection' }, type: 'boolean', role: 'switch', conv: 'bool01', range: B, write: true, exists: 'main.hasHidro', source: 'ha' },
    { id: 'electrolysis.reduction', path: 'hidro.reduction', name: { de: 'Reduktion bei Abdeckung', en: 'Cover reduction' }, type: 'number', role: 'level', unit: '%', min: 1, max: 100, step: 1, range: [0, 100], write: true, exists: 'main.hasHidro', source: 'webapp' },
    { id: 'electrolysis.controlBy', path: 'hidro.control', name: { de: 'Regelung durch', en: 'Controlled by' }, type: 'number', role: 'level.mode', states: { 0: 'Redox', 1: 'Chlor' }, write: true, exists: ['main.hasRX', 'main.hasCL', 'hidro.hasHidroControl'], source: 'webapp' },
    { id: 'electrolysis.isElectrolysis', path: 'hidro.is_electrolysis', name: { de: 'Elektrolyse (statt Hydrolyse)', en: 'Electrolysis (not hydrolysis)' }, type: 'boolean', role: 'indicator', conv: 'bool01', exists: 'main.hasHidro', source: 'ha' },
    { id: 'electrolysis.unit', path: 'hidro.measure', name: { de: 'Einheit Produktion', en: 'Output unit' }, type: 'string', role: 'text', conv: 'text', exists: 'main.hasHidro', source: 'observed' },
    { id: 'electrolysis.maxAllowed', path: 'hidro.maxAllowedValue', name: { de: 'Maximal zulässig', en: 'Max allowed' }, type: 'number', role: 'value', unit: 'hidro', scale: 10, exists: 'main.hasHidro', source: 'lib' },
    { id: 'electrolysis.cellTotalTime', path: 'hidro.cellTotalTime', name: { de: 'Zelle Betriebszeit gesamt', en: 'Cell total runtime' }, type: 'number', role: 'value', exists: 'main.hasHidro', source: 'lib' },
    { id: 'electrolysis.cellPartialTime', path: 'hidro.cellPartialTime', name: { de: 'Zelle Betriebszeit partiell', en: 'Cell partial runtime' }, type: 'number', role: 'value', exists: 'main.hasHidro', source: 'lib' },

    // ---------------------------------------------------------------- Sollwerte Dosierung
    { id: 'setpoint.redox', path: 'modules.rx.status.value', name: { de: 'Redox-Sollwert', en: 'Redox setpoint' }, type: 'number', role: 'level', unit: 'mV', min: 0, max: 1000, step: 1, range: [0, 2000], write: true, exists: 'main.hasRX', source: 'ha' },
    { id: 'setpoint.phLow', path: 'modules.ph.status.low_value', name: { de: 'pH-Sollwert Base (low)', en: 'pH setpoint base (low)' }, type: 'number', role: 'level', scale: 100, min: 6, max: 8, step: 0.01, range: [0, 1400], write: true, exists: 'main.hasPH', source: 'ha' },
    { id: 'setpoint.phHigh', path: 'modules.ph.status.high_value', name: { de: 'pH-Sollwert Säure (high)', en: 'pH setpoint acid (high)' }, type: 'number', role: 'level', scale: 100, min: 6, max: 8, step: 0.01, range: [0, 1400], write: true, exists: 'main.hasPH', source: 'ha' },
    { id: 'setpoint.phType', path: 'modules.ph.type', name: { de: 'pH-Regelung', en: 'pH dosing type' }, type: 'string', role: 'text', conv: 'text', exists: 'main.hasPH', source: 'observed' },

    // ---------------------------------------------------------------- Relais AUX 1-4
    ...[1, 2, 3, 4].flatMap(i => [
        { id: `relay.aux${i}`, path: `relays.relay${i}.info.onoff`, orPaths: [`relays.relay${i}.info.status`], name: { de: `Relais ${i}`, en: `Relay ${i}` }, type: 'boolean', role: 'switch', conv: 'bool01', range: B, write: true, exists: `relays.relay${i}.info`, source: 'ha' },
        { id: `relay.aux${i}Mode`, path: `relays.relay${i}.info.manAutoTemp`, name: { de: `Relais ${i} Modus`, en: `Relay ${i} mode` }, type: 'number', role: 'level.mode', states: RELAY_MODES, write: true, exists: `relays.relay${i}.info`, source: 'webapp' },
        { id: `relay.aux${i}Active`, path: `relays.relay${i}.info.status`, name: { de: `Relais ${i} Ausgang aktiv`, en: `Relay ${i} output active` }, type: 'boolean', role: 'indicator', conv: 'bool01', range: B, exists: `relays.relay${i}.info`, source: 'observed' },
        { id: `relay.aux${i}Start`, path: `relays.relay${i}.info.from`, name: { de: `Relais ${i} Zeitplan Start`, en: `Relay ${i} schedule start` }, type: 'string', role: 'text', conv: 'timeOfDay', range: [0, 172800], exists: `relays.relay${i}.info`, source: 'lib' },
        { id: `relay.aux${i}End`, path: `relays.relay${i}.info.to`, name: { de: `Relais ${i} Zeitplan Ende`, en: `Relay ${i} schedule end` }, type: 'string', role: 'text', conv: 'timeOfDay', range: [0, 172800], exists: `relays.relay${i}.info`, source: 'lib' },
        { id: `relay.aux${i}Name`, path: `relays.relay${i}.name`, name: { de: `Relais ${i} Name`, en: `Relay ${i} name` }, type: 'string', role: 'text', conv: 'text', exists: `relays.relay${i}.info`, source: 'observed' },
    ]),

    // ---------------------------------------------------------------- Licht
    { id: 'light.on', path: 'light.status', name: { de: 'Licht ein/aus', en: 'Light on/off' }, type: 'boolean', role: 'switch.light', conv: 'bool01', range: B, write: true, source: 'ha' },
    { id: 'light.mode', path: 'light.mode', name: { de: 'Beleuchtungsmodus', en: 'Light mode' }, type: 'string', role: 'level.mode', write: true, range: B, states: { off: 'off', on: 'on', auto: 'auto' },
        writeMulti: { off: { 'light.mode': 0, 'light.status': 0 }, on: { 'light.mode': 0, 'light.status': 1 }, auto: { 'light.mode': 1 } }, source: 'ha' },
    { id: 'light.scheduleStart', path: 'light.from', name: { de: 'Beleuchtungsplan Start', en: 'Light schedule start' }, type: 'string', role: 'text', conv: 'timeOfDay', range: DAY, write: true, source: 'ha' },
    { id: 'light.scheduleEnd', path: 'light.to', name: { de: 'Beleuchtungsplan Ende', en: 'Light schedule end' }, type: 'string', role: 'text', conv: 'timeOfDay', range: DAY, write: true, source: 'ha' },
    { id: 'light.scheduleFrequency', path: 'light.freq', name: { de: 'Beleuchtungsplan Wiederholung', en: 'Light schedule frequency' }, type: 'number', role: 'level', write: true, states: FREQ_STATES, source: 'webapp' },

    // ---------------------------------------------------------------- Buttons
    { id: 'button.syncTime', path: 'main.localTime', name: { de: 'Uhrzeit synchronisieren', en: 'Sync controller clock' }, type: 'boolean', role: 'button', write: true, action: 'syncTime', source: 'ha' },
    { id: 'button.ledNext', path: 'light.status', name: { de: 'LED nächste Farbe', en: 'LED next colour' }, type: 'boolean', role: 'button', write: true, action: 'ledPulse', exists: 'main.hasLED', source: 'ha' },

    // ---------------------------------------------------------------- Ausstattung
    ...[['hasPH', 'pH'], ['hasRX', 'Redox'], ['hasCL', 'Chlor'], ['hasCD', 'Leitfähigkeit'], ['hasUV', 'UV'], ['hasIO', 'E/A'], ['hasHidro', 'Elektrolyse/Hydrolyse'], ['hasLED', 'LED'], ['hasBackwash', 'Rückspülung']]
        .map(([k, de]) => ({ id: `modules.${k}`, path: `main.${k}`, name: { de: `Modul ${de} vorhanden`, en: `${k} module` }, type: 'boolean', role: 'indicator', conv: 'bool01', source: 'ha' })),

    // ---------------------------------------------------------------- Info
    { id: 'info.online', path: 'present', name: { de: 'Anlage online', en: 'Controller online' }, type: 'boolean', role: 'indicator.reachable', conv: 'bool01', source: 'lib' },
    { id: 'info.rssi', path: 'main.RSSI', name: { de: 'WLAN-Signalstärke', en: 'Wi-Fi signal' }, type: 'number', role: 'value', unit: 'dBm', source: 'ha' },
    { id: 'info.firmware', path: 'main.version', name: { de: 'Firmware Steuerung', en: 'Controller firmware' }, type: 'number', role: 'info.firmware', source: 'lib' },
    { id: 'info.wifiFirmware', path: 'main.wifiVersion', name: { de: 'Firmware WLAN-Modul', en: 'Wi-Fi module firmware' }, type: 'number', role: 'info.firmware', source: 'lib' },
    { id: 'info.lastUpdate', path: 'updatedAt', name: { de: 'Letzte Meldung der Anlage', en: 'Last controller report' }, type: 'number', role: 'date', conv: 'epochMs', source: 'lib' },
    { id: 'info.controllerTime', path: 'main.localTime', name: { de: 'Uhrzeit der Steuerung (lokal, Epoch)', en: 'Controller clock (local, epoch)' }, type: 'number', role: 'value', source: 'lib' },

    // ---------------------------------------------------------------- Rueckspuelung
    { id: 'backwash.mode', path: 'backwash.mode', name: { de: 'Rückspülung Modus', en: 'Backwash mode' }, type: 'number', role: 'value', exists: 'main.hasBackwash', source: 'lib' },
    { id: 'backwash.interval', path: 'backwash.interval', name: { de: 'Rückspülung Dauer', en: 'Backwash duration' }, type: 'number', role: 'value', unit: 's', exists: 'main.hasBackwash', source: 'lib' },
    { id: 'backwash.frequency', path: 'backwash.frequency', name: { de: 'Rückspülung Wiederholung', en: 'Backwash frequency' }, type: 'number', role: 'value', unit: 'min', exists: 'main.hasBackwash', source: 'lib' },
    { id: 'backwash.remainingTime', path: 'backwash.remainingTime', name: { de: 'Rückspülung Restzeit', en: 'Backwash remaining' }, type: 'number', role: 'value', exists: 'main.hasBackwash', source: 'lib' },
];

/** Teilbaeume, die NICHT in raw.* gespiegelt werden (Adresse/Geodaten). */
const RAW_EXCLUDE = ['form'];

module.exports = { datapoints: dp, RAW_EXCLUDE, FREQ_STATES, RELAY_MODES };
