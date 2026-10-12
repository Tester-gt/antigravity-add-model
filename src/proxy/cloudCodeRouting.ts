import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const PRODUCTION = 'https://cloudcode-pa.googleapis.com';
const DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const MAX_CALLERS = 128;
const TIER_TTL_MS = 60 * 60 * 1000;

interface CallerRoute {
  origin: string;
  expiresAt: number;
}
function callerKey(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization !== 'string' || authorization.length > 16384) return undefined;
  const bearer = /^Bearer[\t ]+(\S+)[\t ]*$/i.exec(authorization);
  return bearer ? createHash('sha256').update(bearer[1]).digest('hex') : undefined;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Antigravity IDE 2.5.5 uses production Cloud Code until loadCodeAssist reveals
 * the account tier, then moves non-GCP tiers to daily Cloud Code. A loopback
 * setting masks that native URL switch, so the IDE service preserves it here.
 * Cache entries contain only an irreversible bearer digest and routing state.
 */
export class CloudCodeRouting {
  private readonly callers = new Map<string, CallerRoute>();
  constructor(private readonly now: () => number = Date.now) {}

  private expire(): void {
    const now = this.now();
    for (const [key, route] of this.callers) if (route.expiresAt <= now) this.callers.delete(key);
  }

  resolve(headers: IncomingHttpHeaders): string {
    this.expire();
    const key = callerKey(headers);
    const route = key ? this.callers.get(key) : undefined;
    if (!key || !route) return PRODUCTION;
    // Refresh recency for bounded eviction without extending the tier TTL.
    this.callers.delete(key);
    this.callers.set(key, route);
    return route.origin;
  }

  observe(headers: IncomingHttpHeaders, status: number, response: unknown): void {
    if (!Number.isInteger(status) || status < 200 || status >= 300 || !object(response)) return;
    const key = callerKey(headers);
    if (!key) return;
    const tier = response.paidTier ?? response.paid_tier;
    if (tier !== undefined && tier !== null && !object(tier)) return;
    const usesGcpTos = object(tier) ? (tier.usesGcpTos ?? tier.uses_gcp_tos) : undefined;
    if (usesGcpTos !== undefined && usesGcpTos !== null && typeof usesGcpTos !== 'boolean') return;
    this.expire();
    this.callers.delete(key);
    this.callers.set(key, { origin: usesGcpTos === true ? PRODUCTION : DAILY, expiresAt: this.now() + TIER_TTL_MS });
    while (this.callers.size > MAX_CALLERS) this.callers.delete(this.callers.keys().next().value!);
  }

  clear(): void {
    this.callers.clear();
  }
}
