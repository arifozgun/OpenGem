import type { Account } from './database';
import type { ErrorCategory } from './error-classifier';
import type { AccountAffinityContext } from './account-affinity';
import {
    orderAccountsForAffinity,
    reserveAffinityAccount,
} from './account-affinity';
import {
    getAccountCooldownInfo,
    getSoonestCooldownExpiry,
    isAccountInCooldown,
    recordProbe,
    shouldProbeAccount,
} from './account-cooldown';
import { accountRateLimiter, RateLimitPolicy, RateLimitResult } from './rate-limiter';

type RequestMode = 'non-stream' | 'stream';

interface RuntimeState {
    inFlight: number;
    successStreak: number;
    failureStreak: number;
    rateLimitPenalty: number;
    ewmaLatencyMs?: number;
    lastSelectedAt?: number;
    lastSuccessAt?: number;
    lastFailureAt?: number;
    lastRateLimitAt?: number;
}

export interface AccountCandidate {
    account: Account;
    mode: RequestMode;
    score: number;
    reason: string;
    shouldProbe: boolean;
    affinityPreferred: boolean;
    rateLimit: RateLimitResult;
    policy: RateLimitPolicy;
}

export interface AccountPlan {
    candidates: AccountCandidate[];
    skipped: Array<{ email: string; reason: string; retryAfterMs?: number }>;
    hasActiveAccounts: boolean;
    nextRetryAfterMs?: number;
}

export interface AccountAttemptLease {
    account: Account;
    candidate: AccountCandidate;
    startedAt: number;
    released: boolean;
}

const runtimeState = new Map<string, RuntimeState>();

const DEFAULT_FREE_RPM = 45;
const DEFAULT_PRO_RPM = 75;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_PRO_MAX_IN_FLIGHT = 3;
const DEFAULT_MIN_GLOBAL_CONCURRENCY = 3;
const DEFAULT_MAX_GLOBAL_CONCURRENCY = 24;
const PENALTY_HALF_LIFE_MS = 2 * 60 * 1000;
const FAILURE_DECAY_MS = 60 * 1000;

export function planAccountAttempts(
    accounts: Account[],
    options: { affinity?: AccountAffinityContext; mode: RequestMode },
): AccountPlan {
    const now = Date.now();
    if (accounts.length === 0) {
        return { candidates: [], skipped: [], hasActiveAccounts: false };
    }

    const ordered = orderAccountsForAffinity(accounts, options.affinity);
    const affinityEmail = options.affinity?.boundEmail;
    const candidates: AccountCandidate[] = [];
    const skipped: AccountPlan['skipped'] = [];

    ordered.forEach((account, index) => {
        const state = getRuntimeState(account.email);
        decayRuntimeState(state, now);

        const cooldown = getAccountCooldownInfo(account.email);
        const inCooldown = isAccountInCooldown(account.email);
        const probe = inCooldown && shouldProbeAccount(account.email);
        if (inCooldown && !probe) {
            skipped.push({
                email: account.email,
                reason: `cooldown:${cooldown?.reason || 'unknown'}`,
                retryAfterMs: cooldown ? Math.max(0, cooldown.cooldownUntil - now) : undefined,
            });
            return;
        }

        const maxInFlight = getMaxInFlight(account, options.mode);
        if (state.inFlight >= maxInFlight) {
            skipped.push({ email: account.email, reason: 'local_concurrency', retryAfterMs: 250 });
            return;
        }

        const policy = getAccountRatePolicy(account);
        const rateLimit = accountRateLimiter.peek(account.email, policy);
        if (!rateLimit.allowed) {
            skipped.push({ email: account.email, reason: 'local_rate_limit', retryAfterMs: rateLimit.retryAfterMs });
            return;
        }

        const affinityPreferred = Boolean(affinityEmail && affinityEmail === account.email);
        const reason: string[] = [];
        const score = scoreAccount({
            account,
            state,
            rateLimit,
            now,
            index,
            shouldProbe: probe,
            affinityPreferred,
            mode: options.mode,
            reason,
        });

        candidates.push({
            account,
            mode: options.mode,
            score,
            reason: reason.join(', '),
            shouldProbe: probe,
            affinityPreferred,
            rateLimit,
            policy,
        });
    });

    candidates.sort((a, b) => b.score - a.score);

    const retryHints = skipped
        .map(item => item.retryAfterMs)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const soonestCooldown = getSoonestCooldownExpiry();
    if (soonestCooldown) retryHints.push(Math.max(0, soonestCooldown - now));

    return {
        candidates,
        skipped,
        hasActiveAccounts: true,
        ...(retryHints.length > 0 && { nextRetryAfterMs: Math.min(...retryHints) }),
    };
}

