/** Explicit Cloud Code account preparation. This module is never invoked by normal generation. */
import * as http from 'node:http';
import * as https from 'node:https';
import { GOOGLE_CLOUD_CODE_USER_AGENT, GoogleAccountError, type GoogleAccount } from './googleAccounts';
import { describeGoogleAccessError } from './googleAccessErrors';

export const GOOGLE_CLOUD_CODE_PRODUCTION = 'https://cloudcode-pa.googleapis.com';
export const GOOGLE_CLOUD_CODE_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const RESPONSE_LIMIT = 1024 * 1024;
type JsonObject = Record<string, unknown>;

export interface GooglePreparationOptions {
  signal?: AbortSignal;
  /** Only an explicit login/preparation action may authorize first-time enrollment. */
  allowOnboard?: boolean;
  /** Official service or a loopback protocol-test endpoint; arbitrary remote origins are refused. */
  endpoint?: string;
}
export interface GooglePreparationDependencies {
  /** Test-only transport injection. URLs are validated before this function is called. */
  request?: (
    url: URL,
    method: 'GET' | 'POST',
    accessToken: string,
    body: JsonObject | undefined,
    signal: AbortSignal,
  ) => Promise<JsonObject>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
}

function invalidResponse(): GoogleAccountError {
  return new GoogleAccountError('Google returned an invalid account preparation response.', 502);
}
function cancellation(): Error {
  return Object.assign(new Error('Google account preparation cancelled.'), { name: 'AbortError' });
}
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
function field(value: JsonObject, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}
function optionalObject(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  const result = object(value);
  if (!result) throw invalidResponse();
  return result;
}
function projectId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = object(value) ? object(value)!.id : value;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw invalidResponse();
  return id;
}
function list(value: unknown): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => !object(entry))) throw invalidResponse();
  return value as JsonObject[];
}
function serviceOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new GoogleAccountError('Account preparation requires an official Google service endpoint.', 400);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    (local
      ? !['http:', 'https:'].includes(url.protocol)
      : ![GOOGLE_CLOUD_CODE_PRODUCTION, GOOGLE_CLOUD_CODE_DAILY].includes(url.origin))
  ) {
    throw new GoogleAccountError('Account preparation requires an official Google service endpoint.', 400);
  }
  return url.origin;
}
function metadata(): JsonObject {
  // Values from the IDE's ClientMetadata.Platform descriptor. Unknown architectures remain unspecified.
  const platforms: Record<string, number> = {
    'darwin:x64': 1,
    'darwin:arm64': 2,
    'linux:x64': 3,
    'linux:arm64': 4,
    'win32:x64': 5,
  };
  return { ideType: 9, ideName: 'antigravity', platform: platforms[`${process.platform}:${process.arch}`] ?? 0 };
}
function operationUrl(origin: string, name: unknown): URL {
  if (
    typeof name !== 'string' ||
    name.length > 1024 ||
    !/^(?:projects\/[A-Za-z0-9_-]+\/(?:locations\/[A-Za-z0-9_-]+\/)?)?operations\/[A-Za-z0-9_-]+$/.test(name)
  )
    throw invalidResponse();
  return new URL(`/v1internal/${name}`, origin);
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellation());
      return;
    }
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(cancellation());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function requestJson(
  url: URL,
  method: 'GET' | 'POST',
  accessToken: string,
  body: JsonObject | undefined,
  signal: AbortSignal,
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellation());
      return;
    }
    const data = body === undefined ? undefined : JSON.stringify(body);
    let settled = false;
    const finish = (error?: Error, result?: JsonObject) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent': GOOGLE_CLOUD_CODE_USER_AGENT,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) {
            finish(new GoogleAccountError('Google account preparation response exceeded the size limit.', 502));
            res.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () =>
          finish(new GoogleAccountError('Google account preparation response was interrupted.', 502)),
        );
        res.on('aborted', () =>
          finish(new GoogleAccountError('Google account preparation response was interrupted.', 502)),
        );
        res.on('end', () => {
          const status = res.statusCode || 502;
          if (status < 200 || status >= 300) {
            // Redirects and raw upstream messages are never followed or returned to callers.
            finish(new GoogleAccountError(describeGoogleAccessError(status).message, status));
            return;
          }
          try {
            const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (!result) throw invalidResponse();
            finish(undefined, result);
          } catch {
            finish(invalidResponse());
          }
        });
      },
    );
    const abort = () => {
      finish(cancellation());
      req.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', () => finish(new GoogleAccountError('Could not connect to Google for account preparation.', 502)));
    req.setTimeout(30000, () => {
      finish(new GoogleAccountError('Google account preparation request timed out.', 504));
      req.destroy();
    });
    req.end(data);
  });
}

