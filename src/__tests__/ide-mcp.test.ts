import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureIdeMcp, parseIdeMcpArgs } from '../../scripts/ide-mcp.mjs';

const roots: string[] = [];
function fixture(source: string | null = '{}\n') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-test-')));
  roots.push(root);
  const config = path.join(root, 'workspace with spaces', '.agents', 'mcp_config.json');
  const dataDir = path.join(root, 'models with spaces');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  if (source !== null) fs.writeFileSync(config, source);
  return { root, config, dataDir, state: `${config}.antigravity-custom-models/state.json`, backup: `${config}.antigravity-custom-models/original.jsonc` };
}
function read(config: string) { return fs.readFileSync(config, 'utf8'); }
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^agy-mcp-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('IDE MCP delegation configuration', () => {
  it.each(['', ' \t\r\n', '// MCP server configuration\n// Edit below', '\ufeff/* MCP help */\r\n// Schema details\r\n'])('initializes a trivia-only IDE config and restores its exact original bytes: %j', (source) => {
    const f = fixture(source);
    expect(configureIdeMcp({ ...f, action: 'status' }).status).toBe('unconfigured');
    expect(configureIdeMcp({ ...f, action: 'apply' }).status).toBe('configured');
    expect(read(f.config)).toContain(source);
    expect(read(f.config)).toContain('"custom-models"');
    expect(read(f.backup)).toBe(source);
    expect(configureIdeMcp({ ...f, action: 'restore' }).status).toBe('restored');
    expect(read(f.config)).toBe(source);
  });

  it('installs absolute argv paths and eager tools, preserving unrelated JSONC byte for byte', () => {
    const source = '\ufeff{\r\n  // Existing tools\r\n  "mcpServers": {"files": {"command":"node", "args":["with spaces.mjs"],}, /* keep */},\r\n  "other": [{"nested":true,}],\r\n}\r\n';
    const f = fixture(source);
    expect(configureIdeMcp({ ...f, action: 'apply' })).toMatchObject({ status: 'configured', applied: true, config: f.config });
    const installed = read(f.config);
    expect(installed).toContain('"files": {"command":"node", "args":["with spaces.mjs"],}, /* keep */');
    expect(installed).toContain('"other": [{"nested":true,}],\r\n');
    expect(installed).toContain(JSON.stringify(process.execPath));
    expect(installed).toContain(JSON.stringify(f.dataDir));
    const server = JSON.parse(read(f.state)).server;
    expect(server.args).toEqual([expect.stringMatching(/scripts[\\/]model-delegation-mcp\.mjs$/), '--data-dir', f.dataDir]);
    expect(path.isAbsolute(server.args[0])).toBe(true);
    expect(server.tools).toEqual({ list_custom_models: { eager: true }, delegate_to_model: { eager: true } });
    expect(configureIdeMcp({ ...f, action: 'apply' }).status).toBe('unchanged');
    expect(configureIdeMcp({ ...f, action: 'status' })).toMatchObject({ status: 'configured', applied: true });
    expect(configureIdeMcp({ ...f, action: 'restore' })).toMatchObject({ status: 'restored', applied: false });
    expect(read(f.config)).toBe(source);
  });

  it('removes an originally absent config on exact restore and allows a later reinstall', () => {
    const f = fixture(null);
    expect(configureIdeMcp({ ...f, action: 'status' }).status).toBe('unconfigured');
    expect(fs.existsSync(path.dirname(f.state))).toBe(false);
    configureIdeMcp({ ...f, action: 'apply' });
    expect(fs.existsSync(f.config)).toBe(true);
    configureIdeMcp({ ...f, action: 'restore' });
    expect(fs.existsSync(f.config)).toBe(false);
    expect(configureIdeMcp({ ...f, action: 'restore' }).status).toBe('unchanged');
    configureIdeMcp({ ...f, action: 'apply' });
    expect(configureIdeMcp({ ...f, action: 'status' }).applied).toBe(true);
  });

  it('restores only its own server when another server and setting were added later', () => {
    const f = fixture('{"mcpServers":{"existing":{"command":"original"}},"other":1}\n');
    configureIdeMcp({ ...f, action: 'apply' });
    const edited = JSON.parse(read(f.config));
    edited.mcpServers.added = { serverUrl: 'https://example.test/mcp' };
    edited.other = 2;
    fs.writeFileSync(f.config, JSON.stringify(edited));
    expect(configureIdeMcp({ ...f, action: 'restore' }).preservedOtherEdits).toBe(true);
    expect(JSON.parse(read(f.config))).toEqual({ mcpServers: { existing: { command: 'original' }, added: { serverUrl: 'https://example.test/mcp' } }, other: 2 });
  });

  it('keeps new unrelated settings when the original file did not exist', () => {
    const f = fixture(null);
    configureIdeMcp({ ...f, action: 'apply' });
    const edited = JSON.parse(read(f.config));
    edited.other = 'keep';
    fs.writeFileSync(f.config, JSON.stringify(edited));
    configureIdeMcp({ ...f, action: 'restore' });
    expect(JSON.parse(read(f.config))).toEqual({ mcpServers: {}, other: 'keep' });
  });

  it('refuses to overwrite an unmanaged server, even when its configuration matches', () => {
    const f = fixture();
    configureIdeMcp({ ...f, action: 'apply' });
    const server = JSON.parse(read(f.state)).server;
    configureIdeMcp({ ...f, action: 'restore' });
    fs.writeFileSync(f.config, JSON.stringify({ mcpServers: { 'custom-models': server } }));
    const original = read(f.config);
    expect(configureIdeMcp({ ...f, action: 'status' }).status).toBe('unmanaged');
    expect(() => configureIdeMcp({ ...f, action: 'apply' })).toThrow('CONFIG_CONFLICT');
    expect(read(f.config)).toBe(original);
  });

  it.each(['apply', 'restore'])('refuses %s after an outside edit to its server', (action) => {
    const f = fixture();
    configureIdeMcp({ ...f, action: 'apply' });
    const edited = JSON.parse(read(f.config));
    edited.mcpServers['custom-models'].disabled = true;
    fs.writeFileSync(f.config, JSON.stringify(edited));
    const original = read(f.config);
    expect(configureIdeMcp({ ...f, action: 'status' }).status).toBe('conflict');
    expect(() => configureIdeMcp({ ...f, action })).toThrow(action === 'apply' ? 'CONFIG_CONFLICT' : 'RESTORE_REFUSED');
    expect(read(f.config)).toBe(original);
  });

  it('requires restoring before changing the model data directory', () => {
    const f = fixture();
    configureIdeMcp({ ...f, action: 'apply' });
    expect(() => configureIdeMcp({ ...f, action: 'apply', dataDir: path.join(f.root, 'different') })).toThrow('CONFIG_CONFLICT');
  });

  it.each(['{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":{},"mcpServers":{}}', '{broken}', '[]', '/* unfinished', '\ufeff// Help\n/* unfinished', '// Help\nnot JSON'])('rejects malformed or ambiguous configuration: %s', (source) => {
    const f = fixture(source);
    expect(() => configureIdeMcp({ ...f, action: 'apply' })).toThrow();
    expect(read(f.config)).toBe(source);
    expect(fs.existsSync(f.state)).toBe(false);
  });

  it('rejects a corrupt backup instead of overwriting the config during restore', () => {
    const f = fixture();
    configureIdeMcp({ ...f, action: 'apply' });
    const installed = read(f.config);
    fs.writeFileSync(f.backup, '{"changed":true}');
    expect(() => configureIdeMcp({ ...f, action: 'restore' })).toThrow('BACKUP_INVALID');
    expect(read(f.config)).toBe(installed);
  });

  it('recovers a prepared manifest after interruption on either side of config installation', () => {
    const f = fixture();
    configureIdeMcp({ ...f, action: 'apply' });
    const state = JSON.parse(read(f.state));
    state.status = 'prepared';
    fs.writeFileSync(f.state, JSON.stringify(state));
    expect(configureIdeMcp({ ...f, action: 'apply' }).status).toBe('unchanged');
    fs.writeFileSync(f.state, JSON.stringify(state));
    fs.writeFileSync(f.config, read(f.backup));
    expect(configureIdeMcp({ ...f, action: 'restore' }).status).toBe('restored');
    expect(read(f.config)).toBe('{}\n');
  });

  it('rejects linked configuration directories without changing their destination', () => {
    const f = fixture();
    const linked = path.join(f.root, 'linked');
    fs.symlinkSync(path.dirname(f.config), linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => configureIdeMcp({ ...f, config: path.join(linked, 'mcp_config.json'), action: 'apply' })).toThrow('UNSAFE_PATH');
    expect(read(f.config)).toBe('{}\n');
  });

  it('does not overwrite the config while another installer holds the lock', () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.state));
    fs.writeFileSync(path.join(path.dirname(f.state), 'lock'), '');
    expect(() => configureIdeMcp({ ...f, action: 'apply' })).toThrow('INSTALL_BUSY');
    expect(read(f.config)).toBe('{}\n');
  });

  it('parses explicit config and data paths without shell quoting and rejects ambiguous arguments', () => {
    expect(parseIdeMcpArgs(['apply', '--config', 'folder with spaces/mcp_config.json', '--data-dir', 'other folder'])).toEqual({ action: 'apply', config: 'folder with spaces/mcp_config.json', dataDir: 'other folder' });
    expect(parseIdeMcpArgs([])).toEqual({ action: 'status' });
    expect(() => parseIdeMcpArgs(['unknown'])).toThrow('INVALID_ARGUMENT');
    expect(() => parseIdeMcpArgs(['apply', '--config'])).toThrow('INVALID_ARGUMENT');
    expect(() => parseIdeMcpArgs(['apply', '--config', 'a', '--config', 'b'])).toThrow('INVALID_ARGUMENT');
  });
});
