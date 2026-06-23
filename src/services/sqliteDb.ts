/**
 * SQLite-backed database (node:sqlite, built-in since Node 22.5+).
 *
 * Replaces the JSON-file localDb. Drops in behind the same `IDatabase`
 * interface so callers (controllers/middleware) require zero changes.
 *
 *  - Storage:   <project_root>/data/db.sqlite  (WAL mode, synchronous=NORMAL)
 *  - Tokens:    AES-256-GCM encrypted via ./config helpers (same as before).
 *  - API keys:  SHA-256 hashes only.
 *  - Migration: First run automatically imports any existing data/db.json,
 *               then renames it to data/db.json.bak so it isn't re-imported.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt, getLoggingConfig } from './config';
import { getDataDir } from './paths';
import type { IDatabase, Account, ApiKey, RequestLog, DbStats, ChatConversation, ChatConversationMessage, ChatConversationSummary } from './database';
import { mergeEffectiveTokenStats } from './token-stats';

const DATA_DIR = getDataDir();
const SQLITE_PATH = path.join(DATA_DIR, 'db.sqlite');
const LEGACY_JSON_PATH = path.join(DATA_DIR, 'db.json');
const LEGACY_JSON_BACKUP_PATH = path.join(DATA_DIR, 'db.json.bak');
const MAX_LOG_ROWS = 5000;

// --- Connection (lazy) -----------------------------------------------------

let _db: DatabaseSync | null = null;

function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function getDb(): DatabaseSync {
    if (_db) return _db;
    ensureDataDir();
    const db = new DatabaseSync(SQLITE_PATH);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA temp_store = MEMORY;

        CREATE TABLE IF NOT EXISTS accounts (
            email             TEXT PRIMARY KEY,
            id                TEXT,
            accessToken       TEXT NOT NULL,
            refreshToken      TEXT NOT NULL,
            projectId         TEXT,
            expiresAt         TEXT,
            isActive          INTEGER NOT NULL DEFAULT 1,
            lastUsedAt        TEXT,
            isPro             INTEGER,
            tierName          TEXT,
            exhaustedAt       TEXT,
            createdAt         TEXT,
            updatedAt         TEXT,
            totalRequests     INTEGER NOT NULL DEFAULT 0,
            successfulRequests INTEGER NOT NULL DEFAULT 0,
            failedRequests    INTEGER NOT NULL DEFAULT 0,
            totalTokensUsed   INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            keyHash       TEXT NOT NULL UNIQUE,
            keyPrefix     TEXT,
            createdAt     TEXT NOT NULL,
            lastUsedAt    TEXT,
            totalRequests INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(keyHash);

        CREATE TABLE IF NOT EXISTS request_logs (
            id                TEXT PRIMARY KEY,
            accountEmail      TEXT,
            question          TEXT,
            answer            TEXT,
            systemInstruction TEXT,
            model             TEXT,
            isFallback        INTEGER,
            affinityKeyHash   TEXT,
            affinitySource    TEXT,
            affinityHit       INTEGER,
            affinityRebound   INTEGER,
            promptTokens      INTEGER,
            completionTokens  INTEGER,
            effectiveTokensUsed INTEGER,
            requestId         TEXT,
            level             TEXT,
            method            TEXT,
            url               TEXT,
            userApi           TEXT,
            status            INTEGER,
            execTimeMs        INTEGER,
            opengemKey        TEXT,
            userAgent         TEXT,
            remoteIp          TEXT,
            tokensUsed        INTEGER NOT NULL DEFAULT 0,
            success           INTEGER NOT NULL DEFAULT 1,
            timestamp         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON request_logs(timestamp DESC);

        CREATE TABLE IF NOT EXISTS chat_conversations (
            id            TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            model         TEXT NOT NULL,
            sessionId     TEXT NOT NULL,
            messages      TEXT NOT NULL,
            messageCount  INTEGER NOT NULL DEFAULT 0,
            forkedFromId  TEXT,
            createdAt     TEXT NOT NULL,
            updatedAt     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updatedAt DESC);
    `);
    ensureRequestLogAffinityColumns(db);
    ensureChatConversationColumns(db);
    _db = db;

    // One-shot migration from legacy JSON, if present.
    try { migrateFromJsonIfNeeded(db); } catch (e) { console.error('SQLite JSON migration error:', e); }

    // Trim oversized log table left over from a prior bad run.
    try { trimLogs(db); } catch { /* ignore */ }

    return db;
}

