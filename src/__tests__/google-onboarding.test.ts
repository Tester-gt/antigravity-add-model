import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { GoogleAccount } from '../googleAccounts';
import {
  GOOGLE_CLOUD_CODE_DAILY,
  GOOGLE_CLOUD_CODE_PRODUCTION,
  prepareGoogleAccount,
  type GooglePreparationDependencies,
} from '../googleOnboarding';

const servers: http.Server[] = [];
afterEach(async () => {
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
const account: GoogleAccount = {
  id: 'fixture-account',
  accessToken: 'fixture-access-token',
  refreshToken: 'fixture-refresh-token',
  clientId: 'fixture-client',
  project: 'existing-project',
};
const fast = { pollIntervalMs: 0 };

describe('explicit Google account preparation', () => {
  it.each(['existing-project', { id: 'existing-project' }])(
    'loads an existing project from supported response shapes without enrolling',
    async (project) => {
      const requests: { path?: string; method?: string; body: unknown; auth?: string }[] = [];
      const endpoint = await serve(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ path: req.url, method: req.method, body: JSON.parse(body), auth: req.headers.authorization });
        res.end(JSON.stringify({ cloudaicompanionProject: project, paidTier: { usesGcpTos: false } }));
      });
      const result = await prepareGoogleAccount(account, { endpoint, allowOnboard: true });
      expect(result).toEqual({ ...account, project: 'existing-project', cloudCodeEndpoint: endpoint });
      expect(requests).toEqual([
        {
          path: '/v1internal:loadCodeAssist',
          method: 'POST',
          auth: 'Bearer fixture-access-token',
          body: {
            cloudaicompanionProject: 'existing-project',
            metadata: { ideType: 9, ideName: 'antigravity', platform: expect.any(Number) },
          },
        },
      ]);
      expect(account).not.toHaveProperty('cloudCodeEndpoint');
    },
  );

  it.each([
    [true, GOOGLE_CLOUD_CODE_PRODUCTION],
    [false, GOOGLE_CLOUD_CODE_DAILY],
    [undefined, GOOGLE_CLOUD_CODE_DAILY],
  ] as const)('chooses the service from the returned paid-tier terms (%s)', async (usesGcpTos, origin) => {
    const request = vi.fn(async () => ({ cloudaicompanionProject: 'prepared', paidTier: { usesGcpTos } }));
    const result = await prepareGoogleAccount(account, {}, { request });
    expect(request.mock.calls[0][0].href).toBe(`${GOOGLE_CLOUD_CODE_PRODUCTION}/v1internal:loadCodeAssist`);
    expect(result.cloudCodeEndpoint).toBe(origin);
  });

  it('preserves an explicitly supplied project when the active tier validates it but omits a project echo', async () => {
    const result = await prepareGoogleAccount(
      account,
      {},
      { request: async () => ({ currentTier: { id: 'standard-tier' }, paidTier: { usesGcpTos: true } }) },
    );
    expect(result.project).toBe(account.project);
  });

  it('enrolls an eligible free tier explicitly and polls the same bounded operation using GET', async () => {
    const calls: { url?: string; method?: string; body?: unknown }[] = [];
    const endpoint = await serve(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : undefined });
      const response =
        calls.length === 1
          ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] }
          : calls.length === 2
            ? { name: 'operations/prepare_123' }
            : calls.length === 3
              ? { name: 'operations/prepare_123', done: false }
              : { done: true, response: { cloudaicompanionProject: { id: 'created-project' } } };
      res.end(JSON.stringify(response));
    });
    const result = await prepareGoogleAccount(
      { ...account, project: undefined },
      { endpoint, allowOnboard: true },
      fast,
    );
    expect(result.project).toBe('created-project');
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', '/v1internal:loadCodeAssist'],
      ['POST', '/v1internal:onboardUser'],
      ['GET', '/v1internal/operations/prepare_123'],
      ['GET', '/v1internal/operations/prepare_123'],
      ['POST', '/v1internal:loadCodeAssist'],
    ]);
    expect(calls[1].body).toMatchObject({ tierId: 'free-tier', metadata: { ideType: 9, ideName: 'antigravity' } });
    expect(calls[1].body).not.toHaveProperty('cloudaicompanionProject');
    expect(calls[2].body).toBeUndefined();
  });

  it('supports snake_case protobuf fields and a synchronous completed onboarding operation', async () => {
    let calls = 0;
    const request = vi.fn(async () =>
      ++calls === 1
        ? { allowed_tiers: [{ id: 'free-tier' }] }
        : { done: true, response: { cloudaicompanion_project: 'prepared-project' } },
    );
    await expect(
      prepareGoogleAccount({ ...account, project: undefined }, { allowOnboard: true }, { request }),
    ).resolves.toMatchObject({ project: 'prepared-project', cloudCodeEndpoint: GOOGLE_CLOUD_CODE_DAILY });
    expect(request.mock.calls[1][0].origin).toBe(GOOGLE_CLOUD_CODE_DAILY);
  });

  it('reloads the prepared project and persists a changed tier route without losing the operation project', async () => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
      .mockResolvedValueOnce({ done: true, response: { cloudaicompanionProject: { id: 'operation-project' } } })
      .mockResolvedValueOnce({ paidTier: { id: 'paid-tier', usesGcpTos: true } });
    await expect(
      prepareGoogleAccount({ ...account, project: undefined }, { allowOnboard: true }, { request }),
    ).resolves.toMatchObject({ project: 'operation-project', cloudCodeEndpoint: GOOGLE_CLOUD_CODE_PRODUCTION });
    expect(request.mock.calls[2][0].href).toBe(`${GOOGLE_CLOUD_CODE_DAILY}/v1internal:loadCodeAssist`);
    expect(request.mock.calls[2][3]).toMatchObject({ cloudaicompanionProject: 'operation-project' });
  });

  it('does not mark an account ready when the confirmation load rejects its project', async () => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
      .mockResolvedValueOnce({ done: true, response: { cloudaicompanionProject: { id: 'operation-project' } } })
      .mockResolvedValueOnce({ projectValidationError: { code: 7, message: 'private-detail' } });
    await expect(
      prepareGoogleAccount({ ...account, project: undefined }, { allowOnboard: true }, { request }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('honors an explicit eligibility rejection even if a stale project is also returned', async () => {
    const request = vi.fn(async () => ({
      cloudaicompanionProject: 'stale-project',
      ineligibleTiers: [{ tierId: 'free-tier' }],
    }));
    await expect(prepareGoogleAccount(account, { allowOnboard: true }, { request })).rejects.toMatchObject({
      status: 403,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [7, 403],
    [8, 429],
    [14, 503],
    [16, 401],
  ])('preserves operation failure category for code %s', async (code, status) => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
      .mockResolvedValueOnce({ done: true, error: { code, message: 'private-failure' } });
    const error = await prepareGoogleAccount(
      { ...account, project: undefined },
      { allowOnboard: true },
      { request },
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ status });
    expect(String(error)).not.toContain('private-failure');
  });

  it.each([undefined, 'local-gcm:encrypted', 'DECRYPTION_FAILED', 'token\u0000invalid', 'token\ninvalid'])(
    'refuses unavailable or unsafe access credentials before transport',
    async (accessToken) => {
      const request = vi.fn();
      await expect(prepareGoogleAccount({ ...account, accessToken }, {}, { request })).rejects.toMatchObject({
        status: 401,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('does not enroll during a read-only preparation request', async () => {
    const request = vi.fn(async () => ({ allowedTiers: [{ id: 'free-tier' }] }));
    await expect(prepareGoogleAccount({ ...account, project: undefined }, {}, { request })).rejects.toMatchObject({
      status: 409,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('allows the verified native personal default only for explicitly selected Antigravity authentication', async () => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ done: true, response: { cloudaicompanionProject: { id: 'personal-project' } } })
      .mockResolvedValueOnce({});
    await expect(
      prepareGoogleAccount(
        { ...account, authMode: 'antigravity', project: undefined },
        { allowOnboard: true },
        { request },
      ),
    ).resolves.toMatchObject({ project: 'personal-project' });
    expect(request).toHaveBeenCalledTimes(3);
    const customRequest = vi.fn(async () => ({}));
    await expect(
      prepareGoogleAccount({ ...account, project: undefined }, { allowOnboard: true }, { request: customRequest }),
    ).rejects.toMatchObject({ status: 403 });
    expect(customRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'sensitive-upstream-info' }] },
    { allowedTiers: [{ id: 'free-tier' }], ineligibleTiers: [{ tierId: 'free-tier' }] },
    { projectValidationError: { code: 7, message: 'private-project-details' } },
    { paidTier: { id: 'paid-tier', usesGcpTos: true } },
    { currentTier: { id: 'standard-tier' } },
  ])('never overrides ineligibility/project rejection or downgrades a paid account: %j', async (response) => {
    const request = vi.fn(async () => response);
    const error = await prepareGoogleAccount(
      { ...account, authMode: 'antigravity', project: undefined },
      { allowOnboard: true },
      { request },
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 403 });
    expect(String(error)).not.toMatch(/sensitive-upstream-info|private-project-details/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 503])('preserves HTTP %s and never attempts enrollment after rejection', async (status) => {
    let calls = 0;
    const endpoint = await serve((_req, res) => {
      calls++;
      res.writeHead(status);
      res.end('fixture-access-token fixture-refresh-token raw-provider-error');
    });
    const error = await prepareGoogleAccount(account, { endpoint, allowOnboard: true }).catch(
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ status });
    expect(String(error)).not.toMatch(/fixture-access-token|fixture-refresh-token|raw-provider-error/);
    expect(calls).toBe(1);
  });

  it('does not follow credential-bearing redirects', async () => {
    const target = vi.fn((_req, res) => res.end('{}'));
    const other = await serve(target);
    const endpoint = await serve((_req, res) => {
      res.writeHead(302, { Location: other });
      res.end();
    });
    await expect(prepareGoogleAccount(account, { endpoint })).rejects.toMatchObject({ status: 302 });
    expect(target).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example',
    'https://cloudcode-pa.googleapis.com.evil.example',
    'https://user:secret@cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com:8443',
    'http://cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com/?token=secret',
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  ])('rejects unsafe service endpoint %s before transport', async (endpoint) => {
    const request = vi.fn();
    await expect(prepareGoogleAccount(account, { endpoint }, { request })).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example/operations/foo',
    '//evil.example/operations/foo',
    '../operations/foo',
    'operations/../secret',
    'operations/abc?key=secret',
    'operations/abc#fragment',
    'operations/%2e%2e',
    'operations/abc%2fsecret',
    '/operations/abc',
    'operations/abc/extra',
  ])('rejects malicious/unsupported operation path %s without a poll', async (name) => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
      .mockResolvedValueOnce({ name });
    await expect(
      prepareGoogleAccount({ ...account, project: undefined }, { allowOnboard: true }, { ...fast, request }),
    ).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed operation name instead of following an unrelated resource', async () => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
      .mockResolvedValueOnce({ name: 'operations/first' })
      .mockResolvedValueOnce({ name: 'operations/second' });
    await expect(
      prepareGoogleAccount({ ...account, project: undefined }, { allowOnboard: true }, { ...fast, request }),
    ).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    { cloudaicompanionProject: { name: 'missing-id' } },
    { cloudaicompanionProject: 42 },
    { cloudaicompanionProject: 'bad\nproject' },
    { paidTier: { usesGcpTos: 'false' } },
    { allowedTiers: {} },
    { ineligibleTiers: ['invalid'] },
  ])('rejects invalid response shape %j', async (response) => {
    await expect(
      prepareGoogleAccount(
        { ...account, project: undefined },
        { allowOnboard: true },
        { request: async () => response },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('bounds operation polling and refuses malformed or failed completion responses', async () => {
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValue({ name: 'operations/pending' })
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] });
    await expect(
      prepareGoogleAccount(
        { ...account, project: undefined },
        { allowOnboard: true },
        { ...fast, maxPolls: 2, request },
      ),
    ).rejects.toMatchObject({ status: 504 });
    expect(request).toHaveBeenCalledTimes(4);
    for (const operation of [
      { done: true, response: {} },
      { done: 'true' },
      { done: true, error: { code: 7, message: 'private-error' } },
    ]) {
      const immediate = vi
        .fn<NonNullable<GooglePreparationDependencies['request']>>()
        .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
        .mockResolvedValueOnce(operation);
      const error = await prepareGoogleAccount(
        { ...account, project: undefined },
        { allowOnboard: true },
        { request: immediate },
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('private-error');
    }
  });

  it('enforces the overall deadline even when a server never responds', async () => {
    const endpoint = await serve(() => undefined);
    await expect(prepareGoogleAccount(account, { endpoint }, { timeoutMs: 25 })).rejects.toMatchObject({
      status: 504,
      message: expect.stringMatching(/timed out/),
    });
  });

  it('cancels an in-flight request and also refuses an already cancelled action', async () => {
    const controller = new AbortController();
    const endpoint = await serve(() => controller.abort());
    await expect(prepareGoogleAccount(account, { endpoint, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const request = vi.fn();
    await expect(prepareGoogleAccount(account, { signal: controller.signal }, { request })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels the polling delay without issuing another request', async () => {
    const controller = new AbortController();
    const request = vi
      .fn<NonNullable<GooglePreparationDependencies['request']>>()
      .mockResolvedValueOnce({ allowedTiers: [{ id: 'free-tier' }] })
      .mockImplementationOnce(async () => {
        setTimeout(() => controller.abort(), 10);
        return { name: 'operations/cancel' };
      });
    await expect(
      prepareGoogleAccount(
        { ...account, project: undefined },
        { allowOnboard: true, signal: controller.signal },
        { request, pollIntervalMs: 1000 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds streamed response bodies and rejects invalid JSON', async () => {
    const huge = await serve((_req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
    await expect(prepareGoogleAccount(account, { endpoint: huge })).rejects.toThrow(/size limit/);
    const bad = await serve((_req, res) => res.end('private-invalid-json'));
    const error = await prepareGoogleAccount(account, { endpoint: bad }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error)).not.toContain('private-invalid-json');
  });
});
