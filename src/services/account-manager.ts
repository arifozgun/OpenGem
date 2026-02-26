/**
 * In-memory account manager for fast account selection and token management.
 *
 * Replaces the per-request `db.getActiveAccounts()` call with an in-memory cache,
 * and de-duplicates concurrent token refreshes via per-account in-flight locks.
 *
 * Cache is refreshed lazily (at most every CACHE_TTL_MS) and can be explicitly
 * invalidated when accounts are added or removed.
 */

import { getDatabase } from './database';
import { refreshAccessToken } from './gemini';
import type { Account } from './database';

const CACHE_TTL_MS = 5_000; // Re-fetch accounts from DB at most once every 5 s

// ─── Cache state ─────────────────────────────────────────────────────────────

let cachedAccounts: Account[] = [];
let cacheUpdatedAt = 0;
let cacheRefreshPromise: Promise<void> | null = null;

// Per-account in-flight token refresh promises (prevents double-refresh race)
const tokenRefreshInFlight = new Map<string, Promise<string>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the current list of active accounts from the in-memory cache.
 * Triggers a background refresh if the cache is stale, but never blocks the caller.
 * On first call (cold start) it waits for the initial data to load.
 */
export async function getReadyAccounts(): Promise<Account[]> {
    const now = Date.now();

    if (cachedAccounts.length === 0 && cacheUpdatedAt === 0) {
        // Cold start — must wait for first load
        await refreshCache();
        return cachedAccounts;
    }

    if (now - cacheUpdatedAt > CACHE_TTL_MS) {
        // Stale — trigger background refresh (don't await; serve cached data)
        triggerBackgroundRefresh();
    }

    return cachedAccounts;
}

/**
 * Ensures the account has a fresh access token, de-duplicating concurrent refresh calls.
 * If two requests for the same account trigger a refresh simultaneously,
 * only one HTTP call is made and both receive the result.
 */
export async function ensureFreshToken(account: Account): Promise<string> {
    const tokenExpireTime =
        account.expiresAt instanceof Date
            ? account.expiresAt.getTime()
            : (account.expiresAt as number);

    const tokenValid = Date.now() < tokenExpireTime - 5 * 60 * 1000;
    if (tokenValid) return account.accessToken;

    // Check if a refresh is already in-flight for this account
    const existing = tokenRefreshInFlight.get(account.email);
    if (existing) {
        return existing;
    }

    const db = getDatabase();
    const refreshPromise = (async () => {
        console.log(`🔄 Refreshing token for ${account.email}...`);
        try {
            const newTokens = await refreshAccessToken(account.refreshToken);
            await db.updateAccount(account.email, {
                accessToken: newTokens.accessToken,
                refreshToken: newTokens.refreshToken,
                expiresAt: newTokens.expiresAt,
            });
            // Update the cached entry to reflect the new token
            const cached = cachedAccounts.find(a => a.email === account.email);
            if (cached) {
                cached.accessToken = newTokens.accessToken;
                cached.refreshToken = newTokens.refreshToken;
                cached.expiresAt = newTokens.expiresAt;
            }
            return newTokens.accessToken;
        } finally {
            tokenRefreshInFlight.delete(account.email);
        }
    })();

    tokenRefreshInFlight.set(account.email, refreshPromise);
    return refreshPromise;
}

/**
 * Forcibly invalidates the in-memory cache so that the next call to
 * `getReadyAccounts()` picks up fresh data from the database.
 * Call this after adding, removing, or reactivating accounts.
 */
export function invalidateAccountCache(): void {
    cacheUpdatedAt = 0;
    cachedAccounts = [];
    cacheRefreshPromise = null;
}

/**
 * Warms the cache at server startup so the first real request isn't delayed.
 */
export async function warmAccountCache(): Promise<void> {
    await refreshCache();
    console.log(`✅ Account cache warmed: ${cachedAccounts.length} active account(s).`);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function refreshCache(): Promise<void> {
    if (cacheRefreshPromise) return cacheRefreshPromise;

    cacheRefreshPromise = (async () => {
        try {
            const db = getDatabase();
            const accounts = await db.getActiveAccounts();
            cachedAccounts = accounts;
            cacheUpdatedAt = Date.now();
        } catch (err) {
            console.error('❌ Account cache refresh failed:', err);
            // Keep stale cache rather than clearing it — better to retry with
            // potentially stale data than to fail all requests.
        } finally {
            cacheRefreshPromise = null;
        }
    })();

    return cacheRefreshPromise;
}

function triggerBackgroundRefresh(): void {
    if (cacheRefreshPromise) return; // Already refreshing
    refreshCache().catch(err => console.error('Account cache background refresh error:', err));
}
