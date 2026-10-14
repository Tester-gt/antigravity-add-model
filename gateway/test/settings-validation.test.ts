import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSettings, writeSettings, initializeConfig } from '../src/settings.js';

const filename = initializeConfig();
const original = fs.readFileSync(filename, 'utf8');
const environment = new Map(['WORKERS_AI_API_KEY', 'WORKERS_AI_BASE_URL', 'PROVIDER_PRIORITY'].map(key => [key, process.env[key]]));
afterEach(() => {
  fs.writeFileSync(filename, original);
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const baseUrl = 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1';

test('Workers AI setup rejects missing and invalid account URLs before changing any saved setting', () => {
  for (const invalid of ['', baseUrl.replace('0123456789abcdef0123456789abcdef', 'ACCOUNT_ID'), baseUrl.replace('0123456789abcdef0123456789abcdef', 'short'), 'https://user:secret@example.com/v1']) {
    assert.throws(() => writeSettings({ PROVIDER_PRIORITY: 'workers-ai', WORKERS_AI_API_KEY: 'new-private-key', WORKERS_AI_BASE_URL: invalid }), /WORKERS_AI_BASE_URL|account|credentials/);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
  }
});

test('Workers AI validation includes saved selection and environment credentials when adding a key', () => {
  const current = { ...readSettings(), PROVIDER_PRIORITY: 'workers-ai' };
  fs.writeFileSync(filename, Object.entries(current).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
  const before = fs.readFileSync(filename, 'utf8');
  process.env.WORKERS_AI_API_KEY = 'environment-key';
  delete process.env.WORKERS_AI_BASE_URL;
  assert.throws(() => writeSettings({ WORKERS_AI_API_KEY: 'new-private-key' }), /WORKERS_AI_BASE_URL|account/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  process.env.WORKERS_AI_BASE_URL = baseUrl;
  writeSettings({ WORKERS_AI_API_KEY: 'new-private-key' });
  assert.equal(readSettings().WORKERS_AI_API_KEY, 'new-private-key');
});

test('Workers AI setup can save an account URL before selecting it, and cannot clear an active account', () => {
  writeSettings({ WORKERS_AI_BASE_URL: baseUrl });
  writeSettings({ WORKERS_AI_API_KEY: 'new-key' });
  writeSettings({ PROVIDER_PRIORITY: 'workers-ai' });
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => writeSettings({ WORKERS_AI_BASE_URL: '' }), /WORKERS_AI_BASE_URL|account/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  writeSettings({ PROVIDER_PRIORITY: 'openai', WORKERS_AI_BASE_URL: '', WORKERS_AI_API_KEY: '' });
  assert.equal(readSettings().PROVIDER_PRIORITY, 'openai');
});

test('invalid Workers AI URL edits are rejected even before enabling the provider', () => {
  assert.throws(() => writeSettings({ WORKERS_AI_BASE_URL: baseUrl.replace('0123456789abcdef0123456789abcdef', 'invalid') }), /WORKERS_AI_BASE_URL|account/);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
});

test('compaction effort accepts explicit levels and rejects invalid settings before writing any field', () => {
  for (const effort of ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    writeSettings({ COMPACTION_REASONING_EFFORT: effort });
    assert.equal(readSettings().COMPACTION_REASONING_EFFORT, effort);
  }
  const before = fs.readFileSync(filename, 'utf8');
  for (const value of ['turbo', 'LOW', '', 'default', null, 0]) {
    assert.throws(() => writeSettings({ LOG_LEVEL: 'debug', COMPACTION_REASONING_EFFORT: value }), /compaction reasoning effort|single-line string/);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
});