// --- JSON → SQLite one-time import ----------------------------------------

interface LegacyDbFile {
    accounts?: Record<string, any>;
    apiKeys?: Record<string, any>;
    logs?: any[];
}

function migrateFromJsonIfNeeded(db: DatabaseSync): void {
    if (!fs.existsSync(LEGACY_JSON_PATH)) return;

    // Already migrated? (Skip if any data is present in sqlite.)
    const accountsCount = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as any).n as number;
    const keysCount = (db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as any).n as number;
    const logsCount = (db.prepare('SELECT COUNT(*) AS n FROM request_logs').get() as any).n as number;
    if (accountsCount > 0 || keysCount > 0 || logsCount > 0) {
        // SQLite already populated; back up the JSON and stop.
        try { fs.renameSync(LEGACY_JSON_PATH, LEGACY_JSON_BACKUP_PATH); } catch { /* ignore */ }
        return;
    }

    let parsed: LegacyDbFile;
    try {
        parsed = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf-8')) as LegacyDbFile;
    } catch {
        console.warn('⚠️ data/db.json is unreadable — skipping migration.');
        return;
    }

    const insertAccount = db.prepare(`
        INSERT INTO accounts (
            email, id, accessToken, refreshToken, projectId, expiresAt, isActive,
            lastUsedAt, isPro, tierName, exhaustedAt, createdAt, updatedAt,
            totalRequests, successfulRequests, failedRequests, totalTokensUsed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertKey = db.prepare(`
        INSERT INTO api_keys (id, name, keyHash, keyPrefix, createdAt, lastUsedAt, totalRequests)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLog = db.prepare(`
        INSERT INTO request_logs (
            id, accountEmail, question, answer, systemInstruction, model,
            isFallback, tokensUsed, success, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
        for (const a of Object.values(parsed.accounts || {})) {
            insertAccount.run(
                a.email,
                a.id ?? null,
                a.accessToken ?? '',
                a.refreshToken ?? '',
                a.projectId ?? null,
                a.expiresAt ?? null,
                a.isActive ? 1 : 0,
                a.lastUsedAt ?? null,
                a.isPro === undefined ? null : (a.isPro ? 1 : 0),
                a.tierName ?? null,
                a.exhaustedAt ?? null,
                a.createdAt ?? null,
                a.updatedAt ?? null,
                a.totalRequests ?? 0,
                a.successfulRequests ?? 0,
                a.failedRequests ?? 0,
                a.totalTokensUsed ?? 0,
            );
        }
        for (const k of Object.values(parsed.apiKeys || {})) {
            insertKey.run(
                k.id,
                k.name,
                k.keyHash,
                k.keyPrefix ?? null,
                k.createdAt,
                k.lastUsedAt ?? null,
                k.totalRequests ?? 0,
            );
        }
        for (const l of (parsed.logs || [])) {
            insertLog.run(
                l.id ?? generateId(),
                l.accountEmail ?? null,
                l.question ?? null,
                l.answer ?? null,
                l.systemInstruction ?? null,
                l.model ?? null,
                l.isFallback === undefined ? null : (l.isFallback ? 1 : 0),
                l.tokensUsed ?? 0,
                l.success === false ? 0 : 1,
                l.timestamp ?? new Date().toISOString(),
            );
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    try { fs.renameSync(LEGACY_JSON_PATH, LEGACY_JSON_BACKUP_PATH); } catch { /* ignore */ }
    console.log(`✅ Migrated db.json → db.sqlite (${Object.keys(parsed.accounts || {}).length} accounts, ${Object.keys(parsed.apiKeys || {}).length} keys, ${(parsed.logs || []).length} logs).`);
}

function trimLogs(db: DatabaseSync): void {
    const retentionDays = getLoggingConfig().requests.maxDaysRetention;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(cutoff);

    const row = db.prepare('SELECT COUNT(*) AS n FROM request_logs').get() as any;
    if ((row.n as number) <= MAX_LOG_ROWS) return;
    db.exec(`
        DELETE FROM request_logs
        WHERE id IN (
            SELECT id FROM request_logs
            ORDER BY timestamp ASC
            LIMIT (SELECT COUNT(*) FROM request_logs) - ${MAX_LOG_ROWS}
        )
    `);
}

function ensureRequestLogAffinityColumns(db: DatabaseSync): void {
    const columns = new Set(
        (db.prepare('PRAGMA table_info(request_logs)').all() as any[])
            .map(row => String(row.name)),
    );
    const addColumn = (name: string, definition: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${definition}`);
    };

    addColumn('affinityKeyHash', 'TEXT');
    addColumn('affinitySource', 'TEXT');
    addColumn('affinityHit', 'INTEGER');
    addColumn('affinityRebound', 'INTEGER');
    addColumn('promptTokens', 'INTEGER');
    addColumn('completionTokens', 'INTEGER');
    addColumn('effectiveTokensUsed', 'INTEGER');
    addColumn('requestId', 'TEXT');
    addColumn('level', 'TEXT');
    addColumn('method', 'TEXT');
    addColumn('url', 'TEXT');
    addColumn('userApi', 'TEXT');
    addColumn('status', 'INTEGER');
    addColumn('execTimeMs', 'INTEGER');
    addColumn('opengemKey', 'TEXT');
    addColumn('userAgent', 'TEXT');
    addColumn('remoteIp', 'TEXT');
}

