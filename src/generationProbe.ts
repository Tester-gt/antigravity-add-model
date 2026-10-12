import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { CustomModel } from './proxy';
import { runCustomModelRequest } from './proxy/customRequest';

/** A bounded response sink exercises the real request path without opening another listening port. */
class ProbeResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  bytes = 0;
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.bytes += chunk.length;
    if (this.bytes > 256 * 1024) return done(new Error('Generation test response exceeds limit'));
    done();
  }
}

/** Explicitly invoked only. One short generation; no retries, tools, user prompt or fallback models. */
export async function runGenerationProbe(input: CustomModel) {
  const startedAt = Date.now();
  const response = new ProbeResponse();
  response.on('error', () => {});
  const model = {
    ...input,
    enabled: true,
    maxRetries: 0,
    fallbackModels: [],
    timeout: 30000,
    retryBudgetMs: 30000,
    maxOutputTokens: 32,
    extraBody: undefined,
    thinkingBudget: undefined,
    circuitBreaker: { enabled: false },
  } as CustomModel;
  await runCustomModelRequest(
    response as unknown as ServerResponse,
    model,
    { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 32 } },
    false,
    [model],
    false,
    'generation-test',
  );
  if (response.statusCode < 200 || response.statusCode >= 300 || response.errored)
    return {
      success: false,
      status: response.statusCode,
      error: `Generation failed (HTTP ${response.statusCode}). Check model access, provider quota, configuration and the 32-token test output limit.`,
    };
  return {
    success: true,
    status: response.statusCode,
    message: `Generation succeeded (HTTP ${response.statusCode}, ${Date.now() - startedAt} ms).`,
  };
}
