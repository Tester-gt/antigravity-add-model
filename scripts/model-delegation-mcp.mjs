#!/usr/bin/env node
// Explicit text-only delegation for IDEs with MCP support. Never starts the proxy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const MAX_INPUT_BYTES = 65536;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const MODE = 'text-only';
class DelegationError extends Error {}
const fail = (message) => new DelegationError(message);
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const clean = (value, token) => value.replaceAll(token, '[redacted]');

export function parseDelegationOptions(args) {
  const options = { dataDirectory: path.join(os.homedir(), '.gemini', 'antigravity') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--data-dir' || !args[i + 1] || args[i + 1].startsWith('--'))
      throw fail('Usage: node scripts/model-delegation-mcp.mjs [--data-dir DIRECTORY]');
    options.dataDirectory = path.resolve(args[++i]);
  }
  return options;
}

function readState(dataDirectory) {
  const directory = path.join(dataDirectory, '.ide-proxy');
  const filename = path.join(directory, 'state.json');
  let fd;
  try {
    for (const entry of [dataDirectory, directory, filename]) {
      if (fs.lstatSync(entry).isSymbolicLink()) throw fail('Linked proxy state is not supported.');
    }
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) throw fail('Invalid proxy state.');
    // Bound the read itself as well, in case the file grows after fstat.
    const buffer = Buffer.alloc(8193);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 8192) throw fail('Invalid proxy state.');
    const value = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    if (
      value?.version !== 1 || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) ||
      typeof value.instance !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.instance) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !Number.isInteger(value.pid) || value.pid < 1
    ) throw fail('Invalid proxy state.');
    return value;
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    if (error?.code === 'ENOENT') throw fail('The owned proxy is not running. Start it with npm run proxy:start using the same data directory.');
    throw fail('Cannot read valid proxy state.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function requestJson(state, route, { signal, body, limit = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(fail('Delegation cancelled or timed out.'));
    let settled = false;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const req = http.request({
      hostname: '127.0.0.1', port: state.port, path: route,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    }, (res) => {
      response = res;
      // Do not follow redirects or expose response bodies/headers on errors.
      if (res.statusCode !== 200) {
        finish(fail(`Proxy request failed (HTTP ${res.statusCode || 0}). Check the proxy and saved model configuration.`));
        res.destroy(); req.destroy(); return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          finish(fail('Proxy response exceeds the allowed size.'));
          res.destroy(); req.destroy(); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(fail('Proxy returned invalid JSON.')); }
      });
      res.on('error', () => finish(fail('Proxy response was interrupted.')));
      res.on('aborted', () => finish(fail('Proxy response was interrupted.')));
    });
    const abort = () => {
      finish(fail('Delegation cancelled or timed out.'));
      response?.destroy(); req.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', () => finish(fail('Cannot reach the owned proxy. Start it with npm run proxy:start using the same data directory.')));
    if (signal.aborted) abort(); else req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function verifiedState(options, signal) {
  const state = readState(options.dataDirectory);
  const health = await requestJson(state, '/_addon/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), limit: 8192 });
  if (health?.service !== 'antigravity-model-proxy' || health.instance !== state.instance || health.pid !== state.pid || health.port !== state.port)
    throw fail('Proxy identity does not match its saved state. Restart the owned proxy before delegating.');
  return state;
}

function validateArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Tool arguments must be an object.');
  const allowed = name === 'list_custom_models' ? ['cursor'] : ['model', 'prompt', 'context'];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw fail('Unsupported tool argument. URLs, API keys and tools cannot be supplied.');
  if (name === 'list_custom_models') {
    if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0))
      throw fail('Cursor must be a nonnegative safe integer returned by list_custom_models.');
    return;
  }
  if (typeof args.model !== 'string' || !args.model.trim() ||
      typeof args.prompt !== 'string' || !args.prompt.trim() ||
      (args.context !== undefined && typeof args.context !== 'string'))
    throw fail('Provide an exact saved model name, a non-empty prompt, and optional text context.');
  if (Buffer.byteLength(args.prompt, 'utf8') + Buffer.byteLength(args.context || '', 'utf8') > MAX_INPUT_BYTES)
    throw fail('Prompt and context together must not exceed 65536 UTF-8 bytes.');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_REQUEST_BYTES)
    throw fail('The complete delegation request must not exceed 256 KiB.');
}

function modelList(value, token, cursor = 0) {
  if (value?.mode !== MODE || !Array.isArray(value.models)) throw fail('Proxy does not provide the expected text-only delegation API. Update and restart it.');
  if (value.nextCursor !== undefined && (!Number.isSafeInteger(value.nextCursor) || value.nextCursor <= cursor))
    throw fail('Proxy returned an invalid model-list cursor.');
  const models = value.models.map((model) => {
    if (typeof model?.name !== 'string' || !model.name ||
        typeof model.displayName !== 'string' || model.displayName.length > 1024 ||
        (model.description !== undefined && (typeof model.description !== 'string' || model.description.length > 8192)))
      throw fail('Proxy returned an invalid model list.');
    return { name: clean(model.name, token), displayName: clean(model.displayName, token),
      ...(model.description === undefined ? {} : { description: clean(model.description, token) }) };
  });
  return { mode: MODE, models, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) };
}