export function beginAccountAttempt(
    candidate: AccountCandidate,
    affinity?: AccountAffinityContext,
): AccountAttemptLease | undefined {
    const state = getRuntimeState(candidate.account.email);
    const maxInFlight = getMaxInFlight(candidate.account, candidate.mode);
    if (state.inFlight >= maxInFlight) return undefined;

    const rate = accountRateLimiter.consume(candidate.account.email, candidate.policy);
    if (!rate.allowed) return undefined;

    if (candidate.shouldProbe) recordProbe(candidate.account.email);
    reserveAffinityAccount(affinity, candidate.account.email);
    if (affinity) affinity.hit = candidate.affinityPreferred;

    state.inFlight += 1;
    state.lastSelectedAt = Date.now();

    return {
        account: candidate.account,
        candidate,
        startedAt: Date.now(),
        released: false,
    };
}

export function releaseAccountAttempt(
    lease: AccountAttemptLease,
    outcome: { success: boolean; category?: ErrorCategory },
): void {
    if (lease.released) return;
    lease.released = true;

    const now = Date.now();
    const state = getRuntimeState(lease.account.email);
    state.inFlight = Math.max(0, state.inFlight - 1);

    const latencyMs = Math.max(0, now - lease.startedAt);
    state.ewmaLatencyMs = state.ewmaLatencyMs === undefined
        ? latencyMs
        : Math.round(state.ewmaLatencyMs * 0.75 + latencyMs * 0.25);

    if (outcome.success) {
        state.successStreak += 1;
        state.failureStreak = 0;
        state.rateLimitPenalty = Math.max(0, state.rateLimitPenalty * 0.65 - 0.03);
        state.lastSuccessAt = now;
        return;
    }

    state.failureStreak += 1;
    state.successStreak = 0;
    state.lastFailureAt = now;

    if (outcome.category === 'rate_limit' || outcome.category === 'overloaded') {
        state.rateLimitPenalty = Math.min(0.8, state.rateLimitPenalty + 0.18);
        state.lastRateLimitAt = now;
    } else if (outcome.category === 'quota') {
        state.rateLimitPenalty = Math.min(0.9, state.rateLimitPenalty + 0.28);
        state.lastRateLimitAt = now;
    } else if (outcome.category === 'auth' || outcome.category === 'billing') {
        state.rateLimitPenalty = 0.95;
    } else if (outcome.category === 'timeout') {
        state.rateLimitPenalty = Math.min(0.6, state.rateLimitPenalty + 0.08);
    }
}

export function getRecommendedGlobalConcurrency(accounts: Account[], mode: RequestMode = 'non-stream'): number {
    const min = readPositiveInt('OPENGEM_MIN_GLOBAL_CONCURRENCY', DEFAULT_MIN_GLOBAL_CONCURRENCY, 1, 100);
    const max = readPositiveInt('OPENGEM_MAX_GLOBAL_CONCURRENCY', DEFAULT_MAX_GLOBAL_CONCURRENCY, min, 200);
    const total = accounts.reduce((sum, account) => sum + getMaxInFlight(account, mode), 0);
    return clamp(total || min, min, max);
}

