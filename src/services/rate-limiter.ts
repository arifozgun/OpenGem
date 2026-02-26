/**
 * Client-side fixed-window rate limiter.
 * Prevents sending too many requests to per account within a time window.
 * Adapted from openclaw's fixed-window-rate-limit.ts.
 */

export interface RateLimitResult {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
}

export interface RateLimiter {
    consume(key: string): RateLimitResult;
    reset(key: string): void;
    resetAll(): void;
}

export function createRateLimiter(params: {
    maxRequests: number;
    windowMs: number;
}): RateLimiter {
    const maxRequests = Math.max(1, Math.floor(params.maxRequests));
    const windowMs = Math.max(1, Math.floor(params.windowMs));

    const buckets = new Map<string, { count: number; windowStartMs: number }>();

    return {
        consume(key: string): RateLimitResult {
            const now = Date.now();
            let bucket = buckets.get(key);

            if (!bucket || now - bucket.windowStartMs >= windowMs) {
                bucket = { count: 0, windowStartMs: now };
                buckets.set(key, bucket);
            }

            if (bucket.count >= maxRequests) {
                return {
                    allowed: false,
                    retryAfterMs: Math.max(0, bucket.windowStartMs + windowMs - now),
                    remaining: 0,
                };
            }

            bucket.count += 1;
            return {
                allowed: true,
                retryAfterMs: 0,
                remaining: Math.max(0, maxRequests - bucket.count),
            };
        },

        reset(key: string): void {
            buckets.delete(key);
        },

        resetAll(): void {
            buckets.clear();
        },
    };
}

// Per-account rate limiter: 60 requests per 60 seconds per account.
// The previous 10 req/min limit was too conservative for a server-side proxy
// and caused unnecessary local throttling before the API even had a chance to respond.
export const accountRateLimiter = createRateLimiter({
    maxRequests: 60,
    windowMs: 60_000,
});
