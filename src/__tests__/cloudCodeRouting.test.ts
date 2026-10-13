import { describe, expect, it, vi } from 'vitest';
import { CloudCodeRouting } from '../proxy/cloudCodeRouting';

const prod = 'https://cloudcode-pa.googleapis.com';
const daily = 'https://daily-cloudcode-pa.googleapis.com';
const headers = (token = 'account-one-token') => ({ authorization: `Bearer ${token}` });

describe('native IDE Cloud Code tier routing', () => {
  const generation = Buffer.from(JSON.stringify({ project: 'owned-project', request: { contents: [] } }));
  const signal = () => new AbortController().signal;

  it('discovers a returning signed-in caller before choosing the generation endpoint', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 200, body: { paidTier: { usesGcpTos: false } } });
    const routing = new CloudCodeRouting(Date.now, lookup);
    expect(await routing.resolveForGeneration(headers(), generation, signal())).toBe(daily);
    expect(lookup).toHaveBeenCalledWith(headers(), generation, expect.any(AbortSignal));
    expect(await routing.resolveForGeneration(headers(), generation, signal())).toBe(daily);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('rediscovers a refreshed token and expired tier without reusing another account identity', async () => {
    let now = 100;
    const lookup = vi.fn().mockResolvedValue({ status: 200, body: { paidTier: { usesGcpTos: false } } });
    const routing = new CloudCodeRouting(() => now, lookup);
    routing.observe(headers('old'), 200, { paidTier: { usesGcpTos: true } });
    expect(await routing.resolveForGeneration(headers('fresh'), generation, signal())).toBe(daily);
    expect(await routing.resolveForGeneration(headers('old'), generation, signal())).toBe(prod);
    now += 60 * 60 * 1000;
    expect(await routing.resolveForGeneration(headers('fresh'), generation, signal())).toBe(daily);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('preserves production for a discovered GCP tier', async () => {
    const routing = new CloudCodeRouting(Date.now, async () => ({
      status: 200,
      body: { paidTier: { usesGcpTos: true } },
    }));
    expect(await routing.resolveForGeneration(headers(), generation, signal())).toBe(prod);
  });

  it('coalesces simultaneous requests without replaying generation', async () => {
    let complete!: (value: { status: number; body: unknown }) => void;
    const lookup = vi.fn(() => new Promise<{ status: number; body: unknown }>((resolve) => (complete = resolve)));
    const routing = new CloudCodeRouting(Date.now, lookup);
    const one = routing.resolveForGeneration(headers(), generation, signal());
    const two = routing.resolveForGeneration(headers(), generation, signal());
    expect(lookup).toHaveBeenCalledTimes(1);
    complete({ status: 200, body: {} });
    expect(await Promise.all([one, two])).toEqual([daily, daily]);
  });

  it('does not guess a generation route after a failed or malformed discovery', async () => {
    for (const response of [
      { status: 429, body: {} },
      { status: 200, body: [] },
      { status: 200, body: { paidTier: 1 } },
    ]) {
      const routing = new CloudCodeRouting(Date.now, async () => response);
      await expect(routing.resolveForGeneration(headers(), generation, signal())).rejects.toThrow('did not establish');
      expect(routing.resolve(headers())).toBe(prod);
    }
  });

  it('allows a later lookup after transport failure', async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 200, body: {} });
    const routing = new CloudCodeRouting(Date.now, lookup);
    await expect(routing.resolveForGeneration(headers(), generation, signal())).rejects.toThrow('offline');
    expect(await routing.resolveForGeneration(headers(), generation, signal())).toBe(daily);
  });

  it('cancels only a disconnected waiter while another generation still needs the lookup', async () => {
    let complete!: (value: { status: number; body: unknown }) => void;
    const lookup = vi.fn(
      (_headers, _body, _signal) => new Promise<{ status: number; body: unknown }>((resolve) => (complete = resolve)),
    );
    const routing = new CloudCodeRouting(Date.now, lookup);
    const disconnected = new AbortController();
    const one = routing.resolveForGeneration(headers(), generation, disconnected.signal);
    const two = routing.resolveForGeneration(headers(), generation, signal());
    disconnected.abort();
    await expect(one).rejects.toThrow('cancelled');
    expect(lookup.mock.calls[0][2].aborted).toBe(false);
    complete({ status: 200, body: {} });
    expect(await two).toBe(daily);
  });

  it('aborts discovery when every waiting generation disconnects and prevents late cache writes', async () => {
    let complete!: (value: { status: number; body: unknown }) => void;
    const lookup = vi.fn(
      (_headers, _body, _signal) => new Promise<{ status: number; body: unknown }>((resolve) => (complete = resolve)),
    );
    const routing = new CloudCodeRouting(Date.now, lookup);
    const disconnected = new AbortController();
    const pending = routing.resolveForGeneration(headers(), generation, disconnected.signal);
    disconnected.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(lookup.mock.calls[0][2].aborted).toBe(true);
    complete({ status: 200, body: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(routing.resolve(headers())).toBe(prod);
  });

  it('clears and aborts pending lookups during proxy shutdown', async () => {
    const lookup = vi.fn(
      (_headers, _body, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const routing = new CloudCodeRouting(Date.now, lookup);
    const pending = routing.resolveForGeneration(headers(), generation, signal());
    routing.clear();
    await expect(pending).rejects.toThrow('cancelled');
    expect(lookup.mock.calls[0][2].aborted).toBe(true);
  });

  it('never discovers missing authorization or a request already cancelled', async () => {
    const lookup = vi.fn();
    const routing = new CloudCodeRouting(Date.now, lookup);
    expect(await routing.resolveForGeneration({}, generation, signal())).toBe(prod);
    const controller = new AbortController();
    controller.abort();
    await expect(routing.resolveForGeneration(headers(), generation, controller.signal)).rejects.toThrow('cancelled');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('starts unknown callers at the production onboarding endpoint', () => {
    const routing = new CloudCodeRouting();
    expect(routing.resolve(headers())).toBe(prod);
    expect(routing.resolve({})).toBe(prod);
    expect(routing.resolve({ authorization: 'Basic credential' })).toBe(prod);
  });

  it.each([{ paidTier: { usesGcpTos: false } }, { paid_tier: { uses_gcp_tos: false } }, { paidTier: {} }, {}])(
    'moves a successful non-GCP tier response to daily: %j',
    (response) => {
      const routing = new CloudCodeRouting();
      routing.observe(headers(), 200, response);
      expect(routing.resolve(headers())).toBe(daily);
    },
  );

  it.each([{ paidTier: { usesGcpTos: true } }, { paid_tier: { uses_gcp_tos: true } }])(
    'keeps GCP terms on production: %j',
    (response) => {
      const routing = new CloudCodeRouting();
      routing.observe(headers(), 200, { paidTier: { usesGcpTos: false } });
      routing.observe(headers(), 200, response);
      expect(routing.resolve(headers())).toBe(prod);
    },
  );

  it('ignores failed or malformed responses without changing an established route', () => {
    const routing = new CloudCodeRouting();
    routing.observe(headers(), 200, {});
    for (const status of [0, 199, 300, 401, 404, 429, 500])
      routing.observe(headers(), status, { paidTier: { usesGcpTos: true } });
    for (const response of [null, [], 'invalid JSON', { paidTier: 'invalid' }, { paidTier: { usesGcpTos: 'true' } }])
      routing.observe(headers(), 200, response);
    expect(routing.resolve(headers())).toBe(daily);
  });

  it('isolates accounts and treats a newly refreshed bearer token as an unknown caller', () => {
    const routing = new CloudCodeRouting();
    routing.observe(headers('one'), 200, {});
    routing.observe(headers('two'), 200, { paidTier: { usesGcpTos: true } });
    expect(routing.resolve(headers('one'))).toBe(daily);
    expect(routing.resolve(headers('two'))).toBe(prod);
    expect(routing.resolve(headers('one-refreshed'))).toBe(prod);
    expect(routing.resolve({ authorization: 'bearer one' })).toBe(daily);
  });

  it('does not cache missing or malformed authorization as a shared anonymous account', () => {
    const routing = new CloudCodeRouting();
    for (const input of [
      {},
      { authorization: 'Bearer ' },
      { authorization: 'Bearer token another' },
      { authorization: 'Basic value' },
    ]) {
      routing.observe(input, 200, {});
      expect(routing.resolve(input)).toBe(prod);
    }
  });

  it('expires tier knowledge after one hour even when the route is accessed', () => {
    let now = 100;
    const routing = new CloudCodeRouting(() => now);
    routing.observe(headers(), 200, {});
    now += 60 * 60 * 1000 - 1;
    expect(routing.resolve(headers())).toBe(daily);
    now++;
    expect(routing.resolve(headers())).toBe(prod);
  });

  it('bounds the cache to 128 callers and evicts the least recently used one', () => {
    const routing = new CloudCodeRouting();
    for (let index = 0; index < 128; index++) routing.observe(headers(`account-${index}`), 200, {});
    expect(routing.resolve(headers('account-0'))).toBe(daily);
    routing.observe(headers('account-128'), 200, {});
    expect(routing.resolve(headers('account-1'))).toBe(prod);
    expect(routing.resolve(headers('account-0'))).toBe(daily);
    expect(routing.resolve(headers('account-128'))).toBe(daily);
  });

  it('can clear caller state without retaining raw authorization values', () => {
    const routing = new CloudCodeRouting();
    routing.observe(headers('sensitive-bearer-never-store'), 200, {});
    expect(
      JSON.stringify(routing, (_key, value) => (value instanceof Map ? [...value.entries()] : value)),
    ).not.toContain('sensitive-bearer-never-store');
    routing.clear();
    expect(routing.resolve(headers('sensitive-bearer-never-store'))).toBe(prod);
  });
});
