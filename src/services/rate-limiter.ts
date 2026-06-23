/**
 * Client-side fixed-window rate limiter.
 * Prevents sending too many requests to per account within a time window.
 * Adapted from openclaw's fixed-window-rate-limit.ts.
 */

export interface RateLimitResult {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
    limit: number;
    resetAt: number;
}

export interface RateLimitPolicy {
    maxRequests?: number;
    windowMs?: number;
}

export interface RateLimiter {
    consume(key: string, policy?: RateLimitPolicy): RateLimitResult;
    peek(key: string, policy?: RateLimitPolicy): RateLimitResult;
    reset(key: string): void;
    resetAll(): void;
}

export function createRateLimiter(params: {
    maxRequests: number;
    windowMs: number;
}): RateLimiter {
    const maxRequests = Math.max(1, Math.floor(params.maxRequests));
    const windowMs = Math.max(1, Math.floor(params.windowMs));

    const buckets = new Map<string, { count: number; windowStartMs: number; maxRequests: number; windowMs: number }>();

    const resolvePolicy = (policy?: RateLimitPolicy) => ({
        maxRequests: Math.max(1, Math.floor(policy?.maxRequests ?? maxRequests)),
        windowMs: Math.max(1, Math.floor(policy?.windowMs ?? windowMs)),
    });

    const getBucket = (key: string, policy?: RateLimitPolicy) => {
        const now = Date.now();
        const resolved = resolvePolicy(policy);
        let bucket = buckets.get(key);

        if (!bucket || bucket.windowMs !== resolved.windowMs || now - bucket.windowStartMs >= resolved.windowMs) {
            bucket = {
                count: 0,
                windowStartMs: now,
                maxRequests: resolved.maxRequests,
                windowMs: resolved.windowMs,
            };
            buckets.set(key, bucket);
        } else {
            bucket.maxRequests = resolved.maxRequests;
            bucket.windowMs = resolved.windowMs;
        }

        return { bucket, now };
    };

    const evaluate = (bucket: { count: number; windowStartMs: number; maxRequests: number; windowMs: number }, now: number): RateLimitResult => {
        const resetAt = bucket.windowStartMs + bucket.windowMs;
        if (bucket.count >= bucket.maxRequests) {
            return {
                allowed: false,
                retryAfterMs: Math.max(0, resetAt - now),
                remaining: 0,
                limit: bucket.maxRequests,
                resetAt,
            };
        }

        return {
            allowed: true,
            retryAfterMs: 0,
            remaining: Math.max(0, bucket.maxRequests - bucket.count),
            limit: bucket.maxRequests,
            resetAt,
        };
    };

    return {
        consume(key: string, policy?: RateLimitPolicy): RateLimitResult {
            const { bucket, now } = getBucket(key, policy);
            const current = evaluate(bucket, now);
            if (!current.allowed) return current;
            bucket.count += 1;
            const updated = evaluate(bucket, now);
            return {
                allowed: true,
                retryAfterMs: 0,
                remaining: updated.remaining,
                limit: bucket.maxRequests,
                resetAt: bucket.windowStartMs + bucket.windowMs,
            };
        },

        peek(key: string, policy?: RateLimitPolicy): RateLimitResult {
            const { bucket, now } = getBucket(key, policy);
            return evaluate(bucket, now);
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
