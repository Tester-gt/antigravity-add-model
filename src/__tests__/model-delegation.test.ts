import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CustomModel } from '../proxy';
import { createModelDelegation } from '../modelDelegation';
import { stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const servers: http.Server[] = [];
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  stopCustomRequests();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});
afterAll(stopCleanupInterval);

describe('explicit text-only model delegation through the real provider pipeline', () => {
  let endpoint: string;
  let models: CustomModel[];
  let upstreamStatus: number;
  let hold: boolean;
  let disconnected: number;
  let requests: Record<string, unknown>[];
  let upstreamReply: Record<string, unknown>;
  beforeEach(async () => {
    requests = [];
    upstreamStatus = 200;
    hold = false;
    disconnected = 0;
    upstreamReply = {
      id: 'child-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'CHILD RESULT' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
    const upstream = await listen(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text));
      res.on('close', () => {
        if (!res.writableEnded) disconnected++;
      });
      if (hold) return;
      res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          upstreamStatus === 200 ? upstreamReply : { error: { message: 'secret-provider-key must not be exposed' } },
        ),
      );
    });
    models = [
      {
        name: 'models/child',
        displayName: 'Child',
        description: 'Custom worker',
        provider: 'openai',
        apiFormat: 'openai',
        apiUrl: `${upstream}/v1`,
        apiKey: 'secret-provider-key',
        externalModelName: 'upstream-child',
        maxRetries: 3,
        fallbackModels: ['models/fallback'],
        timeout: 5000,
        circuitBreaker: { enabled: false },
      },
    ];
    const handler = createModelDelegation(() => models);
    endpoint = await listen((req, res) => {
      if (!handler(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  const run = (body: unknown, signal?: AbortSignal) =>
    fetch(`${endpoint}/_addon/delegation/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  it('lists only safe enabled model metadata without credentials or provider URLs', async () => {
    models.push({ ...models[0], name: 'models/disabled', enabled: false });
    const response = await fetch(`${endpoint}/_addon/delegation/models`);
    expect(await response.json()).toEqual({
      mode: 'text-only',
      models: [{ name: 'models/child', displayName: 'Child', description: 'Custom worker' }],
    });
    expect(requests).toHaveLength(0);
  });
  it('uses the exact requested model, returns a real result and keeps separate requests isolated', async () => {
    const first = await run({ model: 'models/child', prompt: 'first task', context: 'parent supplied data' });
    const second = await run({ model: 'models/child', prompt: 'second task' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('x-antigravity-delegation-id')).not.toBe(
      second.headers.get('x-antigravity-delegation-id'),
    );
    expect(await first.json()).toMatchObject({ candidates: [{ content: { parts: [{ text: 'CHILD RESULT' }] } }] });
    expect(await second.json()).toMatchObject({ candidates: [{ content: { parts: [{ text: 'CHILD RESULT' }] } }] });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ model: 'upstream-child', stream: false, max_tokens: 4096 });
      expect(request).not.toHaveProperty('tools');
    }
    expect(JSON.stringify(requests[0])).toContain('parent supplied data');
    expect(JSON.stringify(requests[1])).not.toContain('parent supplied data');
    expect(JSON.stringify(requests[1])).not.toContain('first task');
  });
  it('pages a 4000-model catalog without truncating model names or exceeding the response bound', async () => {
    const template = models[0];
    models = Array.from({ length: 4000 }, (_, index) => ({
      ...template,
      name: `legacy/child-${index}`,
      displayName: 'Display'.repeat(100),
      description: 'Description'.repeat(100),
    }));
    models.splice(50, 0, { ...template, name: 'models/disabled', enabled: false });
    const names: string[] = [];
    let cursor: number | undefined = 0;
    let pages = 0;
    while (cursor !== undefined) {
      const response = await fetch(`${endpoint}/_addon/delegation/models?cursor=${cursor}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
      const data = JSON.parse(text);
      expect(data.models).toHaveLength(100);
      for (const item of data.models) {
        names.push(item.name);
        expect(item.displayName).toHaveLength(256);
        expect(item.description).toHaveLength(256);
      }
      expect(data.mode).toBe('text-only');
      cursor = data.nextCursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(40);
    }
    expect(names).toEqual(models.filter((model) => model.enabled !== false).map((model) => model.name));
    expect((await run({ model: names.at(-1), prompt: 'Last catalog entry' })).status).toBe(200);
    expect(requests).toHaveLength(1);
    const empty = await fetch(`${endpoint}/_addon/delegation/models?cursor=4000`);
    expect(await empty.json()).toEqual({ mode: 'text-only', models: [] });
  });
  it.each(['cursor=-1', 'cursor=1.5', 'cursor=9007199254740992', 'cursor=1&cursor=2', 'cursor=', 'other=0'])(
    'rejects invalid pagination %s',
    async (query) => {
      expect((await fetch(`${endpoint}/_addon/delegation/models?${query}`)).status).toBe(400);
      expect(requests).toHaveLength(0);
    },
  );
  it.each(['openai/gpt-4o', `models/${'x'.repeat(1500)}`])(
    'preserves and delegates an exact legacy saved name (%#)',
    async (name) => {
      models[0].name = name;
      const catalog = await fetch(`${endpoint}/_addon/delegation/models`);
      expect((await catalog.json()).models[0].name).toBe(name);
      expect((await run({ model: name, prompt: 'Task' })).status).toBe(200);
      expect(requests[0].model).toBe('upstream-child');
      expect((await run({ model: name.toUpperCase(), prompt: 'Task' })).status).toBe(400);
      expect(requests).toHaveLength(1);
    },
  );
  it('reserves input room for a small-context model without changing its saved configuration', async () => {
    models[0].contextWindow = 2048;
    expect((await run({ model: 'models/child', prompt: 'Hi' })).status).toBe(200);
    expect(requests[0].max_tokens).toBe(512);
    expect(models[0].maxOutputTokens).toBeUndefined();
  });
  it.each(['setting', 'extraBody'])('keeps Anthropic %s thinking below the capped output budget', async (source) => {
    models[0] = {
      ...models[0],
      provider: 'anthropic',
      apiFormat: 'anthropic',
      externalModelName: 'claude-sonnet',
      maxOutputTokens: 32768,
      contextWindow: 200000,
      ...(source === 'setting'
        ? { thinkingBudget: 16000 }
        : { extraBody: { thinking: { type: 'enabled', budget_tokens: 16000 } } }),
    };
    upstreamReply = {
      id: 'message-1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ANTHROPIC CHILD' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    const before = structuredClone(models[0]);
    const response = await run({ model: 'models/child', prompt: 'Task' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidates: [{ content: { parts: [{ text: 'ANTHROPIC CHILD' }] } }],
    });
    expect(requests[0]).toMatchObject({ max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 8191 } });
    expect(models[0]).toEqual(before);
  });
  it('disables Anthropic thinking when the context-derived output cap cannot fit its minimum budget', async () => {
    models[0] = {
      ...models[0],
      provider: 'anthropic',
      apiFormat: 'anthropic',
      externalModelName: 'claude-sonnet',
      contextWindow: 4096,
      thinkingBudget: 4096,
    };
    upstreamReply = { content: [{ type: 'text', text: 'SMALL CHILD' }], stop_reason: 'end_turn' };
    expect((await run({ model: 'models/child', prompt: 'Hi' })).status).toBe(200);
    expect(requests[0]).toMatchObject({ max_tokens: 1024, thinking: { type: 'disabled' } });
    expect(models[0].thinkingBudget).toBe(4096);
  });
  it.each(['child', 'Child', 'models/missing', 'models/disabled'])(
    'rejects an unconfigured/disabled selector %s without an upstream attempt',
    async (model) => {
      models.push({ ...models[0], name: 'models/disabled', enabled: false });
      expect((await run({ model, prompt: 'task' })).status).toBe(400);
      expect(requests).toHaveLength(0);
    },
  );
  it('rejects ambiguous duplicate model names', async () => {
    models.push({ ...models[0] });
    expect((await run({ model: 'models/child', prompt: 'task' })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });
  it('bounds UTF-8 input and rejects caller-supplied tools, URLs and route markers', async () => {
    for (const extra of [{ tools: [] }, { apiUrl: 'https://example.com' }, { context: {} }]) {
      expect((await run({ model: 'models/child', prompt: 'task', ...extra })).status).toBe(400);
    }
    expect((await run({ model: 'models/child', prompt: 'ş'.repeat(33000) })).status).toBe(413);
    expect((await run({ model: 'models/child', prompt: '[antigravity-subagent-route:bad]' })).status).toBe(400);
    expect((await run({ model: 'models/child', prompt: '  ' })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });
  it('does not silently retry or fall back to a different configured model after failure', async () => {
    models.push({ ...models[0], name: 'models/fallback', externalModelName: 'unexpected-model' });
    upstreamStatus = 503;
    const result = await run({ model: 'models/child', prompt: 'task' });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('secret-provider-key');
    expect(requests).toHaveLength(1);
  });
  it('limits concurrent calls and cancels upstream work when the parent disconnects', async () => {
    hold = true;
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      run({ model: 'models/child', prompt: 'wait' }, controller.signal).catch(() => null),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect((await run({ model: 'models/child', prompt: 'fifth' })).status).toBe(429);
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    await vi.waitFor(() => expect(disconnected).toBe(4));
    hold = false;
    await vi.waitFor(async () =>
      expect((await run({ model: 'models/child', prompt: 'after cancellation' })).status).toBe(200),
    );
  });
});
