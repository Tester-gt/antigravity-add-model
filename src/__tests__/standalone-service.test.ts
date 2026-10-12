/** Real Node processes and local HTTP fixtures; no provider account or IDE install required. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { serviceCommand } from '../../scripts/desktop-service.mjs';

vi.setConfig({ hookTimeout: 20000, testTimeout: 20000 });
const directories: string[] = [];
const servers: http.Server[] = [];
function directory() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-owned-service-'));
  directories.push(result); return result;
}
async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function request(port: number, url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: options.method || 'GET', headers: options.headers, timeout: 5000 }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, text, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.end(options.body);
  });
}

describe('owned Node proxy and management HTTP', () => {
  let options: { command: string; port: number; dataDirectory: string; open: boolean };
  let endpoint: string;
  let token: string;
  let pid: number;
  let upstreamPort: number;
  const upstreamCalls: { body: unknown; authorization?: string; path?: string }[] = [];
  const apiKey = 'integration-key-never-return-in-ui';
  beforeAll(async () => {
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      upstreamCalls.push({ body: body ? JSON.parse(body) : null, authorization: req.headers.authorization, path: req.url });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion', model: 'local-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the real local fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 } }));
    });
    upstreamPort = await listen(server);
    options = { command: 'start', port: await unusedPort(), dataDirectory: directory(), open: false };
    const started = await serviceCommand(options);
    expect(started.status).toBe('running'); endpoint = started.endpoint; pid = started.pid;
    token = new URLSearchParams(new URL(started.managementUrl).hash.slice(1)).get('token')!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });
  afterAll(async () => {
    try { if (options) await serviceCommand({ ...options, command: 'stop' }); }
    finally {
      for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      for (const root of directories.splice(0)) {
        expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(root)).toMatch(/^agy-owned-service-/);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
  const rpc = async (channel: string, args: unknown[] = []) => {
    const result = await request(options.port, '/_addon/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: endpoint }, body: JSON.stringify({ channel, args }) });
    expect(result.status).toBe(200); return JSON.parse(result.text);
  };
  it('starts idempotently and reports only the authenticated owned instance', async () => {
    const second = await serviceCommand(options);
    expect(second.pid).toBe(pid);
    const status = await serviceCommand({ ...options, command: 'status' });
    expect(status).toMatchObject({ status: 'running', port: options.port, pid });
    expect(status).not.toHaveProperty('managementUrl');
    await expect(serviceCommand({ ...options, port: await unusedPort() })).rejects.toThrow('already uses port');
    const health = await request(options.port, '/_addon/health', { headers: { Authorization: `Bearer ${token}` } });
    expect(JSON.parse(health.text)).toMatchObject({ service: 'antigravity-model-proxy', port: options.port, pid });
  });
  it('serves a browser manager with restrictive headers and no embedded credentials', async () => {
    const html = await request(options.port, '/_addon/');
    expect(html.status).toBe(200);
    expect(html.text).toContain('Antigravity Model Manager');
    expect(html.text).not.toContain(token);
    expect(html.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    const script = await request(options.port, '/_addon/app.js');
    expect(script.status).toBe(200);
    expect(script.text).toContain('sessionStorage');
    expect(script.text).toContain('history.replaceState');
    expect(script.text).not.toContain(token);
  });
  it('runs the actual browser bridge and mounts the model manager using authenticated HTTP', async () => {
    const html = await request(options.port, '/_addon/');
    const script = await request(options.port, '/_addon/app.js');
    const dom = new JSDOM(html.text, { url: `${endpoint}/_addon/#token=${token}`, runScripts: 'outside-only' });
    const observed: string[] = [];
    dom.window.fetch = async (input: string, init: RequestInit) => {
      observed.push(String(input));
      return fetch(new URL(String(input), endpoint), { ...init, headers: { ...init?.headers, Origin: endpoint } });
    };
    try {
      dom.window.eval(script.text);
      dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
      await vi.waitFor(() => expect(dom.window.document.querySelector('#agy-custom-models-section')).not.toBeNull());
      await vi.waitFor(() => expect(observed).toContain('/_addon/rpc'));
      expect(dom.window.location.hash).toBe('');
      expect(dom.window.sessionStorage.getItem('antigravity-addon-token')).toBe(token);
      expect(dom.window.document.body.textContent).toContain('Add model');
      const add = Array.from(dom.window.document.querySelectorAll('button')).find(button => button.textContent === 'Add model')!;
      add.click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('#agy-modal-overlay')).not.toBeNull());
      expect(dom.window.document.body.textContent).toContain('Provider');
    } finally {
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      dom.window.close();
    }
  });
  it('requires the management token for every action and health/stop operation', async () => {
    for (const route of ['/_addon/health', '/_addon/rpc', '/_addon/stop']) {
      const response = await request(options.port, route, { method: route.endsWith('health') ? 'GET' : 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: route.endsWith('health') ? undefined : '{}' });
      expect(response.status).toBe(401);
      expect(response.text).not.toContain(token);
    }
    expect((await serviceCommand({ ...options, command: 'status' })).status).toBe('running');
  });
  it('blocks foreign origins and DNS rebound hosts before management or generation', async () => {
    const count = upstreamCalls.length;
    for (const headers of [{ Origin: 'https://attacker.test' }, { Host: 'attacker.test' }, { Origin: 'null' }]) {
      for (const route of ['/_addon/', '/_addon/rpc', '/v1beta/models/local-fixture:generateContent']) {
        const response = await request(options.port, route, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: '{"contents":[{"role":"user","parts":[{"text":"bad"}]}]}' });
        expect(response.status).toBe(403);
      }
    }
    expect(upstreamCalls).toHaveLength(count);
  });
  it('validates management JSON, route, media type and action names', async () => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await request(options.port, '/_addon/rpc', { method: 'POST', headers, body: '{bad}' })).status).toBe(400);
    expect((await request(options.port, '/_addon/rpc', { method: 'POST', headers, body: JSON.stringify({ channel: 'constructor', args: [] }) })).status).toBe(400);
    expect((await request(options.port, '/_addon/rpc', { method: 'POST', headers, body: JSON.stringify({ channel: 'storage:get-custom-models', args: Array(11).fill(null) }) })).status).toBe(400);
    expect((await request(options.port, '/_addon/rpc', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await request(options.port, '/_addon/rpc', { headers })).status).toBe(404);
  });
  it('saves encrypted models through HTTP and masks credentials in list/export', async () => {
    const model = { name: 'models/local-fixture', displayName: 'Local fixture', provider: 'openai', apiFormat: 'openai', apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey, externalModelName: 'local-fixture', maxRetries: 0, timeout: 2000 };
    expect(await rpc('storage:save-custom-model', [model])).toEqual({ success: true });
    const list = await rpc('storage:get-custom-models');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: model.name, externalModelName: model.externalModelName });
    expect(JSON.stringify(list)).not.toContain(apiKey);
    const saved = fs.readFileSync(path.join(options.dataDirectory, 'custom_models.json'), 'utf8');
    expect(saved).toContain('local-gcm:');
    expect(saved).not.toContain(apiKey);
    expect(fs.readFileSync(path.join(options.dataDirectory, '.model-credentials-key'))).toHaveLength(32);
    const exported = await rpc('storage:export-custom-models');
    expect(exported.models[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(exported)).not.toContain(apiKey);
  });
  it('routes a native generateContent request to the configured provider with its decrypted key', async () => {
    const response = await request(options.port, '/v1beta/models/local-fixture:generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello native IDE request' }] }] }) });
    expect(response.status).toBe(200);
    expect(response.text).toContain('Hello from the real local fixture');
    expect(response.text).not.toContain(apiKey);
    expect(upstreamCalls.at(-1)).toMatchObject({ authorization: `Bearer ${apiKey}`, path: '/v1/chat/completions', body: { model: 'local-fixture', messages: [{ role: 'user', content: 'Hello native IDE request' }] } });
  });
  it('refuses to replace an unrelated listener or stop it using stale state', async () => {
    let stopRequests = 0;
    const foreign = http.createServer((req, res) => { if (req.url === '/_addon/stop') stopRequests++; res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); });
    const port = await listen(foreign);
    const dataDirectory = directory();
    fs.mkdirSync(path.join(dataDirectory, '.ide-proxy'));
    fs.writeFileSync(path.join(dataDirectory, '.ide-proxy/state.json'), JSON.stringify({ version: 1, token: 'a'.repeat(64), instance: randomUUID(), port, pid: process.pid }));
    const foreignOptions = { ...options, port, dataDirectory };
    expect((await serviceCommand({ ...foreignOptions, command: 'status' })).status).toBe('stopped');
    expect((await serviceCommand({ ...foreignOptions, command: 'stop' })).status).toBe('stopped');
    expect(stopRequests).toBe(0);
    await expect(serviceCommand(foreignOptions)).rejects.toThrow(/exited|occupied|EADDRINUSE/);
    expect((await request(port, '/still-here')).status).toBe(200);
    expect(stopRequests).toBe(0);
  });
  it('rejects a second direct run for the same data directory even on a different free port', async () => {
    const cli = fileURLToPath(new URL('../../scripts/desktop-service.mjs', import.meta.url));
    const before = fs.readFileSync(path.join(options.dataDirectory, '.ide-proxy/state.json'));
    await expect(promisify(execFile)(process.execPath, [cli, 'run', '--port', String(await unusedPort()), '--data-dir', options.dataDirectory], { windowsHide: true, timeout: 5000 })).rejects.toThrow(/already|progress/);
    expect(fs.readFileSync(path.join(options.dataDirectory, '.ide-proxy/state.json'))).toEqual(before);
    expect((await serviceCommand({ ...options, command: 'status' })).pid).toBe(pid);
  });
  it('bounds shutdown with an incomplete authenticated RPC body and permits immediate restart', async () => {
    const partial = http.request({ hostname: '127.0.0.1', port: options.port, path: '/_addon/rpc', method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${token}`, Origin: endpoint, 'Content-Type': 'application/json', 'Content-Length': '50000' } });
    partial.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        partial.once('error', reject);
        partial.on('socket', (socket) => { if (socket.connecting) socket.once('connect', () => resolve()); else resolve(); });
        partial.write('{"channel":"storage:get-custom-models",');
      });
      // The body deliberately stays open after headers and an incomplete JSON prefix.
      await new Promise(resolve => setTimeout(resolve, 75));
      const start = Date.now();
      expect((await serviceCommand({ ...options, command: 'stop' })).status).toBe('stopped');
      expect(Date.now() - start).toBeLessThan(7500);
      const restarted = await serviceCommand(options);
      expect(restarted.status).toBe('running');
      expect(restarted.pid).not.toBe(pid);
      pid = restarted.pid;
      token = new URLSearchParams(new URL(restarted.managementUrl).hash.slice(1)).get('token')!;
      expect((await serviceCommand({ ...options, command: 'status' })).pid).toBe(pid);
      expect(await rpc('storage:get-custom-models')).toHaveLength(1);
    } finally { partial.destroy(); }
  });
  it('stops only its own service and removes its state', async () => {
    expect((await serviceCommand({ ...options, command: 'stop' })).status).toBe('stopped');
    expect((await serviceCommand({ ...options, command: 'status' })).status).toBe('stopped');
    expect(fs.existsSync(path.join(options.dataDirectory, '.ide-proxy/state.json'))).toBe(false);
    expect((await request(upstreamPort, '/v1/models')).status).toBe(200);
  });
});
