import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { encrypt, decrypt } from './config';
import type { Account, ApiKey, RequestLog } from './firebase';
import type { DatabaseService, StatsResult } from './db';

const DB_PATH = process.env.SQLITE_PATH ?? path.join(process.cwd(), 'opengem.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
    if (!_db) {
        _db = new Database(DB_PATH);
        _db.pragma('journal_mode = WAL');
        initSchema(_db);
        console.log(`🗄️  SQLite database opened: ${DB_PATH}`);
    }
    return _db;
}

function initSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            accessToken TEXT NOT NULL,
            refreshToken TEXT NOT NULL,
            projectId TEXT NOT NULL,
            expiresAt INTEGER NOT NULL,
            isActive INTEGER NOT NULL DEFAULT 1,
            lastUsedAt INTEGER NOT NULL,
            exhaustedAt INTEGER,
            createdAt INTEGER,
            totalRequests INTEGER DEFAULT 0,
            successfulRequests INTEGER DEFAULT 0,
            failedRequests INTEGER DEFAULT 0,
            totalTokensUsed INTEGER DEFAULT 0,
            updatedAt INTEGER
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            keyHash TEXT NOT NULL,
            keyPrefix TEXT,
            createdAt INTEGER NOT NULL,
            lastUsedAt INTEGER,
            totalRequests INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS request_logs (
            id TEXT PRIMARY KEY,
            accountEmail TEXT NOT NULL,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            tokensUsed INTEGER NOT NULL,
            success INTEGER NOT NULL,
            timestamp INTEGER NOT NULL
        );
    `);
}

function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function toMs(val: Date | number | null | undefined): number | null {
    if (val == null) return null;
    if (val instanceof Date) return val.getTime();
    return Number(val);
}

function rowToAccount(row: any): Account {
    return {
        id: row.id,
        email: row.email,
        accessToken: decrypt(row.accessToken),
        refreshToken: decrypt(row.refreshToken),
        projectId: row.projectId,
        expiresAt: new Date(row.expiresAt),
        isActive: row.isActive === 1,
        lastUsedAt: new Date(row.lastUsedAt),
        exhaustedAt: row.exhaustedAt != null ? new Date(row.exhaustedAt) : undefined,
        createdAt: row.createdAt != null ? new Date(row.createdAt) : undefined,
        updatedAt: row.updatedAt != null ? new Date(row.updatedAt) : undefined,
        totalRequests: row.totalRequests ?? 0,
        successfulRequests: row.successfulRequests ?? 0,
        failedRequests: row.failedRequests ?? 0,
        totalTokensUsed: row.totalTokensUsed ?? 0,
    };
}

export const sqliteDb: DatabaseService = {
    async getActiveAccounts(): Promise<Account[]> {
        const rows = getDb().prepare('SELECT * FROM accounts WHERE isActive = 1').all();
        const accounts = (rows as any[]).map(rowToAccount);
        return accounts.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
    },

    async getAllAccounts(): Promise<Account[]> {
        const rows = getDb().prepare('SELECT * FROM accounts').all();
        const accounts = (rows as any[]).map(rowToAccount);
        return accounts.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
    },

    async upsertAccount(account: Account): Promise<void> {
        const now = Date.now();
        getDb().prepare(`
            INSERT INTO accounts (id, email, accessToken, refreshToken, projectId, expiresAt, isActive, lastUsedAt, exhaustedAt, createdAt, totalRequests, successfulRequests, failedRequests, totalTokensUsed, updatedAt)
            VALUES (@id, @email, @accessToken, @refreshToken, @projectId, @expiresAt, @isActive, @lastUsedAt, @exhaustedAt, @createdAt, @totalRequests, @successfulRequests, @failedRequests, @totalTokensUsed, @updatedAt)
            ON CONFLICT(id) DO UPDATE SET
                email = excluded.email,
                accessToken = excluded.accessToken,
                refreshToken = excluded.refreshToken,
                projectId = excluded.projectId,
                expiresAt = excluded.expiresAt,
                isActive = excluded.isActive,
                lastUsedAt = excluded.lastUsedAt,
                exhaustedAt = excluded.exhaustedAt,
                totalRequests = COALESCE(accounts.totalRequests, excluded.totalRequests),
                successfulRequests = COALESCE(accounts.successfulRequests, excluded.successfulRequests),
                failedRequests = COALESCE(accounts.failedRequests, excluded.failedRequests),
                totalTokensUsed = COALESCE(accounts.totalTokensUsed, excluded.totalTokensUsed),
                updatedAt = excluded.updatedAt
        `).run({
            id: account.email,
            email: account.email,
            accessToken: encrypt(account.accessToken),
            refreshToken: encrypt(account.refreshToken),
            projectId: account.projectId,
            expiresAt: toMs(account.expiresAt),
            isActive: account.isActive ? 1 : 0,
            lastUsedAt: toMs(account.lastUsedAt) ?? now,
            exhaustedAt: toMs((account as any).exhaustedAt),
            createdAt: toMs((account as any).createdAt) ?? now,
            totalRequests: account.totalRequests ?? 0,
            successfulRequests: account.successfulRequests ?? 0,
            failedRequests: account.failedRequests ?? 0,
            totalTokensUsed: account.totalTokensUsed ?? 0,
            updatedAt: now,
        });
    },

    async updateAccount(email: string, data: Partial<Account>): Promise<void> {
        const fields: string[] = [];
        const params: Record<string, any> = { email };

        if (data.accessToken !== undefined) { fields.push('accessToken = @accessToken'); params.accessToken = encrypt(data.accessToken); }
        if (data.refreshToken !== undefined) { fields.push('refreshToken = @refreshToken'); params.refreshToken = encrypt(data.refreshToken); }
        if (data.expiresAt !== undefined) { fields.push('expiresAt = @expiresAt'); params.expiresAt = toMs(data.expiresAt); }
        if (data.isActive !== undefined) { fields.push('isActive = @isActive'); params.isActive = data.isActive ? 1 : 0; }
        if (data.lastUsedAt !== undefined) { fields.push('lastUsedAt = @lastUsedAt'); params.lastUsedAt = toMs(data.lastUsedAt); }
        if ('exhaustedAt' in data) { fields.push('exhaustedAt = @exhaustedAt'); params.exhaustedAt = toMs((data as any).exhaustedAt); }
        if (data.projectId !== undefined) { fields.push('projectId = @projectId'); params.projectId = data.projectId; }

        fields.push('updatedAt = @updatedAt');
        params.updatedAt = Date.now();

        getDb().prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = @email`).run(params);
    },

    async incrementAccountStats(email: string, stats: { successful: number; failed: number; tokens: number }): Promise<void> {
        const now = Date.now();
        getDb().prepare(`
            UPDATE accounts SET
                totalRequests = totalRequests + @total,
                successfulRequests = successfulRequests + @successful,
                failedRequests = failedRequests + @failed,
                totalTokensUsed = totalTokensUsed + @tokens,
                lastUsedAt = @now,
                updatedAt = @now
            WHERE id = @email
        `).run({
            email,
            total: stats.successful + stats.failed,
            successful: stats.successful,
            failed: stats.failed,
            tokens: stats.tokens,
            now,
        });
    },

    async reactivateExhaustedAccounts(cooldownMs: number): Promise<number> {
        const threshold = Date.now() - cooldownMs;
        const result = getDb().prepare(`
            UPDATE accounts SET isActive = 1, exhaustedAt = NULL, updatedAt = @now
            WHERE isActive = 0 AND exhaustedAt IS NOT NULL AND exhaustedAt < @threshold
        `).run({ threshold, now: Date.now() });
        return result.changes;
    },

    async reactivateAccount(email: string): Promise<void> {
        getDb().prepare(`
            UPDATE accounts SET isActive = 1, exhaustedAt = NULL, updatedAt = @now WHERE id = @email
        `).run({ email, now: Date.now() });
    },

    async deleteAccount(idOrEmail: string): Promise<void> {
        getDb().prepare('DELETE FROM accounts WHERE id = ?').run(idOrEmail);
    },

    // --- API KEYS ---

    async createApiKey(name: string, key: string): Promise<ApiKey> {
        const id = crypto.randomUUID();
        const now = Date.now();
        getDb().prepare(`
            INSERT INTO api_keys (id, name, keyHash, keyPrefix, createdAt, totalRequests)
            VALUES (@id, @name, @keyHash, @keyPrefix, @createdAt, 0)
        `).run({ id, name, keyHash: hashApiKey(key), keyPrefix: key.substring(0, 7), createdAt: now });
        return { id, name, key, createdAt: new Date(now), totalRequests: 0 };
    },

    async getAllApiKeys(): Promise<ApiKey[]> {
        const rows = getDb().prepare('SELECT * FROM api_keys ORDER BY createdAt DESC').all() as any[];
        return rows.map(row => ({
            id: row.id,
            name: row.name,
            key: row.keyPrefix
                ? (row.keyPrefix + '\u2022'.repeat(36))
                : '\u2022'.repeat(43),
            createdAt: new Date(row.createdAt),
            lastUsedAt: row.lastUsedAt != null ? new Date(row.lastUsedAt) : undefined,
            totalRequests: row.totalRequests ?? 0,
        }));
    },

    async validateApiKey(key: string): Promise<boolean> {
        const keyHash = hashApiKey(key);
        const db = getDb();
        const row = db.prepare('SELECT id FROM api_keys WHERE keyHash = ?').get(keyHash) as any;
        if (!row) return false;
        db.prepare('UPDATE api_keys SET lastUsedAt = @now, totalRequests = totalRequests + 1 WHERE id = @id')
            .run({ now: Date.now(), id: row.id });
        return true;
    },

    async deleteApiKey(id: string): Promise<void> {
        getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    },

    // --- REQUEST LOGGING ---

    async addRequestLog(log: Omit<RequestLog, 'id'>): Promise<void> {
        getDb().prepare(`
            INSERT INTO request_logs (id, accountEmail, question, answer, tokensUsed, success, timestamp)
            VALUES (@id, @accountEmail, @question, @answer, @tokensUsed, @success, @timestamp)
        `).run({
            id: crypto.randomUUID(),
            accountEmail: log.accountEmail,
            question: log.question,
            answer: log.answer,
            tokensUsed: log.tokensUsed,
            success: (log.success ?? true) ? 1 : 0,
            timestamp: toMs(log.timestamp) ?? Date.now(),
        });
    },

    async getRecentLogs(limitCount: number = 50): Promise<RequestLog[]> {
        const rows = getDb().prepare('SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT ?').all(limitCount) as any[];
        return rows.map(row => ({
            id: row.id,
            accountEmail: row.accountEmail,
            question: row.question,
            answer: row.answer,
            tokensUsed: row.tokensUsed ?? 0,
            success: row.success === 1,
            timestamp: new Date(row.timestamp),
        }));
    },

    async getStats(): Promise<StatsResult> {
        const accounts = await sqliteDb.getAllAccounts();
        let totalRequests = 0, successfulRequests = 0, failedRequests = 0, totalTokensUsed = 0, activeAccounts = 0;

        const accountStats = accounts.map(acc => {
            const accTotal = acc.totalRequests ?? 0;
            const accSuccess = acc.successfulRequests ?? 0;
            const accFailed = acc.failedRequests ?? 0;
            const accTokens = acc.totalTokensUsed ?? 0;

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
            };
        });

        return {
            totalRequests,
            successfulRequests,
            failedRequests,
            totalTokensUsed,
            activeAccounts,
            totalAccounts: accounts.length,
            accountStats,
        };
    },
};

export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}
