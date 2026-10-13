#!/usr/bin/env node
/** Install an owned MCP delegation server without replacing other IDE tools. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSettings } from './ide.mjs';

const KEY = 'custom-models';
const SCRIPT = fileURLToPath(new URL('./model-delegation-mcp.mjs', import.meta.url));
const MAX_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function exists(filename) {
  try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function noLinks(filename) {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH', `Refusing linked path: ${current}`);
  }
}
function read(filename) {
  noLinks(filename);
  if (!exists(filename)) return null;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('INVALID_CONFIG', 'Expected a regular file smaller than 4 MB.');
  return fs.readFileSync(filename);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function atomic(filename, contents) {
  noLinks(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const mode = exists(filename) ? fs.statSync(filename).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode });
    fs.renameSync(temporary, filename);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function value(node) {
  if (node.kind === '{') return Object.fromEntries(node.entries.map(entry => [entry.key.value, value(entry.value)]));
  if (node.kind === '[') return node.entries.map(entry => value(entry.value));
  return node.value;
}
function configSource(source) {
  // The IDE initially writes only schema/help comments. Treat a file containing
  // JSONC trivia alone as an empty config, keeping its original bytes for restore.
  let offset = 0;
  while (offset < source.length) {
    if (/\s/.test(source[offset])) { offset++; continue; }
    if (source.startsWith('//', offset)) {
      const end = source.indexOf('\n', offset + 2);
      offset = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) return source; // Let the JSONC parser reject the broken comment.
      offset = end + 2;
      continue;
    }
    return source;
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return source + (source && !source.endsWith('\n') ? newline : '') + `{}` + newline;
}
function inspect(source) {
  source = configSource(source);
  const tree = parseSettings(source);
  const servers = tree.entries.find(entry => entry.key.value === 'mcpServers')?.value;
  if (servers && servers.kind !== '{') fail('INVALID_CONFIG', 'mcpServers must be an object.');
  const entry = servers?.entries.find(item => item.key.value === KEY);
  return { source, tree, servers, entry, server: entry ? value(entry.value) : undefined };
}
// Use the existing JSONC parser's ranges so comments and other server entries
// stay byte-for-byte intact, including trailing commas and Windows newlines.
function edit(source, tree, key, raw) {
  const index = tree.entries.findIndex(item => item.key.value === key);
  const entry = tree.entries[index];
  if (entry && raw !== null) return source.slice(0, entry.value.start) + raw + source.slice(entry.value.end);
  if (entry) {
    const ranges = [{ start: entry.start, end: entry.end }];
    const comma = entry.comma || tree.entries[index - 1]?.comma;
    if (comma) ranges.push(comma);
    for (const range of ranges.sort((a, b) => b.start - a.start)) source = source.slice(0, range.start) + source.slice(range.end);
  } else if (raw !== null) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const last = tree.entries.at(-1);
    const separator = last && !last.comma ? 1 : 0;
    if (separator) source = source.slice(0, last.end) + ',' + source.slice(last.end);
    const closing = tree.close + separator;
    source = source.slice(0, closing) + `${newline}  ${JSON.stringify(key)}: ${raw}${newline}` + source.slice(closing);
  }
  return source;
}
function serverConfig(dataDir, command = process.execPath, script = SCRIPT) {
  return { command, args: [script, '--data-dir', dataDir], tools: {
    list_custom_models: { eager: true }, delegate_to_model: { eager: true },
  } };
}
function current(config) {
  const bytes = read(config);
  const source = bytes?.toString('utf8') ?? '{}\n';
  return { bytes, source, ...inspect(source) };
}
function unchanged(config, before) {
  const now = read(config);
  if ((now === null) !== (before === null) || (now && !now.equals(before))) fail('CONFIG_CONFLICT', 'MCP configuration changed during this operation; retry after saving it.');
}
function stateBytes(state) { const { backup: _backup, ...saved } = state; return JSON.stringify(saved, null, 2) + '\n'; }
function loadState(config, names) {
  const bytes = read(names.state);
  if (!bytes) return null;
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_STATE', 'Cannot read MCP installer manifest.'); }
  const server = state?.server;
  if (state?.schema !== 1 || state.config !== config || !['prepared', 'active', 'restored'].includes(state.status) ||
      typeof state.originalExists !== 'boolean' || !HASH.test(state.originalHash) || !HASH.test(state.patchedHash) ||
      typeof server?.command !== 'string' || !path.isAbsolute(server.command) || !Array.isArray(server.args) ||
      typeof server.args[0] !== 'string' || !path.isAbsolute(server.args[0]) || typeof server.args[2] !== 'string' ||
      !path.isAbsolute(server.args[2]) || !isDeepStrictEqual(server, serverConfig(server.args[2], server.command, server.args[0]))) {
    fail('INVALID_STATE', 'Invalid MCP installer manifest.');
  }
  const backup = read(names.backup);
  if (!backup || hash(backup) !== state.originalHash) fail('BACKUP_INVALID', 'Original MCP configuration backup is missing or changed.');
  if (inspect(backup.toString('utf8')).entry) fail('INVALID_STATE', 'Backup unexpectedly contains the managed server.');
  return { ...state, backup };
}

export function configureIdeMcp(options = {}) {
  const action = options.action || 'status';
  if (!['apply', 'status', 'restore'].includes(action)) fail('INVALID_ARGUMENT', 'Use ide-mcp apply|status|restore.');
  const config = path.resolve(options.config || path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'));
  const dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.gemini', 'antigravity'));
  const directory = `${config}.antigravity-custom-models`;
  const names = { directory, state: path.join(directory, 'state.json'), backup: path.join(directory, 'original.jsonc'), lock: path.join(directory, 'lock') };
  let now = current(config);
  let state = loadState(config, names);
  const summary = { action, config, server: KEY, dataDir: state?.server.args[2] || dataDir };
  const matches = () => state && isDeepStrictEqual(now.server, state.server);
  if (action === 'status') return { ...summary, applied: Boolean(state && state.status !== 'restored' && matches()), status: !state || state.status === 'restored' ? (now.entry ? 'unmanaged' : 'unconfigured') : matches() ? 'configured' : 'conflict' };
  noLinks(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  noLinks(names.lock);
  let lock;
  try { lock = fs.openSync(names.lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('INSTALL_BUSY', `Another MCP operation is active. Verify no installer is running before removing ${names.lock}.`);
    throw error;
  }
  try {
    state = loadState(config, names); now = current(config);
    const originalUnchanged = () => state && (state.originalExists ? now.bytes && hash(now.bytes) === state.originalHash : now.bytes === null);
    if (action === 'restore') {
      if (!state || state.status === 'restored') return { ...summary, applied: false, status: 'unchanged' };
      if (state.status === 'prepared' && originalUnchanged()) {
        atomic(names.state, stateBytes({ ...state, status: 'restored' }));
        return { ...summary, applied: false, status: 'restored' };
      }
      if (!matches()) fail('RESTORE_REFUSED', 'The managed MCP server was changed outside this installer; preserve the current config and resolve the conflict first.');
      const exact = now.bytes && hash(now.bytes) === state.patchedHash;
      const restored = exact ? state.backup : Buffer.from(edit(now.source, now.servers, KEY, null));
      inspect(restored.toString('utf8'));
      unchanged(config, now.bytes);
      if (exact && !state.originalExists) fs.unlinkSync(config);
      else atomic(config, restored);
      atomic(names.state, stateBytes({ ...state, status: 'restored' }));
      return { ...summary, applied: false, status: 'restored', preservedOtherEdits: !exact };
    }
    const server = serverConfig(dataDir);
    if (state && state.status !== 'restored') {
      if (!isDeepStrictEqual(state.server, server)) fail('CONFIG_CONFLICT', 'Restore the installed MCP server before changing its data directory or runtime path.');
      if (matches()) {
        if (state.status === 'prepared') atomic(names.state, stateBytes({ ...state, status: 'active' }));
        return { ...summary, applied: true, status: 'unchanged' };
      }
      if (state.status !== 'prepared' || !originalUnchanged()) fail('CONFIG_CONFLICT', 'The managed MCP server was changed outside this installer.');
    }
    if (now.entry) fail('CONFIG_CONFLICT', `An unmanaged ${KEY} server already exists; it will not be overwritten.`);
    const original = now.bytes ?? Buffer.from(now.source);
    const patched = Buffer.from(now.servers ? edit(now.source, now.servers, KEY, JSON.stringify(server)) : edit(now.source, now.tree, 'mcpServers', JSON.stringify({ [KEY]: server })));
    inspect(patched.toString('utf8'));
    const manifest = { schema: 1, status: 'prepared', config, server, originalExists: now.bytes !== null, originalHash: hash(original), patchedHash: hash(patched) };
    unchanged(config, now.bytes);
    atomic(names.backup, original);
    atomic(names.state, stateBytes(manifest));
    unchanged(config, now.bytes);
    atomic(config, patched);
    atomic(names.state, stateBytes({ ...manifest, status: 'active' }));
    return { ...summary, dataDir, applied: true, status: 'configured' };
  } finally { fs.closeSync(lock); fs.unlinkSync(names.lock); }
}

export function parseIdeMcpArgs(args) {
  const options = { action: args[0] && !args[0].startsWith('--') ? args.shift() : 'status' };
  const flags = { '--config': 'config', '--data-dir': 'dataDir' };
  if (!['apply', 'status', 'restore'].includes(options.action)) fail('INVALID_ARGUMENT', 'Use ide-mcp apply|status|restore.');
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]];
    if (!key || key in options || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENT', `Unknown, repeated or missing argument: ${args[i]}`);
    options[key] = args[++i];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(configureIdeMcp(parseIdeMcpArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
