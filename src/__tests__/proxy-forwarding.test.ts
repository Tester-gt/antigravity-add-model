import * as subagentRoutingModule from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { listenProxy } from '../proxy/listen';
import { CloudCodeRouting } from '../proxy/cloudCodeRouting';
import * as modelCatalog from '../proxy/modelCatalog';
import * as modelIdentity from '../modelIdentity';
import type { ProxyStartOptions } from '../proxy';

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const servers: http.Server[] = [];
const proxies: { stopProxy(): Promise<void> }[] = [];
const directories: string[] = [];

afterEach(async () => {
  // Close sockets even when a malformed forwarded response makes the client reject.
  for (const server of servers) server.closeAllConnections();
  for (const proxy of proxies.splice(0)) await proxy.stopProxy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-forwarding-'))
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return `http://127.0.0.1:${await listenProxy(server, 0)}`;
}

async function fixture(upstream: string, ideCloudCodeRouting = false) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-forwarding-'));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, 'custom_models.json'), '{"models":[]}');
  // Only the transport destination changes: both sides use real HTTP parsers and sockets.
  const forwarded: { target: string; headers: http.OutgoingHttpHeaders }[] = [];
  const dependencies: Record<string, unknown> = {
    http: {
      ...http,
      createServer: (handler: http.RequestListener) => {
        const server = http.createServer(handler);
        servers.push(server);
        return server;
      },
    },
    https: {
      request: (target: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
        forwarded.push({ target: target.href, headers: { ...options.headers } });
        return http.request(new URL(target.pathname + target.search, upstream), options, callback);
      },
    },
    fs,
    path,
    zlib,
    electron: { app: { getAppPath: () => path.resolve('scratch/forwarding-fixture') } },
    'electron-log': { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    './proxy/shared': { startCleanupInterval: vi.fn(), stopCleanupInterval: vi.fn() },
    './proxy/modelUtils': {},
    './proxy/modelCatalog': modelCatalog,
    './modelIdentity': modelIdentity,
    './proxy/subagentRouting': subagentRoutingModule,
    './proxy/subagentModels': subagentModels,
    './proxy/cloudCodeRouting': { CloudCodeRouting },
    './proxy/customRequest': { stopCustomRequests: vi.fn() },
    './modelStore': { readModelConfig: () => [] },
    './schemaValidator': {},
    './cryptoStore': {},
    './proxy/listen': {
      getRequiredProxyPort: () => undefined,
      listenProxy: (server: http.Server) => listenProxy(server, 0),
    },
  };
  const module = {
    exports: {} as { startProxy(options: ProxyStartOptions): Promise<number>; stopProxy(): Promise<void> },
  };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
  });
  proxies.push(module.exports);
  return {
    url: `http://127.0.0.1:${await module.exports.startProxy({ dataDirectory: directory, ideCloudCodeRouting })}`,
    forwarded,
  };
}

function post(url: string, body: string, chunked: boolean) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer forwarding-fixture-token',
          'content-type': 'application/json',
          ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(body) }),
          'accept-encoding': 'gzip',
          connection: 'close, x-fixture-request-hop',
          'x-fixture-request-hop': 'must-not-forward',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.setTimeout(3000, () => request.destroy(new Error('Forwarding fixture timed out')));
    request.on('error', reject);
    if (chunked) {
      request.write(body.slice(0, 3));
      request.end(body.slice(3));
    } else request.end(body);
  });
}

