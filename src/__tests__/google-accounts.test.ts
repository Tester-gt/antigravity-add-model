import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import {
  acquireGoogleAccount,
  configureGoogleAccountPersistence,
  fetchGoogleQuota,
  fetchGoogleModels,
  getGooglePoolStatus,
  refreshGoogleAccount,
  resetGoogleAccountState,
  type GooglePoolOptions,
  type GoogleAccount,
} from '../googleAccounts';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  configureGoogleAccountPersistence(undefined);
  resetGoogleAccountState();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function account(id: string): GoogleAccount {
  return { id, label: id, accessToken: `access-${id}`, expiresAt: Date.now() + 3_600_000 };
}

describe('Google OAuth with user-provided app credentials', () => {
  it.each([
    [403, 'access-denied', /OAuth client, consent\/test users/],
    [429, 'rate-limited', /rate or quota limit/],
    [503, 'transient', /temporarily unavailable/],
  ] as const)(
    'preserves HTTP %s during token refresh without exposing upstream error pages',
    async (status, category, guidance) => {
      const endpoint = await serve((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'text/html' });
        res.end('<html>private-client-secret refresh-token echoed-upstream-request</html>');
      });
      const failure = await refreshGoogleAccount(
        { id: 'failed-refresh', clientId: 'owned-client', refreshToken: 'refresh-token' },
        endpoint,
      ).catch((error: Error) => error);
      expect(failure).toMatchObject({ status, category, message: expect.stringMatching(guidance) });
      expect(String(failure)).not.toMatch(/private-client-secret|refresh-token|echoed-upstream-request|invalid JSON/);
    },
  );

  it('refreshes expired tokens once, coalesces simultaneous refreshes and persists rotated credentials through the injected callback', async () => {
    let calls = 0;
    let params: URLSearchParams;
    const endpoint = await serve(async (req, res) => {
      calls++;
      let data = '';
      for await (const chunk of req) data += chunk;
      params = new URLSearchParams(data);
      res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }));
    });
    const original = {
      id: 'refresh',
      clientId: 'user-owned-oauth-app',
      clientSecret: 'user-owned-secret',
      refreshToken: 'refresh-token',
      expiresAt: 1,
    };
    const [first, second] = await Promise.all([
      refreshGoogleAccount(original, endpoint),
      refreshGoogleAccount(original, endpoint),
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first.accessToken).toBe('new-access');
    expect(params!.get('client_id')).toBe('user-owned-oauth-app');
    expect(params!.get('client_secret')).toBe('user-owned-secret');
    expect(params!.get('grant_type')).toBe('refresh_token');
    const persist = vi.fn();
    configureGoogleAccountPersistence(persist);
    const lease = await acquireGoogleAccount('models/google', [original]);
    expect(persist).toHaveBeenCalledWith(
      'models/google',
      expect.objectContaining({ refreshToken: 'rotated-refresh' }),
      original,
    );
    lease.release();
  });

  it('does not require a client secret for public OAuth apps and refuses credential redirects to third parties', async () => {
    const endpoint = await serve(async (req, res) => {
      let data = '';
      for await (const chunk of req) data += chunk;
      expect(new URLSearchParams(data).has('client_secret')).toBe(false);
      res.end(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }));
    });
    await expect(
      refreshGoogleAccount({ id: 'public', clientId: 'public-app', refreshToken: 'token' }, endpoint),
    ).resolves.toHaveProperty('accessToken');
    await expect(
      refreshGoogleAccount({ id: 'bad-host', clientId: 'app', refreshToken: 'token' }, 'https://example.com/token'),
    ).rejects.toThrow(/official service/);
  });

  it('reports revoked credentials without returning upstream bodies or secret values', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive-token-value' }));
    });
    await expect(
      refreshGoogleAccount({ id: 'revoked', clientId: 'app', refreshToken: 'sensitive-token-value' }, endpoint),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Google rejected these OAuth credentials; reconnect this account.',
    });
    await expect(refreshGoogleAccount({ id: 'missing-app', refreshToken: 'token' }, endpoint)).rejects.toThrow(
      /OAuth client ID/,
    );
  });
});

