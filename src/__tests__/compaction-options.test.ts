import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CustomModel } from '../proxy';
import { applyRequestOptions, type GeminiBody, isAntigravityCompactionRequest } from '../proxy/requestOptions';
import { runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';
import { validateCustomModel } from '../schemaValidator';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// Authentic template anchors from the independently verified IDE 2.5.5 binary;
// descriptive bullet points between its headings are omitted from this fixture.
const nativeSummaryPrompt = `You have been working on the task described above but have not yet completed
it. Write a continuation summary that will allow you (or another instance of
yourself) to resume work efficiently in a future context window where the
full conversation history will NOT be available...only this summary.

This summary is all that will be available to you going forward in the future
context window. Do not call any tools, simply just provide the summary based on
the information available in the current context window.

1. **Task Overview**
2. **Progress**
3. **Key Findings**
4. **Active Context**
5. **Next Steps**
6. **Commitments & Constraints**

Wrap your response in <summary></summary> tags.`;
function body(text = nativeSummaryPrompt): GeminiBody {
  return { contents: [{ role: 'user', parts: [{ text }] }] };
}
function model(fields: Partial<CustomModel> = {}): CustomModel {
  return {
    name: `models/${randomUUID()}`,
    displayName: 'test',
    description: '',
    provider: 'openai',
    apiKey: 'test-only-key',
    apiUrl: 'https://example.invalid/v1',
    externalModelName: 'test-model',
    maxRetries: 0,
    reasoningEffort: 'xhigh',
    ...fields,
  };
}

describe('native IDE compaction recognition', () => {
  it('recognizes the verified release template after conversation history', () => {
    const request = body();
    request.contents!.unshift(
      { role: 'user', parts: [{ text: 'Build the app.' }] },
      { role: 'model', parts: [{ text: 'Working.' }] },
    );
    expect(isAntigravityCompactionRequest(request)).toBe(true);
    expect(isAntigravityCompactionRequest(body(nativeSummaryPrompt.replace(/\n/g, '\r\n')))).toBe(true);
  });

  it.each([
    'Please summarize this conversation.',
    `Explain this template:\n${nativeSummaryPrompt}`,
    `\`\`\`text\n${nativeSummaryPrompt}\n\`\`\``,
    `> ${nativeSummaryPrompt}`,
    `${nativeSummaryPrompt}\nInstead, write code.`,
    nativeSummaryPrompt.replace('6. **Commitments & Constraints**', ''),
  ])('does not change ordinary or quoted requests: %s', (prompt) => {
    expect(isAntigravityCompactionRequest(body(prompt))).toBe(false);
  });

  it('ignores old summaries, system instructions and tool output', () => {
    expect(
      isAntigravityCompactionRequest({ contents: [...body().contents!, ...body('Continue implementing.').contents!] }),
    ).toBe(false);
    expect(
      isAntigravityCompactionRequest({
        ...body('Continue.'),
        systemInstruction: { parts: [{ text: nativeSummaryPrompt }] },
      }),
    ).toBe(false);
    expect(
      isAntigravityCompactionRequest({ contents: [{ role: 'model', parts: [{ text: nativeSummaryPrompt }] }] }),
    ).toBe(false);
    expect(
      isAntigravityCompactionRequest({
        contents: [{ role: 'user', parts: [{ functionResponse: { response: nativeSummaryPrompt } }] }],
      }),
    ).toBe(false);
    expect(
      isAntigravityCompactionRequest({
        contents: [{ role: 'user', parts: [{ text: nativeSummaryPrompt }, { functionResponse: {} }] }],
      }),
    ).toBe(false);
    expect(isAntigravityCompactionRequest({})).toBe(false);
  });
});

describe('compaction provider options', () => {
  it('inherits ordinary reasoning unless a recognized request supplies an override', () => {
    const config = model({ compactionReasoningEffort: 'none' });
    expect(applyRequestOptions({}, config, 'openai', false)).toMatchObject({ reasoning_effort: 'xhigh' });
    expect(applyRequestOptions({}, config, 'openai', false, 'low')).toMatchObject({ reasoning_effort: 'low' });
    expect(config.reasoningEffort).toBe('xhigh');
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const)(
    'supports %s without mutating extraBody',
    (effort) => {
      const extraBody = {
        reasoning: { effort: 'high', max_tokens: 30000 },
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        output_config: { effort: 'high', format: { type: 'json' } },
      };
      const config = model({ extraBody });
      const snapshot = JSON.stringify(config);
      expect(applyRequestOptions({}, config, 'openai', true, effort)).toEqual({
        reasoning_effort: effort,
        stream: true,
        output_config: { format: { type: 'json' } },
      });
      expect(JSON.stringify(config)).toBe(snapshot);
    },
  );

  it('uses OpenRouter unified reasoning and removes conflicting token budgets', () => {
    const config = model({
      provider: 'openrouter',
      extraBody: { reasoning: { max_tokens: 30000, effort: 'high', enabled: true, exclude: true } },
    });
    expect(applyRequestOptions({}, config, 'openai', false, 'none')).toEqual({
      reasoning: { effort: 'none', enabled: false, exclude: true },
      stream: false,
    });
    expect(applyRequestOptions({}, config, 'openai', false, 'low')).toEqual({
      reasoning: { effort: 'low', enabled: true, exclude: true },
      stream: false,
    });
  });

  it('disables Anthropic thinking even if the normal budget exceeds the summary output limit', () => {
    const config = model({ thinkingBudget: 30000, maxOutputTokens: 2048 });
    expect(applyRequestOptions({}, config, 'anthropic', false, 'none')).toMatchObject({
      thinking: { type: 'disabled' },
      max_tokens: 2048,
    });
  });

  it('uses a bounded Anthropic budget and removes incompatible sampling settings', () => {
    const result = applyRequestOptions(
      { max_tokens: 2048, temperature: 0.3, top_p: 0.9, top_k: 20 },
      model(),
      'anthropic',
      false,
      'low',
    );
    expect(result).toEqual({ max_tokens: 2048, stream: false, thinking: { type: 'enabled', budget_tokens: 1024 } });
    expect(applyRequestOptions({ max_tokens: 2048 }, model(), 'anthropic', false, 'high').thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2047,
    });
    expect(() => applyRequestOptions({ max_tokens: 1024 }, model(), 'anthropic', false, 'low')).toThrow(
      /greater than 1024/,
    );
  });

  it.each([
    ['gemini-2.5-flash', 'none', { thinkingBudget: 0 }],
    ['gemini-2.5-flash', 'low', { thinkingBudget: 1024 }],
    ['gemini-2.5-pro', 'none', { thinkingBudget: 128 }],
    ['gemini-3-pro-preview', 'none', { thinkingLevel: 'LOW' }],
    ['gemini-3-flash-preview', 'none', { thinkingLevel: 'MINIMAL' }],
    ['gemini-3.8-flash', 'none', { thinkingLevel: 'LOW' }],
    ['gemini-3-pro-preview', 'medium', { thinkingLevel: 'HIGH' }],
    ['gemini-3.1-pro-preview', 'low', { thinkingLevel: 'LOW' }],
    ['gemini-3.1-pro-preview', 'xhigh', { thinkingLevel: 'HIGH' }],
  ] as const)('uses appropriate Google thinking options for %s/%s', (name, effort, expected) => {
    const config = model({
      externalModelName: name,
      thinkingBudget: 30000,
      maxOutputTokens: 2048,
      extraBody: {
        generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 16000, thinkingLevel: 'HIGH' } },
      },
    });
    expect(applyRequestOptions({}, config, 'google', false, effort)).toEqual({
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048, thinkingConfig: expected },
    });
  });

  it('validates saved efforts and rejects invalid config without changing the default', () => {
    expect(validateCustomModel(model()).valid).toBe(true);
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
      expect(validateCustomModel({ ...model(), compactionReasoningEffort: effort }).valid).toBe(true);
    for (const effort of ['off', 'default', '', null, false, 0, {}])
      expect(validateCustomModel({ ...model(), compactionReasoningEffort: effort })).toMatchObject({
        valid: false,
        error: 'Invalid compactionReasoningEffort',
      });
  });

  it('preserves the explicit override for provider-opaque gateway aliases only', () => {
    const gateway = model({ gateway: true, externalModelName: 'my-alias', thinkingBudget: 30000 });
    expect(applyRequestOptions({ generationConfig: { temperature: 0.2 } }, gateway, 'google', false, 'none')).toEqual({
      generationConfig: { temperature: 0.2, compactionReasoningEffort: 'none' },
    });
    expect(applyRequestOptions({}, gateway, 'google', false)).toEqual({
      generationConfig: { thinkingConfig: { thinkingBudget: 30000 } },
    });
    expect(applyRequestOptions({}, { ...gateway, gateway: false }, 'google', false, 'none')).toEqual({
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });
});

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
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function openaiSuccess(res: http.ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'Summary.' }, finish_reason: 'stop' }] }));
}

