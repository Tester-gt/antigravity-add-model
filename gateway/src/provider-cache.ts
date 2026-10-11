import { createHash } from 'node:crypto';
import { poolFetch } from './http-pool.js';
import { logger } from './logger.js';
import { BUILTIN_PROVIDERS, getProviderApiKey, getProviderDefinition } from './provider-catalog.js';
import { openAIEndpoint, providerUrl, workersAIBaseUrl } from './provider-endpoints.js';

export interface ProviderModelDetails {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
}
interface CachedModels {
  models: string[];
  modelDetails?: ProviderModelDetails[];
  fetchedAt: number;
  error?: string;
}
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedModels>();
const cacheScopes = new Map<string, string>();
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const positiveInteger = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_ENTRIES = 10_000;
const NON_CHAT_TYPES = new Set([
  'embedding',
  'embeddings',
  'text-embedding',
  'image',
  'audio',
  'video',
  'rerank',
  'reranker',
  'moderation',
  'text-to-image',
  'text-to-speech',
  'speech-to-text',
]);
function modelItems(payload: unknown): unknown[] {
  const data = object(payload);
  if (data.success === false) throw new Error('Provider rejected model discovery');
  const items = Array.isArray(payload) ? payload : (data.data ?? data.models ?? data.output?.models ?? data.result);
  if (!Array.isArray(items)) throw new Error('Provider response has no model list');
  return items;
}

