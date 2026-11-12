'use strict';
/**
 * Push updates of pool documents via the Firestore Listen stream (gRPC) - the same mechanism the
 * Vistapool web app uses (onSnapshot). Authenticated with the Firebase ID token of the account.
 *
 * Events:
 *   'doc'      (poolId, data)  new state of a pool document
 *   'live'     ()              stream is current (initial state received)
 *   'down'     (error|null)    stream closed; it reconnects by itself with backoff
 */
const path = require('node:path');
const EventEmitter = require('node:events');
const { fsFields, PROJECT } = require('./cloud');

const HOST = 'firestore.googleapis.com:443';
const DATABASE = `projects/${PROJECT}/databases/(default)`;
const TARGET_ID = 0x5157;
const STREAM_MAX_AGE = 45 * 60 * 1000; // reopen before the ID token (1 h) expires
const BACKOFF_MIN = 2000;
const BACKOFF_MAX = 10 * 60 * 1000;
const CONNECT_TIMEOUT = 60 * 1000; // no CURRENT within this time -> reconnect

let grpc;
let Firestore;
function loadGrpc() {
    if (!Firestore) {
        grpc = require('@grpc/grpc-js');
        const protoLoader = require('@grpc/proto-loader');
        const def = protoLoader.loadSync(path.join(__dirname, 'proto', 'listen.proto'), {
            keepCase: false,
            longs: String,
            enums: String,
            defaults: false,
            oneofs: true,
        });
        Firestore = grpc.loadPackageDefinition(def).google.firestore.v1.Firestore;
    }
    return Firestore;
}

