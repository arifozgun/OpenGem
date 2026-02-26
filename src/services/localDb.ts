/**
 * Local JSON-file based database backend — write-through in-memory cache.
 *
 * Data is stored in <project_root>/data/db.json.
 * All token values are AES-256-GCM encrypted with the same key used by config.ts.
 * API keys are stored as SHA-256 hashes.
 *
 * Performance tier:
 *  - Reads are served from an in-memory `dbCache` object (zero disk I/O).
 *  - Writes mutate `dbCache` synchronously then schedule a debounced flush (100 ms).
 *  - Critical writes (accounts with token data, API key creation/deletion) flush immediately.
 *  - Stat increments and lastUsedAt updates use the debounced path.
 *  - Flushes are atomic: data written to a temp file first then renamed over the target.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { encrypt, decrypt } from './config';
import type { IDatabase, Account, ApiKey, RequestLog, DbStats } from './database';

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const DB_TMP_PATH = path.join(DATA_DIR, 'db.json.tmp');
const FLUSH_DEBOUNCE_MS = 100;

// --- Types for the on-disk format ---

interface DbFile {
    accounts: Record<string, any>;
    apiKeys: Record<string, any>;
    logs: any[];
}

// --- In-memory cache ---

let dbCache: DbFile | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadFromDisk(): DbFile {
    ensureDataDir();
    if (!fs.existsSync(DB_PATH)) {
        return { accounts: {}, apiKeys: {}, logs: [] };
    }
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) as DbFile;
    } catch {
        return { accounts: {}, apiKeys: {}, logs: [] };
    }
}

/** Returns the in-memory cache, loading from disk on first call. */
function getCache(): DbFile {
    if (!dbCache) {
        dbCache = loadFromDisk();
    }
    return dbCache;
}

/** Atomic write: temp file → rename */
function flushToDisk(): void {
    if (!dbCache) return;
    ensureDataDir();
    const json = JSON.stringify(dbCache, null, 2);
    fs.writeFileSync(DB_TMP_PATH, json, 'utf-8');
    fs.renameSync(DB_TMP_PATH, DB_PATH);
}

/** Schedule a debounced flush — used for high-frequency stat updates. */
function scheduleFlush(): void {
    if (flushTimer) return; // Already scheduled
    flushTimer = setTimeout(() => {
        flushTimer = null;
        try { flushToDisk(); } catch (err) { console.error('LocalDb flush error:', err); }
    }, FLUSH_DEBOUNCE_MS);
}

/** Flush immediately — used after structural writes (add/remove account/key). */
function flushNow(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    flushToDisk();
}

function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function generateId(): string {
    return crypto.randomBytes(12).toString('hex');
}

// --- Serialize / Deserialize ---

function deserializeAccount(data: any): Account {
    return {
        ...data,
        accessToken: decrypt(data.accessToken),
        refreshToken: decrypt(data.refreshToken),
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : new Date(0),
        lastUsedAt: data.lastUsedAt ? new Date(data.lastUsedAt) : new Date(0),
        exhaustedAt: data.exhaustedAt ? new Date(data.exhaustedAt) : undefined,
        createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : undefined,
    } as Account;
}

// --- Implementation ---