describe('buffered Google metadata forwarding', () => {
  it('preserves the IDE tier route across metadata and model-catalog requests', async () => {
    let loadCalls = 0;
    const received: { path: string; authorization?: string; host?: string }[] = [];
    const upstream = await serve((request, response) => {
      request.resume();
      request.on('end', () => {
        received.push({
          path: request.url || '',
          authorization: request.headers.authorization,
          host: request.headers.host,
        });
        const body =
          request.url === '/v1internal:loadCodeAssist'
            ? { paidTier: { usesGcpTos: ++loadCalls === 2 } }
            : { models: {}, agentModelSorts: [] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    const proxy = await fixture(upstream, true);
    const paths = [
      '/v1internal:loadCodeAssist',
      '/v1internal:fetchAvailableModels',
      '/v1internal:loadCodeAssist',
      '/v1internal:fetchAvailableModels',
    ];
    for (const endpoint of paths) {
      const result = await post(proxy.url + endpoint, '{}', true);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body.toString('utf8'))).toBeTypeOf('object');
    }
    const hosts = [
      'cloudcode-pa.googleapis.com',
      'daily-cloudcode-pa.googleapis.com',
      'daily-cloudcode-pa.googleapis.com',
      'cloudcode-pa.googleapis.com',
    ];
    expect(proxy.forwarded.map((entry) => entry.target)).toEqual(
      paths.map((endpoint, index) => `https://${hosts[index]}${endpoint}`),
    );
    expect(received).toEqual(
      paths.map((endpoint, index) => ({
        path: endpoint,
        host: hosts[index],
        authorization: 'Bearer forwarding-fixture-token',
      })),
    );
    for (const entry of proxy.forwarded) {
      expect(entry.headers.host).toBe(new URL(entry.target).host);
      expect(entry.headers.authorization).toBe('Bearer forwarding-fixture-token');
      expect(entry.headers['transfer-encoding']).toBeUndefined();
    }
  });

  it.each([false, true].flatMap((gzip) => [false, true].map((chunkedRequest) => ({ gzip, chunkedRequest }))))(
    'reframes metadata when gzip=$gzip and chunkedRequest=$chunkedRequest',
    async ({ gzip, chunkedRequest }) => {
      const observed: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
      const payload = JSON.stringify({
        message: 'Türkçe metadata ✓',
        endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
        alternate: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
        publicEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      });
      const upstream = await serve((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          observed.push({ path: request.url || '', headers: request.headers, body });
          response.writeHead(203, {
            'content-type': 'application/json; charset=utf-8',
            'transfer-encoding': 'chunked',
            connection: 'close, x-fixture-response-hop',
            'x-fixture-response-hop': 'must-not-forward',
            'keep-alive': 'timeout=5',
            trailer: 'x-fixture-trailer',
            ...(gzip ? { 'content-encoding': 'gzip' } : {}),
          });
          const bytes = gzip ? zlib.gzipSync(payload) : Buffer.from(payload);
          const middle = Math.floor(bytes.length / 2);
          response.write(bytes.subarray(0, middle));
          response.addTrailers({ 'x-fixture-trailer': 'must-not-forward' });
          response.end(bytes.subarray(middle));
        });
      });
      const proxy = await fixture(upstream);
      const requestBody = JSON.stringify({ fixture: true });
      const result = await post(`${proxy.url}/v1internal:loadCodeAssist?fixture=1`, requestBody, chunkedRequest);

      expect(result.status).toBe(203);
      expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(result.headers['transfer-encoding']).toBeUndefined();
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['x-fixture-response-hop']).toBeUndefined();
      expect(result.headers['keep-alive']).toBeUndefined();
      expect(result.headers.trailer).toBeUndefined();
      expect(result.headers['content-length']).toBe(String(result.body.length));
      expect(JSON.parse(result.body.toString('utf8'))).toEqual({
        message: 'Türkçe metadata ✓',
        endpoint: `${proxy.url}/v1internal:generateContent`,
        alternate: `${proxy.url}/v1internal:loadCodeAssist`,
        publicEndpoint: `${proxy.url}/v1beta/models`,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        path: '/v1internal:loadCodeAssist?fixture=1',
        headers: { authorization: 'Bearer forwarding-fixture-token', host: 'daily-cloudcode-pa.googleapis.com' },
        body: requestBody,
      });
      expect(observed[0].headers['accept-encoding']).toBeUndefined();
      expect(observed[0].headers['transfer-encoding']).toBeUndefined();
      expect(observed[0].headers['x-fixture-request-hop']).toBeUndefined();
      expect(observed[0].headers['content-length']).toBe(String(Buffer.byteLength(requestBody)));
      expect(proxy.forwarded).toHaveLength(1);
      expect(proxy.forwarded[0].target).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist?fixture=1',
      );
      expect(proxy.forwarded[0].headers.connection).toBeUndefined();
    },
  );
});
