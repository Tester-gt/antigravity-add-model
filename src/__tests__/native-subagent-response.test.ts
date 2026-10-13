import { afterEach, describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import { PassThrough, Readable, Writable } from 'node:stream';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { forwardNativeGeneration, type NativeSubagentRouting } from '../proxy/nativeSubagentResponse';
import { subagentRouting } from '../proxy/subagentRouting';

class Response extends Writable {
  headersSent = false;
  statusCode = 0;
  headers: http.OutgoingHttpHeaders = {};
  chunks: Buffer[] = [];
  constructor(private delay = 0) {
    super({ highWaterMark: 1 });
  }
  writeHead(status: number, headers: http.OutgoingHttpHeaders) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error) => void) {
    this.chunks.push(Buffer.from(chunk));
    if (this.delay) setTimeout(callback, this.delay);
    else callback();
  }
  get body() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const routing = (): NativeSubagentRouting => ({
  context: subagentRouting.prepareRequest({ conversationId: 'native', contents: [] }, (name) =>
    name === 'models/child' ? name : undefined,
  ).context,
  resolve: (name) => (name === 'models/child' ? name : undefined),
});
function incoming(source: Readable, contentType?: string, encoding?: string): http.IncomingMessage {
  return Object.assign(source, {
    statusCode: 200,
    headers: {
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(encoding ? { 'content-encoding': encoding } : {}),
    },
  }) as http.IncomingMessage;
}
function response(value: Response) {
  return value as unknown as http.ServerResponse;
}
function tool(model = 'models/child') {
  return {
    response: {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'invoke_subagent', args: { Subagents: [{ Model: model, Prompt: 'hello' }] } } },
            ],
          },
        },
      ],
    },
    traceId: 'trace-preserved',
  };
}

afterEach(() => subagentRouting.clear());

