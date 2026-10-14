import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { ModelStore } from '../modelStore';
import type { DiscoveredModel } from '../modelManagement';
import * as codec from '../cryptoStore';
import { cloudflareRequest, expiresOn, isAccountWorkersModel, setupWorkersAi } from '../workersAiSetup';
import type { CloudflareTransport } from '../workersAiSetup';
import { maskedPrompt, parseWorkersAiOptions, readSecretInput, runWorkersAiCli } from '../../scripts/workers-ai.mjs';

const account = 'a'.repeat(32);
const otherAccount = 'b'.repeat(32);
const token = 'fixture-workers-secret-not-a-real-token';
const bootstrap = 'fixture-bootstrap-secret-not-a-real-token';
const createdId = 'c'.repeat(32);
const permission = 'd'.repeat(32);
const endpoint = (id = account) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1/chat/completions`;
const roots: string[] = [];
const now = Date.parse('2026-10-14T12:00:00Z');
function fixture() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-ai-setup-'));
  roots.push(dataDirectory);
  codec.configureCredentialDirectory(dataDirectory);
  const store = new ModelStore(path.join(dataDirectory, 'custom_models.json'), codec);
  const models: DiscoveredModel[] = [
    { id: '@cf/fixture/one', displayName: 'Fixture one', contextWindow: 262144, supportsVision: true },
    { id: '@cf/fixture/unknown', displayName: 'Unknown capabilities' },
  ];
  const manager = { store, discoverModels: vi.fn(async () => ({ success: true, models, status: 200 })) };
  const request = vi.fn<CloudflareTransport>(async (route, _secret, _method, body) => {
    if (route.startsWith('/accounts?')) return { success: true, result: [{ id: account, name: 'My account' }] };
    if (route.includes('/permission_groups?'))
      return {
        success: true,
        result: [
          { id: permission, name: 'Workers AI Write', scopes: ['com.cloudflare.api.account'], is_selectable: true },
        ],
      };
    if (route === `/accounts/${account}/tokens`)
      return {
        success: true,
        result: {
          id: createdId,
          status: 'active',
          value: token,
          expires_on: (body as Record<string, unknown>).expires_on,
        },
      };
    throw new Error('Unexpected fixture request');
  });
  const options = { mode: 'existing' as const, dataDirectory, token, accountId: account, selected: [models[0].id] };
  return { dataDirectory, store, models, manager, request, options, deps: { manager, request, now: () => now } };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^workers-ai-setup-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('safe optional Workers AI onboarding', () => {
  it('uses real authenticated encryption and discovered metadata, leaving unknown capabilities unset', async () => {
    const f = fixture();
    const result = await setupWorkersAi({ ...f.options, selected: f.models.map((model) => model.id) }, f.deps);
    expect(result.saved).toBe(2);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.manager.discoverModels).toHaveBeenCalledWith({
      provider: 'workers-ai',
      apiFormat: 'openai',
      apiUrl: endpoint(),
      apiKey: token,
    });
    const bytes = fs.readFileSync(f.store.filename, 'utf8');
    expect(bytes).not.toContain(token);
    const saved = f.store.read();
    expect(saved[0].encrypted).toBe(true);
    expect(codec.decryptString(saved[0].apiKey!)).toBe(token);
    expect(saved[0].contextWindow).toBe(262144);
    expect(saved[0].supportsVision).toBe(true);
    expect(saved[1]).not.toHaveProperty('contextWindow');
    expect(saved[1]).not.toHaveProperty('supportsVision');
    expect(saved[1]).not.toHaveProperty('maxOutputTokens');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('verify-only checks catalog access without creating any file, token or generation', async () => {
    const f = fixture();
    const result = await setupWorkersAi(
      { mode: 'verify-only', dataDirectory: f.dataDirectory, token, accountId: account },
      f.deps,
    );
    expect(result).toMatchObject({ saved: 0, tokenCreated: false, verification: 'catalog-access-only' });
    expect(fs.readdirSync(f.dataDirectory)).toEqual([]);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('creates exactly one account-scoped Workers AI Write token with expires_on and never creates a token manager', async () => {
    const f = fixture();
    const result = await setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap, expiresInDays: 30 }, f.deps);
    const creates = f.request.mock.calls.filter((call) => call[2] === 'POST');
    expect(creates).toHaveLength(1);
    expect(creates[0].slice(0, 3)).toEqual([`/accounts/${account}/tokens`, bootstrap, 'POST']);
    expect(creates[0][3]).toMatchObject({
      expires_on: '2026-11-13T12:00:00.000Z',
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${account}`]: '*' },
          permission_groups: [{ id: permission }],
        },
      ],
    });
    expect(creates[0][3]).not.toHaveProperty('expires_at');
    expect(result.tokenId).toBe(createdId);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fs.readFileSync(f.store.filename, 'utf8')).not.toContain(bootstrap);
  });

  it.each([
    { name: 'Workers AI Read', scopes: ['com.cloudflare.api.account'] },
    { name: 'Workers AI Write', scopes: ['com.cloudflare.api.user'] },
    { name: 'Workers AI Write', scopes: ['com.cloudflare.api.account', 'com.cloudflare.api.account.zone'] },
    { name: 'Workers AI Write', scopes: ['com.cloudflare.api.account'], is_selectable: false },
  ])('rejects a wrong or unavailable permission group without creating a token (%#)', async (group) => {
    const f = fixture();
    f.request.mockResolvedValue({ success: true, result: [{ id: permission, ...group }] });
    await expect(setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap }, f.deps)).rejects.toThrow(
      'Exactly one account-scoped Workers AI Write',
    );
    expect(f.request.mock.calls.some((call) => call[2] === 'POST')).toBe(false);
    expect(fs.readdirSync(f.dataDirectory)).toEqual([]);
  });

  it('does not mint on a refused wizard confirmation', async () => {
    const f = fixture();
    await expect(
      setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap, confirmCreate: async () => false }, f.deps),
    ).rejects.toThrow('nothing was created');
    expect(f.request.mock.calls.filter((call) => call[2] === 'POST')).toHaveLength(0);
  });

  it('never retries an ambiguous creation failure or leaks its error body', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[2] === 'POST') throw new Error(`connection failed ${bootstrap} ${token}`);
      return original(...args);
    });
    const error = await setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap }, f.deps).catch(
      (value) => value,
    );
    expect(error.message).toContain('may have succeeded remotely');
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain(bootstrap);
    expect(f.request.mock.calls.filter((call) => call[2] === 'POST')).toHaveLength(1);
    expect(fs.readdirSync(f.dataDirectory)).toEqual([]);
  });

  it('reports an orphan token ID after discovery failure and leaves prior configuration intact', async () => {
    const f = fixture();
    fs.writeFileSync(f.store.filename, '[]');
    f.manager.discoverModels.mockRejectedValue(new Error(`provider leak ${token}`));
    const error = await setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap }, f.deps).catch(
      (value) => value,
    );
    expect(error.message).toContain(`Token ${createdId} was created but was not saved`);
    expect(error.message).not.toContain(token);
    expect(fs.readFileSync(f.store.filename, 'utf8')).toBe('[]');
  });

  it('paginates accounts before asking for a selection', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: index.toString(16).padStart(32, '0'),
      name: `Account ${index}`,
    }));
    f.request.mockImplementation(async (...args) => {
      if (args[0].startsWith('/accounts?'))
        return {
          success: true,
          result: args[0].includes('page=1&') ? first : [{ id: account, name: 'Selected' }],
          result_info: { page: args[0].includes('page=1&') ? 1 : 2, total_count: 101 },
        };
      return original(...args);
    });
    const choose = vi.fn(async (accounts) => {
      expect(accounts).toHaveLength(101);
      return account;
    });
    await setupWorkersAi(
      { ...f.options, mode: 'create', token: bootstrap, accountId: undefined, chooseAccount: choose },
      f.deps,
    );
    expect(choose).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.filter((call) => call[0].startsWith('/accounts?'))).toHaveLength(2);
  });

  it('rejects repeated account pages and invalid account IDs before creating a token', async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      success: true,
      result: [{ id: account, name: 'Repeated' }],
      result_info: { total_count: 3 },
    });
    await expect(
      setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap, accountId: undefined }, f.deps),
    ).rejects.toThrow('repeated a page');
    expect(f.request).toHaveBeenCalledTimes(2);
    f.request.mockClear();
    await expect(setupWorkersAi({ ...f.options, accountId: '../other' }, f.deps)).rejects.toThrow('32 hexadecimal');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('rotates only official endpoints in the selected account, preserving settings and encrypted custom headers', async () => {
    const f = fixture();
    const base = {
      provider: 'custom',
      externalModelName: '@cf/fixture/one',
      apiKey: 'old-fixture-token-secret',
      enabled: false,
      contextWindow: 123456,
      temperature: 0.7,
      customHeaders: { 'X-Custom': 'private-header-value' },
    };
    f.store.import([
      { ...base, name: 'models/selected', apiUrl: endpoint() },
      { ...base, name: 'models/other-account', apiUrl: endpoint(otherAccount) },
      { ...base, name: 'models/custom-host', apiUrl: 'https://proxy.example/ai/v1' },
      {
        ...base,
        name: 'models/lookalike',
        apiUrl: `https://api.cloudflare.com.evil.invalid/client/v4/accounts/${account}/ai/v1/chat/completions`,
      },
    ]);
    const before = f.store.read();
    await setupWorkersAi({ ...f.options, selected: [], rotate: true }, f.deps);
    const after = f.store.read();
    expect(codec.decryptString(after[0].apiKey!)).toBe(token);
    expect(after[0]).toMatchObject({
      enabled: false,
      contextWindow: 123456,
      temperature: 0.7,
      customHeaders: before[0].customHeaders,
    });
    expect(codec.decryptString((after[0].customHeaders as Record<string, string>)['X-Custom'])).toBe(
      'private-header-value',
    );
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it('updates selected existing aliases without replacing model settings', async () => {
    const f = fixture();
    f.store.save({
      name: 'models/my-alias',
      provider: 'custom',
      apiUrl: endpoint(),
      externalModelName: f.models[0].id,
      apiKey: 'old-fixture-token-secret',
      enabled: false,
      supportsVision: false,
      maxOutputTokens: 123,
    });
    await setupWorkersAi(f.options, f.deps);
    expect(f.store.read()).toHaveLength(1);
    expect(f.store.read()[0]).toMatchObject({
      name: 'models/my-alias',
      enabled: false,
      supportsVision: false,
      maxOutputTokens: 123,
    });
  });

  it('replaces authentication headers case-insensitively while preserving other encrypted headers', async () => {
    const f = fixture();
    f.store.save({
      name: 'models/auth-aliases',
      provider: 'custom',
      apiUrl: endpoint(),
      externalModelName: f.models[0].id,
      apiKey: 'old-fixture-token-secret',
      customHeaders: {
        authorization: 'Bearer old-one',
        Authorization: 'Bearer old-two',
        'X-AuTh-Key': 'old-global-key',
        'x-auth-email': 'old@example.invalid',
        'X-Custom': 'preserve-private-header',
      },
    });
    const before = f.store.read()[0];
    await setupWorkersAi({ ...f.options, rotate: true, selected: [] }, f.deps);
    const after = f.store.read()[0];
    expect(after.customHeaders).toEqual({ 'X-Custom': (before.customHeaders as Record<string, string>)['X-Custom'] });
    expect(codec.decryptString(after.apiKey!)).toBe(token);
  });

  it('does not create a token for rotation when the selected account has no existing models', async () => {
    const f = fixture();
    await expect(
      setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap, rotate: true, selected: [] }, f.deps),
    ).rejects.toThrow('nothing was saved or created');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('rejects duplicate saved names before token creation', async () => {
    const f = fixture();
    const entry = {
      name: 'models/duplicate',
      provider: 'custom',
      apiUrl: endpoint(),
      externalModelName: '@cf/fixture/one',
    };
    fs.writeFileSync(f.store.filename, JSON.stringify([entry, entry]));
    await expect(setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap }, f.deps)).rejects.toThrow(
      'duplicate saved model names',
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it('requires the create response to confirm the requested expiration', async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[2] === 'POST') delete (result.result as Record<string, unknown>).expires_on;
      return result;
    });
    await expect(setupWorkersAi({ ...f.options, mode: 'create', token: bootstrap }, f.deps)).rejects.toThrow(
      'did not confirm',
    );
    expect(fs.readdirSync(f.dataDirectory)).toEqual([]);
  });

  it('does not overwrite a generated-name collision belonging to another account', async () => {
    const f = fixture();
    const suffix = createHash('sha256').update(f.models[0].id).digest('hex').slice(0, 16);
    f.store.save({
      name: `models/workers-ai-${account}-${suffix}`,
      provider: 'custom',
      apiUrl: endpoint(otherAccount),
      externalModelName: f.models[0].id,
      apiKey: 'old-fixture-token-secret',
    });
    const before = fs.readFileSync(f.store.filename);
    await expect(setupWorkersAi(f.options, f.deps)).rejects.toThrow('conflicts');
    expect(fs.readFileSync(f.store.filename)).toEqual(before);
  });

  it('preserves the whole previous model file when batch validation fails', async () => {
    const f = fixture();
    fs.writeFileSync(f.store.filename, '[]');
    f.models.push({ id: '@cf/bad', displayName: 'Bad', contextWindow: -1 });
    await expect(setupWorkersAi({ ...f.options, selected: f.models.map((model) => model.id) }, f.deps)).rejects.toThrow(
      'not partially updated',
    );
    expect(fs.readFileSync(f.store.filename, 'utf8')).toBe('[]');
  });

  it('validates expiry, modes and absent account rotation before saving', async () => {
    const f = fixture();
    for (const value of ['2026-02-31T12:00:00Z', 'never', '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z'])
      expect(() => expiresOn(value, 90, now)).toThrow();
    expect(() => expiresOn(undefined, 0, now)).toThrow();
    expect(expiresOn('2026-11-01T00:00:00Z', 90, now)).toBe('2026-11-01T00:00:00.000Z');
    await expect(setupWorkersAi({ ...f.options, mode: 'verify-only' }, f.deps)).rejects.toThrow('cannot select');
    await expect(setupWorkersAi({ ...f.options, rotate: true, selected: [] }, f.deps)).rejects.toThrow(
      'nothing was saved',
    );
    expect(fs.readdirSync(f.dataDirectory)).toEqual([]);
  });

  it('matches only complete official Workers AI URLs for the selected account', () => {
    const model = { name: 'models/url-boundary', provider: 'custom', externalModelName: '@cf/fixture/one' };
    for (const apiUrl of [
      endpoint(otherAccount),
      endpoint() + '?account=other',
      endpoint() + '#fragment',
      endpoint().replace('https:', 'http:'),
      endpoint().replace('api.cloudflare.com', 'api.cloudflare.com.evil'),
    ])
      expect(isAccountWorkersModel({ ...model, apiUrl }, account)).toBe(false);
    expect(isAccountWorkersModel({ ...model, apiUrl: endpoint().replace('/chat/completions', '/') }, account)).toBe(
      true,
    );
  });
});

