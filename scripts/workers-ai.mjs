#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELP = `Cloudflare Workers AI setup (Node 22+)
  npm run workers-ai:setup -- wizard
  npm run workers-ai:setup -- existing --account-id ID --select MODEL_ID[,MODEL_ID]
  npm run workers-ai:setup -- verify-only --account-id ID
  npm run workers-ai:setup -- create --account-id ID --select MODEL_ID --expires-in-days 90

Options: --data-dir DIRECTORY, --token-file FILE (existing/verify-only),
--bootstrap-file FILE (create), --select IDs, --rotate (selected account only),
--expires-in-days 1..365 or --expires-on UTC_ISO_DATE (create only).
Existing tokens: CF_WORKERS_AI_TOKEN. Bootstrap: CF_BOOTSTRAP_TOKEN.
Tokens are also accepted through a masked interactive prompt. Never put a token
in a command argument. verify-only checks catalog access, does not run generation,
create tokens, or change files. create explicitly creates one scoped token.
See docs/workers-ai-setup.md for permissions and token lifecycle details.`;

export function parseWorkersAiOptions(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = { mode: args[0] || 'wizard', dataDirectory: path.join(os.homedir(), '.gemini', 'antigravity') };
  if (!['wizard', 'existing', 'create', 'verify-only'].includes(options.mode))
    throw new Error('Choose wizard, existing, create or verify-only. Use --help; token arguments are never accepted.');
  const names = {
    '--data-dir': 'dataDirectory',
    '--account-id': 'accountId',
    '--token-file': 'tokenFile',
    '--bootstrap-file': 'bootstrapFile',
    '--select': 'selection',
    '--expires-in-days': 'expiresInDays',
    '--expires-on': 'expires',
  };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('Duplicate option. Use --help.');
    seen.add(flag);
    if (flag === '--rotate') {
      options.rotate = true;
      continue;
    }
    if (!Object.hasOwn(names, flag) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Unknown or incomplete option. Token arguments are not accepted; use --help.');
    options[names[flag]] = args[++i];
  }
  options.dataDirectory = path.resolve(options.dataDirectory);
  if (options.accountId !== undefined && !/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('Account ID must contain exactly 32 hexadecimal characters.');
  if (options.selection !== undefined) {
    options.selected = options.selection
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    delete options.selection;
    if (!options.selected.length || new Set(options.selected).size !== options.selected.length)
      throw new Error('Select distinct model IDs.');
  }
  if (options.expiresInDays !== undefined) {
    if (!/^\d{1,3}$/.test(options.expiresInDays) || +options.expiresInDays < 1 || +options.expiresInDays > 365)
      throw new Error('Expiry must be between 1 and 365 days.');
    options.expiresInDays = Number(options.expiresInDays);
  }
  if (options.expires && options.expiresInDays !== undefined) throw new Error('Choose one expiry option.');
  if (options.bootstrapFile && options.tokenFile) throw new Error('Choose one credential source.');
  if (options.mode !== 'wizard') validateMode(options);
  return options;
}
function validateMode(options) {
  if (options.mode !== 'create' && (options.bootstrapFile || options.expires || options.expiresInDays !== undefined))
    throw new Error('Bootstrap and expiry options apply only to create mode.');
  if (options.mode === 'create' && options.tokenFile)
    throw new Error('create uses a bootstrap credential, not --token-file.');
  if (options.mode === 'verify-only' && (options.rotate || options.selected))
    throw new Error('verify-only cannot select or rotate models.');
}

/** Masked TTY input; never falls back to an echoing prompt or non-TTY stdin. */
export function maskedPrompt(label, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(
      new Error('Use a token environment variable or protected token file when no interactive terminal is available.'),
    );
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let secret = '';
    readline.emitKeypressEvents(input);
    output.write(label);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off('keypress', keypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(secret);
    };
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        secret = '';
        finish(new Error('Cancelled.'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace') {
        if (secret.length) {
          secret = secret.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (typeof text === 'string' && /^[\x21-\x7e]+$/.test(text) && !key.ctrl && !key.meta) {
        if (secret.length + text.length > 4096) {
          secret = '';
          finish(new Error('Token input is too long.'));
          return;
        }
        secret += text;
        output.write('*'.repeat(text.length));
      }
    };
    input.on('keypress', keypress);
  });
}

export async function readSecretInput({ filename, environmentValue, prompt }) {
  if (filename && environmentValue) throw new Error('Choose either the token file or the token environment variable.');
  if (filename) {
    let fd;
    try {
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error();
      fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8192 || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error();
      const buffer = Buffer.alloc(8193);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 8192) throw new Error();
      return buffer.subarray(0, count).toString('utf8').trim();
    } catch {
      throw new Error('Cannot read a private, regular token file (maximum 8192 bytes; Unix permissions 600).');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (environmentValue) return environmentValue.trim();
  return prompt();
}

async function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Wizard requires an interactive terminal. Use existing, create or verify-only with explicit options.',
    );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}
export async function runWorkersAiCli(args, dependencies = {}) {
  const options = parseWorkersAiOptions(args);
  const write = dependencies.write || ((text) => process.stdout.write(text + '\n'));
  const question = dependencies.ask || ask;
  if (options.help) {
    write(HELP);
    return;
  }
  const wizard = options.mode === 'wizard';
  if (wizard) {
    const choice = await question('Use an existing Workers AI token or create a scoped token? [existing/create]: ');
    if (!['existing', 'create'].includes(choice)) throw new Error('Choose existing or create.');
    options.mode = choice;
    validateMode(options);
  }
  if (options.mode !== 'create' && !options.accountId) {
    if (!wizard) throw new Error('--account-id is required for existing tokens.');
    options.accountId = await question('Cloudflare Account ID (32 hexadecimal characters): ');
  }
  const env = dependencies.env || process.env;
  const create = options.mode === 'create';
  const token = await readSecretInput({
    filename: create ? options.bootstrapFile : options.tokenFile,
    environmentValue: create ? env.CF_BOOTSTRAP_TOKEN : env.CF_WORKERS_AI_TOKEN,
    prompt: () =>
      (dependencies.masked || maskedPrompt)(create ? 'Bootstrap token (masked): ' : 'Workers AI token (masked): '),
  });
  const runner =
    dependencies.setup ||
    createRequire(import.meta.url)(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/workersAiSetup.js'),
    ).setupWorkersAi;
  const selection =
    wizard && !options.selected && !options.rotate
      ? async (models) => {
          models.forEach((model, index) =>
            write(
              `[${index + 1}] ${model.id.replace(/[\x00-\x1f\x7f]/g, '')}${model.contextWindow ? ` (context ${model.contextWindow})` : ' (context not reported)'}`,
            ),
          );
          const selected = await question('Choose model numbers, comma-separated (empty cancels): ');
          if (!/^[0-9]+(?:\s*,\s*[0-9]+)*$/.test(selected)) throw new Error('No valid model selection.');
          return [
            ...new Set(
              selected.split(',').map((part) => {
                const model = models[Number(part) - 1];
                if (!model) throw new Error('Invalid model number.');
                return model.id;
              }),
            ),
          ];
        }
      : undefined;
  const result = await runner({
    ...options,
    token,
    chooseModels: selection,
    ...(wizard
      ? {
          chooseAccount: async (accounts) => {
            accounts.forEach((account, index) => write(`[${index + 1}] ${account.id} ${account.name}`));
            const account = accounts[Number(await question('Choose account number: ')) - 1];
            if (!account) throw new Error('Invalid account selection.');
            return account.id;
          },
          confirmCreate: async (account, expiry) =>
            (await question(
              `Create one Workers AI Write token for account ${account}, expiring ${expiry}? Type CREATE: `,
            )) === 'CREATE',
        }
      : {}),
  });
  write(
    `Account ${result.accountId}: catalog access verified; generation was not tested. ${result.saved} model entries saved.`,
  );
  if (result.tokenCreated)
    write(
      `Created token ID ${result.tokenId}; expires ${result.expiresOn}. The secret was encrypted into model storage. Existing tokens were not revoked.`,
    );
  if (options.mode === 'verify-only')
    write(
      `Read-only verification: ${result.catalog.length} models available. No token or file was created or changed.`,
    );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runWorkersAiCli(process.argv.slice(2));
  } catch (error) {
    // All expected failures are our own sanitized messages. A missing build must
    // not dump module paths, request objects, environment variables or stacks.
    const message = error?.code
      ? 'Setup could not start. Run npm run build and check docs/workers-ai-setup.md.'
      : error?.message;
    process.stderr.write((message || 'Workers AI setup failed.') + '\n');
    process.exitCode = 1;
  }
}
