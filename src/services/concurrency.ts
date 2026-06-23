/**
 * Request concurrency limiter.
 * Adapted from openclaw's run-with-concurrency.ts
 * 
 * Limits the number of concurrent API requests to prevent
 * overwhelming the Gemini API endpoint from a single IP.
 */

import { getReadyAccounts } from './account-manager';
import { getRecommendedGlobalConcurrency } from './account-balancer';

export async function runWithConcurrencyLimit<T>(params: {
    tasks: Array<() => Promise<T>>;
    limit: number;
    onTaskError?: (error: unknown, index: number) => void;
}): Promise<{ results: T[]; firstError: unknown; hasError: boolean }> {
    const { tasks, limit, onTaskError } = params;
    if (tasks.length === 0) {
        return { results: [], firstError: undefined, hasError: false };
    }

    const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
    const results: T[] = Array.from({ length: tasks.length });
    let next = 0;
    let firstError: unknown = undefined;
    let hasError = false;

    const workers = Array.from({ length: resolvedLimit }, async () => {
        while (true) {
            const index = next;
            next += 1;
            if (index >= tasks.length) {
                return;
            }
            try {
                results[index] = await tasks[index]();
            } catch (error) {
                if (!hasError) {
                    firstError = error;
                    hasError = true;
                }
                onTaskError?.(error, index);
            }
        }
    });

    await Promise.allSettled(workers);
    return { results, firstError, hasError };
}

/**
 * Global request semaphore to limit concurrent Gemini API calls.
 * Prevents thundering herd by ensuring at most N requests are
 * in-flight from this process at any time.
 */
export class RequestSemaphore {
    private active = 0;
    private queue: Array<() => void> = [];

    constructor(private maxConcurrent: number) { }

    setMaxConcurrent(limit: number) {
        this.maxConcurrent = limit;
        this.flushQueue();
    }

    private flushQueue() {
        while (this.active < this.maxConcurrent && this.queue.length > 0) {
            this.active++;
            const next = this.queue.shift();
            if (next) next();
        }
    }

    async acquire(): Promise<void> {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return;
        }

        return new Promise<void>(resolve => {
            this.queue.push(() => {
                // this.active is already incremented in flushQueue or release before calling resolve()
                resolve();
            });
        });
    }

    release(): void {
        this.active--;
        this.flushQueue();
    }

    /**
     * Execute a function with the semaphore.
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    get activeCount(): number {
        return this.active;
    }

    get queueLength(): number {
        return this.queue.length;
    }
}

// Global semaphore: max 3 concurrent Gemini API requests per process (default).
// Will be dynamically updated based on active account count to support parallel tools.
export const geminiRequestSemaphore = new RequestSemaphore(3);
// Separate semaphore for streaming requests to prevent IP ban from too many concurrent streams
export const geminiStreamSemaphore = new RequestSemaphore(3);

export async function updateConcurrencyLimits() {
    try {
        const accounts = await getReadyAccounts();
        const limit = getRecommendedGlobalConcurrency(accounts);
        
        geminiRequestSemaphore.setMaxConcurrent(limit);
        geminiStreamSemaphore.setMaxConcurrent(limit);
        
        // console.log(`[Concurrency] Limits updated to ${limit} (based on ${activeCount} accounts)`);
    } catch (e) {
        // console.error('[Concurrency] Failed to update limits', e);
    }
}