function modelResult(value, token) {
  const candidate = value?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) throw fail('The child model returned no text result.');
  if (parts.some((part) => part?.functionCall)) throw fail('The child model requested a tool. This delegation supports text only; no tool was executed.');
  const output = parts.filter((part) => part?.thought !== true && typeof part?.text === 'string').map((part) => part.text).join('');
  if (!output.trim()) throw fail('The child model returned no text result.');
  const knownReasons = ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY', 'UNEXPECTED_TOOL_CALL', 'FINISH_REASON_UNSPECIFIED'];
  const finishReason = knownReasons.includes(candidate.finishReason) ? candidate.finishReason : 'UNKNOWN';
  const usage = {};
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount']) {
    if (Number.isSafeInteger(value?.usageMetadata?.[key]) && value.usageMetadata[key] >= 0) usage[key] = value.usageMetadata[key];
  }
  const metadata = { mode: MODE, finishReason, truncated: finishReason === 'MAX_TOKENS', ...(Object.keys(usage).length ? { usage } : {}) };
  return { content: [
    { type: 'text', text: `Independent text-only child result. No IDE-native subagent session, IDE files, terminal or tools were provided to the child.\n${JSON.stringify(metadata)}` },
    { type: 'text', text: clean(output, token) },
  ], ...(finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS' ? { isError: true } : {}) };
}

export const DELEGATION_TOOLS = [
  {
    name: 'list_custom_models',
    description: 'List one page of up to 100 enabled, saved custom models for independent text-only task delegation. If nextCursor is returned, call again with cursor=nextCursor for the next page. These are not IDE-native subagents. No API credentials are returned.',
    inputSchema: {
      type: 'object',
      properties: { cursor: { type: 'integer', minimum: 0, description: 'Optional nextCursor returned by the previous page. Omit for the first page.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delegate_to_model',
    description: 'Send one independent text-only task to an enabled, saved custom model. First call list_custom_models and use its exact name. Explicit prompt/context are sent to that model provider and may incur usage charges. This does not open an IDE-native subagent or child window; the child cannot read files, use a terminal, call tools or inherit the IDE conversation. Returns the child text plus finish/truncation metadata. Maximum combined prompt/context: 65536 UTF-8 bytes; timeout: 120 seconds.',
    inputSchema: {
      type: 'object', properties: {
        model: { type: 'string', description: 'Exact saved name returned by list_custom_models.', minLength: 1 },
        prompt: { type: 'string', description: 'Independent task for the text-only child model.', minLength: 1, maxLength: 65536 },
        context: { type: 'string', description: 'Optional explicit text context to send with the task.', maxLength: 65536 },
      }, required: ['model', 'prompt'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

export function createDelegationServer(options, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const server = new Server({ name: 'antigravity-custom-model-delegation', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: 'Use saved custom models for independent text-only tasks. This server does not implement native IDE subagents or provide child tools/files. The owned model proxy must already be running.',
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: DELEGATION_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      if (!['list_custom_models', 'delegate_to_model'].includes(params.name)) throw fail('Unknown delegation tool.');
      const args = params.arguments || {};
      validateArguments(params.name, args);
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(Math.min(timeoutMs, REQUEST_TIMEOUT_MS))]);
      const state = await verifiedState(options, signal);
      if (params.name === 'list_custom_models') {
        const route = '/_addon/delegation/models' + (args.cursor === undefined ? '' : `?cursor=${args.cursor}`);
        return textResult(JSON.stringify(modelList(await requestJson(state, route, { signal }), state.token, args.cursor)));
      }
      // The backend validates the exact enabled saved name at execution time. A
      // separate catalog fetch would be stale and could block large catalogs.
      const response = await requestJson(state, '/_addon/delegation/run', { signal, body: args });
      return modelResult(response, state.token);
    } catch (error) {
      // Never return upstream bodies, request objects, stack traces or local credentials.
      return textResult(error instanceof DelegationError ? error.message : 'Delegation failed. Check the owned proxy and model configuration.', true);
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const server = createDelegationServer(parseDelegationOptions(process.argv.slice(2)));
    server.onerror = () => process.stderr.write('MCP protocol error.\n');
    const close = () => { void server.close(); };
    process.stdin.once('end', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_RESPONSE_BYTES }));
  } catch {
    process.stderr.write('Unable to start model delegation MCP. Check --data-dir and the Node installation.\n');
    process.exitCode = 1;
  }
}