describe('Cloudflare transport and CLI boundaries', () => {
  it('uses only the official origin and forbids redirects without leaking provider errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: token }), { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(cloudflareRequest(`/accounts/${account}/tokens`, bootstrap, 'POST', { test: true })).rejects.toThrow(
      'HTTP 403',
    );
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: `Bearer ${bootstrap}` },
    });
    await expect(cloudflareRequest('//evil.invalid', token)).rejects.toThrow('Invalid Cloudflare');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds transport JSON size and redacts thrown network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))),
    );
    await expect(cloudflareRequest('/accounts?page=1', token)).rejects.toThrow('exceeds 2 MiB');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(bootstrap);
      }),
    );
    const error = await cloudflareRequest('/accounts?page=1', token).catch((value) => value);
    expect(error.message).not.toContain(bootstrap);
    expect(error.message).toContain('No request was retried');
  });

  it('terminates a hung request with a wall-clock deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(token)))),
      ),
    );
    const pending = expect(cloudflareRequest('/accounts?page=1', token)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10001);
    await pending;
  });

  it('never accepts tokens as command arguments or mutating verify-only options', () => {
    for (const args of [
      ['existing', '--use-token', token],
      ['create', '--bootstrap-token', bootstrap],
      ['verify-only', '--rotate'],
      ['verify-only', '--bootstrap-file', 'file'],
      ['create', '--expires-in-days', '-1'],
    ]) {
      const error = (() => {
        try {
          parseWorkersAiOptions(args);
        } catch (value) {
          return value;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(bootstrap);
    }
  });

  it('existing mode never reads or requests bootstrap credentials', async () => {
    const writes: string[] = [];
    const env = {
      CF_WORKERS_AI_TOKEN: token,
      get CF_BOOTSTRAP_TOKEN() {
        throw new Error('bootstrap must not be accessed');
      },
    };
    const setup = vi.fn(async (options) => {
      expect(options.token).toBe(token);
      return { accountId: account, saved: 1, tokenCreated: false };
    });
    await runWorkersAiCli(['existing', '--account-id', account, '--select', '@cf/fixture/one'], {
      env,
      setup,
      write: (line) => writes.push(line),
      masked: () => {
        throw new Error('unexpected prompt');
      },
    });
    expect(writes.join('\n')).not.toContain(token);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('reads only a specified private token file and rejects oversized input', async () => {
    const f = fixture();
    const filename = path.join(f.dataDirectory, 'supplied-token');
    fs.writeFileSync(filename, token + '\n', { mode: 0o600 });
    expect(await readSecretInput({ filename })).toBe(token);
    await expect(readSecretInput({ filename, environmentValue: token })).rejects.toThrow('either');
    fs.writeFileSync(filename, 'x'.repeat(8193));
    await expect(readSecretInput({ filename })).rejects.toThrow('8192');
  });

  it('masks interactive input and restores terminal state; refuses non-TTY secret prompts', async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(value) {
        this.isRaw = value;
      }
      resume() {}
      pause() {}
    }
    const input = new Input();
    let output = '';
    const pending = maskedPrompt('Secret: ', input, {
      isTTY: true,
      write: (value) => {
        output += value;
      },
    });
    for (const character of token) input.emit('keypress', character, { name: character });
    input.emit('keypress', '\r', { name: 'return' });
    expect(await pending).toBe(token);
    expect(input.isRaw).toBe(false);
    expect(output).not.toContain(token);
    expect(output).toContain('*');
    await expect(maskedPrompt('Secret: ', { isTTY: false }, { isTTY: false })).rejects.toThrow('environment variable');
  });
});
