'use strict';
/**
 * ioBroker.vistapool
 * Cloud connection for Vistapool / Hayward AquaRite / Sugar Valley pool controllers.
 */
const utils = require('@iobroker/adapter-core');
const { VistapoolCloud } = require('./lib/cloud');
const { PoolListener } = require('./lib/listener');
const { PoolHandler } = require('./lib/pool');
const Settings = require('./lib/settings');
const C = require('./lib/convert');

const MIN_INTERVAL = 15;
const PUSH_POLL_INTERVAL = 15 * 60 * 1000; // safety poll while push works
const MAX_BACKOFF = 15 * 60 * 1000;
const AUTH_RETRY_MS = 10 * 60 * 1000;
const POOL_RESCAN_MS = 60 * 60 * 1000;

class Vistapool extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'vistapool' });
        this.pools = new Map();
        this.timer = null;
        this.refreshTimers = [];
        this.lastRescan = 0;
        this.polling = false;
        this.stopped = false;
        this.failures = 0;
        this.nextPollAt = 0;
        this.lang = 'en';
        this.listener = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    get pushLive() {
        return !!(this.listener && this.listener.active);
    }

    t(en, de) {
        return this.lang === 'de' ? de : en;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        await this.setStateAsync('info.push', false, true);
        try {
            const sys = await this.getForeignObjectAsync('system.config');
            this.lang = sys?.common?.language === 'de' ? 'de' : 'en';
        } catch {
            // keep default
        }
        const { email, password } = this.config;
        if (!email || !password) {
            this.log.error('Please enter e-mail and password of the Vistapool account in the instance settings.');
            return;
        }
        this.interval = Math.max(MIN_INTERVAL, Number(this.config.pollInterval) || 30) * 1000;
        this.cloud = new VistapoolCloud(email, password, this.log);
        if (this.config.push !== false) {
            this.listener = new PoolListener(this.cloud, this.log, {
                timers: { setTimeout: (fn, ms) => this.setTimeout(fn, ms), clearTimeout: t => this.clearTimeout(t) },
            });
            this.listener.on('doc', (id, data) => this.onPushDoc(id, data));
            this.listener.on('live', () => {
                this.setStateChanged('info.push', true, true);
                this.setStateChanged('info.connection', true, true);
                this.log.debug('Push: live');
            });
            this.listener.on('down', () => {
                this.setStateChanged('info.push', false, true);
                // fall back to polling right away instead of waiting for the slow safety poll
                if (!this.stopped && this.nextPollAt - Date.now() > this.interval) {
                    this.schedulePoll(this.interval);
                }
            });
        }
        this.subscribeStates('*');
        await this.poll();
        if (this.listener) {
            this.listener.start();
        }
    }

    handlerOptions() {
        const cfg = this.config;
        const n = (v, d) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
        return {
            rawMirror: !!cfg.rawMirror,
            hidroDisable: cfg.boostPauseControl === false ? 0 : 1,
            commandMaxAge: n(cfg.commandMaxAge, 10),
            relayUse: { 1: cfg.relayUse1, 2: cfg.relayUse2, 3: cfg.relayUse3, 4: cfg.relayUse4 },
            clockSync: cfg.clockSync !== false,
            clockMaxDrift: Math.max(1, n(cfg.clockMaxDrift, 3)),
            timeZone: String(cfg.timeZone || '').trim(),
            requestRefresh: () => this.scheduleRefresh(),
            isLive: () => this.pushLive,
        };
    }

    async discoverPools() {
        const ids = await this.cloud.getPoolIds();
        if (!ids.length) {
            this.log.warn('No pool is registered in the Vistapool account.');
        }
        for (const id of ids) {
            if (this.pools.has(id)) {
                continue;
            }
            this.pools.set(id, new PoolHandler(this, this.cloud, id, this.handlerOptions()));
            this.log.info(`Pool found: ${id}`);
        }
        this.lastRescan = Date.now();
        if (this.listener) {
            this.listener.setPools([...this.pools.keys()]);
        }
    }

    onPushDoc(id, data) {
        const handler = this.pools.get(id);
        if (!handler) {
            return;
        }
        handler.update(data).catch(e => this.log.warn(`[${handler.dev}] ${e.message}`));
    }

    schedulePoll(ms) {
        if (this.stopped) {
            return;
        }
        this.clearTimeout(this.timer);
        this.nextPollAt = Date.now() + ms;
        this.timer = this.setTimeout(() => this.poll(), ms);
    }

    async poll() {
        if (this.stopped || this.polling) {
            return;
        }
        this.polling = true;
        let next;
        try {
            if (!this.pools.size || Date.now() - this.lastRescan > POOL_RESCAN_MS) {
                await this.discoverPools();
            }
            for (const [id, handler] of this.pools) {
                const doc = await this.cloud.getPool(id);
                if (!doc) {
                    this.log.warn(`Pool ${id} cannot be read any more`);
                    continue;
                }
                await handler.update(doc);
            }
            await this.setStateChangedAsync('info.connection', true, true);
            if (this.failures) {
                this.log.info('Cloud reachable again');
            }
            this.failures = 0;
            next = this.pushLive ? PUSH_POLL_INTERVAL : this.interval;
        } catch (e) {
            this.failures++;
            if (!this.pushLive) {
                await this.setStateChangedAsync('info.connection', false, true);
            }
            if (e.auth) {
                this.log.error(`${e.message} – please check the credentials. Next attempt in 10 minutes.`);
                next = AUTH_RETRY_MS;
            } else {
                // back off on repeated errors (cloud overloaded, network down, rate limited)
                next = Math.min(this.interval * 2 ** Math.min(this.failures - 1, 8), MAX_BACKOFF);
                const text = `Reading the cloud failed: ${e.message} – next attempt in ${Math.round(next / 1000)} s`;
                if (this.failures <= 3) {
                    this.log.warn(text);
                } else {
                    this.log.debug(text);
                }
            }
            if (this.pushLive) {
                next = Math.max(next, PUSH_POLL_INTERVAL);
            }
        } finally {
            this.polling = false;
        }
        this.schedulePoll(next);
    }

    /** After a command read again faster (5 s and 15 s) - only needed without push. */
    scheduleRefresh() {
        if (this.pushLive) {
            return;
        }
        for (const t of this.refreshTimers) {
            this.clearTimeout(t);
        }
        this.refreshTimers = [5000, 15000].map(ms => this.setTimeout(() => this.poll(), ms));
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1); // <pool>.<channel>.<state>
        const [dev, ...rest] = rel.split('.');
        const handler = [...this.pools.values()].find(h => h.dev === dev);
        if (!handler || !rest.length) {
            return;
        }
        await handler.handleStateChange(rest.join('.'), state.val);
    }

    // ------------------------------------------------------------------ instance page
    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        const reply = res => obj.callback && this.sendTo(obj.from, obj.command, res, obj.callback);
        const msg = typeof obj.message === 'string' ? safeJson(obj.message) : obj.message || {};
        const lang = msg.lang === 'de' || msg.lang === 'en' ? msg.lang : this.lang;
        const t = (en, de) => (lang === 'de' ? de : en);
        try {
            switch (obj.command) {
                case 'testConnection': {
                    const email = msg.email || this.config.email;
                    const password = msg.password || this.config.password;
                    if (!email || !password) {
                        return reply({
                            error: t('Please enter e-mail and password.', 'Bitte E-Mail und Passwort eingeben.'),
                        });
                    }
                    const cloud = new VistapoolCloud(email, password, this.log);
                    const ids = await cloud.getPoolIds();
                    const names = [];
                    for (const id of ids) {
                        names.push(C.getPath(await cloud.getPool(id), 'form.name') || id);
                    }
                    return reply({
                        result: ids.length
                            ? t(
                                  `Connection OK – ${ids.length} pool(s): ${names.join(', ')}`,
                                  `Verbindung OK – ${ids.length} Pool(s): ${names.join(', ')}`,
                              )
                            : t(
                                  'Connection OK, but no pool in the account.',
                                  'Verbindung OK, aber kein Pool im Konto.',
                              ),
                    });
                }
                case 'getPools': {
                    if (!this.cloud) {
                        return reply([]);
                    }
                    if (!this.pools.size) {
                        await this.discoverPools();
                    }
                    const list = [];
                    for (const [id, h] of this.pools) {
                        list.push({
                            value: id,
                            label: String(C.getPath(h.doc, 'form.name') || id),
                            noTranslation: true,
                        });
                    }
                    return reply(list);
                }
                case 'loadSettings': {
                    const h = await this._handlerFor(msg.poolId);
                    if (!this.pushLive) {
                        const doc = await this.cloud.getPool(h.poolId);
                        if (doc) {
                            await h.update(doc);
                        }
                    }
                    return reply({
                        native: {
                            ...Settings.load(h.doc),
                            poolId: h.poolId,
                            ...Object.fromEntries(Object.keys(Settings.SECTIONS).map(k => [`x_res_${k}`, ''])),
                        },
                    });
                }
                case 'applySettings': {
                    const h = await this._handlerFor(msg.poolId);
                    const changes = await h.applySettings(msg.section, msg.values || {}, lang);
                    const label = Settings.tr(Settings.SECTIONS[msg.section]?.label, lang) || msg.section;
                    this.log.info(
                        `${Settings.tr(Settings.SECTIONS[msg.section]?.label, 'en') || msg.section} from the instance page: ${changes.length ? changes.join('; ') : 'no change'}`,
                    );
                    const time = new Date().toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    const text = changes.length
                        ? t(
                              `${time} – ${label}: ${changes.length} change(s) sent\n${changes.join('\n')}`,
                              `${time} – ${label}: ${changes.length} Änderung(en) gesendet\n${changes.join('\n')}`,
                          )
                        : t(
                              `${time} – ${label}: no difference to the controller, nothing sent.`,
                              `${time} – ${label}: keine Änderung gegenüber der Anlage, nichts gesendet.`,
                          );
                    return reply({
                        native: { ...Settings.load(h.doc), poolId: h.poolId, [`x_res_${msg.section}`]: text },
                    });
                }
                case 'syncTime': {
                    const h = await this._handlerFor(msg.poolId);
                    await h.handleStateChange('button.syncTime', true);
                    return reply({
                        result: t('Controller clock has been set.', 'Uhrzeit der Steuerung wurde gesetzt.'),
                    });
                }
                default:
                    return reply({ error: `Unknown command ${obj.command}` });
            }
        } catch (e) {
            this.log.warn(`${obj.command}: ${e.message}`);
            return reply({ error: e.message });
        }
    }

    async _handlerFor(poolId) {
        if (!this.cloud) {
            throw new Error(
                this.t(
                    'Instance is not configured (e-mail/password missing).',
                    'Instanz ist nicht konfiguriert (E-Mail/Passwort fehlen).',
                ),
            );
        }
        if (!this.pools.size) {
            await this.discoverPools();
        }
        const h = (poolId && this.pools.get(poolId)) || this.pools.values().next().value;
        if (!h) {
            throw new Error(this.t('No pool found in the account.', 'Kein Pool im Konto gefunden.'));
        }
        if (!h.doc) {
            await h.update(await this.cloud.getPool(h.poolId));
        }
        return h;
    }

    onUnload(callback) {
        try {
            this.stopped = true;
            this.clearTimeout(this.timer);
            for (const t of this.refreshTimers) {
                this.clearTimeout(t);
            }
            if (this.listener) {
                this.listener.stop();
            }
            for (const h of this.pools.values()) {
                h.destroy();
            }
        } finally {
            callback();
        }
    }
}

function safeJson(s) {
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

if (require.main !== module) {
    module.exports = options => new Vistapool(options);
} else {
    new Vistapool();
}
