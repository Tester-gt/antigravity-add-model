import { describe, expect, it } from 'vitest';
import { CloudCodeRouting } from '../proxy/cloudCodeRouting';

const prod = 'https://cloudcode-pa.googleapis.com';
const daily = 'https://daily-cloudcode-pa.googleapis.com';
const headers = (token = 'account-one-token') => ({ authorization: `Bearer ${token}` });

describe('native IDE Cloud Code tier routing', () => {
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
