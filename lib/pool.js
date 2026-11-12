'use strict';
/**
 * One pool: create objects, mirror the cloud document into states, send commands.
 * Independent of the transport (push listener or polling).
 */
const C = require('./convert');
const S = require('./settings');
const Clock = require('./clock');
const { datapoints: CATALOG, RAW_EXCLUDE } = require('./datapoints');

const PENDING_TTL = 90 * 1000; // a sent value counts as "on its way" this long (filtration needs up to ~60 s)
const LED_PULSE_DELAY = 1000;
const MAX_BRANCH_HOLD = 3; // updates a branch with transient garbage is held at most
const CONFIRM_TIMEOUT = 75 * 1000; // time the controller may take to confirm a command
const MAX_RETRIES = 2; // afterwards a command is reported as lost
const COMMAND_GAP = 3000; // minimum gap between two commands to the same controller
const COMMAND_MAX_AGE = 10; // minutes: older unconfirmed commands are dropped instead of being executed late
const COALESCE_MS = 1000; // state writes within this window are merged into one command per branch
const MAX_PER_MINUTE = 6; // hard limit of commands per minute (controller drops off Wi-Fi after bursts)
const CLOCK_MAX_DRIFT = 3; // minutes
const CLOCK_SYNC_MIN_INTERVAL = 6 * 3600 * 1000;
const USE_LABELS = {
    heatpump: { en: 'Heat pump', de: 'Wärmepumpe' },
    light: { en: 'Lighting', de: 'Beleuchtung' },
    counterflow: { en: 'Counter-current', de: 'Gegenstromanlage' },
    feature: { en: 'Water feature', de: 'Wasserattraktion' },
    dosing: { en: 'Dosing', de: 'Dosierung' },
    cover: { en: 'Cover', de: 'Abdeckung' },
    other: { en: 'Other', de: 'Sonstiges' },
};
const CMD_STATES = {
    sent: 'sent',
    confirmed: 'confirmed',
    retrying: 'retrying',
    expired: 'expired',
    failed: 'failed',
    untracked: 'sent, not tracked',
    error: 'error',
};
/** Status states of a pool in addition to the catalogue (info.online, info.lastUpdate, ...). */
const INFO_EXTRA = {
    'info.offlineSince': { name: { en: 'Offline since', de: 'Offline seit' }, type: 'number', role: 'date' },
    'info.pendingCommands': {
        name: { en: 'Commands waiting for confirmation', de: 'Unbestätigte Befehle' },
        type: 'number',
        role: 'value',
    },
    'info.lastCommand': { name: { en: 'Last command', de: 'Letzter Befehl' }, type: 'string', role: 'text' },
    'info.lastCommandStatus': {
        name: { en: 'Status of last command', de: 'Status letzter Befehl' },
        type: 'string',
        role: 'text',
        states: CMD_STATES,
    },
    'info.lastCommandTime': {
        name: { en: 'Time of last command status', de: 'Zeit letzter Befehlsstatus' },
        type: 'number',
        role: 'date',
    },
    'info.clockDrift': {
        name: { en: 'Controller clock deviation', de: 'Abweichung Uhr der Steuerung' },
        type: 'number',
        role: 'value',
        unit: 'min',
    },
    'info.lastClockSync': {
        name: { en: 'Last clock sync', de: 'Letzte Uhrzeit-Synchronisation' },
        type: 'number',
        role: 'date',
    },
};

/**
 * Hint if a switch command is ignored by the controller in its current mode
 * (e.g. light on while the light mode is auto).
 *
 * @param dp
 * @param doc
 */
function modeHint(dp, doc) {
    if (dp.id === 'light.on' && C.num(C.getPath(doc, 'light.mode')) === 1) {
        return 'light mode is auto – the controller switches by schedule. Set light.mode to "on"/"off" to switch directly.';
    }
    if (dp.id === 'filtration.on' && C.num(C.getPath(doc, 'filtration.mode')) !== 0) {
        return 'pump mode is not "manual" – the controller switches the pump itself. Set filtration.mode to "manual" to switch directly.';
    }
    if (/^filtration\.interval\d(Start|End)$/.test(dp.id) && C.num(C.getPath(doc, 'filtration.mode')) === 4) {
        return 'pump mode is "intel" – the controller calculates the time windows itself and ignores them. Set filtration.mode to "auto" to use your own time windows.';
    }
    const r = /^relay\.aux(\d)$/.exec(dp.id);
    if (r && C.num(C.getPath(doc, `relays.relay${r[1]}.info.manAutoTemp`)) !== 0) {
        return `relay ${r[1]} is not in manual mode – the controller switches it itself. Set relay.aux${r[1]}Mode to "manual" to switch directly.`;
    }
    return '';
}