describe('native subagent response transport', () => {
  it('decodes stacked encodings in reverse and strips obsolete framing, connection tokens and validators', async () => {
    const body = Buffer.from(JSON.stringify(tool()));
    const upstream = incoming(Readable.from([brotliCompressSync(gzipSync(body))]), 'application/json', 'gzip, br');
    Object.assign(upstream.headers, {
      'content-length': '5',
      connection: 'keep-alive, x-private-hop',
      'x-private-hop': 'omit',
      etag: 'old',
      'x-request-id': 'preserve',
    });
    const downstream = new Response();
    await forwardNativeGeneration(upstream, response(downstream), routing(), true);
    const result = JSON.parse(downstream.body);
    expect(result.response.candidates[0].content.parts[0].functionCall.args.Subagents[0].Model).toBe('inherit');
    expect(result.traceId).toBe('trace-preserved');
    expect(downstream.headers).toEqual({ 'content-type': 'application/json', 'x-request-id': 'preserve' });
  });

  it('flushes an unterminated valid final SSE event without hanging', async () => {
    const downstream = new Response();
    await forwardNativeGeneration(
      incoming(Readable.from([`data: ${JSON.stringify(tool())}`]), 'text/event-stream'),
      response(downstream),
      routing(),
      false,
    );
    expect(
      JSON.parse(downstream.body.slice(6)).response.candidates[0].content.parts[0].functionCall.args.Subagents[0].Model,
    ).toBe('inherit');
    expect(downstream.writableEnded).toBe(true);
  });

  it('recognizes the first SSE data field after an initial fragmented UTF8BOM', async () => {
    const wire = Buffer.from(`\uFEFFdata: ${JSON.stringify(tool())}\n\n`);
    const downstream = new Response();
    await forwardNativeGeneration(
      incoming(Readable.from([...wire].map((byte) => Buffer.from([byte]))), 'text/event-stream'),
      response(downstream),
      routing(),
      false,
    );
    expect(
      JSON.parse(downstream.body.slice(6)).response.candidates[0].content.parts[0].functionCall.args.Subagents[0].Model,
    ).toBe('inherit');
  });

  it('preserves malformed final SSE and lone CR separators verbatim', async () => {
    const original = ': heartbeat\r\revent: meta\rid: 4\rdata: [DONE]\r\rdata: {unfinished';
    const downstream = new Response();
    await forwardNativeGeneration(
      incoming(Readable.from([...original].map((char) => Buffer.from(char))), 'text/event-stream'),
      response(downstream),
      routing(),
      false,
    );
    expect(downstream.body).toBe(original);
    expect(downstream.writableEnded).toBe(true);
  });

  it.each(['gzip', 'unsupported'])('reports broken or unsupported %s bodies as explicit502', async (encoding) => {
    const downstream = new Response();
    await forwardNativeGeneration(
      incoming(Readable.from(['invalid compression']), 'application/json', encoding),
      response(downstream),
      routing(),
      false,
    );
    expect(downstream.statusCode).toBe(502);
    expect(JSON.parse(downstream.body).error.code).toBe(502);
  });

  it('bounds decompressed JSON instead of compressed wire size', async () => {
    const downstream = new Response();
    const tooLarge = gzipSync(Buffer.from(JSON.stringify({ text: 'x'.repeat(16 * 1024 * 1024) })));
    await forwardNativeGeneration(
      incoming(Readable.from([tooLarge]), 'application/json', 'gzip'),
      response(downstream),
      routing(),
      false,
    );
    expect(downstream.statusCode).toBe(502);
    expect(downstream.body).not.toContain('xxxx');
  });

  it('bounds an unterminated SSE event while allowing earlier events to stream', async () => {
    const downstream = new Response();
    await forwardNativeGeneration(
      incoming(Readable.from([': ready\n\n', 'data: ' + 'x'.repeat(4 * 1024 * 1024)]), 'text/event-stream'),
      response(downstream),
      routing(),
      true,
    );
    expect(downstream.statusCode).toBe(200);
    expect(downstream.body).toContain(': ready\n\n');
    expect(downstream.body).toContain('event: error');
    expect(downstream.body).toContain('"code":502');
    expect(downstream.body.length).toBeLessThan(1000);
  });

  it('propagates truncated upstream errors after an emitted SSE event', async () => {
    const source = new PassThrough();
    const downstream = new Response();
    const forwarding = forwardNativeGeneration(
      incoming(source, 'text/event-stream'),
      response(downstream),
      routing(),
      true,
    );
    source.write(': ready\n\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    source.destroy(new Error('upstream socket aborted'));
    await forwarding;
    expect(downstream.body).toContain('event: error');
    expect(downstream.writableEnded).toBe(true);
    expect(downstream.listenerCount('close')).toBe(0);
    expect(downstream.listenerCount('error')).toBe(0);
  });

  it('cancels a compressed upstream when the downstream disconnects before any complete event', async () => {
    const source = new PassThrough();
    const downstream = new Response();
    const forwarding = forwardNativeGeneration(
      incoming(source, 'text/event-stream', 'gzip'),
      response(downstream),
      routing(),
      true,
    );
    source.write(gzipSync(Buffer.from('data: {unfinished')));
    downstream.destroy();
    await forwarding;
    expect(source.destroyed).toBe(true);
    expect(downstream.headersSent).toBe(false);
    expect(downstream.listenerCount('close')).toBe(0);
  });

  it('waits for downstream drain before consuming the next native event', async () => {
    const downstream = new Response(10);
    const upstream = incoming(
      Readable.from(
        (async function* () {
          for (let index = 0; index < 8; index++) yield `data: {"index":${index}}\n\n`;
        })(),
        { highWaterMark: 1 },
      ),
      'text/event-stream',
    );
    await forwardNativeGeneration(upstream, response(downstream), routing(), true);
    expect(downstream.chunks.length).toBe(8);
    expect(downstream.writableLength).toBe(0);
    expect(downstream.body).toContain('"index":7');
    expect(downstream.listenerCount('drain')).toBe(0);
  });

  it('accepts HTTP204 with an empty entity and does not invent a JSON error', async () => {
    const upstream = incoming(Readable.from([]), 'application/json');
    upstream.statusCode = 204;
    const downstream = new Response();
    await forwardNativeGeneration(upstream, response(downstream), routing(), false);
    expect(downstream.statusCode).toBe(204);
    expect(downstream.body).toBe('');
  });
});
