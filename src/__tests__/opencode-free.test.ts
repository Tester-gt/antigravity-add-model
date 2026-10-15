import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CustomModel } from '../proxy';
import { getProvider, isOpencodeEndpoint, OPENCODE_USER_AGENT } from '../providers';
import { getProviderHeaders } from '../proxy/registry';
import { runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const servers: http.Server[] = [];
afterEach(async () => {
  stopCustomRequests();
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
afterAll(stopCleanupInterval);

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
interface CapturedBody {
  stream?: boolean;
  tools: { function: { name: string } }[];
  tool_choice?: unknown;
}
async function readBody(req: http.IncomingMessage): Promise<CapturedBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const requestBody = {
  sessionId: 'conversation Türkçe\nfixture',
  contents: [{ role: 'user', parts: [{ text: 'Read the fixture file.' }] }],
  tools: [
    {
      functionDeclarations: [
        {
          name: 'view_file',
          parameters: { type: 'object', properties: { AbsolutePath: { type: 'string' } }, required: ['AbsolutePath'] },
        },
      ],
    },
  ],
};
function configuration(apiUrl: string, overrides: Partial<CustomModel> = {}): CustomModel {
  return {
    name: `models/${randomUUID()}`,
    displayName: 'OpenCode fixture',
    description: '',
    provider: 'opencode',
    apiKey: '',
    apiUrl,
    externalModelName: 'big-pickle',
    maxRetries: 0,
    ...overrides,
  };
}
async function proxy(model: CustomModel, stream = false): Promise<string> {
  return serve((_req, res) => {
    void runCustomModelRequest(res, model, requestBody, stream, [model], false);
  });
}
function jsonReply(res: http.ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
}

describe('OpenCode API compatibility', () => {
  it('offers keyless chat without changing the paid Go requirement or legacy Zen endpoint', () => {
    expect(getProvider('opencode')).toMatchObject({
      defaultUrl: 'https://opencode.ai/inference/openai/v1/chat/completions',
      keyRequired: false,
    });
    expect(getProvider('zen')).toMatchObject({
      defaultUrl: 'https://opencode.ai/zen/v1/chat/completions',
      keyRequired: false,
    });
    expect(getProvider('opencode-go')).toMatchObject({
      defaultUrl: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
      keyRequired: true,
    });
  });

  it('detects exact official origins and explicit gateways, not lookalike URLs', () => {
    expect(isOpencodeEndpoint('https://opencode.ai/inference/openai/v1/chat/completions', 'custom')).toBe(true);
    expect(isOpencodeEndpoint('https://opencode.ai/zen/v1/chat/completions', 'custom')).toBe(true);
    expect(isOpencodeEndpoint('https://gateway.example/v1/chat/completions', 'opencode')).toBe(true);
    for (const url of [
      'https://opencode.ai.example/inference/v1/chat/completions',
      'https://elsewhere.example/opencode.ai/v1/chat/completions',
      'https://elsewhere.example/v1/chat/completions?provider=opencode.ai',
      'http://opencode.ai/inference/v1/chat/completions',
    ])
      expect(isOpencodeEndpoint(url, 'custom')).toBe(false);
  });

  it.each(['', 'none'])(
    'omits Authorization for keyless requests (%s), without an official-client fingerprint',
    (key) => {
      const headers = getProviderHeaders('opencode', key);
      expect(headers.Authorization).toBeUndefined();
      expect(headers['User-Agent']).toBe(OPENCODE_USER_AGENT);
      expect(headers['x-opencode-client']).toBeUndefined();
      expect(headers['x-opencode-project']).toBeUndefined();
    },
  );

  it.each(['openai', 'anthropic', 'google'] as const)(
    'uses the supplied Console bearer key with %s format',
    (format) => {
      const headers = getProviderHeaders('opencode', 'fixture-key', format);
      expect(headers.Authorization).toBe('Bearer fixture-key');
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['x-goog-api-key']).toBeUndefined();
      if (format === 'anthropic') expect(headers['anthropic-version']).toBe('2023-06-01');
    },
  );

  it.each([false, true])('preserves the real tool declarations and stream=%s with keyless requests', async (stream) => {
    const received: { headers: http.IncomingHttpHeaders; body: CapturedBody; path: string }[] = [];
    const upstream = await serve(async (req, res) => {
      received.push({ headers: req.headers, body: await readBody(req), path: req.url || '' });
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else jsonReply(res);
    });
    const url = await proxy(configuration(`${upstream}/legacy/v1/chat/completions`), stream);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('OK');
    }
    expect(received).toHaveLength(2);
    expect(received[0].body.stream).toBe(stream);
    expect(received[0].body.tools.map((tool) => tool.function.name)).toEqual(['view_file']);
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].headers['user-agent']).toBe(OPENCODE_USER_AGENT);
    expect(received[0].headers['x-opencode-session']).toMatch(/^[a-f0-9]{64}$/);
    expect(received[0].headers['x-opencode-session']).toBe(received[1].headers['x-opencode-session']);
    expect(received[0].path).toBe('/legacy/v1/chat/completions');
    expect(received[0].body.tool_choice).toBeUndefined();
  });

  it('keeps a free-named model on another provider untouched', async () => {
    let received: { headers: http.IncomingHttpHeaders; body: CapturedBody } | undefined;
    const upstream = await serve(async (req, res) => {
      received = { headers: req.headers, body: await readBody(req) };
      jsonReply(res);
    });
    const url = await proxy(configuration(upstream, { provider: 'custom', externalModelName: 'local-free' }));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    await response.text();
    expect(received?.body.stream).toBe(false);
    expect(received?.headers.authorization).toBeUndefined();
    expect(received?.headers['user-agent']).toBeUndefined();
    expect(received?.headers['x-opencode-session']).toBeUndefined();
    expect(received?.body.tools.map((tool) => tool.function.name)).toEqual(['view_file']);
  });

  it('explains the provider free-tier restriction without echoing its response body or retrying', async () => {
    let requests = 0;
    const upstream = await serve(async (req, res) => {
      requests++;
      await readBody(req);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: "OpenCode's free tier can only be used from within OpenCode: secret-echo fixture-prompt" },
        }),
      );
    });
    const url = await proxy(configuration(upstream, { maxRetries: 2 }));
    const response = await fetch(url);
    const body = await response.text();
    expect(response.status).toBe(403);
    expect(body).toContain('restricts this free model to its own client');
    expect(body).toContain('model available to external clients');
    expect(body).not.toContain('secret-echo');
    expect(body).not.toContain('fixture-prompt');
    expect(requests).toBe(1);
  });

  it('explains missing paid-model credentials without fabricating a public token', async () => {
    const upstream = await serve(async (req, res) => {
      await readBody(req);
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'sensitive-upstream-error' } }));
    });
    const url = await proxy(configuration(upstream, { externalModelName: 'paid-model' }));
    const response = await fetch(url);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('valid OpenCode Console API key');
    expect(body).not.toContain('sensitive-upstream-error');
  });

  it.each([false, true])('does not treat partial/error SSE as a complete answer (stream=%s)', async (stream) => {
    const upstream = await serve(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"error":{"message":"sensitive-upstream-error"}}\n\n',
      );
    });
    const url = await proxy(configuration(upstream), stream);
    const response = await fetch(url);
    const body = await response.text();
    if (stream) {
      expect(body).toContain('event: error');
      expect(body).not.toContain('"finishReason":"STOP"');
    } else expect(response.status).toBe(502);
    expect(body).not.toContain('sensitive-upstream-error');
  });
});
