// Re-export shared types from firebase.ts (the type definitions live there for backward compat)
export type { Account, ApiKey, RequestLog } from './firebase';

export interface StatsResult {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalTokensUsed: number;
    activeAccounts: number;
    totalAccounts: number;
    accountStats: Array<{
        email: string;
        totalRequests: number;
        successfulRequests: number;
        failedRequests: number;
        totalTokensUsed: number;
        isActive: boolean;
    }>;
}

export interface DatabaseService {
    getActiveAccounts(): Promise<import('./firebase').Account[]>;
    getAllAccounts(): Promise<import('./firebase').Account[]>;
    upsertAccount(account: import('./firebase').Account): Promise<void>;
    updateAccount(email: string, data: Partial<import('./firebase').Account>): Promise<void>;
    incrementAccountStats(email: string, stats: { successful: number; failed: number; tokens: number }): Promise<void>;
    reactivateExhaustedAccounts(cooldownMs: number): Promise<number>;
    reactivateAccount(email: string): Promise<void>;
    deleteAccount(idOrEmail: string): Promise<void>;
    createApiKey(name: string, key: string): Promise<import('./firebase').ApiKey>;
    getAllApiKeys(): Promise<import('./firebase').ApiKey[]>;
    validateApiKey(key: string): Promise<boolean>;
    deleteApiKey(id: string): Promise<void>;
    addRequestLog(log: Omit<import('./firebase').RequestLog, 'id'>): Promise<void>;
    getRecentLogs(limitCount?: number): Promise<import('./firebase').RequestLog[]>;
    getStats(): Promise<StatsResult>;
}

export function createDb(): DatabaseService {
    const provider = process.env.DB_PROVIDER ?? 'firebase';
    if (provider === 'sqlite') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('./sqlite').sqliteDb as DatabaseService;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./firebase').default as DatabaseService;
}

// Lazy proxy: defers backend selection until first use so that dotenv.config()
// in index.ts has a chance to run before DB_PROVIDER is read.
let _instance: DatabaseService | null = null;
export const db: DatabaseService = new Proxy({} as DatabaseService, {
    get(_target, prop: string) {
        if (!_instance) _instance = createDb();
        return (_instance as unknown as Record<string, unknown>)[prop];
    },
});