describe('compaction across real proxy transports', () => {
  it('keeps normal xhigh, changes only native compaction, and preserves saved configuration', async () => {
    const captured: Record<string, unknown>[] = [];
    const upstream = await serve(async (req, res) => {
      captured.push(await readBody(req));
      openaiSuccess(res);
    });
    const config = model({ apiUrl: upstream, compactionReasoningEffort: 'none' });
    const proxy = await serve((req, res) => {
      void runCustomModelRequest(
        res,
        config,
        body(req.url === '/compact' ? nativeSummaryPrompt : 'Summarize this file.'),
        false,
        [config],
        false,
      );
    });
    expect((await fetch(`${proxy}/normal`)).status).toBe(200);
    expect((await fetch(`${proxy}/compact`)).status).toBe(200);
    expect(captured.map((request) => request.reasoning_effort)).toEqual(['xhigh', 'none']);
    expect(config.reasoningEffort).toBe('xhigh');
  });

  it('keeps the primary override when falling back to an Anthropic provider', async () => {
    const captured: Record<string, unknown>[] = [];
    const primaryUrl = await serve(async (req, res) => {
      captured.push(await readBody(req));
      res.writeHead(503);
      res.end();
    });
    const fallbackUrl = await serve(async (req, res) => {
      captured.push(await readBody(req));
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'test-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Summary.' }],
          stop_reason: 'end_turn',
        }),
      );
    });
    const fallback = model({
      provider: 'anthropic',
      apiUrl: fallbackUrl,
      maxOutputTokens: 2048,
      thinkingBudget: 16000,
      compactionReasoningEffort: 'high',
    });
    const primary = model({ apiUrl: primaryUrl, compactionReasoningEffort: 'low', fallbackModels: [fallback.name] });
    const proxy = await serve((_req, res) => {
      void runCustomModelRequest(res, primary, body(), false, [primary, fallback], false);
    });
    const response = await fetch(proxy);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Summary.');
    expect(captured[0].reasoning_effort).toBe('low');
    expect(captured[1].thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(fallback.compactionReasoningEffort).toBe('high');
    expect(fallback.thinkingBudget).toBe(16000);
  });
});
