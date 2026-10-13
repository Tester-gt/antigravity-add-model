import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import { gzipSync } from 'node:zlib';
import { fetchCloudCodeTier } from '../proxy/cloudCodeRouting';

vi.mock('node:https', () => ({ request: vi.fn() }));
const servers: http.Server[] = [];

afterEach(async () => {
  vi.mocked(https.request).mockReset();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  vi.mocked(https.request).mockImplementation(((
    target: string,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
  ) => {
    expect(target).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    return http.request(`http://127.0.0.1:${address.port}/v1internal:loadCodeAssist`, options, callback);
  }) as typeof https.request);
}

describe('native Cloud Code account discovery transport', () => {
  it('preserves identity and quota project while excluding generation content and unrelated headers', async () => {
    let captured: { body: unknown; headers: http.IncomingHttpHeaders };
    await upstream((request, response) => {
      let text = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (text += chunk));
      request.on('end', () => {
        captured = { body: JSON.parse(text), headers: request.headers };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"paidTier":{"usesGcpTos":false}}');
      });
    });
    const result = await fetchCloudCodeTier(
      {
        authorization: 'Bearer owned-test-token',
        'user-agent': 'antigravity/2.5.5 windows/x64',
        'x-goog-user-project': 'quota-project',
        cookie: 'unrelated-cookie',
        host: '127.0.0.1',
        'content-length': '1',
      },
      Buffer.from(JSON.stringify({ project: 'owned-project', request: { contents: [{ text: 'private prompt' }] } })),
      new AbortController().signal,
    );
    expect(result).toEqual({ status: 200, body: { paidTier: { usesGcpTos: false } } });
    expect(captured.body).toEqual({
      metadata: { ideName: 'antigravity', ideType: 'ANTIGRAVITY', ideVersion: '2.5.5' },
      cloudaicompanionProject: 'owned-project',
    });
    expect(captured.headers.authorization).toBe('Bearer owned-test-token');
    expect(captured.headers['x-goog-user-project']).toBe('quota-project');
    expect(captured.headers.cookie).toBeUndefined();
    expect(JSON.stringify(captured.body)).not.toContain('private prompt');
    expect(captured.headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(captured.body))));
  });

  it('reads a compressed metadata response within the same size bound', async () => {
    await upstream((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync('{"paidTier":{"usesGcpTos":true}}'));
    });
    const result = await fetchCloudCodeTier(
      { authorization: 'Bearer fixture' },
      Buffer.from('{}'),
      new AbortController().signal,
    );
    expect(result.body).toEqual({ paidTier: { usesGcpTos: true } });
  });

  it.each([false, true])('rejects oversized metadata, compressed=%s', async (compressed) => {
    await upstream((request, response) => {
      request.resume();
      const body = Buffer.from(JSON.stringify({ padding: 'x'.repeat(600 * 1024) }));
      response.writeHead(200, compressed ? { 'content-encoding': 'gzip' } : {});
      response.end(compressed ? gzipSync(body) : body);
    });
    await expect(
      fetchCloudCodeTier({ authorization: 'Bearer fixture' }, Buffer.from('{}'), new AbortController().signal),
    ).rejects.toThrow();
  });

  it('does not follow a redirect with the caller authorization', async () => {
    await upstream((request, response) => {
      request.resume();
      response.writeHead(302, { location: 'https://untrusted.invalid/' });
      response.end('{}');
    });
    expect(
      await fetchCloudCodeTier({ authorization: 'Bearer fixture' }, Buffer.from('{}'), new AbortController().signal),
    ).toEqual({ status: 302, body: {} });
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight lookup when its generation no longer needs it', async () => {
    let seen!: () => void;
    const received = new Promise<void>((resolve) => (seen = resolve));
    await upstream((request) => {
      request.resume();
      seen();
    });
    const controller = new AbortController();
    const pending = fetchCloudCodeTier({ authorization: 'Bearer fixture' }, Buffer.from('{}'), controller.signal);
    const cancelled = expect(pending).rejects.toThrow();
    await received;
    controller.abort();
    await cancelled;
  });
});
