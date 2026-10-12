import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { catalogModelSlug } from './proxy/modelCatalog';

/** Verified against the Antigravity IDE 2.5.5 Model enum: M0..M650 = 1000..1650. */
export const NATIVE_MODEL_CAPACITY = 651;
export interface IdentityModel {
  name: string;
  displayName?: string;
  externalModelName?: string;
}
export interface ModelIdentity {
  name: string;
  catalogId: string;
  placeholderId?: string;
  placeholderValue?: number;
}
interface IdentityState {
  version: 1;
  assignments: Record<string, number>;
  reserved: number[];
}

function hash(value: string): number {
  let result = 5381;
  for (let i = 0; i < value.length; i++) result = ((result << 5) + result + value.charCodeAt(i)) | 0;
  return Math.abs(result);
}
export function legacyPlaceholderId(model: IdentityModel): string {
  return `MODEL_PLACEHOLDER_M${400 + (hash((model.displayName || model.name || 'custom-model').toLowerCase()) % 200)}`;
}
export function placeholderIndex(value: unknown): number | undefined {
  const index =
    typeof value === 'number'
      ? value - 1000
      : typeof value === 'string' && /^MODEL_PLACEHOLDER_M\d+$/.test(value)
        ? Number(value.slice('MODEL_PLACEHOLDER_M'.length))
        : undefined;
  return Number.isInteger(index) && index! >= 0 && index! < NATIVE_MODEL_CAPACITY ? index : undefined;
}
function upstreamPlaceholders(upstream: unknown): number[] {
  if (!upstream || typeof upstream !== 'object') return [];
  const result = new Set<number>();
  for (const key of ['models', 'availableModels', 'available_models']) {
    const collection = (upstream as Record<string, unknown>)[key];
    if (!collection || typeof collection !== 'object') continue;
    for (const entry of Object.values(collection)) {
      if (!entry || typeof entry !== 'object') continue;
      const index = placeholderIndex(entry.model);
      if (index !== undefined) result.add(index);
    }
  }
  return [...result];
}
function loadState(filename: string): IdentityState {
  try {
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (
      raw?.version !== 1 ||
      !raw.assignments ||
      typeof raw.assignments !== 'object' ||
      Array.isArray(raw.assignments) ||
      !Array.isArray(raw.reserved)
    )
      throw new Error('Invalid native model identity metadata');
    const entries = Object.entries(raw.assignments);
    const valid = (value: unknown) =>
      Number.isInteger(value) && Number(value) >= 0 && Number(value) < NATIVE_MODEL_CAPACITY;
    if (entries.some(([name, value]) => !name || !valid(value)) || raw.reserved.some((value: unknown) => !valid(value)))
      throw new Error('Invalid native model identity allocation');
    if (new Set(entries.map(([, value]) => value)).size !== entries.length)
      throw new Error('Duplicate native model identity allocation');
    return {
      version: 1,
      assignments: Object.fromEntries(entries),
      reserved: [...new Set(raw.reserved)],
    } as IdentityState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, assignments: {}, reserved: [] };
    throw error;
  }
}

/**
 * Persist enum ownership independently of model ordering, display labels and secrets.
 * Removed models retain their assignment so cached IDE selections never select a different model.
 * Native enum reservations survive offline catalog fallback; a newly observed native owner wins.
 */
export function allocateModelIdentities(
  dataDirectory: string,
  models: IdentityModel[],
  upstream?: unknown,
): ModelIdentity[] {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const lockfile = path.join(dataDirectory, 'custom_model_identities.lock');
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let lock: number;
  try {
    lock = fs.openSync(lockfile, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let stoppedPid: number | undefined;
      try {
        const { pid } = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === 'ESRCH') stoppedPid = pid;
          }
        }
      } catch {
        /* A live owner may not have written its PID yet; never steal its lock. */
      }
      if (stoppedPid !== undefined)
        throw new Error(
          `Native model identity lock remains from stopped process ${stoppedPid}. Close Antigravity and proxy processes, remove only ${lockfile}, then retry. Preserve custom_model_identities.json.`,
        );
      throw new Error('Native model identities are being updated by another process; retry after it finishes');
    }
    throw error;
  }
  try {
    fs.writeFileSync(lock, owner);
    return allocateLocked(dataDirectory, models, upstream);
  } finally {
    fs.closeSync(lock);
    if (fs.readFileSync(lockfile, 'utf8') === owner) fs.unlinkSync(lockfile);
  }
}

function allocateLocked(dataDirectory: string, models: IdentityModel[], upstream?: unknown): ModelIdentity[] {
  const filename = path.join(dataDirectory, 'custom_model_identities.json');
  const state = loadState(filename);
  const before = JSON.stringify(state);
  const reserved = new Set([...state.reserved, ...upstreamPlaceholders(upstream)]);
  const assignments = new Map(Object.entries(state.assignments));
  // A Google catalog can start using an enum that was free at installation time.
  // Retire our old ownership instead of ever routing that native selection to a custom provider.
  for (const [name, index] of assignments) if (reserved.has(index)) assignments.delete(name);
  const used = new Set([...reserved, ...assignments.values()]);
  const unique = new Map(models.map((model) => [model.name, model]));
  if (unique.size !== models.length)
    throw new Error('Duplicate saved model names cannot have distinct native identities');
  const ordered = [...unique.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const legacyCounts = new Map<number, number>();
  for (const model of ordered) {
    const index = placeholderIndex(legacyPlaceholderId(model))!;
    legacyCounts.set(index, (legacyCounts.get(index) || 0) + 1);
  }
  // Preserve unambiguous legacy IDs during migration, before allocating collision replacements.
  for (const model of ordered) {
    if (assignments.has(model.name)) continue;
    const legacy = placeholderIndex(legacyPlaceholderId(model))!;
    if (legacyCounts.get(legacy) === 1 && !used.has(legacy)) {
      assignments.set(model.name, legacy);
      used.add(legacy);
    }
  }
  for (const model of ordered) {
    if (assignments.has(model.name)) continue;
    const start = hash(model.name) % NATIVE_MODEL_CAPACITY;
    for (let offset = 0; offset < NATIVE_MODEL_CAPACITY; offset++) {
      const index = (start + offset) % NATIVE_MODEL_CAPACITY;
      if (used.has(index)) continue;
      assignments.set(model.name, index);
      used.add(index);
      break;
    }
  }
  state.assignments = Object.fromEntries(assignments);
  state.reserved = [...reserved].sort((a, b) => a - b);
  if (JSON.stringify(state) !== before) {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return models.map((model) => {
    const index = assignments.get(model.name);
    return {
      name: model.name,
      catalogId: catalogModelSlug(model, models),
      ...(index === undefined ? {} : { placeholderId: `MODEL_PLACEHOLDER_M${index}`, placeholderValue: index + 1000 }),
    };
  });
}
