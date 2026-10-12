import type { IncomingHttpHeaders } from 'node:http';
/**
 * Antigravity IDE 2.5.5 uses production Cloud Code until loadCodeAssist reveals
 * the account tier, then moves non-GCP tiers to daily Cloud Code. A loopback
 * setting masks that native URL switch, so the IDE service preserves it here.
 * Cache entries contain only an irreversible bearer digest and routing state.
 */
export declare class CloudCodeRouting {
    private readonly now;
    private readonly callers;
    constructor(now?: () => number);
    private expire;
    resolve(headers: IncomingHttpHeaders): string;
    observe(headers: IncomingHttpHeaders, status: number, response: unknown): void;
    clear(): void;
}
//# sourceMappingURL=cloudCodeRouting.d.ts.map