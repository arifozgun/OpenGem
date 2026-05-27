import type { Account, RequestLog } from './database';

export interface EffectiveTokenStats {
    totalTokensUsed: number;
    byAccount: Record<string, number>;
}

export function calculateEffectiveTokenStats(logs: RequestLog[]): EffectiveTokenStats {
    const byAccount: Record<string, number> = {};
    const affinityMax = new Map<string, { accountEmail: string; tokens: number }>();

    for (const log of logs) {
        if (!log.accountEmail || log.success === false) continue;

        const accountEmail = log.accountEmail;
        const effective = asFiniteNumber(log.effectiveTokensUsed);
        const raw = asFiniteNumber(log.tokensUsed) ?? 0;

        if (effective !== undefined) {
            byAccount[accountEmail] = (byAccount[accountEmail] || 0) + effective;
            continue;
        }

        if (log.affinityKeyHash) {
            const key = `${accountEmail}:${log.affinityKeyHash}`;
            const existing = affinityMax.get(key);
            if (!existing || raw > existing.tokens) {
                affinityMax.set(key, { accountEmail, tokens: raw });
            }
            continue;
        }

        byAccount[accountEmail] = (byAccount[accountEmail] || 0) + raw;
    }

    for (const { accountEmail, tokens } of affinityMax.values()) {
        byAccount[accountEmail] = (byAccount[accountEmail] || 0) + tokens;
    }

    return {
        totalTokensUsed: Object.values(byAccount).reduce((sum, tokens) => sum + tokens, 0),
        byAccount,
    };
}

export function mergeEffectiveTokenStats(accounts: Account[], logs: RequestLog[]): EffectiveTokenStats {
    const stats = calculateEffectiveTokenStats(logs);
    for (const account of accounts) {
        if (!stats.byAccount[account.email]) stats.byAccount[account.email] = 0;
    }
    return stats;
}

function asFiniteNumber(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}