class PoolHandler {
    /**
     * @param {object} adapter  ioBroker adapter instance (or mock)
     * @param {import('./cloud').VistapoolCloud} cloud
     * @param {string} poolId
     * @param {object} opts
     * @param {boolean} [opts.rawMirror]
     * @param {Function} [opts.requestRefresh]  called after a command (faster re-read when polling)
     * @param {Function} [opts.isLive]          true while push updates arrive (no read before write needed)
     * @param {object} [opts.relayUse]
     * @param {number} [opts.hidroDisable]
     * @param {number} [opts.commandMaxAge]     minutes, 0 = never drop
     * @param {number} [opts.commandGap]        ms
     * @param {number} [opts.coalesceMs]
     * @param {number} [opts.maxPerMinute]      0 = unlimited
     * @param {boolean} [opts.clockSync]
     * @param {number} [opts.clockMaxDrift]     minutes
     * @param {string} [opts.timeZone]          IANA zone of the controller, default: host zone
     * @param {string} [opts.lang]              'de' | 'en' for object names
     */
    constructor(adapter, cloud, poolId, opts = {}) {
        this.adapter = adapter;
        this.cloud = cloud;
        this.poolId = poolId;
        this.dev = C.safeId(poolId);
        this.opts = opts;
        this.doc = null; // last plausible state
        this.pending = new Map(); // path -> { value, until }
        this.created = new Set(); // created state IDs (relative)
        this.byStateId = new Map(); // relative ID -> catalogue entry
        this.queue = Promise.resolve();
        this.updating = Promise.resolve();
        this.infoChain = Promise.resolve();
        this.branchHold = {}; // branch -> number of consecutive updates with transients
        this.inflight = new Map(); // branch -> { updates, opts, check, sentAt, createdAt, retries, offline }
        this.batch = null; // { items: Map, promise, resolve, timer }
        this.sendTimes = [];
        this.wasOnline = undefined;
        this.clock = { lastLocal: 0, prevDrift: null, lastSync: 0, warned: false };
        const tz = opts.timeZone && Clock.isValidZone(opts.timeZone) ? opts.timeZone : '';
        if (opts.timeZone && !tz) {
            this.log.warn(`[${this.dev}] Unknown time zone "${opts.timeZone}", using the host time zone`);
        }
        this.zone = tz || Clock.systemZone();
        this.zoneUnsure = !tz && Clock.isUtcZone(this.zone);
        for (const dp of CATALOG) {
            this.byStateId.set(dp.id, dp);
        }
    }

    get log() {
        return this.adapter.log;
    }

