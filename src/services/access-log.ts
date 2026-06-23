import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Request, Response, NextFunction } from 'express';
import { getLoggingConfig } from './config';
import { getDataDir } from './paths';

const DATA_DIR = getDataDir();
const ACCESS_LOG_PATH = path.join(DATA_DIR, 'access-logs.sqlite');
const MAX_ACCESS_LOG_ROWS = 20000;

export interface AccessLogEntry {
    id: string;
    level: 'info' | 'warn' | 'error';
    timestamp: Date;
    method: string;
    url: string;
    userApi: string;
    status: number;
    execTimeMs: number;
    opengemKey?: string;
    userAgent?: string;
    remoteIp?: string;
    requestSize?: number;
    responseSize?: string;
}

export interface RequestLogMetadata {
    requestId: string;
    level: 'info' | 'warn' | 'error';
    method: string;
    url: string;
    userApi: string;
    opengemKey?: string;
    userAgent?: string;
    remoteIp?: string;
    execTimeMs?: number;
}

let _db: DatabaseSync | null = null;

function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function getDb(): DatabaseSync {
    if (_db) return _db;
    ensureDataDir();
    const db = new DatabaseSync(ACCESS_LOG_PATH);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;

        CREATE TABLE IF NOT EXISTS access_logs (
            id            TEXT PRIMARY KEY,
            level         TEXT NOT NULL,
            timestamp     TEXT NOT NULL,
            method        TEXT NOT NULL,
            url           TEXT NOT NULL,
            userApi       TEXT NOT NULL,
            status        INTEGER NOT NULL,
            execTimeMs    INTEGER NOT NULL,
            opengemKey    TEXT,
            userAgent     TEXT,
            remoteIp      TEXT,
            requestSize   INTEGER,
            responseSize  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_access_logs_level ON access_logs(level);
        CREATE INDEX IF NOT EXISTS idx_access_logs_status ON access_logs(status);
    `);
    _db = db;
    return db;
}

function redactSecret(secret?: string | null): string | undefined {
    if (!secret) return undefined;
    const clean = String(secret).trim();
    if (!clean) return undefined;
    if (clean.length <= 12) return `${clean.slice(0, 3)}...`;
    return `${clean.slice(0, 7)}...${clean.slice(-4)}`;
}

function extractOpenGemKey(req: Request): string | undefined {
    const authHeader = req.header('authorization');
    if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match) return match[1].trim();
    }
    const goog = req.header('x-goog-api-key');
    if (goog) return goog.trim();
    const anthropic = req.header('x-api-key');
    if (anthropic) return anthropic.trim();
    if (typeof req.query.key === 'string') return req.query.key;
    return undefined;
}

function sanitizeUrl(req: Request): string {
    const original = req.originalUrl || req.url || req.path || '/';
    const [pathname, query = ''] = original.split('?');
    if (!query) return pathname;
    const params = new URLSearchParams(query);
    for (const key of params.keys()) {
        if (/key|token|secret|password|code/i.test(key)) {
            params.set(key, 'redacted');
        }
    }
    const serialized = params.toString();
    return serialized ? `${pathname}?${serialized}` : pathname;
}

function getClientIp(req: Request): string | undefined {
    const forwarded = req.header('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || req.ip || req.socket.remoteAddress || undefined;
}

function classifyUserApi(req: Request): string {
    const pathName = req.path || '';
    if (pathName.startsWith('/api/v1/')) return 'OpenRouter';
    if (pathName.startsWith('/v1beta/')) return 'Gemini';
    if (pathName === '/v1/models' || pathName.startsWith('/v1/chat/')) return 'OpenAI';
    if (pathName.startsWith('/v1/messages')) return 'Anthropic';
    if (pathName.startsWith('/api/admin')) return 'Admin';
    if (pathName.startsWith('/api/auth')) return 'OAuth';
    if (pathName.startsWith('/api/setup')) return 'Setup';
    return 'Server';
}

function shouldStoreAccessLog(req: Request): boolean {
    if (req.method === 'OPTIONS') return false;
    const pathName = req.path || '';
    if (pathName.startsWith('/api/v1/')) return true;
    if (pathName.startsWith('/v1beta/') || pathName.startsWith('/v1/')) return true;
    if (pathName === '/api/admin/login' || pathName === '/api/admin/login/verify') return true;
    if (pathName === '/api/setup' || pathName.startsWith('/api/auth/')) return true;
    if (req.method !== 'GET' && (
        pathName.startsWith('/api/accounts') ||
        pathName.startsWith('/api/keys') ||
        pathName.startsWith('/api/admin/credentials') ||
        pathName.startsWith('/api/admin/db-switch') ||
        pathName.startsWith('/api/admin/security-settings')
    )) return true;
    return false;
}

function levelFromStatus(status: number): AccessLogEntry['level'] {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return 'info';
}

function trimAccessLogs(db: DatabaseSync): void {
    const settings = getLoggingConfig();
    const cutoff = new Date(Date.now() - settings.logs.maxDaysRetention * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM access_logs WHERE timestamp < ?').run(cutoff);

    const row = db.prepare('SELECT COUNT(*) AS n FROM access_logs').get() as any;
    if ((row.n as number) <= MAX_ACCESS_LOG_ROWS) return;
    db.exec(`
        DELETE FROM access_logs
        WHERE id IN (
            SELECT id FROM access_logs
            ORDER BY timestamp ASC
            LIMIT (SELECT COUNT(*) FROM access_logs) - ${MAX_ACCESS_LOG_ROWS}
        )
    `);
}

function addAccessLog(log: AccessLogEntry): void {
    const db = getDb();
    db.prepare(`
        INSERT INTO access_logs (
            id, level, timestamp, method, url, userApi, status, execTimeMs,
            opengemKey, userAgent, remoteIp, requestSize, responseSize
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        log.id,
        log.level,
        log.timestamp.toISOString(),
        log.method,
        log.url,
        log.userApi,
        log.status,
        log.execTimeMs,
        log.opengemKey ?? null,
        log.userAgent ?? null,
        log.remoteIp ?? null,
        log.requestSize ?? null,
        log.responseSize ?? null,
    );

    if (Math.random() < 0.1) trimAccessLogs(db);
}

export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const settings = getLoggingConfig();
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    const clientIp = getClientIp(req);
    const baseMeta: RequestLogMetadata = {
        requestId: id,
        level: 'info',
        method: req.method,
        url: sanitizeUrl(req),
        userApi: classifyUserApi(req),
        opengemKey: redactSecret(extractOpenGemKey(req)),
        userAgent: req.header('user-agent') || undefined,
        remoteIp: settings.requests.enableIpLogging ? clientIp : undefined,
    };

    (req as any).opengemRequestMeta = baseMeta;
    (req as any).opengemRequestStartedAt = startedAt;
    res.setHeader('x-opengem-request-id', id);

    if (shouldStoreAccessLog(req)) {
        res.on('finish', () => {
            const status = res.statusCode || 0;
            const execTimeMs = Math.max(0, Date.now() - startedAt);
            try {
                addAccessLog({
                    id,
                    level: levelFromStatus(status),
                    timestamp: new Date(),
                    method: req.method,
                    url: baseMeta.url,
                    userApi: baseMeta.userApi,
                    status,
                    execTimeMs,
                    opengemKey: baseMeta.opengemKey,
                    userAgent: baseMeta.userAgent,
                    remoteIp: settings.logs.enableIpLogging ? clientIp : undefined,
                    requestSize: Number(req.header('content-length')) || undefined,
                    responseSize: res.getHeader('content-length')?.toString(),
                });
            } catch (err) {
                console.error('Access log write error:', err);
            }
        });
    }

    next();
}