class PoolListener extends EventEmitter {
    /**
     * @param {import('./cloud').VistapoolCloud} cloud
     * @param {{debug: Function, info: Function, warn: Function}} log
     * @param {{timers?: object, host?: string, insecure?: boolean, backoffMin?: number, maxAge?: number}} [opts] timers of the adapter; the rest for tests
     */
    constructor(cloud, log, opts = {}) {
        super();
        this.cloud = cloud;
        this.log = log;
        this.opts = opts;
        this.poolIds = [];
        this.call = null;
        this.client = null;
        this.live = false;
        this.stopped = true;
        this.resumeToken = null;
        this.backoff = opts.backoffMin || BACKOFF_MIN;
        this.failures = 0;
        this.timers = {};
        this.lastError = '';
        // timer functions of the adapter (cleared automatically on unload), plain timers in tests
        this.clock = opts.timers || { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    }

    /** True while the stream delivers current data. */
    get active() {
        return this.live;
    }

    /**
     * Set the watched pools (restarts the stream if they changed).
     *
     * @param {string[]} ids pool IDs
     */
    setPools(ids) {
        const next = [...ids].sort();
        if (next.join() === this.poolIds.join()) {
            return;
        }
        this.poolIds = next;
        this.resumeToken = null;
        if (!this.stopped) {
            this._reopen(0);
        }
    }

    start() {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        this._reopen(0);
    }

    stop() {
        this.stopped = true;
        for (const t of Object.values(this.timers)) {
            this.clock.clearTimeout(t);
        }
        this._close();
        if (this.client) {
            this.client.close();
            this.client = null;
        }
    }

    _timer(name, ms, fn) {
        this.clock.clearTimeout(this.timers[name]);
        this.timers[name] = this.clock.setTimeout(fn, ms);
    }

    _reopen(delay) {
        this._close();
        this._timer('open', delay, () => this._open().catch(e => this._down(e)));
    }

    _close() {
        this.clock.clearTimeout(this.timers.recycle);
        this.clock.clearTimeout(this.timers.connect);
        const call = this.call;
        this.call = null;
        if (call) {
            call.removeAllListeners();
            call.on('error', () => {}); // swallow CANCELLED
            call.cancel();
        }
        if (this.live) {
            this.live = false;
            this.emit('down', null);
        }
    }

    _client() {
        if (!this.client) {
            const Svc = loadGrpc();
            let creds;
            if (this.opts.insecure) {
                creds = grpc.credentials.createInsecure();
            } else {
                const callCreds = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
                    const md = new grpc.Metadata();
                    md.add('authorization', `Bearer ${this.cloud.tokens?.idToken || ''}`);
                    cb(null, md);
                });
                creds = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), callCreds);
            }
            this.client = new Svc(this.opts.host || HOST, creds, {
                'grpc.keepalive_time_ms': 5 * 60 * 1000,
                'grpc.keepalive_timeout_ms': 20 * 1000,
                'grpc.primary_user_agent': 'iobroker.vistapool',
            });
        }
        return this.client;
    }

    async _open() {
        if (this.stopped || this.call || !this.poolIds.length) {
            return;
        }
        const maxAge = this.opts.maxAge || STREAM_MAX_AGE;
        await this.cloud.ensureAuth(false, maxAge + 5 * 60 * 1000);
        if (this.stopped || this.call) {
            return;
        }
        const client = this._client(); // also loads grpc
        const md = new grpc.Metadata();
        md.add('google-cloud-resource-prefix', DATABASE);
        md.add('x-goog-request-params', `database=${encodeURIComponent(DATABASE)}`);
        if (this.opts.insecure) {
            md.add('authorization', `Bearer ${this.cloud.tokens?.idToken || ''}`);
        }
        const call = client.Listen(md);
        this.call = call;
        call.on('data', m => this._onMessage(m));
        call.on('error', e => this._down(e));
        call.on('end', () => this._down(null));

        const target = {
            targetId: TARGET_ID,
            documents: { documents: this.poolIds.map(id => `${DATABASE}/documents/pools/${id}`) },
        };
        if (this.resumeToken) {
            target.resumeToken = this.resumeToken;
        }
        call.write({ database: DATABASE, addTarget: target });
        this.log.debug(`Push: stream opened for ${this.poolIds.length} pool(s)${this.resumeToken ? ' (resumed)' : ''}`);
        this._timer('connect', CONNECT_TIMEOUT, () => this._down(new Error('no initial data from the push stream')));
        this._timer('recycle', maxAge, () => {
            this.log.debug('Push: renewing stream');
            this._reopen(0);
        });
    }

    _onMessage(m) {
        if (m.targetChange) {
            const tc = m.targetChange;
            const type = tc.targetChangeType || 'NO_CHANGE';
            if (
                tc.resumeToken &&
                tc.resumeToken.length &&
                (!tc.targetIds || !tc.targetIds.length || tc.targetIds.includes(TARGET_ID))
            ) {
                this.resumeToken = tc.resumeToken;
            }
            if (type === 'REMOVE') {
                const cause = tc.cause ? `${tc.cause.code} ${tc.cause.message}` : 'target removed';
                this._down(Object.assign(new Error(`push target removed: ${cause}`), { code: tc.cause?.code }));
                return;
            }
            if (type === 'RESET') {
                this.resumeToken = null;
            }
            if (type === 'CURRENT' && !this.live) {
                this.clock.clearTimeout(this.timers.connect);
                this.live = true;
                this.failures = 0;
                this.backoff = this.opts.backoffMin || BACKOFF_MIN;
                if (this.lastError) {
                    this.log.info('Push: connected again');
                }
                this.lastError = '';
                this.emit('live');
            }
            return;
        }
        if (m.documentChange && m.documentChange.document) {
            const d = m.documentChange.document;
            const id = String(d.name || '')
                .split('/')
                .pop();
            this.emit('doc', id, fsFields(d.fields || {}));
            return;
        }
        if (m.documentDelete || m.documentRemove) {
            const name = (m.documentDelete || m.documentRemove).document || '';
            this.log.warn(`Push: pool ${name.split('/').pop()} is no longer accessible`);
        }
    }

    _down(err) {
        if (!this.call && !err) {
            return;
        }
        const wasLive = this.live;
        this._close();
        if (this.stopped) {
            return;
        }
        const code = err && err.code;
        if (code === 16 /* UNAUTHENTICATED */ || code === 7 /* PERMISSION_DENIED */) {
            this.cloud.tokens && (this.cloud.expiry = 0); // force token refresh on next open
        }
        if (wasLive && !err) {
            // server closed a healthy stream (normal from time to time): reconnect right away
            this._reopen(500);
            return;
        }
        this.failures++;
        const msg = err ? err.details || err.message : 'stream ended';
        const delay = Math.min(this.backoff, BACKOFF_MAX);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
        if (msg !== this.lastError && this.failures <= 3) {
            this.log.info(`Push: ${msg} – polling is used meanwhile, reconnecting in ${Math.round(delay / 1000)} s`);
        } else {
            this.log.debug(`Push: ${msg} – reconnecting in ${Math.round(delay / 1000)} s`);
        }
        this.lastError = msg;
        this.emit('down', err || null);
        const jitter = Math.round(delay * 0.2 * Math.random());
        this._reopen(delay + jitter);
    }
}

module.exports = { PoolListener, DATABASE, TARGET_ID };
