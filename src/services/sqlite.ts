/**
 * SQLite database backend for OpenGem.
 *
 * Why SQLite over the local JSON file backend:
 *  - ACID transactions: writes are atomic at the row level, not the whole file.
 *    A crash mid-write cannot corrupt the database.
 *  - Concurrent reads: multiple processes / workers can query simultaneously.
 *  - WAL mode: readers never block writers, writers never block readers.
 *  - Proper indexing: O(log n) lookups instead of O(n) JSON scans.
 *  - No full-file rewrite on every change: the JSON backend rewrites
 *    the entire db.json on every update; SQLite only touches changed pages.
 *  - Scales to millions of rows without memory pressure.
 *  - The file is a single cross-platform binary blob — easy to back up with cp.
 *
 * Data is stored in <project_root>/data/opengem.db by default.
 * Override with the SQLITE_PATH environment variable (":memory:" for tests).
 * Token values are AES-256-GCM encrypted (same as the JSON and Firebase backends).
 * API keys are stored as SHA-256 hashes (same as the other backends).
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { encrypt, decrypt } from './config';
import type { IDatabase, Account, ApiKey, RequestLog, DbStats } from './database';

// ---------------------------------------------------------------------------
// DB initialisation
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
    if (_db) return _db;

    const dbPath = process.env.SQLITE_PATH
        ?? path.join(__dirname, '../../data/opengem.db');

    // Ensure data directory exists (skip for :memory:)
    if (dbPath !== ':memory:') {
        const { mkdirSync } = require('fs');
        mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    _db = new Database(dbPath);
    console.log(`🗄️  SQLite database opened: ${dbPath}`);

    // Performance & safety settings
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    migrate(_db);
    return _db;
}

/** Idempotent schema migration — safe to run on every startup. */
function migrate(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            email          TEXT PRIMARY KEY,
            access_token   TEXT NOT NULL,
            refresh_token  TEXT NOT NULL,
            project_id     TEXT NOT NULL DEFAULT '',
            expires_at     INTEGER NOT NULL DEFAULT 0,
            is_active      INTEGER NOT NULL DEFAULT 1,
            last_used_at   INTEGER NOT NULL DEFAULT 0,
            exhausted_at   INTEGER,
            created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            total_requests        INTEGER NOT NULL DEFAULT 0,
            successful_requests   INTEGER NOT NULL DEFAULT 0,
            failed_requests       INTEGER NOT NULL DEFAULT 0,
            total_tokens_used     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            key_hash     TEXT NOT NULL UNIQUE,
            created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            last_used_at INTEGER,
            total_requests INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS request_logs (
            id            TEXT PRIMARY KEY,
            account_email TEXT NOT NULL,
            question      TEXT NOT NULL DEFAULT '',
            answer        TEXT NOT NULL DEFAULT '',
            tokens_used   INTEGER NOT NULL DEFAULT 0,
            success       INTEGER NOT NULL DEFAULT 1,
            timestamp     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_is_active ON accounts(is_active);
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON request_logs(timestamp DESC);
    `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function generateId(): string {
    return crypto.randomBytes(12).toString('hex');
}

function rowToAccount(row: Record<string, unknown>): Account {
    return {
        id: row.email as string,
        email: row.email as string,
        accessToken: decrypt(row.access_token as string),
        refreshToken: decrypt(row.refresh_token as string),
        projectId: row.project_id as string,
        expiresAt: new Date(row.expires_at as number),
        isActive: (row.is_active as number) === 1,
        lastUsedAt: new Date(row.last_used_at as number),
        exhaustedAt: row.exhausted_at != null ? new Date(row.exhausted_at as number) : undefined,
        createdAt: new Date(row.created_at as number),
        updatedAt: new Date(row.updated_at as number),
        totalRequests: row.total_requests as number,
        successfulRequests: row.successful_requests as number,
        failedRequests: row.failed_requests as number,
        totalTokensUsed: row.total_tokens_used as number,
    };
}

function toMs(value: Date | number | undefined | null): number | null {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    return value;
}

// ---------------------------------------------------------------------------
// IDatabase implementation
// ---------------------------------------------------------------------------

const sqliteDb: IDatabase = {
    // --- Accounts ---

    async getActiveAccounts(): Promise<Account[]> {
        const rows = getDb()
            .prepare('SELECT * FROM accounts WHERE is_active = 1 ORDER BY last_used_at ASC')
            .all() as Record<string, unknown>[];
        return rows.map(rowToAccount);
    },

    async getAllAccounts(): Promise<Account[]> {
        const rows = getDb()
            .prepare('SELECT * FROM accounts ORDER BY created_at DESC')
            .all() as Record<string, unknown>[];
        return rows.map(rowToAccount);
    },

    async upsertAccount(account: Account): Promise<void> {
        getDb().prepare(`
            INSERT INTO accounts
                (email, access_token, refresh_token, project_id, expires_at,
                 is_active, last_used_at, exhausted_at, created_at, updated_at)
            VALUES
                (@email, @access_token, @refresh_token, @project_id, @expires_at,
                 @is_active, @last_used_at, @exhausted_at, @created_at, @updated_at)
            ON CONFLICT(email) DO UPDATE SET
                access_token  = excluded.access_token,
                refresh_token = excluded.refresh_token,
                project_id    = excluded.project_id,
                expires_at    = excluded.expires_at,
                is_active     = excluded.is_active,
                last_used_at  = excluded.last_used_at,
                exhausted_at  = excluded.exhausted_at,
                updated_at    = excluded.updated_at
        `).run({
            email: account.email,
            access_token: encrypt(account.accessToken),
            refresh_token: encrypt(account.refreshToken),
            project_id: account.projectId ?? '',
            expires_at: toMs(account.expiresAt) ?? 0,
            is_active: account.isActive ? 1 : 0,
            last_used_at: toMs(account.lastUsedAt) ?? 0,
            exhausted_at: toMs(account.exhaustedAt) ?? null,
            created_at: toMs(account.createdAt) ?? Date.now(),
            updated_at: Date.now(),
        });
    },

    async updateAccount(email: string, data: Partial<Account>): Promise<void> {
        const sets: string[] = ['updated_at = @updated_at'];
        const params: Record<string, unknown> = { email, updated_at: Date.now() };

        if (data.accessToken !== undefined) {
            sets.push('access_token = @access_token');
            params.access_token = encrypt(data.accessToken);
        }
        if (data.refreshToken !== undefined) {
            sets.push('refresh_token = @refresh_token');
            params.refresh_token = encrypt(data.refreshToken);
        }
        if (data.projectId !== undefined) {
            sets.push('project_id = @project_id');
            params.project_id = data.projectId;
        }
        if (data.expiresAt !== undefined) {
            sets.push('expires_at = @expires_at');
            params.expires_at = toMs(data.expiresAt);
        }
        if (data.isActive !== undefined) {
            sets.push('is_active = @is_active');
            params.is_active = data.isActive ? 1 : 0;
        }
        if (data.lastUsedAt !== undefined) {
            sets.push('last_used_at = @last_used_at');
            params.last_used_at = toMs(data.lastUsedAt);
        }
        if (data.exhaustedAt !== undefined) {
            sets.push('exhausted_at = @exhausted_at');
            params.exhausted_at = toMs(data.exhaustedAt);
        }

        getDb()
            .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE email = @email`)
            .run(params);
    },

    async incrementAccountStats(
        email: string,
        stats: { successful: number; failed: number; tokens: number }
    ): Promise<void> {
        getDb().prepare(`
            UPDATE accounts SET
                total_requests      = total_requests      + @total,
                successful_requests = successful_requests + @successful,
                failed_requests     = failed_requests     + @failed,
                total_tokens_used   = total_tokens_used   + @tokens,
                updated_at          = @updated_at
            WHERE email = @email
        `).run({
            email,
            total: stats.successful + stats.failed,
            successful: stats.successful,
            failed: stats.failed,
            tokens: stats.tokens,
            updated_at: Date.now(),
        });
    },

    async reactivateExhaustedAccounts(cooldownMs: number): Promise<number> {
        const cutoff = Date.now() - cooldownMs;
        const result = getDb().prepare(`
            UPDATE accounts
            SET is_active    = 1,
                exhausted_at = NULL,
                updated_at   = @updated_at
            WHERE is_active = 0
              AND exhausted_at IS NOT NULL
              AND exhausted_at <= @cutoff
        `).run({ cutoff, updated_at: Date.now() });
        return result.changes;
    },

    async reactivateAccount(email: string): Promise<void> {
        getDb().prepare(`
            UPDATE accounts
            SET is_active    = 1,
                exhausted_at = NULL,
                updated_at   = @updated_at
            WHERE email = @email
        `).run({ email, updated_at: Date.now() });
    },

    async deleteAccount(idOrEmail: string): Promise<void> {
        getDb()
            .prepare('DELETE FROM accounts WHERE email = @email')
            .run({ email: idOrEmail });
    },

    // --- API Keys ---

    async createApiKey(name: string, key: string): Promise<ApiKey> {
        const id = generateId();
        const now = Date.now();
        getDb().prepare(`
            INSERT INTO api_keys (id, name, key_hash, created_at, total_requests)
            VALUES (@id, @name, @key_hash, @created_at, 0)
        `).run({ id, name, key_hash: hashApiKey(key), created_at: now });
        return { id, name, key, createdAt: now };
    },

    async getAllApiKeys(): Promise<ApiKey[]> {
        const rows = getDb()
            .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
            .all() as Record<string, unknown>[];
        return rows.map(r => ({
            id: r.id as string,
            name: r.name as string,
            key: `${(r.key_hash as string).slice(0, 7)}...`, // prefix only — plaintext never stored
            createdAt: r.created_at as number,
            lastUsedAt: r.last_used_at as number | undefined,
            totalRequests: r.total_requests as number,
        }));
    },

    async validateApiKey(key: string): Promise<boolean> {
        const hash = hashApiKey(key);
        const row = getDb()
            .prepare('SELECT id FROM api_keys WHERE key_hash = @hash')
            .get({ hash }) as { id: string } | undefined;
        if (!row) return false;
        // Update last-used timestamp
        getDb()
            .prepare('UPDATE api_keys SET last_used_at = @now, total_requests = total_requests + 1 WHERE key_hash = @hash')
            .run({ now: Date.now(), hash });
        return true;
    },

    async deleteApiKey(id: string): Promise<void> {
        getDb().prepare('DELETE FROM api_keys WHERE id = @id').run({ id });
    },

    // --- Request Logs ---

    async addRequestLog(log: Omit<RequestLog, 'id'>): Promise<void> {
        getDb().prepare(`
            INSERT INTO request_logs
                (id, account_email, question, answer, tokens_used, success, timestamp)
            VALUES
                (@id, @account_email, @question, @answer, @tokens_used, @success, @timestamp)
        `).run({
            id: generateId(),
            account_email: log.accountEmail,
            question: log.question ?? '',
            answer: log.answer ?? '',
            tokens_used: log.tokensUsed ?? 0,
            success: log.success ? 1 : 0,
            timestamp: toMs(log.timestamp) ?? Date.now(),
        });
    },

    async getRecentLogs(limit = 100): Promise<RequestLog[]> {
        const rows = getDb()
            .prepare('SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT @limit')
            .all({ limit }) as Record<string, unknown>[];
        return rows.map(r => ({
            id: r.id as string,
            accountEmail: r.account_email as string,
            question: r.question as string,
            answer: r.answer as string,
            tokensUsed: r.tokens_used as number,
            success: (r.success as number) === 1,
            timestamp: r.timestamp as number,
        }));
    },

    // --- Stats ---

    async getStats(): Promise<DbStats> {
        const db = getDb();

        const totals = db.prepare(`
            SELECT
                SUM(total_requests)      AS total_requests,
                SUM(successful_requests) AS successful_requests,
                SUM(failed_requests)     AS failed_requests,
                SUM(total_tokens_used)   AS total_tokens_used,
                COUNT(*)                 AS total_accounts,
                SUM(is_active)           AS active_accounts
            FROM accounts
        `).get() as Record<string, number | null>;

        const accountRows = db.prepare(`
            SELECT email, total_requests, successful_requests, failed_requests,
                   total_tokens_used, is_active
            FROM accounts
            ORDER BY total_requests DESC
        `).all() as Record<string, unknown>[];

        return {
            totalRequests: totals.total_requests ?? 0,
            successfulRequests: totals.successful_requests ?? 0,
            failedRequests: totals.failed_requests ?? 0,
            totalTokensUsed: totals.total_tokens_used ?? 0,
            totalAccounts: totals.total_accounts ?? 0,
            activeAccounts: totals.active_accounts ?? 0,
            accountStats: accountRows.map(r => ({
                email: r.email as string,
                totalRequests: r.total_requests as number,
                successfulRequests: r.successful_requests as number,
                failedRequests: r.failed_requests as number,
                totalTokensUsed: r.total_tokens_used as number,
                isActive: (r.is_active as number) === 1,
            })),
        };
    },
};

export { sqliteDb };

/** Closes the database connection. Call this on process exit or in test teardown. */
export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}
