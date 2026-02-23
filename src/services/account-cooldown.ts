/**
 * Account cooldown system with probe recovery.
 * Adapted from openclaw's auth-profiles/usage.ts and model-fallback.ts
 * 
 * Tracks per-account cooldown state with:
 * - Rate limit cooldown (short, auto-expires)
 * - Quota exhaustion cooldown (long, probed for recovery)
 * - Probe recovery: periodically tests exhausted accounts to detect recovery
 */

import { ErrorCategory } from './error-classifier';

export interface AccountCooldownState {
    cooldownUntil: number;    // epoch ms when cooldown expires
    reason: ErrorCategory;
    failureCount: number;
    lastProbeAt?: number;     // last time we probed this account
}

const MIN_PROBE_INTERVAL_MS = 30_000;  // 30 seconds between probes (from openclaw)
const RATE_LIMIT_COOLDOWN_MS = 15_000; // 15 seconds for rate limits
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes for quota exhaustion
const PROBE_MARGIN_MS = 2 * 60 * 1000;    // Start probing 2 min before cooldown expires

// In-memory cooldown state per account email
const cooldownState = new Map<string, AccountCooldownState>();

/**
 * Calculate cooldown duration based on error category and failure count.
 * Uses escalating cooldowns from openclaw's calculateAuthProfileCooldownMs.
 */
export function calculateCooldownMs(category: ErrorCategory, failureCount: number): number {
    switch (category) {
        case 'rate_limit':
        case 'overloaded':
            // Escalating: 15s → 30s → 60s → 120s
            return Math.min(RATE_LIMIT_COOLDOWN_MS * 2 ** Math.max(0, failureCount - 1), 2 * 60 * 1000);
        case 'quota':
            return QUOTA_COOLDOWN_MS;
        case 'auth':
        case 'billing':
            // Don't auto-recover from auth/billing — these need manual intervention
            return Number.MAX_SAFE_INTEGER;
        case 'timeout':
            // Short cooldown for timeouts
            return 5_000;
        default:
            return RATE_LIMIT_COOLDOWN_MS;
    }
}

/**
 * Mark an account as in cooldown.
 */
export function markAccountCooldown(email: string, category: ErrorCategory): void {
    const existing = cooldownState.get(email);
    const failureCount = (existing?.failureCount ?? 0) + 1;
    const cooldownMs = calculateCooldownMs(category, failureCount);

    cooldownState.set(email, {
        cooldownUntil: Date.now() + cooldownMs,
        reason: category,
        failureCount,
        lastProbeAt: existing?.lastProbeAt,
    });

    console.log(`🔒 Account ${email} in cooldown (${category}) for ${Math.round(cooldownMs / 1000)}s [failure #${failureCount}]`);
}

/**
 * Check if an account is currently in cooldown.
 */
export function isAccountInCooldown(email: string): boolean {
    const state = cooldownState.get(email);
    if (!state) return false;
    if (Date.now() >= state.cooldownUntil) {
        // Cooldown expired, clear it
        clearAccountCooldown(email);
        return false;
    }
    return true;
}

/**
 * Check if we should probe an account that's in cooldown.
 * Adapted from openclaw's shouldProbePrimaryDuringCooldown.
 * Returns true if enough time has passed since last probe and cooldown is near expiry.
 */
export function shouldProbeAccount(email: string): boolean {
    const state = cooldownState.get(email);
    if (!state) return false;

    const now = Date.now();

    // Don't probe auth/billing errors — they need manual fix
    if (state.reason === 'auth' || state.reason === 'billing') return false;

    // Check if we've waited long enough since last probe
    const lastProbe = state.lastProbeAt ?? 0;
    if (now - lastProbe < MIN_PROBE_INTERVAL_MS) return false;

    // Probe when cooldown is near expiry or already expired
    if (now >= state.cooldownUntil - PROBE_MARGIN_MS) return true;

    // For rate limits, always probe after MIN_PROBE_INTERVAL
    if (state.reason === 'rate_limit' || state.reason === 'overloaded') return true;

    return false;
}

/**
 * Record a probe attempt for an account.
 */
export function recordProbe(email: string): void {
    const state = cooldownState.get(email);
    if (state) {
        state.lastProbeAt = Date.now();
    }
}

/**
 * Clear cooldown for an account (e.g., after successful probe or manual reset).
 */
export function clearAccountCooldown(email: string): void {
    const state = cooldownState.get(email);
    if (state) {
        console.log(`🔓 Account ${email} cooldown cleared (was: ${state.reason}, failures: ${state.failureCount})`);
    }
    cooldownState.delete(email);
}

/**
 * Mark an account as successfully used — clears cooldown and resets failure count.
 */
export function markAccountSuccess(email: string): void {
    if (cooldownState.has(email)) {
        clearAccountCooldown(email);
    }
}

/**
 * Get the soonest cooldown expiry across all accounts.
 * Useful for determining when to retry.
 */
export function getSoonestCooldownExpiry(): number | null {
    let soonest: number | null = null;
    const now = Date.now();

    for (const [, state] of cooldownState) {
        if (state.cooldownUntil <= now) continue; // expired
        if (soonest === null || state.cooldownUntil < soonest) {
            soonest = state.cooldownUntil;
        }
    }

    return soonest;
}

/**
 * Get cooldown info for an account (for logging/diagnostics).
 */
export function getAccountCooldownInfo(email: string): AccountCooldownState | undefined {
    return cooldownState.get(email);
}

/**
 * Clear all expired cooldowns. Called periodically.
 */
export function clearExpiredCooldowns(): number {
    let cleared = 0;
    const now = Date.now();

    for (const [email, state] of cooldownState) {
        if (now >= state.cooldownUntil) {
            cooldownState.delete(email);
            cleared++;
        }
    }

    return cleared;
}

/**
 * Get all accounts currently in cooldown (for diagnostics).
 */
export function getCooldownDiagnostics(): Array<{ email: string; state: AccountCooldownState }> {
    return Array.from(cooldownState.entries()).map(([email, state]) => ({ email, state }));
}