function scoreAccount(params: {
    account: Account;
    state: RuntimeState;
    rateLimit: RateLimitResult;
    now: number;
    index: number;
    shouldProbe: boolean;
    affinityPreferred: boolean;
    mode: RequestMode;
    reason: string[];
}): number {
    const { account, state, rateLimit, now, index, shouldProbe, affinityPreferred, mode, reason } = params;
    const ageMs = Math.max(0, now - dateLikeToMs(account.lastUsedAt));
    const ageScore = Math.min(28, ageMs / (60 * 60 * 1000));
    const remainingRatio = rateLimit.limit > 0 ? rateLimit.remaining / rateLimit.limit : 0;
    const latencyPenalty = state.ewmaLatencyMs ? Math.min(16, state.ewmaLatencyMs / 1500) : 0;
    const selectedRecentlyMs = state.lastSelectedAt ? now - state.lastSelectedAt : Number.POSITIVE_INFINITY;
    const recentSelectionPenalty = selectedRecentlyMs < 2000 ? (2000 - selectedRecentlyMs) / 80 : 0;

    let score = 100;
    score += ageScore;
    score += remainingRatio * 34;
    score += account.isPro ? 8 : 0;
    score += affinityPreferred ? 55 : 0;
    score += Math.min(10, state.successStreak * 2);
    score -= state.inFlight * (mode === 'stream' ? 28 : 22);
    score -= state.failureStreak * 16;
    score -= state.rateLimitPenalty * 75;
    score -= latencyPenalty;
    score -= recentSelectionPenalty;
    score -= shouldProbe ? 12 : 0;
    score -= index * 0.01;

    if (affinityPreferred) reason.push('affinity');
    if (account.isPro) reason.push('pro');
    if (state.inFlight > 0) reason.push(`in_flight:${state.inFlight}`);
    if (state.failureStreak > 0) reason.push(`failures:${state.failureStreak}`);
    if (state.rateLimitPenalty > 0.05) reason.push(`adaptive_penalty:${state.rateLimitPenalty.toFixed(2)}`);
    if (shouldProbe) reason.push('probe');
    reason.push(`remaining:${rateLimit.remaining}/${rateLimit.limit}`);

    return score;
}

function getAccountRatePolicy(account: Account): RateLimitPolicy {
    const baseLimit = account.isPro
        ? readPositiveInt('OPENGEM_PRO_ACCOUNT_RATE_LIMIT_PER_MINUTE', DEFAULT_PRO_RPM, 1, 600)
        : readPositiveInt('OPENGEM_ACCOUNT_RATE_LIMIT_PER_MINUTE', DEFAULT_FREE_RPM, 1, 600);
    const state = getRuntimeState(account.email);
    const adjustedLimit = Math.max(1, Math.floor(baseLimit * (1 - Math.min(0.85, state.rateLimitPenalty))));
    return {
        maxRequests: adjustedLimit,
        windowMs: readPositiveInt('OPENGEM_ACCOUNT_RATE_WINDOW_MS', DEFAULT_RATE_WINDOW_MS, 1000, 10 * 60 * 1000),
    };
}

function getMaxInFlight(account: Account, mode: RequestMode = 'non-stream'): number {
    const base = account.isPro
        ? readPositiveInt('OPENGEM_PRO_ACCOUNT_MAX_IN_FLIGHT', DEFAULT_PRO_MAX_IN_FLIGHT, 1, 20)
        : readPositiveInt('OPENGEM_ACCOUNT_MAX_IN_FLIGHT', DEFAULT_MAX_IN_FLIGHT, 1, 20);
    if (mode === 'stream') {
        return Math.max(1, Math.min(base, readPositiveInt('OPENGEM_STREAM_ACCOUNT_MAX_IN_FLIGHT', base, 1, 20)));
    }
    return base;
}

function getRuntimeState(email: string): RuntimeState {
    let state = runtimeState.get(email);
    if (!state) {
        state = {
            inFlight: 0,
            successStreak: 0,
            failureStreak: 0,
            rateLimitPenalty: 0,
        };
        runtimeState.set(email, state);
    }
    return state;
}

function decayRuntimeState(state: RuntimeState, now: number): void {
    if (state.lastFailureAt && now - state.lastFailureAt > FAILURE_DECAY_MS) {
        const steps = Math.floor((now - state.lastFailureAt) / FAILURE_DECAY_MS);
        state.failureStreak = Math.max(0, state.failureStreak - steps);
        state.lastFailureAt = now;
    }

    if (state.lastRateLimitAt && state.rateLimitPenalty > 0) {
        const elapsed = now - state.lastRateLimitAt;
        if (elapsed > PENALTY_HALF_LIFE_MS) {
            const halvings = elapsed / PENALTY_HALF_LIFE_MS;
            state.rateLimitPenalty = Math.max(0, state.rateLimitPenalty * 0.5 ** halvings);
            state.lastRateLimitAt = now;
        }
    }
}

function dateLikeToMs(value: Date | number | undefined): number {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
}

function readPositiveInt(name: string, fallback: number, min: number, max: number): number {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(Math.floor(parsed), min, max);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
