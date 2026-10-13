/** Exercise the public MCP protocol against real child processes and loopback HTTP. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDelegationServer, parseDelegationOptions } from '../../scripts/model-delegation-mcp.mjs';

vi.setConfig({ testTimeout: 15000, hookTimeout: 15000 });
const script = fileURLToPath(new URL('../../scripts/model-delegation-mcp.mjs', import.meta.url));
const directories: string[] = [];
const clients: Client[] = [];
const servers: http.Server[] = [];
const answer = { candidates: [{ content: { parts: [{ text: 'A verified independent answer.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 6, totalTokenCount: 14 } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-test-'));
  directories.push(value); return value;
}
async function fixture() {
  const dataDirectory = directory();
  const requests: { url?: string; authorization?: string; body: any }[] = [];
  const state = { version: 1, token: randomBytes(32).toString('hex'), instance: randomUUID(), pid: process.pid, port: 0 };
  const f = {
    dataDirectory, requests, state, health: {} as Record<string, unknown>,
    result: structuredClone(answer) as any, status: 200, raw: undefined as string | undefined,
    models: [{ name: 'models/fixture-child', displayName: 'Fixture child', description: 'Independent model', apiKey: 'never-return-model-api-key' }],
    hold: false, entered: deferred(), disconnected: deferred(), healthRequests: 0,
  };
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
    expect(req.headers.authorization).toBe(`Bearer ${state.token}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/_addon/health') {
      f.healthRequests++;
      res.end(JSON.stringify({ service: 'antigravity-model-proxy', instance: state.instance, pid: state.pid, port: state.port, ...f.health }));
    } else if (req.url?.startsWith('/_addon/delegation/models')) {
      const cursor = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('cursor') || 0);
      const nextCursor = cursor + 100 < f.models.length ? cursor + 100 : undefined;
      res.end(JSON.stringify({ mode: 'text-only', models: f.models.slice(cursor, cursor + 100), nextCursor }));
    } else if (req.url === '/_addon/delegation/run') {
      if (!f.models.some((model) => model.name === JSON.parse(text).model)) {
        res.statusCode = 400; res.end(JSON.stringify({ error: `Unknown model. Private diagnostic: ${state.token}` })); return;
      }
      f.entered.resolve();
      if (f.hold) { res.once('close', () => f.disconnected.resolve()); return; }
      res.statusCode = f.status;
      res.end(f.raw ?? JSON.stringify(f.result));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  fs.mkdirSync(path.join(dataDirectory, '.ide-proxy'));
  fs.writeFileSync(path.join(dataDirectory, '.ide-proxy', 'state.json'), JSON.stringify(state));
  return f;
}
async function connect(dataDirectory: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [script, '--data-dir', dataDirectory], stderr: 'pipe' });
  const transcript: string[] = [];
  const errors: Error[] = [];
  let stderr = '';
  transport.onmessage = (message) => transcript.push(JSON.stringify(message));
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'mcp-protocol-test', version: '1.0.0' });
  clients.push(client);
  client.onerror = (error) => errors.push(error);
  await client.connect(transport);
  return { client, transcript, errors, stderr: () => stderr };
}
const call = (client: Client, args: Record<string, unknown> = { model: 'models/fixture-child', prompt: 'Explain the supplied context.', context: 'A small independent task.' }) =>
  client.callTool({ name: 'delegate_to_model', arguments: args });

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  for (const root of directories.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^agy-mcp-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('custom model delegation MCP', () => {
  it('negotiates stdio, advertises explicit text-only tools and returns only safe model fields', async () => {
    const f = await fixture();
    const connected = await connect(f.dataDirectory);
    const tools = await connected.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['list_custom_models', 'delegate_to_model']);
    expect(tools.tools[1].description).toContain('does not open an IDE-native subagent');
    expect(tools.tools[1].inputSchema.additionalProperties).toBe(false);
    const result = await connected.client.callTool({ name: 'list_custom_models', arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain('models/fixture-child');
    expect(JSON.stringify(result)).not.toContain('apiKey');
    expect(connected.transcript.join('\n')).not.toContain('never-return-model-api-key');
    expect(connected.transcript.join('\n')).not.toContain(f.state.token);
    expect(connected.stderr()).toBe('');
    expect(connected.errors).toEqual([]);
    expect(f.requests.map((request) => request.url)).toEqual(['/_addon/health', '/_addon/delegation/models']);
  });

  it('delegates an exact saved name and returns text, finish reason and numeric usage', async () => {
    const f = await fixture();
    f.result.candidates[0].content.parts.unshift({ text: 'private internal reasoning', thought: true });
    f.result.usageMetadata.apiKey = 'usage-credential';
    const connected = await connect(f.dataDirectory);
    const result = await call(connected.client);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain('A verified independent answer.');
    expect(JSON.stringify(result)).toContain('STOP');
    expect(JSON.stringify(result)).toContain('totalTokenCount');
    expect(JSON.stringify(result)).not.toContain('private internal reasoning');
    expect(JSON.stringify(result)).not.toContain('usage-credential');
    expect(f.requests.at(-1)?.body).toEqual({ model: 'models/fixture-child', prompt: 'Explain the supplied context.', context: 'A small independent task.' });
    expect(f.requests.map((request) => request.url)).toEqual(['/_addon/health', '/_addon/delegation/run']);
    expect(connected.transcript.join('\n')).not.toContain(f.state.token);
  });

  it.each(['instance', 'pid', 'port', 'service'])('refuses a mismatched authenticated service %s before contacting a model', async (field) => {
    const f = await fixture();
    f.health[field] = field === 'pid' || field === 'port' ? 0 : 'wrong-identity';
    const { client } = await connect(f.dataDirectory);
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('identity does not match');
    expect(f.requests.map((request) => request.url)).toEqual(['/_addon/health']);
  });

  it('does not start a service when no saved state exists', async () => {
    const dataDirectory = directory();
    const { client, stderr } = await connect(dataDirectory);
    const result = await client.callTool({ name: 'list_custom_models', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('not running');
    expect(fs.readdirSync(dataDirectory)).toEqual([]);
    expect(stderr()).toBe('');
  });

  it.each(['oversized', 'invalid', 'negative-pid'])('rejects %s state without contacting its endpoint', async (kind) => {
    const f = await fixture();
    const content = kind === 'oversized' ? ' '.repeat(8193) : kind === 'negative-pid' ? JSON.stringify({ ...f.state, pid: -1 }) : JSON.stringify({ ...f.state, token: 'bad-token' });
    fs.writeFileSync(path.join(f.dataDirectory, '.ide-proxy', 'state.json'), content);
    const { client } = await connect(f.dataDirectory);
    expect((await call(client)).isError).toBe(true);
    expect(f.requests).toEqual([]);
  });

  it('rejects a linked state directory before reading credentials', async () => {
    const f = await fixture();
    const dataDirectory = directory();
    fs.symlinkSync(path.join(f.dataDirectory, '.ide-proxy'), path.join(dataDirectory, '.ide-proxy'), process.platform === 'win32' ? 'junction' : 'dir');
    const { client } = await connect(dataDirectory);
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Linked proxy state');
    expect(f.requests).toEqual([]);
  });

  it.each([
    { model: 'models/fixture-child', prompt: 'x', apiUrl: 'https://example.invalid' },
    { model: 'models/fixture-child', prompt: 'x', apiKey: 'no-secret-arguments' },
    { model: 'models/fixture-child', prompt: 'x', tools: [] },
    { model: 'models/fixture-child', prompt: '😀'.repeat(16384), context: 'x' },
    { model: 'saved-child-' + 'x'.repeat(256 * 1024), prompt: 'x' },
    { model: 'models/fixture-child', prompt: ' ' },
  ])('rejects invalid or over-limit task arguments before any network request (%#)', async (args) => {
    const f = await fixture();
    const { client } = await connect(f.dataDirectory);
    expect((await call(client, args)).isError).toBe(true);
    expect(f.requests).toEqual([]);
  });

  it('passes unknown model rejection from the authoritative backend without fetching a catalog', async () => {
    const f = await fixture();
    const { client } = await connect(f.dataDirectory);
    const result = await call(client, { model: 'http://example.invalid/model', prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('HTTP 400');
    expect(JSON.stringify(result)).not.toContain(f.state.token);
    expect(f.requests.map((request) => request.url)).toEqual(['/_addon/health', '/_addon/delegation/run']);
  });

  it('paginates a catalog larger than 1 MiB and delegates directly to a later model', async () => {
    const f = await fixture();
    f.models = Array.from({ length: 1201 }, (_, index) => ({ name: `saved-child-${index}`, displayName: `Child ${index}`, description: 'Description '.repeat(150), apiKey: 'never-return-model-api-key' }));
    expect(Buffer.byteLength(JSON.stringify(f.models))).toBeGreaterThan(1024 * 1024);
    const connected = await connect(f.dataDirectory);
    const first = await connected.client.callTool({ name: 'list_custom_models', arguments: {} });
    const firstPage = JSON.parse((first.content as { text: string }[])[0].text);
    expect(firstPage.models).toHaveLength(100);
    expect(firstPage.nextCursor).toBe(100);
    const second = await connected.client.callTool({ name: 'list_custom_models', arguments: { cursor: firstPage.nextCursor } });
    const secondPage = JSON.parse((second.content as { text: string }[])[0].text);
    expect(secondPage.models[0].name).toBe('saved-child-100');
    expect(secondPage.nextCursor).toBe(200);
    const last = await connected.client.callTool({ name: 'list_custom_models', arguments: { cursor: 1200 } });
    const lastPage = JSON.parse((last.content as { text: string }[])[0].text);
    expect(lastPage.models).toHaveLength(1);
    expect(lastPage.nextCursor).toBeUndefined();
    f.requests.length = 0;
    const result = await call(connected.client, { model: 'saved-child-1200', prompt: 'Answer independently.' });
    expect(result.isError).toBeUndefined();
    expect(f.requests.map((request) => request.url)).toEqual(['/_addon/health', '/_addon/delegation/run']);
    expect(connected.transcript.join('\n')).not.toContain('never-return-model-api-key');
    expect(connected.transcript.join('\n')).not.toContain(f.state.token);
    expect(connected.errors).toEqual([]);
  });

  it('lists and delegates legitimate saved names longer than 1024 characters without requiring a prefix', async () => {
    const f = await fixture();
    f.models[0].name = `saved-${'custom'.repeat(400)}`;
    const { client } = await connect(f.dataDirectory);
    const listed = await client.callTool({ name: 'list_custom_models', arguments: {} });
    expect(JSON.stringify(listed)).toContain(f.models[0].name);
    const result = await call(client, { model: f.models[0].name, prompt: 'Answer independently.' });
    expect(result.isError).toBeUndefined();
    expect(f.requests.at(-1)?.body.model).toBe(f.models[0].name);
  });

  it.each([-1, 0.5, '100', Number.MAX_SAFE_INTEGER + 1])('rejects invalid pagination cursor %s before a network request', async (cursor) => {
    const f = await fixture();
    const { client } = await connect(f.dataDirectory);
    const result = await client.callTool({ name: 'list_custom_models', arguments: { cursor } });
    expect(result.isError).toBe(true);
    expect(f.requests).toEqual([]);
  });

  it('surfaces truncation and strips any accidentally echoed service credential', async () => {
    const f = await fixture();
    f.result.candidates[0].finishReason = 'MAX_TOKENS';
    f.result.candidates[0].content.parts = [{ text: `Partial answer ${f.state.token}` }];
    const connected = await connect(f.dataDirectory);
    const result = await call(connected.client);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain('MAX_TOKENS');
    expect(JSON.stringify(result)).toContain('truncated\\\":true');
    expect(connected.transcript.join('\n')).not.toContain(f.state.token);
    expect(JSON.stringify(result)).toContain('[redacted]');
  });

  it.each([
    { candidates: [{ content: { parts: [{ thought: true, text: 'thinking only' }] } }] },
    { candidates: [{ content: { parts: [{ text: ' ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'A pretend answer' }, { functionCall: { name: 'run_command', args: {} } }] } }] },
    { error: { message: 'upstream-api-key-secret' } },
  ])('does not report empty, reasoning-only or tool-call replies as successful child tasks (%#)', async (response) => {
    const f = await fixture(); f.result = response;
    const { client } = await connect(f.dataDirectory);
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('thinking only');
    expect(JSON.stringify(result)).not.toContain('A pretend answer');
    expect(JSON.stringify(result)).not.toContain('upstream-api-key-secret');
  });

  it.each([302, 401, 429, 502])('returns sanitized HTTP %s errors without exposing bodies or following redirects', async (status) => {
    const f = await fixture(); f.status = status;
    f.raw = JSON.stringify({ error: `Bearer ${f.state.token} provider-api-key-secret` });
    const connected = await connect(f.dataDirectory);
    const result = await call(connected.client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(`HTTP ${status}`);
    expect(connected.transcript.join('\n')).not.toContain(f.state.token);
    expect(connected.transcript.join('\n')).not.toContain('provider-api-key-secret');
    expect(connected.stderr()).toBe('');
  });

  it.each(['invalid-json', 'oversized'])('bounds and rejects %s provider responses', async (kind) => {
    const f = await fixture(); f.raw = kind === 'invalid-json' ? '{invalid-json' : JSON.stringify({ value: 'x'.repeat(1024 * 1024) });
    const { client } = await connect(f.dataDirectory);
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(kind === 'invalid-json' ? 'invalid JSON' : 'allowed size');
  });

  it('propagates MCP cancellation to the active HTTP child request', async () => {
    const f = await fixture(); f.hold = true;
    const { client } = await connect(f.dataDirectory);
    const controller = new AbortController();
    const result = client.callTool({ name: 'delegate_to_model', arguments: { model: 'models/fixture-child', prompt: 'Wait' } }, undefined, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow();
    await f.entered.promise;
    controller.abort(new Error('Test cancelled'));
    await rejected;
    await f.disconnected.promise;
    // A cancelled request does not break the protocol connection.
    expect((await client.listTools()).tools).toHaveLength(2);
  });

  it('aborts a child request on stdio client disconnect', async () => {
    const f = await fixture(); f.hold = true;
    const { client } = await connect(f.dataDirectory);
    const result = call(client);
    const rejected = expect(result).rejects.toThrow();
    await f.entered.promise;
    await client.close();
    await rejected;
    await f.disconnected.promise;
  });

  it('enforces its deadline even when a provider never sends headers', async () => {
    const f = await fixture(); f.hold = true;
    const server = createDelegationServer({ dataDirectory: f.dataDirectory }, { timeoutMs: 200 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'deadline-test', version: '1' }); clients.push(client);
    await client.connect(clientTransport);
    const result = await call(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('timed out');
    await f.disconnected.promise;
  });

  it('parses only the documented data-directory option', () => {
    expect(parseDelegationOptions(['--data-dir', '.']).dataDirectory).toBe(path.resolve('.'));
    expect(parseDelegationOptions([]).dataDirectory).toBe(path.join(os.homedir(), '.gemini', 'antigravity'));
    expect(() => parseDelegationOptions(['--port', '5000'])).toThrow('Usage:');
    expect(() => parseDelegationOptions(['--data-dir'])).toThrow('Usage:');
  });
});