describe('Google account selection and quota', () => {
  it.each([
    [401, 'authentication', /Reconnect this account/],
    [403, 'access-denied', /account\/project permissions and service eligibility/],
    [429, 'rate-limited', /rate or quota limit/],
    [503, 'transient', /temporarily unavailable/],
  ] as const)(
    'preserves HTTP %s for quota and model discovery with safe, actionable guidance',
    async (status, category, guidance) => {
      let responseBody = '<html>private-token private-project private-email@example.com</html>';
      const endpoint = await serve((_req, res) => {
        res.writeHead(status);
        res.end(responseBody);
      });
      for (const body of [responseBody, JSON.stringify({ error: { message: responseBody } })]) {
        responseBody = body;
        for (const operation of [fetchGoogleQuota, fetchGoogleModels]) {
          const failure = await operation(account('diagnostic'), endpoint).catch((error: Error) => error);
          expect(failure).toMatchObject({ status, category, message: expect.stringMatching(guidance) });
          expect(String(failure)).not.toMatch(/private-token|private-project|private-email|invalid JSON/);
        }
      }
    },
  );

  it('still rejects malformed successful account responses instead of inventing quota', async () => {
    const endpoint = await serve((_req, res) => res.end('not-json'));
    await expect(fetchGoogleQuota(account('malformed'), endpoint)).rejects.toMatchObject({
      status: 502,
      message: 'Google account service returned invalid JSON.',
    });
  });

  it.each<NonNullable<GooglePoolOptions['strategy']>>(['round-robin', 'least-loaded', 'quota', 'adaptive'])(
    'supports 50 accounts with %s and keeps access failures separate from transient cooldowns',
    async (strategy) => {
      const accounts = Array.from({ length: 50 }, (_, index) => account(`pool-${index}`));
      const leases = [];
      for (let index = 0; index < accounts.length; index++)
        leases.push(await acquireGoogleAccount('models/test', accounts, { strategy, maxConcurrency: 1 }));
      expect(new Set(leases.map((lease) => lease.account.id)).size).toBe(50);
      await expect(acquireGoogleAccount('models/test', accounts, { strategy, maxConcurrency: 1 })).rejects.toThrow(
        /concurrency/,
      );
      leases[0].release({ status: 403 });
      leases[1].release({ status: 429 });
      leases[2].release({ status: 503 });
      for (const lease of leases.slice(3)) lease.release({ status: 200 });
      const next = await acquireGoogleAccount('models/test', accounts, { strategy, maxConcurrency: 1 });
      expect(leases.slice(0, 3).map((lease) => lease.account.id)).not.toContain(next.account.id);
      next.release({ status: 200 });
      const statuses = getGooglePoolStatus();
      expect(statuses.find((state) => state.id === leases[0].account.id)).toMatchObject({
        status: 'forbidden',
        lastError: { category: 'access-denied' },
      });
      expect(statuses.find((state) => state.id === leases[1].account.id)).toMatchObject({
        status: 'cooldown',
        lastError: { category: 'rate-limited' },
      });
      expect(statuses.find((state) => state.id === leases[2].account.id)).toMatchObject({
        status: 'cooldown',
        lastError: { category: 'transient' },
      });
      expect(JSON.stringify(statuses)).not.toContain('access-pool');
    },
  );

  it('discovers authenticated Cloud Code models with the account project and returns only IDs and labels', async () => {
    const endpoint = await serve(async (req, res) => {
      expect(req.url).toBe('/v1internal:fetchAvailableModels');
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe('Bearer access-discovery');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      expect(JSON.parse(raw)).toEqual({ project: 'project-id' });
      res.end(
        JSON.stringify({
          models: {
            'gemini-custom': { displayName: 'Gemini Custom', model: 'MODEL_ENUM', secret: 'private' },
            invalid: null,
          },
        }),
      );
    });
    await expect(fetchGoogleModels({ ...account('discovery'), project: 'project-id' }, endpoint)).resolves.toEqual([
      { id: 'gemini-custom', displayName: 'Gemini Custom' },
    ]);
  });
  it('round robins healthy accounts and respects per-account concurrency limits', async () => {
    const accounts = [account('a'), account('b')];
    const first = await acquireGoogleAccount('models/test', accounts, { maxConcurrency: 1 });
    const second = await acquireGoogleAccount('models/test', accounts, { maxConcurrency: 1 });
    expect(first.account.id).toBe('a');
    expect(second.account.id).toBe('b');
    await expect(acquireGoogleAccount('models/test', accounts, { maxConcurrency: 1 })).rejects.toThrow(/concurrency/);
    first.release();
    second.release();
    expect(getGooglePoolStatus().every((state) => state.inFlight === 0)).toBe(true);
    expect(JSON.stringify(getGooglePoolStatus())).not.toContain('access-');
  });

  it('retains explicit conversation identity and excludes accounts requiring reauthentication', async () => {
    const accounts = [account('sticky-a'), account('sticky-b')];
    const first = await acquireGoogleAccount('models/test', accounts, {}, 'conversation');
    first.release();
    const second = await acquireGoogleAccount('models/test', accounts, {}, 'conversation');
    expect(second.account.id).toBe(first.account.id);
    second.release({ status: 401 });
    const third = await acquireGoogleAccount('models/test', accounts, {}, 'conversation');
    expect(third.account.id).not.toBe(first.account.id);
    third.release();
    expect(getGooglePoolStatus()).toContainEqual(
      expect.objectContaining({ id: first.account.id, status: 'unauthorized' }),
    );
  });

  it('shares account capacity across different models and rotated credential values', async () => {
    const first = await acquireGoogleAccount('models/first', [account('shared')], { maxConcurrency: 1 });
    await expect(
      acquireGoogleAccount('models/second', [{ ...account('shared'), accessToken: 'rotated-access' }], {
        maxConcurrency: 1,
      }),
    ).rejects.toThrow(/concurrency/);
    first.release();
    const second = await acquireGoogleAccount(
      'models/second',
      [{ ...account('shared'), accessToken: 'rotated-access' }],
      { maxConcurrency: 1 },
    );
    second.release();
    expect(getGooglePoolStatus().filter((state) => state.id === 'shared')).toHaveLength(1);
  });

  it('cooldowns rate-limited accounts, recovers after the interval, and skips disabled accounts', async () => {
    const accounts = [account('cooling'), { ...account('disabled'), enabled: false }];
    const lease = await acquireGoogleAccount('models/test', accounts, { cooldownMs: 20 });
    lease.release({ status: 429 });
    await expect(acquireGoogleAccount('models/test', accounts)).rejects.toThrow(/eligible/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const recovered = await acquireGoogleAccount('models/test', accounts);
    expect(recovered.account.id).toBe('cooling');
    recovered.release();
  });

  it('uses measured quotas for quota-aware selection and preserves unknown quota as unknown', async () => {
    const endpoint = await serve((req, res) => {
      expect(req.url).toBe('/v1internal:retrieveUserQuotaSummary');
      const fraction = req.headers.authorization === 'Bearer access-quota-a' ? 0.2 : 0.8;
      res.end(
        JSON.stringify({
          groups: [
            {
              buckets: [
                { bucketId: '5h', remainingFraction: fraction, resetTime: new Date(Date.now() + 60_000).toISOString() },
              ],
            },
          ],
        }),
      );
    });
    const accounts = [account('quota-a'), account('quota-b')];
    await Promise.all(accounts.map((entry) => fetchGoogleQuota(entry, endpoint)));
    const lease = await acquireGoogleAccount('models/test', accounts, { strategy: 'quota' });
    expect(lease.account.id).toBe('quota-b');
    lease.release();
    const empty = await serve((_req, res) => res.end('{}'));
    const result = await fetchGoogleQuota(account('unknown'), empty);
    expect(result.remainingFraction).toBeUndefined();
    expect(result.buckets).toEqual([]);
    await expect(fetchGoogleQuota(account('bad-host'), 'https://example.com')).rejects.toThrow(/official service/);
  });

  it('selects between two eligible accounts using measured latency and preserves conversation affinity', async () => {
    const accounts = [account('slow'), account('fast')];
    const slow = await acquireGoogleAccount('models/test', [accounts[0]]);
    slow.release({ status: 200, latencyMs: 5000 });
    slow.release({ status: 500 }); // A lease can only be released once.
    const fast = await acquireGoogleAccount('models/test', [accounts[1]]);
    fast.release({ status: 200, latencyMs: 100 });
    const selected = await acquireGoogleAccount('models/test', accounts, { strategy: 'adaptive' });
    expect(selected.account.id).toBe('fast');
    selected.release({ status: 200, latencyMs: 200 });
    expect(getGooglePoolStatus()).toContainEqual(
      expect.objectContaining({
        id: 'fast',
        requests: 2,
        succeeded: 2,
        failed: 0,
        avgLatencyMs: 120,
        lastStatus: 200,
      }),
    );
    const affinity = await acquireGoogleAccount('models/test', [accounts[0]], {}, 'same-conversation');
    affinity.release({ status: 200 });
    const sticky = await acquireGoogleAccount('models/test', accounts, { strategy: 'adaptive' }, 'same-conversation');
    expect(sticky.account.id).toBe('slow');
    sticky.release();
    expect(JSON.stringify(getGooglePoolStatus())).not.toContain('access-');
  });

  it('keeps capacity limits above adaptive preference and forgets stale latency measurements', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const accounts = [account('busy-fast'), account('idle')];
    const measured = await acquireGoogleAccount('models/test', [accounts[0]]);
    measured.release({ status: 200, latencyMs: 25 });
    const busy = await acquireGoogleAccount('models/test', [accounts[0]], { maxConcurrency: 1 });
    const other = await acquireGoogleAccount('models/test', accounts, { strategy: 'adaptive', maxConcurrency: 1 });
    expect(other.account.id).toBe('idle');
    busy.release({ cancelled: true, status: 502 });
    other.release();
    expect(getGooglePoolStatus().find((state) => state.id === 'busy-fast')?.failed).toBe(0);
    clock.mockReturnValue(now + 10 * 60_000);
    expect(getGooglePoolStatus().find((state) => state.id === 'busy-fast')?.avgLatencyMs).toBeUndefined();
  });

  it('scopes cooldowns to a model and honors server delays without replacing them with the configured floor', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const accounts = [account('shared-limit')];
    const limited = await acquireGoogleAccount('models/claude', accounts, { cooldownMs: 60_000 });
    limited.release({ status: 429, retryAfterMs: 2000, cooldownReason: 'rate-limited' });
    await expect(acquireGoogleAccount('models/claude', accounts)).rejects.toThrow(/cooldown/);
    const otherModel = await acquireGoogleAccount('models/gemini', accounts);
    otherModel.release({ status: 200 });
    expect(getGooglePoolStatus()[0]).toMatchObject({
      failed: 1,
      succeeded: 1,
      modelCooldowns: [{ modelName: 'models/claude', cooldownUntil: now + 2000, reason: 'rate-limited' }],
    });
    clock.mockReturnValue(now + 2001);
    const resumed = await acquireGoogleAccount('models/claude', accounts);
    resumed.release();
    expect(getGooglePoolStatus()[0].status).toBe('ready');
  });

  it('excludes only fresh entirely exhausted quota and reconsiders it after reset or refresh', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let buckets: Array<Record<string, unknown>> = [
      { bucketId: 'all', remainingFraction: 0, resetTime: new Date(now + 1000).toISOString() },
    ];
    const endpoint = await serve((_req, res) => res.end(JSON.stringify({ buckets })));
    const entry = account('quota-zero');
    await fetchGoogleQuota(entry, endpoint);
    await expect(acquireGoogleAccount('models/test', [entry])).rejects.toThrow(/quota/);
    expect(getGooglePoolStatus()[0]).toMatchObject({
      status: 'quota-exhausted',
      quotaFresh: true,
      quotaExhausted: true,
    });
    clock.mockReturnValue(now + 1001);
    const reset = await acquireGoogleAccount('models/test', [entry]);
    reset.release();
    expect(getGooglePoolStatus()[0].quotaFresh).toBe(false);
    buckets = [
      { bucketId: 'claude', remainingFraction: 0 },
      { bucketId: 'gemini', remainingFraction: 0.8 },
    ];
    await fetchGoogleQuota(entry, endpoint);
    const mixed = await acquireGoogleAccount('models/test', [entry]);
    mixed.release();
    expect(getGooglePoolStatus()[0].quotaExhausted).toBe(false);
    buckets = [{ bucketId: 'claude', remainingFraction: 0 }, { bucketId: 'unknown' }];
    await fetchGoogleQuota(entry, endpoint);
    const unknown = await acquireGoogleAccount('models/test', [entry]);
    unknown.release();
    buckets = [{ bucketId: 'all', remainingFraction: 0 }];
    await fetchGoogleQuota(entry, endpoint);
    clock.mockReturnValue(now + 11 * 60_000);
    const stale = await acquireGoogleAccount('models/test', [entry]);
    stale.release();
    expect(getGooglePoolStatus()[0]).toMatchObject({ quotaFresh: false, quotaExhausted: false });
  });

  it('does not shorten an existing quota cooldown when a concurrent request reports a shorter burst limit', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const accounts = [account('concurrent')];
    const first = await acquireGoogleAccount('models/test', accounts);
    const second = await acquireGoogleAccount('models/test', accounts);
    first.release({ status: 429, retryAfterMs: 3_600_000, cooldownReason: 'quota-exhausted' });
    second.release({ status: 429, retryAfterMs: 1000, cooldownReason: 'rate-limited' });
    expect(getGooglePoolStatus()[0]).toMatchObject({
      failed: 2,
      inFlight: 0,
      modelCooldowns: [{ modelName: 'models/test', cooldownUntil: now + 3_600_000, reason: 'quota-exhausted' }],
    });
  });

  it('shares an upstream model cooldown across local effort aliases while keeping other upstream models eligible', async () => {
    const accounts = [account('aliases')];
    const first = await acquireGoogleAccount('models/local-low', accounts, {}, 'conversation', 'gemini-pro');
    first.release({ status: 429, retryAfterMs: 60_000 });
    await expect(acquireGoogleAccount('models/local-high', accounts, {}, 'conversation', 'gemini-pro')).rejects.toThrow(
      /cooldown/,
    );
    const different = await acquireGoogleAccount('models/local-flash', accounts, {}, 'conversation', 'gemini-flash');
    different.release({ status: 200 });
    expect(getGooglePoolStatus()[0].modelCooldowns[0].modelName).toBe('gemini-pro');
  });

  it('uses measured failures in adaptive selection without making an unsuccessful account permanently ineligible', async () => {
    const accounts = [account('failed'), account('healthy')];
    const first = await acquireGoogleAccount('models/test', [accounts[0]]);
    first.release({ status: 400 });
    const preferred = await acquireGoogleAccount('models/test', accounts, { strategy: 'adaptive' });
    expect(preferred.account.id).toBe('healthy');
    preferred.release({ status: 200 });
    const recovered = await acquireGoogleAccount('models/test', [accounts[0]], { strategy: 'adaptive' });
    recovered.release({ status: 200 });
    expect(getGooglePoolStatus().find((state) => state.id === 'failed')).toMatchObject({
      failed: 1,
      succeeded: 1,
      status: 'ready',
    });
  });
});
