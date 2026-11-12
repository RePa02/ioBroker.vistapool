'use strict';
/**
 * Access to the Hayward/Vistapool cloud (Firebase project "hayward-europe").
 *  - Sign-in: Firebase Identity Toolkit (e-mail/password), token refresh via securetoken
 *  - Read:    Firestore REST (users/{uid}, pools/{poolId}); push see listener.js
 *  - Write:   Cloud Function sendPoolCommand (operation WRP)
 * Uses the global fetch of Node.js.
 */

// Public Firebase web key of the Hayward web app (same as aioaquarite/const.py). Not a secret:
// Firebase web API keys only identify the project; access is protected by Firebase Authentication.
const API_KEY = 'AIzaSyBLaxiyZ2nS1KgRBqWe-NY4EG7OzG5fKpE';
const IDENTITY_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const SECURETOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
const REFERRER = 'https://hayward-europe.web.app/';
const ORIGIN = 'https://hayward-europe.web.app';
const PROJECT = 'hayward-europe';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FUNCTIONS = `https://europe-west1-${PROJECT}.cloudfunctions.net`;
const HTTP_TIMEOUT = 20000;

class CloudError extends Error {
    constructor(message, { status, code, auth = false, network = false } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.auth = auth;
        this.network = network;
    }
}

async function http(url, { method = 'GET', headers = {}, body, form } = {}) {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(HTTP_TIMEOUT) };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    if (form !== undefined) {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(form).toString();
    }
    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        throw new CloudError(
            `network error at ${new URL(url).host}: ${e.cause?.code || e.cause?.message || e.message}`,
            { network: true },
        );
    }
    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
}

function fsValue(v) {
    if (v == null) {
        return null;
    }
    if ('stringValue' in v) {
        return v.stringValue;
    }
    if ('integerValue' in v) {
        return Number(v.integerValue);
    }
    if ('doubleValue' in v) {
        return Number(v.doubleValue);
    }
    if ('booleanValue' in v) {
        return v.booleanValue;
    }
    if ('nullValue' in v) {
        return null;
    }
    if ('timestampValue' in v) {
        const t = v.timestampValue; // REST: RFC 3339 string, gRPC: { seconds, nanos }
        return t && typeof t === 'object'
            ? new Date(Number(t.seconds) * 1000 + Math.round((t.nanos || 0) / 1e6)).toISOString()
            : t;
    }
    if ('referenceValue' in v) {
        return v.referenceValue;
    }
    if ('bytesValue' in v) {
        return Buffer.isBuffer(v.bytesValue) ? v.bytesValue.toString('base64') : v.bytesValue;
    }
    if ('geoPointValue' in v) {
        return { latitude: v.geoPointValue.latitude, longitude: v.geoPointValue.longitude };
    }
    if ('arrayValue' in v) {
        return (v.arrayValue.values || []).map(fsValue);
    }
    if ('mapValue' in v) {
        return fsFields(v.mapValue.fields || {});
    }
    return v;
}
function fsFields(fields) {
    const o = {};
    for (const [k, v] of Object.entries(fields || {})) {
        o[k] = fsValue(v);
    }
    return o;
}

class VistapoolCloud {
    /**
     * @param {string} email
     * @param {string} password
     * @param {{debug: Function, info: Function, warn: Function}} log
     */
    constructor(email, password, log) {
        this.email = email;
        this.password = password;
        this.log = log;
        this.tokens = null;
        this.expiry = 0;
        this._authPromise = null;
    }

    get uid() {
        return this.tokens?.uid;
    }

    async login() {
        const r = await http(`${IDENTITY_URL}?key=${API_KEY}`, {
            method: 'POST',
            headers: { Referer: REFERRER, Origin: ORIGIN },
            body: { email: this.email, password: this.password, returnSecureToken: true },
        });
        if (!r.ok) {
            const code = r.json?.error?.message || `HTTP ${r.status}`;
            const auth = /INVALID|EMAIL_NOT_FOUND|PASSWORD|USER_DISABLED|MISSING/i.test(code);
            throw new CloudError(`sign-in failed: ${code}`, { status: r.status, code, auth });
        }
        this.tokens = { idToken: r.json.idToken, refreshToken: r.json.refreshToken, uid: r.json.localId };
        this.expiry = Date.now() + Number(r.json.expiresIn) * 1000;
        this.log.debug('Signed in');
    }

    async _refresh() {
        const r = await http(`${SECURETOKEN_URL}?key=${API_KEY}`, {
            method: 'POST',
            headers: { Referer: REFERRER, Origin: ORIGIN },
            form: { grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken },
        });
        if (!r.ok) {
            this.log.debug(`Token refresh failed (${r.status}), signing in again`);
            return this.login();
        }
        this.tokens.idToken = r.json.id_token;
        this.tokens.refreshToken = r.json.refresh_token;
        this.expiry = Date.now() + Number(r.json.expires_in) * 1000;
        this.log.debug('Token refreshed');
    }

    /**
     * Makes sure a valid token is available (safe for parallel calls).
     *
     * @param {boolean} [force]       sign in again
     * @param {number}  [minValidMs]  token must stay valid at least this long
     */
    async ensureAuth(force = false, minValidMs = 5 * 60 * 1000) {
        if (!force && this.tokens && Date.now() < this.expiry - minValidMs) {
            return;
        }
        if (!this._authPromise) {
            this._authPromise = (async () => {
                try {
                    if (this.tokens && !force) {
                        await this._refresh();
                    } else {
                        await this.login();
                    }
                } finally {
                    this._authPromise = null;
                }
            })();
        }
        return this._authPromise;
    }

    async _authorized(fn) {
        await this.ensureAuth();
        let r = await fn(this.tokens.idToken);
        if (r.status === 401) {
            await this.ensureAuth(true);
            r = await fn(this.tokens.idToken);
        }
        return r;
    }

    async getDoc(docPath) {
        const r = await this._authorized(t =>
            http(`${FIRESTORE}/${docPath}`, { headers: { Authorization: `Bearer ${t}` } }),
        );
        if (r.status === 404) {
            return null;
        }
        if (!r.ok) {
            throw new CloudError(
                `Firestore ${docPath.split('/')[0]}: HTTP ${r.status} ${r.json?.error?.message || ''}`.trim(),
                { status: r.status },
            );
        }
        return fsFields(r.json.fields);
    }

    /** @returns {Promise<string[]>} Pool-IDs des Kontos */
    async getPoolIds() {
        await this.ensureAuth();
        const user = await this.getDoc(`users/${this.uid}`);
        return Array.isArray(user?.pools) ? user.pools.map(String) : [];
    }

    getPool(poolId) {
        return this.getDoc(`pools/${poolId}`);
    }

    async sendCommand(payload) {
        const r = await this._authorized(t =>
            http(`${FUNCTIONS}/sendPoolCommand`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${t}` },
                body: payload,
            }),
        );
        if (!r.ok) {
            throw new CloudError(`sendPoolCommand: HTTP ${r.status} ${r.text?.slice(0, 200) || ''}`.trim(), {
                status: r.status,
            });
        }
        return r.json ?? r.text;
    }

    async getStats(poolId, type, period = 30) {
        const r = await this._authorized(t =>
            http(`${FUNCTIONS}/getStats`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${t}` },
                body: { uuid: poolId, type, period },
            }),
        );
        if (!r.ok) {
            throw new CloudError(`getStats ${type}: HTTP ${r.status}`, { status: r.status });
        }
        return Array.isArray(r.json) ? r.json : [];
    }
}

module.exports = { VistapoolCloud, CloudError, fsFields, PROJECT };
