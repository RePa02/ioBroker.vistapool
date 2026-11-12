'use strict';
/* Offline-Tests ohne ioBroker und ohne Cloud: node test/run.js */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const C = require('../lib/convert');
const { PoolHandler } = require('../lib/pool');
const { datapoints } = require('../lib/datapoints');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pool.json'), 'utf8'));
const doc = () => JSON.parse(JSON.stringify(fixture));

function mockAdapter() {
    const objects = {}, states = {}, logs = [];
    const log = lvl => m => logs.push(`${lvl}: ${m}`);
    return {
        objects, states, logs,
        log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
        async extendObjectAsync(id, obj) { objects[id] = { ...(objects[id] || {}), ...obj }; },
        async setStateChangedAsync(id, s) { states[id] = s.val; },
        async setStateAsync(id, s) { states[id] = s.val; },
    };
}
function mockCloud() {
    const sent = [];
    return { sent, async sendCommand(p) { sent.push(p); return { ok: true }; } };
}
const changes = p => JSON.parse(p.changes);

let n = 0;
async function test(name, fn) {
    try { await fn(); n++; console.log(`  ok   ${name}`); }
    catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1; }
}

(async () => {
    console.log('Katalog');
    await test('IDs eindeutig', () => {
        const ids = datapoints.map(d => d.id);
        assert.equal(new Set(ids).size, ids.length);
    });

    console.log('Lesen (echtes Dokument, anonymisiert)');
    const a = mockAdapter(), c = mockCloud();
    const h = new PoolHandler(a, c, 'POOL_1_ANON', { rawMirror: true, commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
    await h.update(doc());
    const S = id => a.states[`POOL_1_ANON.${id}`];

    await test('Device mit Poolnamen', () => assert.equal(a.objects.POOL_1_ANON.common.name, 'Testpool'));
    await test('Messwerte', () => {
        assert.equal(S('measure.temperature'), 3.6);
        assert.equal(S('measure.ph'), 6.71);
        assert.equal(S('measure.redox'), 451);
        assert.equal(S('filtration.intelHours'), 9);
    });
    await test('Module ohne Hardware werden nicht angelegt', () => {
        assert.equal(a.objects['POOL_1_ANON.measure.chlorine'], undefined);
        assert.equal(a.objects['POOL_1_ANON.button.ledNext'], undefined);
    });
    await test('Hydrolyse in % (dynamische Einheit)', () => {
        assert.equal(a.objects['POOL_1_ANON.electrolysis.setpoint'].common.unit, '%');
        assert.equal(a.objects['POOL_1_ANON.electrolysis.setpoint'].common.max, 100);
        assert.equal(S('electrolysis.setpoint'), 100);
    });
    await test('Modus, Zeiten, Relais', () => {
        assert.equal(S('filtration.mode'), 2);
        assert.equal(S('filtration.interval1Start'), '07:00');
        assert.equal(S('filtration.interval1End'), '20:00');
        assert.equal(S('relay.aux1'), true);
        assert.equal(S('relay.aux4'), true);   // onoff 0, status 1 -> an
        assert.equal(S('relay.aux1End'), '00:25'); // 87900 s -> naechster Tag
        assert.equal(S('light.mode'), 'off');
        assert.equal(S('heating.climate'), true);
    });
    await test('Raw-Spiegel ohne Adresse', () => {
        assert.equal(S('raw.pump.isVSP'), 0);
        assert.equal(S('raw.modules.io.status'), '8256');
        assert.ok(!Object.keys(a.states).some(k => k.includes('.raw.form.')));
    });
    const stateCount = Object.keys(a.objects).filter(k => a.objects[k].type === 'state' && !k.includes('.raw.')).length;
    const writable = Object.keys(a.objects).filter(k => a.objects[k].type === 'state' && a.objects[k].common.write).length;
    console.log(`       -> ${stateCount} Datenpunkte, davon ${writable} steuerbar, ${Object.keys(a.objects).filter(k => k.includes('.raw.')).length} Rohfelder`);

    console.log('Transienten (aus dem Watch-Protokoll)');
    await test('Unplausible Werte werden ignoriert', async () => {
        const t = doc();
        t.filtration.interval1.to = -520093692; t.filtration.interval1.from = 0;
        t.filtration.heating.clima = 43200; t.light.freq = 231145472; t.filtration.intel.time = '43200';
        await h.update(t);
        assert.equal(S('filtration.interval1End'), '20:00');
        assert.equal(S('heating.climate'), true);
        assert.equal(S('light.scheduleFrequency'), 86400);
        assert.equal(S('filtration.intelHours'), 9);
        assert.equal(S('filtration.interval1Start'), '07:00'); // ganzer Zweig gehalten
        await h.update(doc());
    });
    await test('Echte Aenderung im selben Snapshot kommt eine Abfrage spaeter', async () => {
        const t = doc(); t.light.mode = 1; t.light.to = -1056964604; t.light.freq = 231145472;
        await h.update(t);
        assert.equal(S('light.mode'), 'off');
        const t2 = doc(); t2.light.mode = 1;
        await h.update(t2);
        assert.equal(S('light.mode'), 'auto');
        await h.update(doc());
    });
    await test('Dauerhaft seltsames Feld friert Zweig nicht ein', async () => {
        for (let i = 0; i < 5; i++) { const t = doc(); t.light.freq = 123; t.light.status = 1; await h.update(t); }
        assert.equal(S('light.on'), true);
        assert.equal(S('light.scheduleFrequency'), 86400);
        await h.update(doc());
    });

    console.log('Schreiben');
    await test('Filtration aus -> kompletter filtration-Zweig', async () => {
        await h.handleStateChange('filtration.on', false);
        const p = c.sent.at(-1);
        assert.equal(p.operation, 'WRP'); assert.equal(p.gateway, 'GATEWAY_ANON'); assert.equal(p.poolId, 'POOL_1_ANON');
        const ch = changes(p);
        assert.deepEqual(Object.keys(ch), ['filtration']);
        assert.equal(ch.filtration.status, 0);
        assert.equal(ch.filtration.interval1.to, 72000);
        assert.equal(ch.filtration.mode, 2);
        assert.equal(S('filtration.on'), false);
    });
    await test('Gesendeter Wert bleibt, bis Cloud bestaetigt', async () => {
        await h.update(doc());                    // Cloud noch alt (status 1)
        assert.equal(S('filtration.on'), false);
        const d2 = doc(); d2.filtration.status = 0;
        await h.update(d2);                       // bestaetigt
        assert.equal(h.pending.has('filtration.status'), false);
    });
    await test('Relais aus: Anzeige folgt sofort (Ausgang wird mitgefuehrt)', async () => {
        await h.handleStateChange('relay.aux1', false);   // relay1: manuell, onoff 1, status 1
        assert.equal(S('relay.aux1'), false);
        await h.update(doc());                            // Cloud noch alt
        assert.equal(S('relay.aux1'), false);
    });
    await test('Hinweis bei Schalten im Auto-Modus', async () => {
        const n = a.logs.length;
        await h.handleStateChange('relay.aux4', true);    // relay4 steht auf Auto
        assert.ok(a.logs.slice(n).some(l => l.includes('not in manual mode')));
    });
    await test('Pumpenmodus per Label', async () => {
        await h.handleStateChange('filtration.mode', 'manual');
        assert.equal(changes(c.sent.at(-1)).filtration.mode, 0);
    });
    await test('Relais 2 -> nur relays.relay2', async () => {
        await h.handleStateChange('relay.aux2', true);
        const ch = changes(c.sent.at(-1));
        assert.deepEqual(Object.keys(ch.relays), ['relay2']);
        assert.equal(ch.relays.relay2.info.onoff, 1);
        assert.equal(ch.relays.relay2.info.to, 600);
    });
    await test('Lichtmodus auto', async () => {
        await h.handleStateChange('light.mode', 'auto');
        assert.equal(changes(c.sent.at(-1)).light.mode, 1);
    });
    await test('Zeitfenster 08:30', async () => {
        await h.handleStateChange('filtration.interval1Start', '08:30');
        assert.equal(changes(c.sent.at(-1)).filtration.interval1.from, 30600);
    });
    await test('Hydrolyse 99,5 % -> 995', async () => {
        await h.handleStateChange('electrolysis.setpoint', 99.5);
        assert.equal(changes(c.sent.at(-1)).hidro.level, 995);
    });
    await test('Ungueltige Werte werden abgelehnt und zurueckgesetzt', async () => {
        const before = c.sent.length;
        await h.handleStateChange('electrolysis.setpoint', 150);
        await h.handleStateChange('filtration.mode', 9);
        await h.handleStateChange('filtration.interval2End', '25:99');
        assert.equal(c.sent.length, before);
        assert.equal(S('filtration.mode'), 0);
        assert.ok(a.logs.filter(l => l.startsWith('warn')).length >= 3);
    });
    await test('Nicht steuerbare States', async () => {
        const before = c.sent.length;
        a.states['POOL_1_ANON.relay.aux3Start'] = '08:00';     // Skript schreibt auf read-only State
        await h.handleStateChange('measure.temperature', 30);
        await h.handleStateChange('relay.aux3Start', '08:00');
        assert.equal(c.sent.length, before);
        assert.equal(S('relay.aux3Start'), '00:00', 'Wert der Anlage wiederhergestellt');
    });
    await test('Zeitfenster im Intel-Modus: Hinweis, keine Wiederholung', async () => {
        const a18 = mockAdapter(), c18 = mockCloud();
        const h18 = new PoolHandler(a18, c18, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        const d18 = doc(); d18.filtration.mode = 4;
        await h18.update(d18);
        await h18.handleStateChange('filtration.interval3Start', '00:05');
        assert.equal(c18.sent.length, 1);
        assert.equal(h18.inflight.size, 0);
        assert.ok(a18.logs.some(l => l.includes('intel')));
    });
    await test('Uhrzeit synchronisieren', async () => {
        await h.handleStateChange('button.syncTime', true);
        const ch = changes(c.sent.at(-1));
        assert.ok(Math.abs(ch.main.localTime - (Date.now() / 1000 - new Date().getTimezoneOffset() * 60)) < 5);
        assert.equal(ch.main.temperature, 3.6);
    });
    await test('Boost wie Web-App: disable gesetzt, reduction unveraendert', async () => {
        await h.handleStateChange('electrolysis.boost', true);
        const ch = changes(c.sent.at(-1));
        assert.equal(ch.hidro.cloration_enabled, 1);
        assert.equal(ch.hidro.disable, 1);
        assert.equal(ch.hidro.reduction, 20);
    });
    await test('Relais-Modus als State', async () => {
        assert.equal(S('relay.aux4Mode'), 1);
        await h.handleStateChange('relay.aux3Mode', 'tempo');
        assert.equal(changes(c.sent.at(-1)).relays.relay3.info.manAutoTemp, 2);
    });
    await test('Verwendung im Objektnamen', async () => {
        const a2 = mockAdapter();
        const h2 = new PoolHandler(a2, c, 'P', { relayUse: { 4: 'heatpump' }, commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        await h2.update(doc());
        assert.equal(a2.objects['P.relay.aux4'].common.name.de, 'Relais 4 – Wärmepumpe');
    });

    console.log('Bestaetigung und Wiederholung');
    await test('Befehl geht verloren, Anlage offline -> wird nach Rueckkehr wiederholt', async () => {
        const a4 = mockAdapter(), c4 = mockCloud();
        const h4 = new PoolHandler(a4, c4, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        await h4.update(doc());
        await h4.handleStateChange('filtration.mode', 'manual');
        assert.equal(c4.sent.length, 1);
        const off = doc(); off.present = false;
        await h4.update(off); await h4.queue;
        assert.equal(c4.sent.length, 1, 'offline: nicht senden');
        await h4.update(doc()); await h4.queue;          // wieder online, Wert nicht uebernommen
        assert.equal(c4.sent.length, 2, 'nach Rueckkehr erneut senden');
        assert.equal(changes(c4.sent[1]).filtration.mode, 0);
        assert.equal(a4.states['P.filtration.mode'], 0);
        const ok = doc(); ok.filtration.mode = 0;
        await h4.update(ok); await h4.queue;             // bestaetigt
        assert.equal(h4.inflight.size, 0);
        assert.equal(c4.sent.length, 2);
    });
    await test('Nach zwei Wiederholungen aufgeben und Anlagenstand zeigen', async () => {
        const a5 = mockAdapter(), c5 = mockCloud();
        const h5 = new PoolHandler(a5, c5, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        await h5.update(doc());
        await h5.handleStateChange('setpoint.redox', 700);
        for (let i = 0; i < 3; i++) {
            for (const x of h5.inflight.values()) x.sentAt -= 10 * 60 * 1000;   // Zeit vorspulen
            for (const [p, x] of h5.pending) x.until -= 10 * 60 * 1000;
            await h5.update(doc()); await h5.queue;
        }
        assert.equal(c5.sent.length, 3);
        assert.equal(h5.inflight.size, 0);
        assert.equal(a5.states['P.setpoint.redox'], 750);
        assert.ok(a5.logs.some(l => l.includes('not taken')));
    });

    await test('Befehl nach langer Offline-Zeit verwerfen statt spaet ausfuehren', async () => {
        const a6 = mockAdapter(), c6 = mockCloud();
        const h6 = new PoolHandler(a6, c6, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0, commandMaxAge: 10 });
        await h6.update(doc());
        await h6.handleStateChange('setpoint.redox', 700);
        const off = doc(); off.present = false;
        await h6.update(off); await h6.queue;
        for (const x of h6.inflight.values()) x.createdAt -= 15 * 60 * 1000;   // 15 min offline
        await h6.update(doc()); await h6.queue;
        assert.equal(c6.sent.length, 1, 'nicht erneut senden');
        assert.equal(h6.inflight.size, 0);
        assert.equal(a6.states['P.setpoint.redox'], 750, 'Anzeige zeigt Stand der Anlage');
        assert.ok(a6.logs.some(l => l.includes('command dropped')));
    });
    await test('Ignorierte Befehle (Licht im Auto-Modus) werden nicht wiederholt', async () => {
        const a7 = mockAdapter(), c7 = mockCloud();
        const h7 = new PoolHandler(a7, c7, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        const d7 = doc(); d7.light.mode = 1;
        await h7.update(d7);
        await h7.handleStateChange('light.on', true);
        assert.equal(h7.inflight.size, 0);
    });
    await test('Vor dem Senden frischen Stand holen (App-Aenderung bleibt erhalten)', async () => {
        const a8 = mockAdapter();
        const fresh = doc(); fresh.filtration.interval2.from = 36000; fresh.filtration.interval2.to = 39600;
        const c8 = { ...mockCloud(), sent: [], async sendCommand(p) { this.sent.push(p); }, async getPool() { return JSON.parse(JSON.stringify(fresh)); } };
        const h8 = new PoolHandler(a8, c8, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        await h8.update(doc());                            // alter Stand ohne Fenster 2
        await h8.handleStateChange('filtration.mode', 'auto');
        const ch = changes(c8.sent[0]).filtration;
        assert.equal(ch.mode, 1);
        assert.equal(ch.interval2.from, 36000);
        assert.equal(a8.states['P.filtration.interval2Start'], '10:00');
    });

    console.log('Buendeln, Begrenzen, Status');
    await test('Mehrere Schreibvorgaenge -> ein Befehl je Zweig', async () => {
        const a9 = mockAdapter(), c9 = mockCloud();
        const h9 = new PoolHandler(a9, c9, 'P', { commandGap: 0, coalesceMs: 30, maxPerMinute: 0 });
        await h9.update(doc());
        await Promise.all([
            h9.handleStateChange('filtration.mode', 'manual'),
            h9.handleStateChange('filtration.interval1Start', '08:00'),
            h9.handleStateChange('light.mode', 'auto'),
            h9.handleStateChange('filtration.mode', 'auto'),     // letzter Wert gewinnt
        ]);
        assert.equal(c9.sent.length, 2);
        const f = c9.sent.map(changes).find(x => x.filtration).filtration;
        assert.equal(f.mode, 1);
        assert.equal(f.interval1.from, 28800);
        assert.equal(c9.sent.map(changes).find(x => x.light).light.mode, 1);
    });
    await test('Ungueltiger Wert im Buendel blockiert die anderen nicht', async () => {
        const a10 = mockAdapter(), c10 = mockCloud();
        const h10 = new PoolHandler(a10, c10, 'P', { commandGap: 0, coalesceMs: 30, maxPerMinute: 0 });
        await h10.update(doc());
        await Promise.all([h10.handleStateChange('setpoint.redox', 700), h10.handleStateChange('filtration.mode', 9)]);
        assert.equal(c10.sent.length, 1);
        assert.equal(changes(c10.sent[0]).modules.rx.status.value, 700);
        assert.equal(a10.states['P.filtration.mode'], 2);
    });
    await test('Hoechstens N Befehle pro Minute', async () => {
        const a11 = mockAdapter(), c11 = mockCloud();
        const h11 = new PoolHandler(a11, c11, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 2 });
        await h11.update(doc());
        h11.sendTimes = [Date.now() - 59800, Date.now() - 59700];
        const t0 = Date.now();
        await h11.handleStateChange('setpoint.redox', 700);
        assert.ok(Date.now() - t0 >= 150, 'gewartet');
        assert.ok(a11.logs.some(l => l.includes('commands per minute')));
    });
    await test('Status-Datenpunkte: Befehl, Bestaetigung, offline', async () => {
        const a12 = mockAdapter(), c12 = mockCloud();
        const h12 = new PoolHandler(a12, c12, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        await h12.update(doc());
        await h12.handleStateChange('setpoint.redox', 700);
        await h12.infoChain;
        assert.equal(a12.states['P.info.lastCommandStatus'], 'sent');
        assert.equal(a12.states['P.info.pendingCommands'], 1);
        assert.equal(a12.states['P.info.lastCommand'], 'modules.rx.status.value=700');
        const ok = doc(); ok.modules.rx.status.value = 700;
        await h12.update(ok);
        assert.equal(a12.states['P.info.lastCommandStatus'], 'confirmed');
        assert.equal(a12.states['P.info.pendingCommands'], 0);
        assert.equal(a12.states['P.info.offlineSince'], 0);
        const off = doc(); off.present = false;
        await h12.update(off);
        assert.equal(a12.states['P.info.offlineSince'], off.updatedAt * 1000);
        assert.equal(a12.objects['P.info.lastCommandStatus'].common.type, 'string');
    });

    console.log('Uhr der Steuerung');
    const Clock = require('../lib/clock');
    await test('Zeitzonen-Offset (Sommer/Winter)', () => {
        assert.equal(Clock.offsetSec(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin'), 3600);
        assert.equal(Clock.offsetSec(new Date('2026-07-15T12:00:00Z'), 'Europe/Berlin'), 7200);
        assert.equal(Clock.isUtcZone('UTC'), true);
        assert.equal(Clock.isUtcZone('Europe/Berlin'), false);
    });
    const clockDoc = (dt = 0, localShift = 0) => { const d = doc(); d.updatedAt += dt; d.main.localTime += dt + localShift; return d; };
    await test('Abweichung 47 min -> nach zweitem Messwert synchronisieren', async () => {
        const a13 = mockAdapter(), c13 = mockCloud();
        const h13 = new PoolHandler(a13, c13, 'P', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0, clockSync: true, timeZone: 'Europe/Berlin' });
        await h13.update(clockDoc());
        await h13.queue;
        assert.equal(c13.sent.length, 0, 'ein Messwert reicht nicht');
        assert.equal(a13.states['P.info.clockDrift'], 47);
        await h13.update(clockDoc(60));
        await h13.queue;
        assert.equal(c13.sent.length, 1);
        const lt = changes(c13.sent[0]).main.localTime;
        assert.ok(Math.abs(lt - Clock.localEpoch(new Date(), 'Europe/Berlin')) < 5);
        await h13.update(clockDoc(120)); await h13.queue;
        assert.equal(c13.sent.length, 1, 'hoechstens alle 6 h');
    });
    await test('Kleine Abweichung oder abgeschaltet -> nichts senden', async () => {
        const c14 = mockCloud();
        const h14 = new PoolHandler(mockAdapter(), c14, 'P', { commandGap: 0, coalesceMs: 0, clockSync: true, timeZone: 'Europe/Berlin' });
        for (let i = 0; i < 3; i++) await h14.update(clockDoc(i * 60, -2830 + 60));   // 1 min
        const c15 = mockCloud();
        const h15 = new PoolHandler(mockAdapter(), c15, 'P', { commandGap: 0, coalesceMs: 0, clockSync: false, timeZone: 'Europe/Berlin' });
        for (let i = 0; i < 3; i++) await h15.update(clockDoc(i * 60));
        await h14.queue; await h15.queue;
        assert.equal(c14.sent.length + c15.sent.length, 0);
    });
    await test('Host in UTC ohne Zeitzone -> nur Warnung', async () => {
        const a16 = mockAdapter(), c16 = mockCloud();
        const h16 = new PoolHandler(a16, c16, 'P', { commandGap: 0, coalesceMs: 0, clockSync: true, timeZone: 'UTC' });
        h16.zoneUnsure = true;
        for (let i = 0; i < 3; i++) await h16.update(clockDoc(i * 60, 3 * 3600));
        await h16.queue;
        assert.equal(c16.sent.length, 0);
        assert.ok(a16.logs.some(l => l.includes('host runs in UTC')));
    });

    console.log('Push (Firestore Listen, lokaler gRPC-Server)');
    await test('Dokument kommt per Push, Stream wird mit Resume-Token erneuert', async () => {
        const grpc = require('@grpc/grpc-js');
        const loader = require('@grpc/proto-loader');
        const def = loader.loadSync(path.join(__dirname, '..', 'lib', 'proto', 'listen.proto'), { keepCase: false, longs: String, enums: String, defaults: false, oneofs: true });
        const svc = grpc.loadPackageDefinition(def).google.firestore.v1.Firestore.service;
        const requests = [];
        const server = new grpc.Server();
        server.addService(svc, {
            Listen(call) {
                call.on('data', req => {
                    requests.push({ req, auth: call.metadata.get('authorization')[0] });
                    const tid = req.addTarget.targetId;
                    call.write({ targetChange: { targetChangeType: 'ADD', targetIds: [tid] } });
                    call.write({ documentChange: { targetIds: [tid], document: { name: req.addTarget.documents.documents[0], fields: {
                        present: { booleanValue: true },
                        main: { mapValue: { fields: { temperature: { doubleValue: 24.5 }, version: { integerValue: '825' } } } },
                        form: { mapValue: { fields: { name: { stringValue: 'Push' } } } },
                    } } } });
                    call.write({ targetChange: { targetChangeType: 'CURRENT', targetIds: [tid], resumeToken: Buffer.from('tok1') } });
                    call.write({ targetChange: { targetChangeType: 'NO_CHANGE', targetIds: [], resumeToken: Buffer.from('tok2') } });
                    if (requests.length === 1) setTimeout(() => call.end(), 50);   // Server schliesst gesunden Stream
                });
                call.on('error', () => {});
            },
        });
        const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
        const { PoolListener } = require('../lib/listener');
        const cloud = { tokens: { idToken: 'ID1' }, expiry: Date.now() + 3600e3, async ensureAuth() {} };
        const silent = { debug() {}, info() {}, warn() {} };
        const l = new PoolListener(cloud, silent, { host: `127.0.0.1:${port}`, insecure: true, backoffMin: 50 });
        const docs = [];
        let lives = 0;
        l.on('doc', (id, d) => docs.push({ id, d }));
        l.on('live', () => lives++);
        l.setPools(['POOL_A']);
        l.start();
        for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise(r => setTimeout(r, 30));
        l.stop();
        server.forceShutdown();
        assert.equal(requests[0].req.database, 'projects/hayward-europe/databases/(default)');
        assert.equal(requests[0].req.addTarget.documents.documents[0], 'projects/hayward-europe/databases/(default)/documents/pools/POOL_A');
        assert.equal(requests[0].auth, 'Bearer ID1');
        assert.equal(docs[0].id, 'POOL_A');
        assert.deepEqual(docs[0].d, { present: true, main: { temperature: 24.5, version: 825 }, form: { name: 'Push' } });
        assert.ok(lives >= 1);
        assert.equal(requests.length, 2, 'neu verbunden');
        assert.equal(Buffer.from(requests[1].req.addTarget.resumeToken).toString(), 'tok2');
    });
    await test('Push-Dokument laeuft durch den PoolHandler', async () => {
        const a17 = mockAdapter();
        const h17 = new PoolHandler(a17, mockCloud(), 'P', {});
        const { fsFields } = require('../lib/cloud');
        const rest = { present: { booleanValue: true }, main: { mapValue: { fields: { temperature: { doubleValue: 21.5 }, hasPH: { integerValue: '0' } } } } };
        await h17.update(fsFields(rest));
        assert.equal(a17.states['P.measure.temperature'], 21.5);
        assert.equal(a17.states['P.info.online'], true);
    });

    console.log('Instanz-Seite (Einstellungen)');
    const Set_ = require('../lib/settings');
    const form = Set_.load(doc());
    await test('Laden: Werte wie in der Web-App', () => {
        assert.equal(form.d_f_mode, 2);
        assert.equal(form.d_f_i1from, '07:00:00');
        assert.equal(form.d_f_heatTemp, 33);
        assert.equal(form.d_f_intelHours, 9);
        assert.equal(form.d_h_levelPct, 100);
        assert.equal(form.d_ph_high, 6.9);
        assert.equal(form.d_r4_mode, 1);
        assert.equal(form.d_r4_from, '09:30:00');
        assert.equal(form.d_r1_to, '00:25:00');
        assert.equal(form.x_hasHeat, 1); assert.equal(form.x_hidroUnit, '%'); assert.equal(form.x_relays, 4);
        assert.equal(form.x_phType, 'ACID'); assert.equal(form.x_vsp, false); assert.equal(form.x_hasBackwash, false);
    });
    // jsonData liefert Strings
    const asStrings = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
    await test('Unveraendertes Formular -> nichts senden', () => {
        for (const sec of ['filtration', 'light', 'relay1', 'relay2', 'relay3', 'relay4', 'water']) {
            const r = Set_.diff(sec, asStrings(form), doc());
            assert.equal(r.groups.length, 0, `${sec}: ${r.changes.join('; ')}`);
        }
    });
    await test('Filtration: zwei Aenderungen, ein Befehl', () => {
        const v = asStrings({ ...form, d_f_mode: 1, d_f_i1from: '08:00:00' });
        const r = Set_.diff('filtration', v, doc());
        assert.equal(r.groups.length, 1);
        assert.deepEqual(r.groups[0].updates, { 'filtration.mode': 1, 'filtration.interval1.from': 28800 });
        assert.equal(r.changes.length, 2);
    });
    await test('Relais: Name + Modus im Zweig relays.relay2', () => {
        const v = asStrings({ ...form, d_r2_name: 'WP', d_r2_mode: 3, d_r2_signal: 1 });
        const r = Set_.diff('relay2', v, doc());
        assert.equal(r.groups.length, 1); assert.equal(r.groups[0].branch, 'relays.relay2');
        const cmd = C.buildCommand(doc(), 'X', r.groups[0].updates, { branch: 'relays.relay2' });
        const ch = JSON.parse(cmd.payload.changes);
        assert.equal(ch.relays.relay2.name, 'WP'); assert.equal(ch.relays.relay2.info.manAutoTemp, 3); assert.equal(ch.relays.relay2.info.signal, 1);
        assert.equal(ch.relays.relay2.info.to, 600);
        assert.deepEqual(Object.keys(ch.relays), ['relay2']);
    });
    await test('Wasserpflege: drei Zweige', () => {
        const v = asStrings({ ...form, d_h_levelPct: 80, d_ph_high: 7.2, d_rx_set: 700 });
        const r = Set_.diff('water', v, doc());
        assert.deepEqual(r.groups.map(g => Object.keys(g.updates)[0]).sort(), ['hidro.level', 'modules.ph.status.high_value', 'modules.rx.status.value']);
        assert.equal(r.groups.find(g => 'hidro.level' in g.updates).updates['hidro.level'], 800);
        assert.equal(r.groups.find(g => 'modules.ph.status.high_value' in g.updates).updates['modules.ph.status.high_value'], 720);
    });
    await test('Ungueltige Werte werden abgelehnt', () => {
        assert.throws(() => Set_.diff('water', asStrings({ ...form, d_h_levelPct: 150 }), doc()));
        assert.throws(() => Set_.diff('relay1', asStrings({ ...form, d_r1_name: 'viel zu langer Name' }), doc()));
        assert.throws(() => Set_.diff('backwash', asStrings(form), doc()), /not available/);
        assert.throws(() => Set_.diff('backwash', asStrings(form), doc(), 'de'), /nicht vorhanden/);
        const named = doc(); named.relays.relay3.name = 'Test';
        assert.throws(() => Set_.diff('relay3', asStrings({ ...Set_.load(named), d_r3_name: '' }), named), /empty name/);
        assert.throws(() => Set_.diff('relay3', asStrings({ ...Set_.load(named), d_r3_name: '' }), named, 'de'), /leeren Namen/);
    });
    await test('applySettings sendet und meldet Aenderungen', async () => {
        const a3 = mockAdapter(), c3 = mockCloud();
        const h3 = new PoolHandler(a3, c3, 'P', { hidroDisable: 0, commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        await h3.update(doc());
        const res = await h3.applySettings('water', asStrings({ ...Set_.load(doc()), d_h_shock: true, d_rx_set: 740 }));
        assert.equal(c3.sent.length, 2);
        const hidro = c3.sent.map(changes).find(x => x.hidro).hidro;
        assert.equal(hidro.cloration_enabled, 1); assert.equal(hidro.disable, 0);
        assert.ok(res.some(x => x.startsWith('Boost')));
        assert.equal(a3.states['P.setpoint.redox'], 740);
    });
    await test('Kein Senden, wenn Zweig unplausibel waere', async () => {
        const h2 = new PoolHandler(mockAdapter(), c, 'X', { commandGap: 0, coalesceMs: 0, maxPerMinute: 0 });
        const t = doc(); t.light.freq = 231145472;
        await h2.update(t);                  // kein guter Vorwert vorhanden
        const before = c.sent.length;
        await h2.handleStateChange('light.on', true);
        assert.equal(c.sent.length, before);
    });

    console.log(`\n${n} Tests bestanden${process.exitCode ? ', es gibt Fehler' : ''}.`);
    process.exit(process.exitCode || 0);
})();
