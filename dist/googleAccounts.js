"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleAccountError = void 0;
exports.configureGoogleAccountPersistence = configureGoogleAccountPersistence;
exports.refreshGoogleAccount = refreshGoogleAccount;
exports.fetchGoogleQuota = fetchGoogleQuota;
exports.fetchGoogleModels = fetchGoogleModels;
exports.acquireGoogleAccount = acquireGoogleAccount;
exports.getGooglePoolStatus = getGooglePoolStatus;
exports.resetGoogleAccountState = resetGoogleAccountState;
/** Google Cloud Code account pools. OAuth applications and credentials are supplied by the user. */
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const crypto_1 = require("crypto");
const googleAccessErrors_1 = require("./googleAccessErrors");
class GoogleAccountError extends Error {
    constructor(message, status = 503) {
        super(message);
        this.status = status;
        this.category = (0, googleAccessErrors_1.describeGoogleAccessError)(status).category;
    }
}
exports.GoogleAccountError = GoogleAccountError;
const tokenCache = new Map();
const refreshing = new Map();
const poolStates = new Map();
const sticky = new Map();
let selectionOrder = 0;
const MEASUREMENT_TTL_MS = 10 * 60000;
let persistAccount;
function configureGoogleAccountPersistence(callback) {
    persistAccount = callback;
}
function accountKey(account) {
    return (0, crypto_1.createHash)('sha256')
        .update(JSON.stringify([account.id, account.clientId, account.refreshToken || account.accessToken]))
        .digest('hex');
}
function poolKey(account) {
    // Account IDs survive refreshed/rotated credentials, so parallel models share one capacity limit.
    return (0, crypto_1.createHash)('sha256')
        .update(JSON.stringify([account.id, account.clientId]))
        .digest('hex');
}
function stateFor(account) {
    const key = poolKey(account);
    let state = poolStates.get(key);
    if (!state) {
        state = {
            id: account.id,
            label: account.label,
            inFlight: 0,
            lastUsed: 0,
            cooldownUntil: 0,
            modelCooldowns: new Map(),
            requests: 0,
            succeeded: 0,
            failed: 0,
            consecutiveFailures: 0,
        };
        poolStates.set(key, state);
    }
    state.label = account.label;
    for (const [model, cooldown] of state.modelCooldowns) {
        if (cooldown.until <= Date.now())
            state.modelCooldowns.delete(model);
    }
    return state;
}
function quotaIsFresh(quota, now = Date.now()) {
    return (!!quota &&
        now >= quota.checkedAt &&
        now - quota.checkedAt < MEASUREMENT_TTL_MS &&
        !quota.buckets.some((bucket) => bucket.resetTime && Date.parse(bucket.resetTime) <= now));
}
function quotaExhausted(state, now = Date.now()) {
    // A depleted Claude bucket must not disable an account with remaining Gemini quota.
    return (quotaIsFresh(state.quota, now) &&
        !!state.quota?.buckets.length &&
        state.quota.buckets.every((bucket) => bucket.remainingFraction === 0));
}
function measuredLatency(state, now = Date.now()) {
    return state.latency && now - state.latency.measuredAt < MEASUREMENT_TTL_MS ? state.latency.average : undefined;
}
function adaptiveScore(state) {
    const quota = quotaIsFresh(state.quota) ? state.quota?.remainingFraction : undefined;
    return ((quota ?? 0.5) * 100 -
        state.inFlight * 20 -
        Math.min(40, (measuredLatency(state) ?? 0) / 100) -
        Math.min(30, state.consecutiveFailures * 10));
}
function selectAdaptive(candidates) {
    if (candidates.length < 2)
        return candidates[0];
    const first = (0, crypto_1.randomInt)(candidates.length);
    let second = (0, crypto_1.randomInt)(candidates.length - 1);
    if (second >= first)
        second++;
    const a = stateFor(candidates[first]), b = stateFor(candidates[second]);
    const difference = adaptiveScore(a) - adaptiveScore(b);
    return difference > 0 || (difference === 0 && a.lastUsed <= b.lastUsed) ? candidates[first] : candidates[second];
}
function validAccess(account) {
    return (!!account.accessToken &&
        !/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.accessToken) &&
        (!account.expiresAt || account.expiresAt > Date.now() + 60000));
}
function checkedEndpoint(value, hosts) {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) ||
        (!local && (url.protocol !== 'https:' || !hosts.includes(url.hostname))) ||
        url.username ||
        url.password) {
        throw new GoogleAccountError('Google credentials may only be sent to the configured official service.', 400);
    }
    return url;
}
async function postJson(url, headers, body) {
    return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (response) => {
            let bytes = 0;
            const chunks = [];
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > 2 * 1024 * 1024)
                    request.destroy(new GoogleAccountError('Google account response is too large.', 502));
                else
                    chunks.push(chunk);
            });
            response.on('error', () => reject(new GoogleAccountError('Google account response was interrupted.', 502)));
            response.on('end', () => {
                const status = response.statusCode || 502;
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!data || typeof data !== 'object' || Array.isArray(data))
                        throw new Error();
                    resolve({ status, data });
                }
                catch {
                    // Preserve an upstream denial/overload even when its error page is HTML or empty.
                    if (status < 200 || status >= 300)
                        resolve({ status, data: {} });
                    else
                        reject(new GoogleAccountError('Google account service returned invalid JSON.', 502));
                }
            });
        });
        const timeout = setTimeout(() => request.destroy(new GoogleAccountError('Google account request timed out.', 504)), 10000);
        request.once('close', () => clearTimeout(timeout));
        request.once('error', (error) => reject(error instanceof GoogleAccountError
            ? error
            : new GoogleAccountError('Google account service could not be reached.', 502)));
        request.end(body);
    });
}
/** Refresh requests are coalesced and cached. Endpoint override is restricted to localhost fixtures. */
async function refreshGoogleAccount(account, tokenEndpointOverride = 'https://oauth2.googleapis.com/token') {
    for (const [key, cached] of tokenCache)
        if (cached.expiresAt && cached.expiresAt < Date.now())
            tokenCache.delete(key);
    const key = accountKey(account);
    const cached = tokenCache.get(key);
    if (cached && validAccess(cached))
        return {
            ...account,
            accessToken: cached.accessToken,
            refreshToken: cached.refreshToken,
            expiresAt: cached.expiresAt,
        };
    if (validAccess(account))
        return { ...account };
    if (!account.refreshToken ||
        !account.clientId ||
        /^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.refreshToken)) {
        throw new GoogleAccountError('This account requires a valid access token or a refresh token and your OAuth client ID.', 401);
    }
    const active = refreshing.get(key);
    if (active)
        return active;
    const refresh = (async () => {
        const endpoint = checkedEndpoint(tokenEndpointOverride, ['oauth2.googleapis.com']);
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: account.refreshToken,
            client_id: account.clientId,
        });
        if (account.clientSecret)
            body.set('client_secret', account.clientSecret);
        const { status, data } = await postJson(endpoint, { 'Content-Type': 'application/x-www-form-urlencoded' }, body.toString());
        if (status < 200 || status >= 300 || typeof data.access_token !== 'string' || !data.access_token) {
            const invalidGrant = data.error === 'invalid_grant' || data.error === 'invalid_client';
            throw new GoogleAccountError(invalidGrant
                ? 'Google rejected these OAuth credentials; reconnect this account.'
                : (0, googleAccessErrors_1.describeGoogleAccessError)(status >= 400 ? status : 502, 'oauth').message, invalidGrant ? 401 : status >= 400 ? status : 502);
        }
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
        const updated = { ...account, accessToken: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
        if (typeof data.refresh_token === 'string' && data.refresh_token)
            updated.refreshToken = data.refresh_token;
        tokenCache.set(key, updated);
        tokenCache.set(accountKey(updated), updated);
        return updated;
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, refresh);
    return refresh;
}
/** Explicit quota refresh; never infers subscription eligibility or fabricates an available quota. */
async function fetchGoogleQuota(account, baseURL = 'https://daily-cloudcode-pa.googleapis.com') {
    const endpoint = checkedEndpoint(baseURL, ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com']);
    endpoint.pathname = '/v1internal:retrieveUserQuotaSummary';
    endpoint.search = '';
    const current = await refreshGoogleAccount(account);
    const { status, data } = await postJson(endpoint, { 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` }, JSON.stringify(account.project ? { project: account.project } : {}));
    if (status < 200 || status >= 300)
        throw new GoogleAccountError((0, googleAccessErrors_1.describeGoogleAccessError)(status, 'quota').message, status);
    const buckets = [];
    const groups = Array.isArray(data.groups) ? data.groups : [{ buckets: data.buckets }];
    for (const group of groups) {
        for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
            if (!bucket || typeof bucket !== 'object')
                continue;
            buckets.push({
                id: typeof bucket.bucketId === 'string' ? bucket.bucketId : typeof bucket.id === 'string' ? bucket.id : 'quota',
                remainingFraction: typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
                    ? Math.max(0, Math.min(1, bucket.remainingFraction))
                    : undefined,
                resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined,
            });
        }
    }
    const remaining = buckets.flatMap((bucket) => bucket.remainingFraction === undefined ? [] : [bucket.remainingFraction]);
    const snapshot = {
        accountId: account.id,
        checkedAt: Date.now(),
        buckets,
        remainingFraction: remaining.length ? Math.min(...remaining) : undefined,
    };
    stateFor(account).quota = snapshot;
    return snapshot;
}
/** Discover only the models returned for this authenticated account/project. */
async function fetchGoogleModels(account, baseURL = 'https://daily-cloudcode-pa.googleapis.com') {
    const endpoint = checkedEndpoint(baseURL, ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com']);
    endpoint.pathname = '/v1internal:fetchAvailableModels';
    endpoint.search = '';
    const current = await refreshGoogleAccount(account);
    const { status, data } = await postJson(endpoint, { 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` }, JSON.stringify(current.project ? { project: current.project } : {}));
    if (status < 200 || status >= 300)
        throw new GoogleAccountError((0, googleAccessErrors_1.describeGoogleAccessError)(status, 'models').message, status);
    const models = data.models || data.availableModels || data.available_models;
    if (!models || typeof models !== 'object')
        throw new GoogleAccountError('Google did not return an available model list.', 502);
    const entries = Array.isArray(models) ? models.map((value) => ['', value]) : Object.entries(models);
    const found = new Map();
    for (const [key, value] of entries) {
        if (!value || typeof value !== 'object')
            continue;
        const model = value;
        const candidate = model.id || model.name || key || model.modelId || model.model;
        if (typeof candidate !== 'string' || !candidate)
            continue;
        const id = candidate.replace(/^models\//, '');
        const displayName = typeof model.displayName === 'string' ? model.displayName : id;
        found.set(id, { id, displayName });
    }
    return [...found.values()];
}
async function acquireGoogleAccount(modelName, accounts, options = {}, requestIdentity, cooldownScope = modelName) {
    const attempted = new Set();
    const identityKey = requestIdentity
        ? (0, crypto_1.createHash)('sha256').update(`${modelName}\0${requestIdentity}`).digest('hex')
        : undefined;
    for (const [key, entry] of sticky)
        if (Date.now() - entry.at > 3600000)
            sticky.delete(key);
    if (sticky.size > 2000)
        sticky.delete(sticky.keys().next().value);
    while (attempted.size < accounts.length) {
        const now = Date.now();
        let candidates = accounts.filter((account) => {
            const state = stateFor(account);
            return (account.enabled !== false &&
                !attempted.has(poolKey(account)) &&
                !state.authState &&
                state.cooldownUntil <= now &&
                (state.modelCooldowns.get(cooldownScope)?.until ?? 0) <= now &&
                !quotaExhausted(state, now) &&
                state.inFlight < (options.maxConcurrency ?? 2));
        });
        candidates = candidates.sort((left, right) => {
            const a = stateFor(left), b = stateFor(right);
            if (options.strategy === 'least-loaded' && a.inFlight !== b.inFlight)
                return a.inFlight - b.inFlight;
            if (options.strategy === 'quota') {
                const qa = (quotaIsFresh(a.quota) ? a.quota?.remainingFraction : undefined) ?? 0.5, qb = (quotaIsFresh(b.quota) ? b.quota?.remainingFraction : undefined) ?? 0.5;
                if (qa !== qb)
                    return qb - qa;
            }
            return a.lastUsed - b.lastUsed;
        });
        const stick = identityKey ? sticky.get(identityKey) : undefined;
        const selected = candidates.find((account) => poolKey(account) === stick?.accountKey) ||
            (options.strategy === 'adaptive' ? selectAdaptive(candidates) : candidates[0]);
        if (!selected)
            throw new GoogleAccountError('No Google account is currently eligible: check authentication, quota, cooldown and concurrency limits.', 503);
        const key = poolKey(selected), state = stateFor(selected);
        attempted.add(key);
        state.inFlight += 1;
        state.lastUsed = ++selectionOrder;
        try {
            const updated = await refreshGoogleAccount(selected);
            if (updated.accessToken !== selected.accessToken ||
                updated.refreshToken !== selected.refreshToken ||
                updated.expiresAt !== selected.expiresAt) {
                await persistAccount?.(modelName, updated, selected);
            }
            if (identityKey)
                sticky.set(identityKey, { accountKey: key, at: Date.now() });
            state.requests++;
            let released = false;
            return {
                account: updated,
                release(result = {}) {
                    if (released)
                        return;
                    released = true;
                    state.inFlight = Math.max(0, state.inFlight - 1);
                    if (result.cancelled)
                        return;
                    if (result.status !== undefined)
                        state.lastStatus = result.status;
                    if (result.status >= 200 && result.status < 400) {
                        state.succeeded++;
                        state.consecutiveFailures = 0;
                        if (Number.isFinite(result.latencyMs) && result.latencyMs >= 0) {
                            const previous = measuredLatency(state);
                            state.latency = {
                                average: Math.round(previous === undefined ? result.latencyMs : previous * 0.8 + result.latencyMs * 0.2),
                                measuredAt: Date.now(),
                            };
                        }
                    }
                    else if (result.status >= 400) {
                        state.failed++;
                        state.consecutiveFailures++;
                    }
                    if (result.status === 401 || result.status === 403) {
                        state.authState = result.status === 401 ? 'unauthorized' : 'forbidden';
                        tokenCache.delete(accountKey(selected));
                        tokenCache.delete(accountKey(updated));
                    }
                    else if (result.status === 408 || result.status === 429 || (result.status && result.status >= 500)) {
                        const delay = Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0
                            ? result.retryAfterMs
                            : (options.cooldownMs ?? 60000);
                        const until = Date.now() + Math.min(delay, 31 * 24 * 60 * 60 * 1000);
                        // Concurrent in-flight failures must not shorten a stronger server reset hint.
                        if (until >= (state.modelCooldowns.get(cooldownScope)?.until ?? 0)) {
                            state.modelCooldowns.set(cooldownScope, {
                                until,
                                reason: result.cooldownReason || (result.status === 429 ? 'rate-limited' : 'upstream-error'),
                            });
                        }
                    }
                },
            };
        }
        catch (error) {
            state.inFlight = Math.max(0, state.inFlight - 1);
            if (error instanceof GoogleAccountError && [401, 403].includes(error.status))
                state.authState = error.status === 401 ? 'unauthorized' : 'forbidden';
            else
                state.cooldownUntil = Date.now() + (options.cooldownMs ?? 60000);
        }
    }
    throw new GoogleAccountError('No Google account could authenticate; reconnect an account or check its OAuth client configuration.', 401);
}
function getGooglePoolStatus() {
    const now = Date.now();
    return [...poolStates.values()].map((state) => {
        const modelCooldowns = [...state.modelCooldowns]
            .filter(([, value]) => value.until > now)
            .map(([modelName, value]) => ({ modelName, cooldownUntil: value.until, reason: value.reason }));
        const cooldownUntil = Math.max(state.cooldownUntil, ...modelCooldowns.map((value) => value.cooldownUntil));
        return {
            id: state.id,
            label: state.label,
            inFlight: state.inFlight,
            status: state.authState ||
                (quotaExhausted(state, now) ? 'quota-exhausted' : cooldownUntil > now ? 'cooldown' : 'ready'),
            cooldownUntil,
            modelCooldowns,
            requests: state.requests,
            succeeded: state.succeeded,
            failed: state.failed,
            avgLatencyMs: measuredLatency(state, now),
            lastStatus: state.lastStatus,
            lastError: state.lastStatus >= 400 ? (0, googleAccessErrors_1.describeGoogleAccessError)(state.lastStatus) : undefined,
            quotaAgeMs: state.quota ? Math.max(0, now - state.quota.checkedAt) : undefined,
            quotaFresh: quotaIsFresh(state.quota, now),
            quotaExhausted: quotaExhausted(state, now),
            quota: state.quota,
        };
    });
}
/** Clear volatile account state after explicit account edits or sign-in. */
function resetGoogleAccountState(id) {
    for (const [key, state] of poolStates)
        if (!id || state.id === id)
            poolStates.delete(key);
    for (const [key, account] of tokenCache)
        if (!id || account.id === id)
            tokenCache.delete(key);
    if (!id) {
        tokenCache.clear();
        sticky.clear();
    }
}
//# sourceMappingURL=googleAccounts.js.map