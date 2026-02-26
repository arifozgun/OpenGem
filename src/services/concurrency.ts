/**
 * Request concurrency limiter.
 * Adapted from openclaw's run-with-concurrency.ts
 * 
 * Limits the number of concurrent API requests to prevent
 * overwhelming the Gemini API endpoint from a single IP.
 */

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
class RequestSemaphore {
    private active = 0;
    private queue: Array<() => void> = [];

    constructor(private readonly maxConcurrent: number) { }

    async acquire(): Promise<void> {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return;
        }

        return new Promise<void>(resolve => {
            this.queue.push(() => {
                this.active++;
                resolve();
            });
        });
    }

    release(): void {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
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

// Global semaphore: max 3 concurrent Gemini API requests per process.
// Prevents IP-level throttling — same server IP used for all accounts,
// so keeping total concurrent outbound requests low is critical.
export const geminiRequestSemaphore = new RequestSemaphore(3);
