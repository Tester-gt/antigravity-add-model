import { beforeEach, describe, expect, it } from 'vitest';
import { beginDiagnosticRequest, clearDiagnostics, getDiagnostics } from '../diagnostics';

beforeEach(clearDiagnostics);
describe('bounded proxy diagnostics', () => {
  it('retains usage from only the final attempted provider and forgets missing fields from failed attempts', () => {
    const request = beginDiagnosticRequest({ model: 'models/primary', provider: 'anthropic', stream: true });
    request.observe(
      { message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 5 } } },
      'anthropic',
    );
    request.resetUsage();
    request.observe({ usage: { prompt_tokens: 12, completion_tokens: 2 } }, 'openai');
    request.finish({ outcome: 'succeeded', status: 200, model: 'models/fallback', provider: 'openai' });
    expect(getDiagnostics().requests[0]).toMatchObject({
      model: 'models/fallback',
      provider: 'openai',
      inputTokens: 12,
      outputTokens: 2,
    });
    expect(getDiagnostics().requests[0]).not.toHaveProperty('cachedTokens');
    expect(getDiagnostics().summary.requests).toBe(1);
  });
  it('retains measured usage only and never records request or response payloads', () => {
    const request = beginDiagnosticRequest({ model: 'models/test', provider: 'openai', stream: true });
    expect(getDiagnostics().active).toBe(1);
    request.observe(
      {
        choices: [{ delta: { content: 'secret-response' } }],
        apiKey: 'secret-key',
        usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } },
      },
      'openai',
    );
    request.observe({ usage: { prompt_tokens: 100, completion_tokens: 9 } }, 'openai');
    request.finish({ outcome: 'succeeded', status: 200 });
    request.finish({ outcome: 'failed', status: 500 });
    const snapshot = getDiagnostics();
    expect(snapshot.active).toBe(0);
    expect(snapshot.summary).toMatchObject({
      requests: 1,
      succeeded: 1,
      inputTokens: 100,
      outputTokens: 9,
      cachedTokens: 60,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-|choices|apiKey|content/);
    expect(snapshot.recentModels).toEqual(['models/test']);
  });

  it('combines Anthropic cache usage and final output without double counting events', () => {
    const request = beginDiagnosticRequest({ model: 'models/claude', provider: 'anthropic', stream: true });
    request.observe(
      {
        type: 'message_start',
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 1 },
        },
      },
      'anthropic',
    );
    request.observe({ type: 'message_delta', usage: { output_tokens: 12 } }, 'anthropic');
    request.finish({ outcome: 'succeeded', status: 200 });
    expect(getDiagnostics().requests[0]).toMatchObject({ inputTokens: 60, outputTokens: 12, cachedTokens: 30 });
  });

  it('reads native Gemini envelopes but leaves missing or invalid usage unknown', () => {
    const known = beginDiagnosticRequest({ model: 'models/gemini', provider: 'google', stream: false });
    known.observe(
      { response: { usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 3, cachedContentTokenCount: 4 } } },
      'google',
    );
    known.finish({ outcome: 'succeeded' });
    const unknown = beginDiagnosticRequest({ model: 'models/custom', provider: 'custom', stream: false });
    unknown.observe({ usage: { prompt_tokens: -1, completion_tokens: '24' } }, 'openai');
    unknown.finish({ outcome: 'failed', status: 401 });
    expect(getDiagnostics().requests[0]).not.toHaveProperty('inputTokens');
    expect(getDiagnostics().requests[0]).not.toHaveProperty('outputTokens');
    expect(getDiagnostics().summary).toMatchObject({ measuredRequests: 1, inputTokens: 22, outputTokens: 3 });
  });

  it('limits history, separates test requests from recent models and returns detached data', () => {
    for (let index = 0; index < 210; index++) {
      const request = beginDiagnosticRequest({
        model: `models/${index}`,
        provider: 'custom',
        stream: false,
        kind: 'generation-test',
      });
      request.finish({ outcome: 'succeeded' });
    }
    const snapshot = getDiagnostics();
    expect(snapshot.requests).toHaveLength(200);
    expect(snapshot.recentModels).toEqual([]);
    snapshot.requests[0].model = 'changed';
    expect(getDiagnostics().requests[0].model).toBe('models/209');
  });

  it('clearing during a request prevents that old request from repopulating history', () => {
    const request = beginDiagnosticRequest({ model: 'models/test', provider: 'custom', stream: false });
    clearDiagnostics();
    expect(getDiagnostics()).toMatchObject({ active: 1, requests: [] });
    request.finish({ outcome: 'cancelled' });
    expect(getDiagnostics()).toMatchObject({ active: 0, requests: [] });
  });
});