async function readModelList(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_MODEL_LIST_BYTES) {
    await response.body?.cancel();
    throw new Error('Provider model list is too large');
  }
  if (!response.body) throw new Error('Provider response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MODEL_LIST_BYTES) throw new Error('Provider model list is too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only known capability fields leave discovery; upstream payloads may contain private metadata. */
export function parseProviderModelDetails(provider: string, payload: unknown): ProviderModelDetails[] {
  const items = modelItems(payload);
  if (items.length > MAX_MODEL_ENTRIES) throw new Error('Provider model list has too many entries');
  const models = new Map<string, ProviderModelDetails>();
  for (const value of items) {
    const model = object(value);
    if (provider === 'workers-ai') {
      const task = typeof model.task === 'string' ? model.task : model.task?.name;
      if (typeof task === 'string' && task.toLowerCase() !== 'text generation') continue;
    }
    if (typeof model.type === 'string' && NON_CHAT_TYPES.has(model.type.toLowerCase())) continue;
    const outputs = model.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) continue;
    if (provider === 'together' && model.type && model.type !== 'chat') continue;
    if (provider === 'mistral' && model.capabilities?.completion_chat === false) continue;
    if (
      provider === 'google' &&
      Array.isArray(model.supportedGenerationMethods) &&
      !model.supportedGenerationMethods.includes('generateContent')
    )
      continue;
    if (
      provider === 'fireworks' &&
      (model.supportsServerless === false ||
        (model.state && model.state !== 'READY') ||
        model.kind === 'EMBEDDING_MODEL')
    )
      continue;
    const live = Array.isArray(model.providers)
      ? model.providers.filter((item: unknown) => object(item).status === 'live')
      : undefined;
    if (provider === 'huggingface' && live && live.length === 0) continue;
    const rawId = provider === 'dashscope' ? model.model :
      provider === 'workers-ai' && Array.isArray(object(payload).result) ? model.name : (model.id ?? model.name);
    if (typeof rawId !== 'string' || !rawId.trim() || /[\r\n\0]/.test(rawId)) continue;
    const id = provider === 'google' ? rawId.replace(/^models\//, '') : rawId;
    const result: ProviderModelDetails = { id };
    const name =
      model.display_name ??
      model.displayName ??
      model.title ??
      (model.id || provider === 'dashscope' ? model.name : undefined);
    if (typeof name === 'string' && name) result.displayName = name;
    const context = positiveInteger(
      model.context_length ??
        model.context_window ??
        model.context_size ??
        model.contextLength ??
        model.max_context_length ??
        model.inputTokenLimit ??
        model.model_info?.context_window,
    );
    if (context) result.contextWindow = context;
    const output = positiveInteger(
      model.max_completion_tokens ??
        model.max_output_tokens ??
        model.outputTokenLimit ??
        model.top_provider?.max_completion_tokens,
    );
    if (output) result.maxOutputTokens = output;
    const modalities =
      model.architecture?.input_modalities ?? model.input_modalities ?? model.inference_metadata?.request_modality;
    if (Array.isArray(modalities))
      result.supportsVision = modalities.some((item) => typeof item === 'string' && item.toLowerCase() === 'image');
    else if (typeof model.supportsImageInput === 'boolean') result.supportsVision = model.supportsImageInput;
    if (typeof model.supportsTools === 'boolean') result.supportsTools = model.supportsTools;
    else if (typeof model.capabilities?.function_calling === 'boolean')
      result.supportsTools = model.capabilities.function_calling;
    else if (Array.isArray(model.features)) result.supportsTools = model.features.includes('function-calling');
    else if (Array.isArray(model.supported_parameters)) result.supportsTools = model.supported_parameters.includes('tools');
    if (provider === 'huggingface' && live?.length) {
      // Automatic routing may choose any live provider. Unknown limits stay unknown.
      const limits = live.map((item: unknown) => positiveInteger(object(item).context_length));
      if (!context && limits.every((limit: number | undefined) => limit !== undefined))
        result.contextWindow = Math.min(...(limits as number[]));
      if (live.every((item: unknown) => typeof object(item).supports_tools === 'boolean')) {
        result.supportsTools = live.every((item: unknown) => object(item).supports_tools === true);
      }
    }
    models.set(id, result);
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function modelsUrl(provider: string, baseUrl: string): URL {
  if (provider === 'workers-ai') {
    const url = workersAIBaseUrl(baseUrl);
    url.pathname = url.pathname.replace(/\/v1$/, '/models/search');
    url.searchParams.set('format', 'openrouter');
    url.searchParams.set('task', 'Text Generation');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', '1');
    return url;
  }
  if (provider === 'dashscope' || provider === 'fireworks') {
    const url = providerUrl(baseUrl);
    const basePath = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    url.pathname =
      provider === 'dashscope'
        ? basePath.replace(/\/(?:compatible-mode\/v1|api\/v1(?:\/models)?|v1)$/, '') + '/api/v1/models'
        : basePath.replace(/\/(?:inference\/v1|v1)$/, '') + '/v1/accounts/fireworks/models';
    if (provider === 'dashscope') {
      url.searchParams.set('capabilities', 'TG');
      url.searchParams.set('page_no', '1');
      url.searchParams.set('page_size', '100');
    } else url.searchParams.set('pageSize', '200');
    return url;
  }
  if (provider === 'google' || provider === 'ollama') {
    const url = providerUrl(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, '') + (provider === 'google' ? '/v1/models' : '/api/tags');
    return url;
  }
  const url = new URL(openAIEndpoint(baseUrl, 'models'));
  if (provider === 'siliconflow') url.searchParams.set('sub_type', 'chat');
  return url;
}

export async function fetchProviderModels(provider: string, apiKey?: string, force = false): Promise<CachedModels> {
  const definition = getProviderDefinition(provider);
  if (!definition) return { models: [], fetchedAt: Date.now(), error: 'Unknown provider' };
  const baseUrl = process.env[definition.baseUrlEnv] || definition.baseUrl;
  if (provider === 'workers-ai') {
    try { workersAIBaseUrl(baseUrl); }
    catch {
      return { models: [], fetchedAt: Date.now(), error: 'Set WORKERS_AI_BASE_URL with your actual account ID: https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1' };
    }
  }
  const key = apiKey || getProviderApiKey(definition);
  if (definition.envKey && !key)
    return { models: [], fetchedAt: Date.now(), error: `No API key configured — set ${definition.envKey} in .env` };
  const scope = createHash('sha256')
    .update(JSON.stringify([baseUrl, key]))
    .digest('hex');
  const now = Date.now();
  const existing = cache.get(provider);
  if (!force && cacheScopes.get(provider) === scope && existing && now - existing.fetchedAt < CACHE_TTL_MS)
    return existing;
  let modelDetails: ProviderModelDetails[] = [];
  let error: string | undefined;
  try {
    const url = modelsUrl(provider, baseUrl);
    const headers: Record<string, string> = {};
    if (provider === 'google') headers['x-goog-api-key'] = key;
    else if (provider === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else if (key) headers.Authorization = `Bearer ${key}`;
    const details = new Map<string, ProviderModelDetails>();
    const pages = new Set<string>();
    const deadline = AbortSignal.timeout(30_000);
    let seen = 0;
    for (let page = 1; page <= 50; page++) {
      const response = await poolFetch(url.toString(), {
        headers,
        signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await readModelList(response);
      const count = modelItems(payload).length;
      if (provider === 'workers-ai' && count > 0) {
        const signature = createHash('sha256').update(JSON.stringify(modelItems(payload))).digest('hex');
        if (pages.has(signature)) throw new Error('Provider returned a repeated model page');
        pages.add(signature);
      }
      seen += count;
      if (seen > MAX_MODEL_ENTRIES) throw new Error('Provider model list has too many entries');
      for (const model of parseProviderModelDetails(provider, payload)) details.set(model.id, model);
      const data = object(payload);
      if (provider === 'workers-ai') {
        const pagination = object(data.result_info);
        const total = pagination.total_count;
        const knownTotal = Number.isSafeInteger(total) && total >= 0;
        const totalPages = positiveInteger(pagination.total_pages);
        if (knownTotal && total > MAX_MODEL_ENTRIES) throw new Error('Provider model list has too many entries');
        if (pagination.page !== undefined && pagination.page !== page) throw new Error('Provider returned an unexpected page');
        if (count === 0 && (knownTotal && seen < total || totalPages && page < totalPages)) throw new Error('Provider returned an incomplete model list');
        if (knownTotal ? seen >= total : totalPages ? page >= totalPages : count < 100) break;
        url.searchParams.set('page', String(page + 1));
      } else if (provider === 'dashscope') {
        const total = data.output?.total;
        const knownTotal = Number.isSafeInteger(total) && total >= 0;
        if (knownTotal && total > MAX_MODEL_ENTRIES) throw new Error('Provider model list has too many entries');
        if (count === 0 && knownTotal && seen < total) throw new Error('Provider returned an incomplete model list');
        if (knownTotal ? seen >= total : count < 100) break;
        url.searchParams.set('page_no', String(page + 1));
      } else if (provider === 'fireworks' && typeof data.nextPageToken === 'string' && data.nextPageToken) {
        if (pages.has(data.nextPageToken)) throw new Error('Provider returned a repeated pagination token');
        pages.add(data.nextPageToken);
        url.searchParams.set('pageToken', data.nextPageToken);
      } else break;
      if (page === 50) throw new Error('Provider model list exceeds the pagination limit');
    }
    modelDetails = [...details.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    // Never propagate provider bodies, URLs, keys, or library error payloads.
    error = 'Model discovery failed. Check the provider address, credentials, and access.';
    logger.warn(`[provider-cache] Failed to fetch ${provider} models`);
  }
  const result: CachedModels = { models: modelDetails.map((model) => model.id), modelDetails, fetchedAt: now, error };
  cache.set(provider, result);
  cacheScopes.set(provider, scope);
  return result;
}
export function getCachedProviderModels(provider: string): CachedModels | null {
  return cache.get(provider) || null;
}
export function clearProviderCache(provider?: string): void {
  if (provider) {
    cache.delete(provider);
    cacheScopes.delete(provider);
  } else {
    cache.clear();
    cacheScopes.clear();
  }
}
export function listKnownProviders(): string[] {
  return BUILTIN_PROVIDERS.map((provider) => provider.id);
}
export async function warmProviderCache(): Promise<void> {
  await Promise.allSettled(listKnownProviders().map((provider) => fetchProviderModels(provider).catch(() => null)));
}