export const localDb: IDatabase = {

    async getActiveAccounts(): Promise<Account[]> {
        const db = getCache();
        const active = Object.values(db.accounts)
            .filter((a: any) => a.isActive === true)
            .map(deserializeAccount);
        return active.sort((a, b) =>
            new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime()
        );
    },

    async getAllAccounts(): Promise<Account[]> {
        const db = getCache();
        const all = Object.values(db.accounts).map(deserializeAccount);
        return all.sort((a, b) =>
            new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime()
        );
    },

    async upsertAccount(account: Account): Promise<void> {
        const db = getCache();
        const existing = db.accounts[account.email];

        const toIso = (val: any, fallback: string = new Date(0).toISOString()): string => {
            if (!val) return fallback;
            const d = val instanceof Date ? val : new Date(val);
            return isNaN(d.getTime()) ? fallback : d.toISOString();
        };
        const toIsoOrNull = (val: any): string | null => {
            if (!val) return null;
            const d = val instanceof Date ? val : new Date(val);
            return isNaN(d.getTime()) ? null : d.toISOString();
        };

        db.accounts[account.email] = {
            ...(existing || {}),
            ...account,
            accessToken: encrypt(account.accessToken),
            refreshToken: encrypt(account.refreshToken),
            expiresAt: toIso(account.expiresAt),
            lastUsedAt: toIso(account.lastUsedAt),
            exhaustedAt: toIsoOrNull(account.exhaustedAt),
            updatedAt: new Date().toISOString(),
            createdAt: existing?.createdAt || new Date().toISOString(),
        };
        flushNow(); // Structural write — flush immediately
    },

    async updateAccount(email: string, data: Partial<Account>): Promise<void> {
        const db = getCache();
        if (!db.accounts[email]) return;
        const update: any = { ...data, updatedAt: new Date().toISOString() };
        if (update.accessToken) update.accessToken = encrypt(update.accessToken);
        if (update.refreshToken) update.refreshToken = encrypt(update.refreshToken);
        if (update.expiresAt instanceof Date) update.expiresAt = update.expiresAt.toISOString();
        if (update.lastUsedAt instanceof Date) update.lastUsedAt = update.lastUsedAt.toISOString();
        if (update.exhaustedAt instanceof Date) update.exhaustedAt = update.exhaustedAt.toISOString();
        else if (update.exhaustedAt === null || update.exhaustedAt === undefined) update.exhaustedAt = null;
        db.accounts[email] = { ...db.accounts[email], ...update };

        // Token updates are critical; stat-only updates use debounced flush
        const isTokenUpdate = data.accessToken !== undefined || data.refreshToken !== undefined;
        if (isTokenUpdate) {
            flushNow();
        } else {
            scheduleFlush();
        }
    },

    async incrementAccountStats(email: string, stats: { successful: number; failed: number; tokens: number }): Promise<void> {
        const db = getCache();
        if (!db.accounts[email]) return;
        const acc = db.accounts[email];
        acc.totalRequests = (acc.totalRequests || 0) + stats.successful + stats.failed;
        if (stats.successful > 0) acc.successfulRequests = (acc.successfulRequests || 0) + stats.successful;
        if (stats.failed > 0) acc.failedRequests = (acc.failedRequests || 0) + stats.failed;
        if (stats.tokens > 0) acc.totalTokensUsed = (acc.totalTokensUsed || 0) + stats.tokens;
        acc.lastUsedAt = new Date().toISOString();
        acc.updatedAt = new Date().toISOString();
        scheduleFlush(); // High-frequency — debounce
    },

    async reactivateExhaustedAccounts(cooldownMs: number): Promise<number> {
        const db = getCache();
        let count = 0;
        for (const email of Object.keys(db.accounts)) {
            const acc = db.accounts[email];
            if (acc.isActive || !acc.exhaustedAt) continue;
            const exhaustedTime = new Date(acc.exhaustedAt).getTime();
            if (Date.now() - exhaustedTime > cooldownMs) {
                acc.isActive = true;
                acc.exhaustedAt = null;
                acc.updatedAt = new Date().toISOString();
                console.log(`♻️ Auto-reactivated account: ${email}`);
                count++;
            }
        }
        if (count > 0) flushNow();
        return count;
    },

    async reactivateAccount(email: string): Promise<void> {
        const db = getCache();
        if (!db.accounts[email]) return;
        db.accounts[email].isActive = true;
        db.accounts[email].exhaustedAt = null;
        db.accounts[email].updatedAt = new Date().toISOString();
        flushNow();
    },

    async deleteAccount(idOrEmail: string): Promise<void> {
        const db = getCache();
        delete db.accounts[idOrEmail];
        flushNow();
    },

    // --- API Keys ---

    async createApiKey(name: string, key: string): Promise<ApiKey> {
        const db = getCache();
        const id = generateId();
        const keyData = {
            id,
            name,
            keyHash: hashApiKey(key),
            keyPrefix: key.substring(0, 7),
            createdAt: new Date().toISOString(),
            totalRequests: 0,
        };
        db.apiKeys[id] = keyData;
        flushNow();
        return { ...keyData, key, createdAt: new Date(keyData.createdAt) };
    },

    async getAllApiKeys(): Promise<ApiKey[]> {
        const db = getCache();
        return Object.values(db.apiKeys)
            .map((k: any) => {
                const masked = k.keyPrefix
                    ? k.keyPrefix + '•'.repeat(36)
                    : '•'.repeat(43);
                return {
                    id: k.id,
                    name: k.name,
                    key: masked,
                    createdAt: new Date(k.createdAt),
                    lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt) : undefined,
                    totalRequests: k.totalRequests || 0,
                };
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    },

    async validateApiKey(key: string): Promise<boolean> {
        const db = getCache();
        const keyHash = hashApiKey(key);
        const found = Object.values(db.apiKeys).find((k: any) => k.keyHash === keyHash) as any;
        if (found) {
            const id = found.id;
            db.apiKeys[id].lastUsedAt = new Date().toISOString();
            db.apiKeys[id].totalRequests = (db.apiKeys[id].totalRequests || 0) + 1;
            scheduleFlush(); // High-frequency — debounce
            return true;
        }
        return false;
    },

    async deleteApiKey(id: string): Promise<void> {
        const db = getCache();
        delete db.apiKeys[id];
        flushNow();
    },

    // --- Request Logging ---

    async addRequestLog(log: Omit<RequestLog, 'id'>): Promise<void> {
        const db = getCache();
        db.logs.push({
            id: generateId(),
            accountEmail: log.accountEmail,
            question: log.question,
            answer: log.answer,
            tokensUsed: log.tokensUsed,
            success: log.success ?? true,
            timestamp: new Date().toISOString(),
        });
        // Keep only last 5000 logs to prevent unbounded growth
        if (db.logs.length > 5000) {
            db.logs = db.logs.slice(db.logs.length - 5000);
        }
        scheduleFlush(); // High-frequency — debounce
    },

    async getRecentLogs(limitCount: number = 50): Promise<RequestLog[]> {
        const db = getCache();
        return [...db.logs]
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, limitCount)
            .map(l => ({
                ...l,
                timestamp: new Date(l.timestamp),
            }));
    },

    // --- Stats ---

    async getStats(): Promise<DbStats> {
        const allAccounts = await this.getAllAccounts();
        let totalRequests = 0, successfulRequests = 0, failedRequests = 0, totalTokensUsed = 0, activeAccounts = 0;

        const accountStats = allAccounts.map(acc => {
            const accTotal = acc.totalRequests || 0;
            const accSuccess = acc.successfulRequests || 0;
            const accFailed = acc.failedRequests || 0;
            const accTokens = acc.totalTokensUsed || 0;
            totalRequests += accTotal;
            successfulRequests += accSuccess;
            failedRequests += accFailed;
            totalTokensUsed += accTokens;
            if (acc.isActive) activeAccounts++;
            return {
                email: acc.email,
                totalRequests: accTotal,
                successfulRequests: accSuccess,
                failedRequests: accFailed,
                totalTokensUsed: accTokens,
                isActive: acc.isActive,
                isPro: acc.isPro,
            };
        });

        return {
            totalRequests,
            successfulRequests,
            failedRequests,
            totalTokensUsed,
            activeAccounts,
            totalAccounts: allAccounts.length,
            accountStats,
        };
    },
};

export default localDb;
