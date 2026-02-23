/**
 * Exponential backoff retry utility with jitter support.
 * Inspired by openclaw's retry.ts infrastructure.
 */

export interface RetryConfig {
    attempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitter: number; // 0-1, e.g. 0.1 = ±10% randomness
}

export interface RetryOptions extends RetryConfig {
    label?: string;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
    retryAfterMs?: (err: unknown) => number | undefined;
    onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; err: unknown; label?: string }) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    attempts: 5,
    minDelayMs: 1000,
    maxDelayMs: 60_000,
    jitter: 0.2, // ±20% randomness to prevent thundering herd
};

function applyJitter(delayMs: number, jitter: number): number {
    if (jitter <= 0) return delayMs;
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(delayMs * (1 + offset)));
}

export async function retryAsync<T>(
    fn: () => Promise<T>,
    options: Partial<RetryOptions> = {},
): Promise<T> {
    const config: RetryOptions = { ...DEFAULT_RETRY_CONFIG, ...options };
    const maxAttempts = Math.max(1, config.attempts);
    const shouldRetry = config.shouldRetry ?? (() => true);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
                break;
            }

            // Check if the server told us how long to wait
            const serverRetryAfter = config.retryAfterMs?.(err);
            const hasServerHint = typeof serverRetryAfter === 'number' && Number.isFinite(serverRetryAfter);

            // Exponential backoff: minDelay * 2^(attempt-1)
            const baseDelay = hasServerHint
                ? Math.max(serverRetryAfter, config.minDelayMs)
                : config.minDelayMs * 2 ** (attempt - 1);

            let delay = Math.min(baseDelay, config.maxDelayMs);
            delay = applyJitter(delay, config.jitter);
            delay = Math.max(config.minDelayMs, Math.min(delay, config.maxDelayMs));

            config.onRetry?.({
                attempt,
                maxAttempts,
                delayMs: delay,
                err,
                label: config.label,
            });

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastErr ?? new Error('Retry failed');
}
