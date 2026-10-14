import type { GoogleCooldownReason } from './googlePoolPolicy';
import { type GoogleAccessErrorCategory } from './googleAccessErrors';
export interface GoogleAccount {
    id: string;
    label?: string;
    refreshToken?: string;
    accessToken?: string;
    expiresAt?: number;
    clientId?: string;
    clientSecret?: string;
    project?: string;
    enabled?: boolean;
}
export interface GooglePoolOptions {
    strategy?: 'round-robin' | 'least-loaded' | 'quota' | 'adaptive';
    maxConcurrency?: number;
    cooldownMs?: number;
}
export interface GoogleQuotaSnapshot {
    accountId: string;
    checkedAt: number;
    remainingFraction?: number;
    buckets: {
        id: string;
        remainingFraction?: number;
        resetTime?: string;
    }[];
}
export interface GoogleAccountLease {
    account: GoogleAccount;
    release(result?: {
        status?: number;
        retryAfterMs?: number;
        cooldownReason?: GoogleCooldownReason;
        latencyMs?: number;
        cancelled?: boolean;
    }): void;
}
export declare class GoogleAccountError extends Error {
    readonly status: number;
    readonly category: GoogleAccessErrorCategory;
    constructor(message: string, status?: number);
}
declare let persistAccount: ((modelName: string, account: GoogleAccount, previousAccount: GoogleAccount) => Promise<void> | void) | undefined;
export declare function configureGoogleAccountPersistence(callback?: typeof persistAccount): void;
/** Refresh requests are coalesced and cached. Endpoint override is restricted to localhost fixtures. */
export declare function refreshGoogleAccount(account: GoogleAccount, tokenEndpointOverride?: string): Promise<GoogleAccount>;
/** Explicit quota refresh; never infers subscription eligibility or fabricates an available quota. */
export declare function fetchGoogleQuota(account: GoogleAccount, baseURL?: string): Promise<GoogleQuotaSnapshot>;
/** Discover only the models returned for this authenticated account/project. */
export declare function fetchGoogleModels(account: GoogleAccount, baseURL?: string): Promise<{
    id: string;
    displayName: string;
}[]>;
export declare function acquireGoogleAccount(modelName: string, accounts: GoogleAccount[], options?: GooglePoolOptions, requestIdentity?: string, cooldownScope?: string): Promise<GoogleAccountLease>;
export declare function getGooglePoolStatus(): {
    id: string;
    label: string;
    inFlight: number;
    status: string;
    cooldownUntil: number;
    modelCooldowns: {
        modelName: string;
        cooldownUntil: number;
        reason: GoogleCooldownReason;
    }[];
    requests: number;
    succeeded: number;
    failed: number;
    avgLatencyMs: number;
    lastStatus: number;
    lastError: {
        category: GoogleAccessErrorCategory;
        message: string;
    };
    quotaAgeMs: number;
    quotaFresh: boolean;
    quotaExhausted: boolean;
    quota: GoogleQuotaSnapshot;
}[];
/** Clear volatile account state after explicit account edits or sign-in. */
export declare function resetGoogleAccountState(id?: string): void;
export {};
//# sourceMappingURL=googleAccounts.d.ts.map