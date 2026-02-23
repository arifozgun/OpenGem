/**
 * IDatabase — abstract interface for all database backends.
 * Both Firebase Firestore and the local JSON file backend implement this.
 */

export interface RequestLog {
    id?: string;
    accountEmail: string;
    question: string;
    answer: string;
    systemInstruction?: string;
    tokensUsed: number;
    success: boolean;
    timestamp: Date | number;
}

export interface Account {
    id: string;
    email: string;
    accessToken: string;
    refreshToken: string;
    projectId: string;
    expiresAt: Date | number;
    isActive: boolean;
    lastUsedAt: Date | number;
    isPro?: boolean;
    tierName?: string;
    exhaustedAt?: Date | number;
    createdAt?: Date | number;
    updatedAt?: Date | number;
    totalRequests?: number;
    successfulRequests?: number;
    failedRequests?: number;
    totalTokensUsed?: number;
}

export interface ApiKey {
    id?: string;
    name: string;
    key: string;
    createdAt: Date | number;
    lastUsedAt?: Date | number;
    totalRequests?: number;
}

export interface DbStats {
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
        isPro?: boolean;
    }>;
}

export interface IDatabase {
    getActiveAccounts(): Promise<Account[]>;
    getAllAccounts(): Promise<Account[]>;
    upsertAccount(account: Account): Promise<void>;
    updateAccount(email: string, data: Partial<Account>): Promise<void>;
    incrementAccountStats(email: string, stats: { successful: number; failed: number; tokens: number }): Promise<void>;
    reactivateExhaustedAccounts(cooldownMs: number): Promise<number>;
    reactivateAccount(email: string): Promise<void>;
    deleteAccount(idOrEmail: string): Promise<void>;

    createApiKey(name: string, key: string): Promise<ApiKey>;
    getAllApiKeys(): Promise<ApiKey[]>;
    validateApiKey(key: string): Promise<boolean>;
    deleteApiKey(id: string): Promise<void>;

    addRequestLog(log: Omit<RequestLog, 'id'>): Promise<void>;
    getRecentLogs(limit?: number): Promise<RequestLog[]>;

    getStats(): Promise<DbStats>;
}

// ---- Factory -----------------------------------------------------------------

let _cachedDb: IDatabase | null = null;
let _cachedBackend: string | null = null;

/**
 * Returns the active database backend based on config.dbBackend.
 * Lazy-initialised; call invalidateDbCache() after switching backends.
 */
export function getDatabase(): IDatabase {
    // Import here to avoid circular dep at module load time
    const { getConfig, isConfigured } = require('./config');

    if (!isConfigured()) {
        // During setup, return a no-op stub or local db by default
        return getLocalDb();
    }

    const config = getConfig();
    const backend = config.dbBackend || 'firebase';

    if (_cachedDb && _cachedBackend === backend) {
        return _cachedDb;
    }

    if (backend === 'local') {
        _cachedDb = getLocalDb();
    } else {
        _cachedDb = getFirebaseDb();
    }
    _cachedBackend = backend;
    return _cachedDb;
}

/** Call this after switching the database backend in config so the cache is rebuilt. */
export function invalidateDbCache(): void {
    _cachedDb = null;
    _cachedBackend = null;
}

function getLocalDb(): IDatabase {
    const { localDb } = require('./localDb');
    return localDb;
}

function getFirebaseDb(): IDatabase {
    const { firebaseDb } = require('./firebase');
    return firebaseDb;
}
