/**
 * Comprehensive error classification system.
 * Adapted from openclaw's pi-embedded-helpers/errors.ts
 * 
 * Classifies API errors into actionable categories:
 * - rate_limit: Temporary, retry after backoff
 * - quota: Account exhausted, rotate to next account
 * - auth: Invalid credentials, deactivate account
 * - timeout: Transient, retry immediately
 * - overloaded: Server busy, treat as rate_limit
 * - billing: Payment issue
 * - model_not_found: Wrong model name
 * - format: Invalid request format
 */

export type ErrorCategory =
    | 'rate_limit'
    | 'quota'
    | 'auth'
    | 'timeout'
    | 'overloaded'
    | 'billing'
    | 'model_not_found'
    | 'format'
    | 'unknown';

type ErrorPattern = RegExp | string;

// Comprehensive error patterns from openclaw
const ERROR_PATTERNS = {
    rateLimit: [
        /rate[_ ]limit|too many requests|429/i,
        'exceeded your current quota',
        'usage limit',
    ] as ErrorPattern[],

    quota: [
        'resource has been exhausted',
        'resource_exhausted',
        'quota exceeded',
        'quota_exceeded',
        'insufficient_quota',
    ] as ErrorPattern[],

    overloaded: [
        /overloaded_error|"type"\s*:\s*"overloaded_error"/i,
        'overloaded',
        'service unavailable',
        'high demand',
    ] as ErrorPattern[],

    timeout: [
        'timeout',
        'timed out',
        'deadline exceeded',
        'context deadline exceeded',
        /without sending (?:any )?chunks?/i,
        /\bstop reason:\s*abort\b/i,
    ] as ErrorPattern[],

    billing: [
        /[\"']?(?:status|code)[\"']?\s*[:=]\s*402\b|\bhttp\s*402\b/i,
        'payment required',
        'insufficient credits',
        'credit balance',
        'insufficient balance',
    ] as ErrorPattern[],

    auth: [
        /invalid[_ ]?api[_ ]?key/i,
        'incorrect api key',
        'invalid token',
        'invalid_grant',
        'token refresh failed',
        'unauthorized',
        'forbidden',
        'access denied',
        'token has expired',
        /\b401\b/,
        /\b403\b/,
        'no credentials found',
        'no api key found',
        'oauth token refresh failed',
        're-authenticate',
    ] as ErrorPattern[],

    modelNotFound: [
        'unknown model',
        'model not found',
        'model_not_found',
        'not_found_error',
        /models\/[^\s]+ is not found/i,
        /\b404\b.*not[-_ ]?found/i,
    ] as ErrorPattern[],

    format: [
        'invalid request format',
        'string should match pattern',
        /tool call id was.*must be/i,
    ] as ErrorPattern[],
} as const;

const TRANSIENT_HTTP_ERROR_CODES = new Set([500, 502, 503, 504, 521, 522, 523, 524, 529]);

function matchesPatterns(text: string, patterns: readonly ErrorPattern[]): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return patterns.some(pattern =>
        pattern instanceof RegExp ? pattern.test(lower) : lower.includes(pattern),
    );
}

/**
 * Extract HTTP status code from error text.
 */
function extractHttpStatus(text: string): number | undefined {
    const match = text.match(/^(\d{3})\s+/);
    if (match) return Number(match[1]);
    return undefined;
}

/**
 * Classify an error message into an actionable category.
 * Uses the same classification chain as openclaw's classifyFailoverReason.
 */
export function classifyError(text: string): ErrorCategory {
    if (!text) return 'unknown';

    const httpStatus = extractHttpStatus(text);

    // Check HTTP status codes first
    if (httpStatus) {
        if (httpStatus === 429) {
            // Sub-classify: is it quota or rate limit?
            if (matchesPatterns(text, ERROR_PATTERNS.quota)) return 'quota';
            return 'rate_limit';
        }
        if (httpStatus === 401 || httpStatus === 403) return 'auth';
        if (httpStatus === 402) return 'billing';
        if (httpStatus === 404) return 'model_not_found';
        if (httpStatus === 408) return 'timeout';
        if (TRANSIENT_HTTP_ERROR_CODES.has(httpStatus)) return 'timeout';
    }

    // Model not found (before rate limit checks)
    if (matchesPatterns(text, ERROR_PATTERNS.modelNotFound)) return 'model_not_found';

    // Quota exhaustion (more specific than general rate limits)
    if (matchesPatterns(text, ERROR_PATTERNS.quota)) return 'quota';

    // Rate limits
    if (matchesPatterns(text, ERROR_PATTERNS.rateLimit)) return 'rate_limit';

    // Overloaded (treat as rate_limit for retry purposes)
    if (matchesPatterns(text, ERROR_PATTERNS.overloaded)) return 'overloaded';

    // Auth errors
    if (matchesPatterns(text, ERROR_PATTERNS.auth)) return 'auth';

    // Format errors
    if (matchesPatterns(text, ERROR_PATTERNS.format)) return 'format';

    // Billing errors
    if (matchesPatterns(text, ERROR_PATTERNS.billing)) return 'billing';

    // Timeout errors
    if (matchesPatterns(text, ERROR_PATTERNS.timeout)) return 'timeout';

    return 'unknown';
}

/**
 * Determine retry strategy based on error category.
 */
export function getRetryStrategy(category: ErrorCategory): {
    shouldRetry: boolean;
    shouldRotateAccount: boolean;
    shouldDeactivateAccount: boolean;
    shouldTryFallbackModel: boolean;
} {
    switch (category) {
        case 'rate_limit':
        case 'overloaded':
            return {
                shouldRetry: true,
                shouldRotateAccount: true,
                shouldDeactivateAccount: false,
                shouldTryFallbackModel: true,
            };
        case 'quota':
            return {
                shouldRetry: true,
                shouldRotateAccount: true,
                shouldDeactivateAccount: true,
                shouldTryFallbackModel: true,
            };
        case 'auth':
            return {
                shouldRetry: true,
                shouldRotateAccount: true,
                shouldDeactivateAccount: true,
                shouldTryFallbackModel: false,
            };
        case 'timeout':
            return {
                shouldRetry: true,
                shouldRotateAccount: false,
                shouldDeactivateAccount: false,
                shouldTryFallbackModel: false,
            };
        case 'billing':
            return {
                shouldRetry: true,
                shouldRotateAccount: true,
                shouldDeactivateAccount: true,
                shouldTryFallbackModel: false,
            };
        case 'model_not_found':
            return {
                shouldRetry: false,
                shouldRotateAccount: false,
                shouldDeactivateAccount: false,
                shouldTryFallbackModel: true,
            };
        case 'format':
            return {
                shouldRetry: false,
                shouldRotateAccount: false,
                shouldDeactivateAccount: false,
                shouldTryFallbackModel: false,
            };
        default:
            return {
                shouldRetry: true,
                shouldRotateAccount: true,
                shouldDeactivateAccount: false,
                shouldTryFallbackModel: false,
            };
    }
}

/**
 * Check if an error message indicates a rate limit or quota issue.
 * Convenience function matching openclaw's isApiKeyRateLimitError.
 */
export function isRateLimitOrQuotaError(text: string): boolean {
    const category = classifyError(text);
    return category === 'rate_limit' || category === 'quota' || category === 'overloaded';
}

/**
 * Check if an error indicates the account should be deactivated.
 */
export function shouldDeactivateOnError(text: string): boolean {
    const category = classifyError(text);
    return getRetryStrategy(category).shouldDeactivateAccount;
}