    // adapter timers are cleared automatically on unload; the mock adapter in tests has none
    _timer(fn, ms) {
        return this.adapter.setTimeout ? this.adapter.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms);
    }

    _clearTimer(t) {
        return this.adapter.clearTimeout ? this.adapter.clearTimeout(t) : globalThis.clearTimeout(t);
    }

    _delay(ms) {
        return this.adapter.delay ? this.adapter.delay(ms) : new Promise(r => globalThis.setTimeout(r, ms));
    }

    /** Stop timers (adapter unload). */
    destroy() {
        if (this.batch) {
            this._clearTimer(this.batch.timer);
            this.batch.resolve();
            this.batch = null;
        }
    }

    // ------------------------------------------------------------------ reading
    /**
     * New cloud document (from push or polling). Calls are serialised.
     *
     * @param rawDoc
     */
    update(rawDoc) {
        const p = this.updating.then(() => this._update(rawDoc));
        this.updating = p.catch(e => this.log.warn(`[${this.dev}] Update failed: ${e.message}`));
        return p;
    }

    async _update(rawDoc) {
        const { doc, transients } = C.sanitize(rawDoc, this.doc, CATALOG);
        if (transients.length) {
            this.log.debug(`[${this.dev}] Ignored implausible values: ${transients.join(', ')}`);
        }

        // Transients come branch-wise (e.g. interval1.to = -520093692 AND interval1.from = 0),
        // so the whole top-level branch is held on the last good state - for at most
        // MAX_BRANCH_HOLD updates, so that a permanently odd field does not freeze anything.
        const dirty = new Set(transients.map(t => t.split('.')[0]));
        for (const b of Object.keys(this.branchHold)) {
            if (!dirty.has(b)) {
                delete this.branchHold[b];
            }
        }
        for (const b of dirty) {
            this.branchHold[b] = (this.branchHold[b] || 0) + 1;
            if (this.doc && this.doc[b] !== undefined && this.branchHold[b] <= MAX_BRANCH_HOLD) {
                doc[b] = C.clone(this.doc[b]);
            }
        }

        // Sent commands: confirmed, retry or give up (before overlaying pending values)
        this._checkInflight(doc);

        // Overlay sent but unconfirmed values
        const now = Date.now();
        for (const [p, { value, until }] of this.pending) {
            const cur = C.getPath(doc, p);
            const waiting = [...this.inflight.values()].some(c => p in c.check);
            if (C.num(cur) === C.num(value) || cur === value || (now > until && !waiting)) {
                this.pending.delete(p);
            } else {
                C.setPath(doc, p, value);
            }
        }

        this.doc = doc;
        await this._ensureObjects(doc);
        await this._writeStates(doc);
        this._trackOnline(doc);
        this._checkClock(doc);
        if (this.opts.rawMirror) {
            await this._writeRaw(rawDoc);
        }
        await this.infoChain;
    }

    /**
     * Check confirmation of sent commands. The controller sometimes drops off-line for a moment
     * after a command; commands arriving meanwhile are lost. They are therefore repeated as soon
     * as the controller is back (at most MAX_RETRIES times).
     *
     * @param {object} cloud document as reported by the cloud
     */
    _checkInflight(cloud) {
        const now = Date.now();
        const online = C.truthy(C.getPath(cloud, 'present'));
        for (const [key, c] of this.inflight) {
            const confirmed = Object.entries(c.check).every(([p, v]) => {
                const cur = C.getPath(cloud, p);
                return cur === v || C.num(cur) === C.num(v);
            });
            if (confirmed) {
                this.inflight.delete(key);
                if (c.retries) {
                    this.log.info(`[${this.dev}] ${key}: confirmed after retry ${c.retries}`);
                }
                this._cmdStatus('confirmed', c.updates);
                continue;
            }
            const maxAge = (this.opts.commandMaxAge ?? COMMAND_MAX_AGE) * 60 * 1000;
            if (maxAge > 0 && now - c.createdAt > maxAge) {
                this.inflight.delete(key);
                for (const p of Object.keys(c.check)) {
                    this.pending.delete(p);
                }
                this.log.warn(
                    `[${this.dev}] ${key}: command dropped – the controller did not take it within ${Math.round((now - c.createdAt) / 60000)} min (${Object.keys(c.updates).join(', ')}). Sending it later could switch at the wrong time.`,
                );
                this._cmdStatus('expired', c.updates);
                continue;
            }
            if (!online) {
                c.offline = true;
                continue;
            }
            if (!c.offline && now - c.sentAt < CONFIRM_TIMEOUT) {
                continue;
            }
            if (c.retries >= MAX_RETRIES) {
                this.inflight.delete(key);
                for (const p of Object.keys(c.check)) {
                    this.pending.delete(p);
                }
                this.log.warn(
                    `[${this.dev}] ${key}: command was not taken by the controller (${Object.keys(c.updates).join(', ')}). States show the controller's values again.`,
                );
                this._cmdStatus('failed', c.updates);
                continue;
            }
            this.log.info(
                `[${this.dev}] ${key}: not confirmed yet${c.offline ? ' (controller was offline)' : ''} – sending again (${c.retries + 1}/${MAX_RETRIES})`,
            );
            c.retries++;
            c.offline = false;
            c.sentAt = now;
            this._enqueue(() => this._send(c.updates, { ...c.opts, retry: c.retries }));
        }
        this._info('info.pendingCommands', this.inflight.size);
    }

    /**
     * Put a job into the pool's command queue (strictly sequential).
     *
     * @param fn
     */
    _enqueue(fn) {
        const p = this.queue.then(fn, fn);
        this.queue = p.catch(e => this.log.warn(`[${this.dev}] ${e.message}`));
        return p;
    }

    // ------------------------------------------------------------------ status states
    _info(id, val) {
        this.infoChain = this.infoChain
            .then(async () => {
                if (!this.created.has(id)) {
                    if (!this.created.has('')) {
                        return;
                    } // device not created yet
                    const d = INFO_EXTRA[id];
                    const common = { name: d.name, type: d.type, role: d.role, read: true, write: false };
                    if (d.unit) {
                        common.unit = d.unit;
                    }
                    if (d.states) {
                        common.states = { ...d.states };
                    }
                    await this._ensureChannel('info');
                    await this.adapter.extendObjectAsync(`${this.dev}.${id}`, { type: 'state', common, native: {} });
                    this.created.add(id);
                }
                await this.adapter.setStateChangedAsync(`${this.dev}.${id}`, { val, ack: true });
            })
            .catch(e => this.log.debug(`[${this.dev}] ${id}: ${e.message}`));
    }

    _cmdStatus(status, updates) {
        if (updates) {
            this._info(
                'info.lastCommand',
                Object.entries(updates)
                    .map(([p, v]) => `${p}=${v}`)
                    .join(', '),
            );
        }
        this._info('info.lastCommandStatus', status);
        this._info('info.lastCommandTime', Date.now());
        this._info('info.pendingCommands', this.inflight.size);
    }

    _trackOnline(doc) {
        const online = C.truthy(C.getPath(doc, 'present'));
        if (online === this.wasOnline) {
            return;
        }
        if (online) {
            if (this.wasOnline === false) {
                this.log.info(`[${this.dev}] Controller is online again`);
            }
            this._info('info.offlineSince', 0);
        } else {
            const upd = C.num(doc.updatedAt);
            const since = upd > 0 && upd * 1000 <= Date.now() ? upd * 1000 : Date.now();
            this.log.info(`[${this.dev}] Controller is offline (last report ${new Date(since).toISOString()})`);
            this._info('info.offlineSince', since);
        }
        this.wasOnline = online;
    }

    // ------------------------------------------------------------------ controller clock
    /**
     * Compare the controller clock (main.localTime) with the time of the report (updatedAt).
     * The clock drifts and does not follow daylight saving time; timers would run off.
     *
     * @param {object} doc pool document
     */
    _checkClock(doc) {
        const local = C.num(C.getPath(doc, 'main.localTime'));
        const upd = C.num(doc.updatedAt);
        if (!(local > 0) || !(upd > 0) || !C.truthy(doc.present) || local === this.clock.lastLocal) {
            return;
        }
        this.clock.lastLocal = local;
        const drift = local - Clock.localEpoch(new Date(upd * 1000), this.zone);
        if (Math.abs(drift) > 36 * 3600) {
            this.clock.prevDrift = null;
            return;
        } // garbage
        this._info('info.clockDrift', Math.round(drift / 60));
        const prev = this.clock.prevDrift;
        this.clock.prevDrift = drift;
        if (!this.opts.clockSync) {
            return;
        }
        const limit = (this.opts.clockMaxDrift ?? CLOCK_MAX_DRIFT) * 60;
        if (Math.abs(drift) <= limit) {
            return;
        }
        if (this.zoneUnsure) {
            if (!this.clock.warned) {
                this.log.warn(
                    `[${this.dev}] Controller clock is ${Math.round(drift / 60)} min off, but the host runs in UTC. Set the time zone in the instance settings to enable the automatic clock sync.`,
                );
                this.clock.warned = true;
            }
            return;
        }
        // two consistent samples, at most every 6 h, never while commands are open
        if (prev === null || Math.abs(prev - drift) > 120) {
            return;
        }
        if (Date.now() - this.clock.lastSync < CLOCK_SYNC_MIN_INTERVAL || this.inflight.size || this.batch) {
            return;
        }
        this.clock.lastSync = Date.now();
        this.clock.prevDrift = null;
        this.log.info(
            `[${this.dev}] Controller clock is ${Math.round(drift / 60)} min off – setting it (${this.zone})`,
        );
        this._enqueue(() => this._syncClock());
    }

    async _syncClock() {
        if (this.zoneUnsure) {
            this.log.warn(
                `[${this.dev}] Host runs in UTC – the controller is set to UTC. Set the time zone in the instance settings if that is wrong.`,
            );
        }
        await this._send(
            { 'main.localTime': Clock.localEpoch(new Date(), this.zone) },
            { noTrack: true, silent: true },
        );
        this.clock.lastSync = Date.now();
        this._info('info.lastClockSync', Date.now());
    }

    // ------------------------------------------------------------------ objects
    async _ensureChannel(channel) {
        if (this.created.has(channel)) {
            return;
        }
        await this.adapter.extendObjectAsync(`${this.dev}.${channel}`, {
            type: 'channel',
            common: { name: channel },
            native: {},
        });
        this.created.add(channel);
    }

    async _ensureObjects(doc) {
        const a = this.adapter;
        if (!this.created.has('')) {
            const name = C.getPath(doc, 'form.name') || this.poolId;
            await a.extendObjectAsync(this.dev, {
                type: 'device',
                common: { name: String(name) },
                native: { poolId: this.poolId },
            });
            this.created.add('');
        }
        for (const dp of CATALOG) {
            if (this.created.has(dp.id) || !C.exists(dp, doc)) {
                continue;
            }
            await this._ensureChannel(dp.id.split('.')[0]);
            await a.extendObjectAsync(`${this.dev}.${dp.id}`, {
                type: 'state',
                common: this._common(dp, doc),
                native: { path: dp.path, source: dp.source },
            });
            this.created.add(dp.id);
        }
    }

    _common(dp, doc) {
        let name = dp.name;
        const rm = /^relay\.aux(\d)/.exec(dp.id);
        if (rm) {
            const label = this._relayLabel(Number(rm[1]), doc);
            if (label.en) {
                name = { en: `${dp.name.en} – ${label.en}`, de: `${dp.name.de} – ${label.de}` };
            }
        }
        const common = { name, type: dp.type, role: dp.role, read: !dp.action, write: !!dp.write };
        const unit = C.unitOf(dp, doc);
        if (unit) {
            common.unit = unit;
        }
        if (dp.type === 'number' && dp.write && !dp.states) {
            if (dp.min !== undefined) {
                common.min = dp.min;
            }
            const max = C.maxOf(dp, doc);
            if (max !== undefined) {
                common.max = max;
            }
            if (dp.step !== undefined) {
                common.step = dp.step;
            }
        }
        if (dp.states) {
            common.states = { ...dp.states };
        }
        if (dp.action) {
            common.def = false;
        }
        if (dp.conv === 'timeOfDay' && dp.write) {
            common.desc = 'HH:MM';
        }
        return common;
    }

    /**
     * Relay label: use from the instance settings, otherwise name from the cloud.
     *
     * @param n
     * @param doc
     */
    _relayLabel(n, doc) {
        const use = USE_LABELS[(this.opts.relayUse || {})[n]];
        const cloud = String(C.getPath(doc, `relays.relay${n}.name`) || '').trim();
        const join = l => [use ? use[l] : '', cloud].filter(Boolean).join(', ');
        return { en: join('en'), de: join('de') };
    }

    async _writeStates(doc) {
        for (const dp of CATALOG) {
            if (dp.action || !this.created.has(dp.id)) {
                continue;
            }
            const val = C.toState(dp, doc);
            if (val === undefined) {
                continue;
            }
            await this.adapter.setStateChangedAsync(`${this.dev}.${dp.id}`, { val, ack: true });
        }
    }

    async _writeRaw(rawDoc) {
        const flat = C.flatten(rawDoc);
        for (const [p, v] of Object.entries(flat)) {
            if (RAW_EXCLUDE.some(x => p === x || p.startsWith(`${x}.`))) {
                continue;
            }
            const id = `raw.${p.split('.').map(C.safeId).join('.')}`;
            if (!this.created.has(id)) {
                const type = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string';
                await this.adapter.extendObjectAsync(`${this.dev}.${id}`, {
                    type: 'state',
                    common: { name: p, type, role: 'value', read: true, write: false },
                    native: { path: p },
                });
                this.created.add(id);
            }
            const val = v === null || typeof v === 'object' ? JSON.stringify(v) : v;
            await this.adapter.setStateChangedAsync(`${this.dev}.${id}`, { val, ack: true });
        }
    }

    // ------------------------------------------------------------------ writing
    /**
     * Called by main.js when a state was changed with ack=false.
     * Writes within COALESCE_MS are merged into one command per branch; the returned
     * promise resolves when the merged command has been sent (or failed).
     *
     * @param {string} relId state ID relative to the pool device
     * @param {any} val new value
     */
    handleStateChange(relId, val) {
        const dp = this.byStateId.get(relId);
        if (!dp || !dp.write) {
            this.log.warn(`[${this.dev}] ${relId} is read-only`);
            return dp ? this._resetState(dp) : Promise.resolve();
        }
        if (dp.action) {
            return this._enqueue(() =>
                this._action(dp).catch(e => {
                    this.log.warn(`[${this.dev}] ${dp.id} failed: ${e.message}`);
                    this._cmdStatus('error');
                }),
            );
        }
        if (!this.batch) {
            let resolve;
            const promise = new Promise(r => (resolve = r));
            const delay = this.opts.coalesceMs ?? COALESCE_MS;
            this.batch = { items: new Map(), promise, resolve };
            this.batch.timer = this._timer(() => this._flushBatch(), delay);
        }
        this.batch.items.delete(dp.id); // keep order of the last write
        this.batch.items.set(dp.id, { dp, val });
        return this.batch.promise;
    }

    _flushBatch() {
        const b = this.batch;
        if (!b) {
            return;
        }
        this.batch = null;
        this._enqueue(() => this._writeBatch([...b.items.values()])).then(b.resolve, b.resolve);
    }

    async _resetState(dp) {
        if (!dp.action && this.doc && this.created.has(dp.id)) {
            await this.adapter.setStateAsync(`${this.dev}.${dp.id}`, { val: C.toState(dp, this.doc), ack: true });
        }
    }

    async _writeBatch(items) {
        if (!this.doc) {
            this.log.warn(`[${this.dev}] No data from the pool yet – ${items.map(i => i.dp.id).join(', ')} not sent`);
            return;
        }
        if (!C.truthy(C.getPath(this.doc, 'present'))) {
            this.log.warn(
                `[${this.dev}] Controller reports offline – command is sent anyway and repeated when it is back`,
            );
        }
        await this._refresh();

        // group by branch; commands the controller ignores in its current mode are not tracked
        const groups = new Map();
        for (const it of items) {
            let updates;
            try {
                updates = C.fromState(it.dp, it.val, this.doc);
            } catch (e) {
                this.log.warn(`[${this.dev}] ${it.dp.id} = ${JSON.stringify(it.val)} not sent: ${e.message}`);
                await this._resetState(it.dp);
                continue;
            }
            const hint = modeHint(it.dp, this.doc);
            if (hint) {
                this.log.warn(`[${this.dev}] ${it.dp.id}: ${hint}`);
            }
            for (const [p, v] of Object.entries(updates)) {
                const key = `${C.branchSignature(p)}${hint ? '#untracked' : ''}`;
                if (!groups.has(key)) {
                    groups.set(key, { updates: {}, items: new Set(), noTrack: !!hint });
                }
                const g = groups.get(key);
                g.updates[p] = v;
                g.items.add(it);
            }
        }
        for (const g of groups.values()) {
            try {
                await this._send(g.updates, g.noTrack ? { noTrack: true } : {});
            } catch (e) {
                const ids = [...g.items].map(i => `${i.dp.id} = ${JSON.stringify(i.val)}`).join(', ');
                this.log.warn(`[${this.dev}] ${ids} not sent: ${e.message}`);
                this._cmdStatus('error', g.updates);
                for (const it of g.items) {
                    await this._resetState(it.dp);
                }
            }
        }
        await this._writeStates(this.doc); // acknowledge incl. dependent states
    }

    async _action(dp) {
        if (!this.doc) {
            throw new Error('no data from the pool yet');
        }
        await this._refresh();
        if (dp.action === 'syncTime') {
            await this._syncClock();
        } else if (dp.action === 'ledPulse') {
            if (C.num(C.getPath(this.doc, 'light.status')) === 1) {
                await this._send({ 'light.status': 0 });
                await this._delay(LED_PULSE_DELAY);
            }
            await this._send({ 'light.status': 1 });
        }
        await this.adapter.setStateAsync(`${this.dev}.${dp.id}`, { val: false, ack: true });
    }

    /**
     * Apply settings from the instance page (changed fields only).
     *
     * @param {string} section settings section
     * @param {object} values form values
     * @param {string} [lang] language of the returned texts
     * @returns {Promise<string[]>} list of changes (readable)
     */
    applySettings(section, values, lang) {
        const run = async () => {
            if (!this.doc) {
                throw new Error(lang === 'de' ? 'Noch keine Daten vom Pool' : 'No data from the pool yet');
            }
            await this._refresh();
            const { groups, changes } = S.diff(section, values, this.doc, lang);
            for (const g of groups) {
                await this._send(g.updates, g.branch ? { branch: g.branch } : {});
            }
            if (groups.length) {
                await this._writeStates(this.doc);
            }
            return changes;
        };
        return this._enqueue(run);
    }

    /**
     * Fetch the current state right before a command: the command always carries the whole
     * branch - without a fresh state it could overwrite a change made in the app since the last
     * read. Not needed while push updates arrive.
     */
    async _refresh() {
        if (typeof this.cloud.getPool !== 'function' || (this.opts.isLive && this.opts.isLive())) {
            return;
        }
        try {
            const fresh = await this.cloud.getPool(this.poolId);
            if (fresh) {
                await this.update(fresh);
            }
        } catch (e) {
            this.log.debug(`[${this.dev}] Refresh before sending failed: ${e.message}`);
        }
    }

    async _rateLimit() {
        const limit = this.opts.maxPerMinute ?? MAX_PER_MINUTE;
        if (!limit) {
            return;
        }
        const now = Date.now();
        this.sendTimes = this.sendTimes.filter(t => now - t < 60000);
        if (this.sendTimes.length >= limit) {
            const wait = 60000 - (now - this.sendTimes[0]) + 50;
            this.log.info(`[${this.dev}] More than ${limit} commands per minute – waiting ${Math.ceil(wait / 1000)} s`);
            await this._delay(wait);
        }
        this.sendTimes.push(Date.now());
    }

    async _send(updates, opts = {}) {
        const { payload, effective } = C.buildCommand(this.doc, this.poolId, updates, {
            ...opts,
            hidroDisable: this.opts.hidroDisable,
        });
        // safety net: never send back a branch with implausible values
        const branch = JSON.parse(payload.changes);
        const { transients } = C.sanitize(branch, null, CATALOG);
        if (transients.length) {
            throw new Error(`branch contains implausible values (${transients.join(', ')}), command dropped`);
        }

        await this._rateLimit();
        this.log.debug(`[${this.dev}] sendPoolCommand ${JSON.stringify(effective)}`);
        await this.cloud.sendCommand(payload);
        const text = Object.entries(updates)
            .map(([p, v]) => `${p}=${v}`)
            .join(', ');
        if (opts.silent) {
            this.log.debug(`[${this.dev}] sent: ${text}`);
        } else {
            this.log.info(`[${this.dev}] sent: ${text}`);
        }

        const until = Date.now() + PENDING_TTL;
        // confirm only fields the cloud stores (e.g. not hidro.disable)
        const check = Object.fromEntries(
            Object.entries(effective).filter(([p]) => C.getPath(this.doc, p) !== undefined),
        );
        const key = opts.branch || C.branchSignature(Object.keys(updates)[0]);
        const prev = this.inflight.get(key);
        if (opts.noTrack) {
            this.inflight.delete(key);
        } else {
            this.inflight.set(key, {
                createdAt: prev && opts.retry ? prev.createdAt : Date.now(),
                updates: { ...(prev && !opts.retry ? prev.updates : {}), ...updates },
                opts: { branch: opts.branch },
                check: { ...(prev && !opts.retry ? prev.check : {}), ...check },
                sentAt: Date.now(),
                retries: opts.retry || 0,
                offline: false,
            });
        }
        this._cmdStatus(opts.noTrack ? 'untracked' : opts.retry ? 'retrying' : 'sent', updates);
        if (!opts.noTrack || !opts.silent) {
            for (const [p, v] of Object.entries(effective)) {
                if (p === 'main.localTime') {
                    continue;
                }
                this.pending.set(p, { value: v, until });
                C.setPath(this.doc, p, v);
                // relays: the output (info.status) follows onoff only after confirmation - carry it
                // along until then, otherwise relay.auxN still shows the old state
                const m = /^relays\.(relay\d)\.info\.onoff$/.exec(p);
                if (m && C.num(C.getPath(this.doc, `relays.${m[1]}.info.manAutoTemp`)) === 0) {
                    this.pending.set(`relays.${m[1]}.info.status`, { value: v, until });
                    C.setPath(this.doc, `relays.${m[1]}.info.status`, v);
                }
            }
        }
        if (this.opts.requestRefresh) {
            this.opts.requestRefresh();
        }
        const gap = this.opts.commandGap ?? COMMAND_GAP;
        if (gap) {
            await this._delay(gap);
        }
    }
}

module.exports = { PoolHandler, PENDING_TTL, CONFIRM_TIMEOUT, USE_LABELS, modeHint };