/** Discover the account's project/service route, and enroll only after an explicit user action. */
export async function prepareGoogleAccount(
  account: GoogleAccount,
  options: GooglePreparationOptions = {},
  dependencies: GooglePreparationDependencies = {},
): Promise<GoogleAccount & { project: string; cloudCodeEndpoint: string }> {
  if (options.signal?.aborted) throw cancellation();
  const accessToken = account.accessToken;
  if (
    !accessToken ||
    accessToken.length > 16384 ||
    /[^\x21-\x7e]/.test(accessToken) ||
    /^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(accessToken)
  ) {
    throw new GoogleAccountError('Sign in or refresh the Google account before preparing it.', 401);
  }
  const initialOrigin = serviceOrigin(options.endpoint ?? GOOGLE_CLOUD_CODE_PRODUCTION);
  const savedProject = projectId(account.project);
  const fixture = ![GOOGLE_CLOUD_CODE_PRODUCTION, GOOGLE_CLOUD_CODE_DAILY].includes(initialOrigin);
  const timeoutMs = dependencies.timeoutMs ?? 120000;
  const intervalMs = dependencies.pollIntervalMs ?? 1000;
  const maxPolls = dependencies.maxPolls ?? 60;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > 10000 ||
    !Number.isInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 120
  ) {
    throw new GoogleAccountError('Invalid Google account preparation timeout settings.', 400);
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const transport = dependencies.request ?? requestJson;
  const send = async (url: URL, method: 'GET' | 'POST', body?: JsonObject): Promise<JsonObject> => {
    if (controller.signal.aborted) throw cancellation();
    // The internal transport also observes the same signal. Race guards injected transports as well.
    return new Promise<JsonObject>((resolve, reject) => {
      const aborted = () => reject(cancellation());
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve()
        .then(() => transport(url, method, accessToken, body, controller.signal))
        .then((value) => {
          if (!object(value)) throw invalidResponse();
          return value;
        })
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', aborted));
    });
  };
  const clientMetadata = metadata();
  const inspectLoaded = (loaded: JsonObject) => {
    const projectError = optionalObject(field(loaded, 'projectValidationError', 'project_validation_error'));
    if (projectError && projectError.code !== undefined && projectError.code !== 0) {
      throw new GoogleAccountError(
        'Google rejected the selected Cloud Code project. Check project access and account eligibility.',
        403,
      );
    }
    const paidTier = optionalObject(field(loaded, 'paidTier', 'paid_tier'));
    const usesGcpTos = paidTier && field(paidTier, 'usesGcpTos', 'uses_gcp_tos');
    if (usesGcpTos !== undefined && typeof usesGcpTos !== 'boolean') throw invalidResponse();
    const origin = fixture
      ? initialOrigin
      : usesGcpTos === true
        ? GOOGLE_CLOUD_CODE_PRODUCTION
        : GOOGLE_CLOUD_CODE_DAILY;
    const currentTier = optionalObject(field(loaded, 'currentTier', 'current_tier'));
    const returnedProject = projectId(field(loaded, 'cloudaicompanionProject', 'cloudaicompanion_project'));
    const allowed = list(field(loaded, 'allowedTiers', 'allowed_tiers'));
    const ineligible = list(field(loaded, 'ineligibleTiers', 'ineligible_tiers'));
    const freeTierDenied = ineligible.some((tier) => field(tier, 'tierId', 'tier_id') === 'free-tier');
    if (freeTierDenied)
      throw new GoogleAccountError(
        'This account is not eligible for the Cloud Code free tier. Complete any required verification in Antigravity or use an eligible account.',
        403,
      );
    return { origin, paidTier, currentTier, returnedProject, allowed };
  };
  try {
    const loaded = await send(new URL('/v1internal:loadCodeAssist', initialOrigin), 'POST', {
      metadata: clientMetadata,
      ...(savedProject ? { cloudaicompanionProject: savedProject } : {}),
    });
    const { origin, paidTier, currentTier, returnedProject, allowed } = inspectLoaded(loaded);
    const project = returnedProject ?? (currentTier || paidTier ? savedProject : undefined);
    if (project) return { ...account, project, cloudCodeEndpoint: origin };
    if (!options.allowOnboard)
      throw new GoogleAccountError(
        'This Google account has no prepared Cloud Code project. Use Prepare account or sign in to set it up.',
        409,
      );
    if ((paidTier?.id && paidTier.id !== 'free-tier') || (currentTier?.id && currentTier.id !== 'free-tier')) {
      throw new GoogleAccountError(
        'This account requires its existing Cloud Code project. Complete project setup in Antigravity; paid enrollment is not automatic.',
        403,
      );
    }
    const eligibleFree = allowed.some((tier) => tier.id === 'free-tier') || currentTier?.id === 'free-tier';
    // Native personal sign-in also permits free-tier when Google lists no explicit eligibility rejection.
    if (!eligibleFree && account.authMode !== 'antigravity') {
      throw new GoogleAccountError(
        'Google did not offer a supported free tier. Complete project setup in Antigravity; paid enrollment is not automatic.',
        403,
      );
    }
    let operation = await send(new URL('/v1internal:onboardUser', origin), 'POST', {
      tierId: 'free-tier',
      metadata: clientMetadata,
      ...(savedProject ? { cloudaicompanionProject: savedProject } : {}),
    });
    let pollUrl: URL | undefined;
    for (let polls = 0; ; polls++) {
      if (operation.error !== undefined) {
        const error = optionalObject(operation.error);
        const statusByCode: Record<number, number> = { 3: 400, 4: 504, 7: 403, 8: 429, 14: 503, 16: 401 };
        const status = typeof error?.code === 'number' ? (statusByCode[error.code] ?? 502) : 502;
        throw new GoogleAccountError(
          `Google account preparation failed. ${describeGoogleAccessError(status).message}`,
          status,
        );
      }
      if (operation.done !== undefined && typeof operation.done !== 'boolean') throw invalidResponse();
      if (operation.done === true) {
        const response = optionalObject(operation.response);
        const preparedProject =
          response && projectId(field(response, 'cloudaicompanionProject', 'cloudaicompanion_project'));
        if (!preparedProject) throw invalidResponse();
        // Refresh the service route after enrollment, as the IDE does when refreshing user status.
        const confirmed = inspectLoaded(
          await send(new URL('/v1internal:loadCodeAssist', origin), 'POST', {
            metadata: clientMetadata,
            cloudaicompanionProject: preparedProject,
          }),
        );
        return {
          ...account,
          project: confirmed.returnedProject ?? preparedProject,
          cloudCodeEndpoint: confirmed.origin,
        };
      }
      if (polls >= maxPolls)
        throw new GoogleAccountError(
          'Google account preparation did not finish in time. Try preparing the account again later.',
          504,
        );
      const nextUrl = operationUrl(origin, operation.name);
      if (pollUrl && nextUrl.href !== pollUrl.href) throw invalidResponse();
      pollUrl = nextUrl;
      await sleep(intervalMs, controller.signal);
      operation = await send(pollUrl, 'GET');
    }
  } catch (error) {
    if (timedOut)
      throw new GoogleAccountError('Google account preparation timed out. Try preparing the account again later.', 504);
    if (controller.signal.aborted) throw cancellation();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