function ensureChatConversationColumns(db: DatabaseSync): void {
    const columns = new Set(
        (db.prepare('PRAGMA table_info(chat_conversations)').all() as any[])
            .map(row => String(row.name)),
    );
    const addColumn = (name: string, definition: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE chat_conversations ADD COLUMN ${name} ${definition}`);
    };

    addColumn('messageCount', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('forkedFromId', 'TEXT');
}

// --- Helpers --------------------------------------------------------------

function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}
function generateId(): string {
    return crypto.randomBytes(12).toString('hex');
}
function toIso(val: any, fallback: string = new Date(0).toISOString()): string {
    if (!val) return fallback;
    const d = val instanceof Date ? val : new Date(val);
    return isNaN(d.getTime()) ? fallback : d.toISOString();
}
function toIsoOrNull(val: any): string | null {
    if (!val) return null;
    const d = val instanceof Date ? val : new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseChatMessages(value: any): ChatConversationMessage[] {
    if (!value) return [];
    if (Array.isArray(value)) return value as ChatConversationMessage[];
    try {
        const parsed = JSON.parse(String(value));
        return Array.isArray(parsed) ? parsed as ChatConversationMessage[] : [];
    } catch {
        return [];
    }
}

function rowToAccount(r: any): Account {
    return {
        id: r.id,
        email: r.email,
        accessToken: r.accessToken ? decrypt(r.accessToken) : '',
        refreshToken: r.refreshToken ? decrypt(r.refreshToken) : '',
        projectId: r.projectId,
        expiresAt: r.expiresAt ? new Date(r.expiresAt) : new Date(0),
        isActive: !!r.isActive,
        lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : new Date(0),
        isPro: r.isPro === null || r.isPro === undefined ? undefined : !!r.isPro,
        tierName: r.tierName ?? undefined,
        exhaustedAt: r.exhaustedAt ? new Date(r.exhaustedAt) : undefined,
        createdAt: r.createdAt ? new Date(r.createdAt) : undefined,
        updatedAt: r.updatedAt ? new Date(r.updatedAt) : undefined,
        totalRequests: r.totalRequests ?? 0,
        successfulRequests: r.successfulRequests ?? 0,
        failedRequests: r.failedRequests ?? 0,
        totalTokensUsed: r.totalTokensUsed ?? 0,
    };
}

function rowToChatSummary(r: any): ChatConversationSummary {
    return {
        id: r.id,
        title: r.title,
        model: r.model,
        sessionId: r.sessionId,
        messageCount: r.messageCount ?? parseChatMessages(r.messages).length,
        ...(r.forkedFromId && { forkedFromId: r.forkedFromId }),
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date(0),
        updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(0),
    };
}

function rowToChatConversation(r: any): ChatConversation {
    return {
        ...rowToChatSummary(r),
        messages: parseChatMessages(r.messages),
    };
}

// --- Implementation ------------------------------------------------------

export const sqliteDb: IDatabase = {

    // --- Accounts ---

    async getActiveAccounts(): Promise<Account[]> {
        const rows = getDb().prepare(
            'SELECT * FROM accounts WHERE isActive = 1 ORDER BY lastUsedAt ASC'
        ).all();
        return rows.map(rowToAccount);
    },

    async getAllAccounts(): Promise<Account[]> {
        const rows = getDb().prepare(
            'SELECT * FROM accounts ORDER BY lastUsedAt ASC'
        ).all();
        return rows.map(rowToAccount);
    },

    async upsertAccount(account: Account): Promise<void> {
        const db = getDb();
        const now = new Date().toISOString();
        const existing = db.prepare('SELECT createdAt FROM accounts WHERE email = ?').get(account.email) as any;
        const createdAt = existing?.createdAt || now;

        db.prepare(`
            INSERT INTO accounts (
                email, id, accessToken, refreshToken, projectId, expiresAt, isActive,
                lastUsedAt, isPro, tierName, exhaustedAt, createdAt, updatedAt,
                totalRequests, successfulRequests, failedRequests, totalTokensUsed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                id = excluded.id,
                accessToken = excluded.accessToken,
                refreshToken = excluded.refreshToken,
                projectId = excluded.projectId,
                expiresAt = excluded.expiresAt,
                isActive = excluded.isActive,
                lastUsedAt = excluded.lastUsedAt,
                isPro = excluded.isPro,
                tierName = excluded.tierName,
                exhaustedAt = excluded.exhaustedAt,
                updatedAt = excluded.updatedAt
        `).run(
            account.email,
            account.id ?? null,
            encrypt(account.accessToken || ''),
            encrypt(account.refreshToken || ''),
            account.projectId ?? null,
            toIso(account.expiresAt),
            account.isActive ? 1 : 0,
            toIso(account.lastUsedAt),
            account.isPro === undefined ? null : (account.isPro ? 1 : 0),
            account.tierName ?? null,
            toIsoOrNull(account.exhaustedAt),
            createdAt,
            now,
            account.totalRequests ?? 0,
            account.successfulRequests ?? 0,
            account.failedRequests ?? 0,
            account.totalTokensUsed ?? 0,
        );
    },

    async updateAccount(email: string, data: Partial<Account>): Promise<void> {
        const db = getDb();
        const existing = db.prepare('SELECT email FROM accounts WHERE email = ?').get(email);
        if (!existing) return;

        const sets: string[] = [];
        const vals: any[] = [];
        const set = (col: string, v: any) => { sets.push(`${col} = ?`); vals.push(v); };

        if (data.id !== undefined) set('id', data.id);
        if (data.accessToken !== undefined) set('accessToken', encrypt(data.accessToken));
        if (data.refreshToken !== undefined) set('refreshToken', encrypt(data.refreshToken));
        if (data.projectId !== undefined) set('projectId', data.projectId);
        if (data.expiresAt !== undefined) set('expiresAt', toIso(data.expiresAt));
        if (data.isActive !== undefined) set('isActive', data.isActive ? 1 : 0);
        if (data.lastUsedAt !== undefined) set('lastUsedAt', toIso(data.lastUsedAt));
        if (data.isPro !== undefined) set('isPro', data.isPro ? 1 : 0);
        if (data.tierName !== undefined) set('tierName', data.tierName);
        if (data.exhaustedAt !== undefined) set('exhaustedAt', toIsoOrNull(data.exhaustedAt));

        set('updatedAt', new Date().toISOString());

        vals.push(email);
        db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE email = ?`).run(...vals);
    },

    async incrementAccountStats(email: string, stats: { successful: number; failed: number; tokens: number }): Promise<void> {
        const db = getDb();
        const now = new Date().toISOString();
        db.prepare(`
            UPDATE accounts SET
                totalRequests     = totalRequests + ?,
                successfulRequests = successfulRequests + ?,
                failedRequests    = failedRequests + ?,
                totalTokensUsed   = totalTokensUsed + ?,
                lastUsedAt        = ?,
                updatedAt         = ?
            WHERE email = ?
        `).run(
            (stats.successful || 0) + (stats.failed || 0),
            stats.successful || 0,
            stats.failed || 0,
            stats.tokens || 0,
            now,
            now,
            email,
        );
    },

    async reactivateExhaustedAccounts(cooldownMs: number): Promise<number> {
        const db = getDb();
        const cutoff = new Date(Date.now() - cooldownMs).toISOString();
        const rows = db.prepare(
            'SELECT email FROM accounts WHERE isActive = 0 AND exhaustedAt IS NOT NULL AND exhaustedAt < ?'
        ).all(cutoff) as any[];

        if (rows.length === 0) return 0;
        const now = new Date().toISOString();
        const stmt = db.prepare(
            'UPDATE accounts SET isActive = 1, exhaustedAt = NULL, updatedAt = ? WHERE email = ?'
        );
        for (const r of rows) {
            stmt.run(now, r.email);
            console.log(`♻️ Auto-reactivated account: ${r.email}`);
        }
        return rows.length;
    },

    async reactivateAccount(email: string): Promise<void> {
        getDb().prepare(
            'UPDATE accounts SET isActive = 1, exhaustedAt = NULL, updatedAt = ? WHERE email = ?'
        ).run(new Date().toISOString(), email);
    },

    async deleteAccount(idOrEmail: string): Promise<void> {
        getDb().prepare('DELETE FROM accounts WHERE email = ? OR id = ?').run(idOrEmail, idOrEmail);
    },

    // --- API keys ---

    async createApiKey(name: string, key: string): Promise<ApiKey> {
        const db = getDb();
        const id = generateId();
        const createdAt = new Date().toISOString();
        const keyHash = hashApiKey(key);
        const keyPrefix = key.substring(0, 7);
        db.prepare(`
            INSERT INTO api_keys (id, name, keyHash, keyPrefix, createdAt, totalRequests)
            VALUES (?, ?, ?, ?, ?, 0)
        `).run(id, name, keyHash, keyPrefix, createdAt);
        return { id, name, key, createdAt: new Date(createdAt), totalRequests: 0 };
    },

    async getAllApiKeys(): Promise<ApiKey[]> {
        const rows = getDb().prepare(
            'SELECT id, name, keyPrefix, createdAt, lastUsedAt, totalRequests FROM api_keys ORDER BY createdAt DESC'
        ).all() as any[];
        return rows.map(r => {
            const masked = r.keyPrefix ? r.keyPrefix + '•'.repeat(36) : '•'.repeat(43);
            return {
                id: r.id,
                name: r.name,
                key: masked,
                createdAt: new Date(r.createdAt),
                lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : undefined,
                totalRequests: r.totalRequests || 0,
            };
        });
    },

    async validateApiKey(key: string): Promise<boolean> {
        const db = getDb();
        const keyHash = hashApiKey(key);
        const row = db.prepare('SELECT id FROM api_keys WHERE keyHash = ?').get(keyHash) as any;
        if (!row) return false;
        db.prepare(
            'UPDATE api_keys SET lastUsedAt = ?, totalRequests = totalRequests + 1 WHERE id = ?'
        ).run(new Date().toISOString(), row.id);
        return true;
    },

    async deleteApiKey(id: string): Promise<void> {
        getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    },

    // --- Request logs ---

    async addRequestLog(log: Omit<RequestLog, 'id'>): Promise<void> {
        const db = getDb();
        db.prepare(`
            INSERT INTO request_logs (
                id, accountEmail, question, answer, systemInstruction, model,
                isFallback, affinityKeyHash, affinitySource, affinityHit,
                affinityRebound, promptTokens, completionTokens, effectiveTokensUsed,
                requestId, level, method, url, userApi, status, execTimeMs,
                opengemKey, userAgent, remoteIp, tokensUsed, success, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            generateId(),
            log.accountEmail ?? null,
            log.question ?? null,
            log.answer ?? null,
            log.systemInstruction ?? null,
            log.model ?? null,
            log.isFallback === undefined ? null : (log.isFallback ? 1 : 0),
            log.affinityKeyHash ?? null,
            log.affinitySource ?? null,
            log.affinityHit === undefined ? null : (log.affinityHit ? 1 : 0),
            log.affinityRebound === undefined ? null : (log.affinityRebound ? 1 : 0),
            log.promptTokens ?? null,
            log.completionTokens ?? null,
            log.effectiveTokensUsed ?? null,
            log.requestId ?? null,
            log.level ?? null,
            log.method ?? null,
            log.url ?? null,
            log.userApi ?? null,
            log.status ?? null,
            log.execTimeMs ?? null,
            log.opengemKey ?? null,
            log.userAgent ?? null,
            log.remoteIp ?? null,
            log.tokensUsed ?? 0,
            log.success === false ? 0 : 1,
            toIso(log.timestamp, new Date().toISOString()),
        );
        // Cheap probabilistic trim to avoid running on every insert.
        if (Math.random() < 0.01) trimLogs(db);
    },

    async getRecentLogs(limitCount: number = 50): Promise<RequestLog[]> {
        const rows = getDb().prepare(
            'SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT ?'
        ).all(limitCount) as any[];
        return rows.map(r => ({
            id: r.id,
            accountEmail: r.accountEmail,
            question: r.question,
            answer: r.answer,
            ...(r.systemInstruction && { systemInstruction: r.systemInstruction }),
            ...(r.model && { model: r.model }),
            ...(r.isFallback !== null && r.isFallback !== undefined && { isFallback: !!r.isFallback }),
            ...(r.affinityKeyHash && { affinityKeyHash: r.affinityKeyHash }),
            ...(r.affinitySource && { affinitySource: r.affinitySource }),
            ...(r.affinityHit !== null && r.affinityHit !== undefined && { affinityHit: !!r.affinityHit }),
            ...(r.affinityRebound !== null && r.affinityRebound !== undefined && { affinityRebound: !!r.affinityRebound }),
            ...(r.promptTokens !== null && r.promptTokens !== undefined && { promptTokens: r.promptTokens }),
            ...(r.completionTokens !== null && r.completionTokens !== undefined && { completionTokens: r.completionTokens }),
            ...(r.effectiveTokensUsed !== null && r.effectiveTokensUsed !== undefined && { effectiveTokensUsed: r.effectiveTokensUsed }),
            ...(r.requestId && { requestId: r.requestId }),
            ...(r.level && { level: r.level }),
            ...(r.method && { method: r.method }),
            ...(r.url && { url: r.url }),
            ...(r.userApi && { userApi: r.userApi }),
            ...(r.status !== null && r.status !== undefined && { status: r.status }),
            ...(r.execTimeMs !== null && r.execTimeMs !== undefined && { execTimeMs: r.execTimeMs }),
            ...(r.opengemKey && { opengemKey: r.opengemKey }),
            ...(r.userAgent && { userAgent: r.userAgent }),
            ...(r.remoteIp && { remoteIp: r.remoteIp }),
            tokensUsed: r.tokensUsed || 0,
            success: !!r.success,
            timestamp: new Date(r.timestamp),
        }));
    },

    // --- Admin chat history ---

    async upsertChatConversation(conversation: ChatConversation): Promise<ChatConversation> {
        const db = getDb();
        const now = new Date().toISOString();
        const existing = db.prepare('SELECT createdAt FROM chat_conversations WHERE id = ?').get(conversation.id) as any;
        const createdAt = existing?.createdAt || toIso(conversation.createdAt, now);
        const updatedAt = toIso(conversation.updatedAt, now);
        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];

        db.prepare(`
            INSERT INTO chat_conversations (
                id, title, model, sessionId, messages, messageCount, forkedFromId, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                model = excluded.model,
                sessionId = excluded.sessionId,
                messages = excluded.messages,
                messageCount = excluded.messageCount,
                forkedFromId = excluded.forkedFromId,
                updatedAt = excluded.updatedAt
        `).run(
            conversation.id,
            conversation.title,
            conversation.model,
            conversation.sessionId,
            JSON.stringify(messages),
            messages.length,
            conversation.forkedFromId ?? null,
            createdAt,
            updatedAt,
        );

        const saved = await this.getChatConversation(conversation.id);
        return saved || { ...conversation, createdAt: new Date(createdAt), updatedAt: new Date(updatedAt), messageCount: messages.length };
    },

    async getChatConversations(limitCount: number = 50): Promise<ChatConversationSummary[]> {
        const rows = getDb().prepare(
            'SELECT id, title, model, sessionId, messageCount, forkedFromId, createdAt, updatedAt FROM chat_conversations ORDER BY updatedAt DESC LIMIT ?'
        ).all(limitCount) as any[];
        return rows.map(rowToChatSummary);
    },

    async getChatConversation(id: string): Promise<ChatConversation | null> {
        const row = getDb().prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as any;
        return row ? rowToChatConversation(row) : null;
    },

    async deleteChatConversation(id: string): Promise<void> {
        getDb().prepare('DELETE FROM chat_conversations WHERE id = ?').run(id);
    },

    // --- Stats ---

    async getStats(): Promise<DbStats> {
        const all = await this.getAllAccounts();
        const logs = await this.getRecentLogs(MAX_LOG_ROWS);
        const tokenStats = mergeEffectiveTokenStats(all, logs);
        let totalRequests = 0, successfulRequests = 0, failedRequests = 0, activeAccounts = 0;

        const accountStats = all.map(acc => {
            const t = acc.totalRequests || 0;
            const s = acc.successfulRequests || 0;
            const f = acc.failedRequests || 0;
            const tk = tokenStats.byAccount[acc.email] || 0;
            totalRequests += t;
            successfulRequests += s;
            failedRequests += f;
            if (acc.isActive) activeAccounts++;
            return {
                email: acc.email,
                totalRequests: t,
                successfulRequests: s,
                failedRequests: f,
                totalTokensUsed: tk,
                isActive: acc.isActive,
                isPro: acc.isPro,
            };
        });

        return {
            totalRequests,
            successfulRequests,
            failedRequests,
            totalTokensUsed: tokenStats.totalTokensUsed,
            activeAccounts,
            totalAccounts: all.length,
            accountStats,
        };
    },
};

export default sqliteDb;
