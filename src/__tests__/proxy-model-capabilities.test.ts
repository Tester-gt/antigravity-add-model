import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { detectModelCapabilities } from '../proxy/modelUtils';
import { validateCustomModel } from '../schemaValidator';

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type Failure = 'error' | 'timeout';
function requestModels(url: string, body: unknown, failure?: Failure, config: Record<string, unknown> = {}) {
  const models = [
    { externalModelName: 'deepseek-vl2', displayName: 'Automatic vision' },
    { externalModelName: 'deepseek-r1', displayName: 'Enabled vision', supportsVision: true },
    { externalModelName: 'deepseek-ai/Janus-Pro-7B', displayName: 'Disabled vision', supportsVision: false },
  ].map((model, i) => ({
    ...model,
    name: `models/custom-${i}`,
    provider: 'deepseek',
    apiFormat: 'openai',
    apiUrl: 'https://example.test/v1',
    apiKey: '',
    description: 'A custom model',
    ...config,
  }));
  const request = (_url: URL, _options: unknown, callback: (response: EventEmitter) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: () => void;
    };
    let timeout: (() => void) | undefined;
    outgoing.setTimeout = vi.fn((_ms: number, handler: () => void) => {
      timeout = handler;
    });
    outgoing.destroy = vi.fn();
    outgoing.write = vi.fn();
    outgoing.end = () => {
      if (failure === 'error') return void outgoing.emit('error', new Error('Fixture connection failure'));
      const upstream = Object.assign(new EventEmitter(), { statusCode: 200 });
      callback(upstream);
      if (failure === 'timeout') return timeout!();
      upstream.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      upstream.emit('end');
    };
    return outgoing;
  };
  const dependencies: Record<string, unknown> = {
    http: {},
    https: { request },
    fs: { existsSync: () => true },
    path,
    electron: { app: { getPath: () => '/fixture' } },
    'electron-log': { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    './proxy/shared': {},
    './proxy/modelUtils': { detectModelCapabilities },
    './proxy/customRequest': {},
    './modelStore': { readModelConfig: () => models },
    './cryptoStore': { decryptModels: (value: unknown) => value },
    './schemaValidator': { validateCustomModel },
    './proxy/listen': {},
  };
  const module = { exports: {} as { handleRequest: http.RequestListener } };
  runInNewContext(`${compiled}\nexports.handleRequest = handleRequest;`, {
    exports: module.exports,
    module,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
    URL,
    Buffer,
    console,
    process,
  });
  const req = Object.assign(new EventEmitter(), { url, method: 'GET', headers: {} });
  const res = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };
  module.exports.handleRequest(req as http.IncomingMessage, res as unknown as http.ServerResponse);
  req.emit('end');
  expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
  expect(res.end).toHaveBeenCalledOnce();
  return JSON.parse(res.end.mock.calls[0][0]);
}

function checkCapabilities(container: Record<string, unknown> | unknown[]) {
  const models = (Array.isArray(container) ? container : Object.values(container)) as {
    displayName: string;
    supportsImages: boolean;
    supportedMimeTypes: Record<string, boolean>;
  }[];
  for (const displayName of ['Automatic vision', 'Enabled vision', 'Disabled vision']) {
    const model = models.find((entry) => entry.displayName === displayName);
    const images = displayName !== 'Disabled vision';
    expect(model, displayName).toBeDefined();
    expect(model!.supportsImages, displayName).toBe(images);
    expect(model!.supportedMimeTypes['image/png'], displayName).toBe(images ? true : undefined);
    expect(model!.supportedMimeTypes['image/jpeg'], displayName).toBe(images ? true : undefined);
    expect(model!.supportedMimeTypes['image/heic'], displayName).toBeUndefined();
    expect(model!.supportedMimeTypes['text/plain'], displayName).toBe(true);
  }
}

describe('custom model vision capability advertisement', () => {
  it.each([
    { config: { provider: 'google', apiFormat: 'google' }, native: true },
    { config: { provider: 'google-cloudcode', apiFormat: undefined }, native: true },
    { config: { provider: 'google', apiFormat: 'openai' }, native: false },
    { config: { provider: 'google', apiFormat: 'google', gateway: true }, native: false },
  ])('keeps HEIC/HEIF only for native Google routes: $config', ({ config, native }) => {
    const response = requestModels('/v1internal:fetchAvailableModels', { models: {} }, undefined, config);
    expect(Object.values(response.models)).toHaveLength(3);
    for (const entry of Object.values(response.models) as {
      supportsImages: boolean;
      supportedMimeTypes: Record<string, boolean>;
    }[]) {
      expect(entry.supportedMimeTypes['image/heic']).toBe(native && entry.supportsImages ? true : undefined);
      expect(entry.supportedMimeTypes['image/heif']).toBe(native && entry.supportsImages ? true : undefined);
    }
  });

  it.each(['models', 'availableModels', 'available_models'])(
    'advertises the same capabilities in %s maps and arrays',
    (key) => {
      for (const native of [{ native: { displayName: 'Native' } }, [{ displayName: 'Native' }]]) {
        const response = requestModels('/v1internal:fetchAvailableModels', { [key]: native });
        checkCapabilities(response[key]);
        expect(Object.values(response[key])).toContainEqual({ displayName: 'Native' });
      }
    },
  );

  it.each([
    { label: 'missing collection', body: { status: 'ok' } },
    { label: 'invalid JSON', body: 'invalid-json' },
    { label: 'connection error', failure: 'error' as const },
    { label: 'timeout', failure: 'timeout' as const },
  ])('advertises vision when fetchAvailableModels falls back after $label', ({ body, failure }) => {
    checkCapabilities(requestModels('/v1internal:fetchAvailableModels', body, failure).models);
  });

  it.each([
    { label: 'successful list', body: { models: [] } },
    { label: 'invalid JSON', body: 'invalid-json' },
    { label: 'connection error', failure: 'error' as const },
    { label: 'timeout', failure: 'timeout' as const },
  ])('advertises vision in the Gemini models endpoint: $label', ({ body, failure }) => {
    checkCapabilities(requestModels('/v1beta/models', body, failure).models);
  });
});