export function getRequestLogMetadata(req: Request): RequestLogMetadata {
    const meta = (req as any).opengemRequestMeta as RequestLogMetadata | undefined;
    const startedAt = Number((req as any).opengemRequestStartedAt || Date.now());
    if (meta) {
        return {
            ...meta,
            execTimeMs: Math.max(0, Date.now() - startedAt),
        };
    }
    return {
        requestId: crypto.randomUUID(),
        level: 'info',
        method: req.method,
        url: sanitizeUrl(req),
        userApi: classifyUserApi(req),
        opengemKey: redactSecret(extractOpenGemKey(req)),
        userAgent: req.header('user-agent') || undefined,
        remoteIp: getLoggingConfig().requests.enableIpLogging ? getClientIp(req) : undefined,
        execTimeMs: 0,
    };
}

export function getRecentAccessLogs(limitCount: number = 500, search: string = ''): AccessLogEntry[] {
    const db = getDb();
    trimAccessLogs(db);

    const limit = Math.min(1000, Math.max(1, Math.floor(limitCount)));
    const term = search.trim();
    let rows: any[];
    if (term) {
        const like = `%${term}%`;
        rows = db.prepare(`
            SELECT * FROM access_logs
            WHERE id LIKE ?
               OR level LIKE ?
               OR method LIKE ?
               OR url LIKE ?
               OR userApi LIKE ?
               OR CAST(status AS TEXT) LIKE ?
               OR opengemKey LIKE ?
               OR userAgent LIKE ?
               OR remoteIp LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(like, like, like, like, like, like, like, like, like, limit) as any[];
    } else {
        rows = db.prepare('SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as any[];
    }

    return rows.map(row => ({
        id: row.id,
        level: row.level,
        timestamp: new Date(row.timestamp),
        method: row.method,
        url: row.url,
        userApi: row.userApi,
        status: row.status,
        execTimeMs: row.execTimeMs,
        opengemKey: row.opengemKey ?? undefined,
        userAgent: row.userAgent ?? undefined,
        remoteIp: row.remoteIp ?? undefined,
        requestSize: row.requestSize ?? undefined,
        responseSize: row.responseSize ?? undefined,
    }));
}
