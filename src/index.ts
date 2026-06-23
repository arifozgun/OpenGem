import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getRuntimeEnvPath } from './services/paths';
import { getDatabase, invalidateDbCache } from './services/database';
import type { ChatConversation, ChatConversationMessage } from './services/database';
import { requireAdmin } from './middleware/auth';
import {
    isConfigured,
    getConfig,
    saveConfig,
    generateJwtSecret,
    generateSessionVersion,
    generateApiKey,
    verifyUsername,
    switchDatabaseBackend,
    updateAdminCredentials,
    updateSecuritySettings,
    isSmtpConfigured,
    getDefaultLoggingConfig,
    type LoggingConfig,
    type SmtpConfig,
} from './services/config';
import {
    OAUTH_CONFIG,
    generatePkce,
    exchangeCodeForTokens,
    discoverProjectId,
    getUserEmail,
    refreshAccessToken,
    checkAccountTier,
    GEMINI_API_BASE,
    DEFAULT_MODEL
} from './services/antigravity';
import { warmAccountCache, invalidateAccountCache } from './services/account-manager';
import { hashAffinityValue } from './services/account-affinity';
import { createTwoFactorChallenge, verifyTwoFactorChallenge } from './services/two-factor';
import { accessLogMiddleware, getRecentAccessLogs } from './services/access-log';

dotenv.config({ path: getRuntimeEnvPath(), quiet: true });
dotenv.config({ quiet: true });

const app = express();
const ADMIN_SESSION_COOKIE = 'admin_session';
const ADMIN_CSRF_COOKIE = 'admin_csrf';
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const BODY_LIMIT = process.env.OPENGEM_BODY_LIMIT || '10mb';

function resolveTrustProxy(): boolean | number | string {
    const value = process.env.TRUST_PROXY;
    if (!value) return 'loopback';
    if (value === 'true') return true;
    if (value === 'false') return false;
    const numeric = Number(value);
    return Number.isInteger(numeric) ? numeric : value;
}

app.set('trust proxy', resolveTrustProxy());

const configuredCorsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const allowAnyCorsOrigin = process.env.NODE_ENV === 'production' && configuredCorsOrigins.includes('*');
app.use(cors({
    origin(origin, callback) {
        if (process.env.NODE_ENV !== 'production') return callback(null, true);
        if (!origin) return callback(null, true);
        if (allowAnyCorsOrigin) return callback(null, true);
        return callback(null, configuredCorsOrigins.includes(origin));
    },
    credentials: !allowAnyCorsOrigin,
    maxAge: 600,
}));
const preBodyLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
});
app.use(['/v1', '/v1beta', '/api/admin/login', '/api/admin/login/verify', '/api/setup'], preBodyLimiter);
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
        }
    }
}));
app.use(cookieParser());
app.use(accessLogMiddleware);
const webDir = path.join(__dirname, '../out');
app.use(express.static(webDir, { index: false, redirect: false }));

function isAdminSurface(pathname: string): boolean {
    return (
        pathname === '/api/stats' ||
        pathname === '/api/logs' ||
        pathname === '/api/requests' ||
        pathname === '/api/server-logs' ||
        pathname.startsWith('/api/admin/') ||
        pathname.startsWith('/api/accounts') ||
        pathname.startsWith('/api/keys') ||
        pathname === '/api/setup' ||
        pathname === '/api/auth/login'
    );
}

function sameOriginForRequest(req: express.Request): string | null {
    const host = req.get('host');
    if (!host) return null;
    return `${req.protocol}://${host}`;
}

app.use((req, res, next) => {
    if (!isAdminSurface(req.path)) return next();

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const origin = req.get('origin');
    if (!origin) return next();

    const sameOrigin = sameOriginForRequest(req);
    if (sameOrigin && origin === sameOrigin) return next();

    return res.status(403).json({ error: 'Forbidden. Admin requests must come from the OpenGem origin.' });
});

function sendWebPage(res: express.Response, route: string) {
    const normalized = route === '/' ? '/index' : route;
    const candidates = [
        path.join(webDir, `${normalized}.html`),
        path.join(webDir, normalized, 'index.html'),
        path.join(webDir, 'index.html'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return res.sendFile(candidate);
        }
    }
    return res.status(500).send('OpenGem frontend build not found. Run `npm run build` before starting the server.');
}

// --- SETUP MIDDLEWARE ---
// Redirect all requests to /setup if not configured (except setup routes and static files)
app.use((req, res, next) => {
    // Always allow setup routes, static assets
    if (
        req.path === '/setup' ||
        req.path === '/api/setup' ||
        req.path === '/api/setup/status' ||
        req.path === '/github' ||
        req.path === '/robots.txt' ||
        req.path.startsWith('/_next/') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.ico') ||
        req.path.endsWith('.png') ||
        req.path.endsWith('.svg') ||
        req.path.endsWith('.woff2')
    ) {
        return next();
    }

    if (!isConfigured()) {
        return res.redirect('/setup');
    }

    next();
});

// --- SETUP ROUTES ---

// Serve setup.html at clean /setup URL
app.get(['/setup', '/setup/'], (req, res) => {
    sendWebPage(res, '/setup');
});

app.get('/api/setup/status', (req, res) => {
    res.json({ configured: isConfigured() });
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\n');
});

app.get('/github', (_req, res) => {
    res.redirect(302, 'https://github.com/arifozgun/OpenGem');
});

app.post('/api/setup', async (req, res) => {
    // Prevent re-setup if already configured
    if (isConfigured()) {
        return res.status(400).json({ error: 'System is already configured. Reset config.json to reconfigure.' });
    }

    const { firebase, admin, dbBackend } = req.body;
    const backend: 'firebase' | 'local' = dbBackend === 'local' ? 'local' : 'firebase';

    // Validate Firebase config only when firebase backend is chosen
    if (backend === 'firebase') {
        if (!firebase || !firebase.apiKey || !firebase.projectId || !firebase.authDomain ||
            !firebase.storageBucket || !firebase.messagingSenderId || !firebase.appId) {
            return res.status(400).json({ error: 'Missing required Firebase configuration fields.' });
        }
    }

    if (!admin || !admin.username || !admin.password) {
        return res.status(400).json({ error: 'Missing admin username or password.' });
    }

    if (admin.password.length < 8) {
        return res.status(400).json({ error: 'Admin password must be at least 8 characters.' });
    }

    if (!/[A-Z]/.test(admin.password) || !/[a-z]/.test(admin.password) || !/[0-9]/.test(admin.password)) {
        return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one digit.' });
    }

    try {
        const [hashedUsername, hashedPassword] = await Promise.all([
            bcrypt.hash(admin.username, 12),
            bcrypt.hash(admin.password, 12),
        ]);

        const config: any = {
            admin: {
                username: hashedUsername,
                password: hashedPassword,
                sessionVersion: generateSessionVersion(),
            },
            jwtSecret: generateJwtSecret(),
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString(),
            dbBackend: backend,
        };

        if (backend === 'firebase') {
            config.firebase = {
                apiKey: firebase.apiKey,
                authDomain: firebase.authDomain,
                projectId: firebase.projectId,
                storageBucket: firebase.storageBucket,
                messagingSenderId: firebase.messagingSenderId,
                appId: firebase.appId,
                measurementId: firebase.measurementId || '',
            };
        }

        saveConfig(config);

        res.json({
            success: true,
            message: 'Setup completed successfully!'
        });
    } catch (err: any) {
        console.error('Setup error:', err);
        const errMsg = process.env.NODE_ENV === 'production' ? 'Setup failed. Please try again.' : 'Setup failed: ' + err.message;
        res.status(500).json({ error: errMsg });
    }
});

// --- Helper to get config values safely ---
function getJwtSecret(): string {
    return getConfig().jwtSecret;
}

function getAdminCredentials() {
    const config = getConfig();
    return {
        username: config.admin.username,
        password: config.admin.password,
        sessionVersion: config.admin.sessionVersion || '',
    };
}

function adminCookieOptions(): express.CookieOptions {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: ADMIN_SESSION_MAX_AGE_MS,
    };
}

function csrfCookieOptions(): express.CookieOptions {
    return {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: ADMIN_SESSION_MAX_AGE_MS,
    };
}

function clearAdminCookies(res: express.Response): void {
    const base = {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict' as const,
        path: '/',
    };
    res.clearCookie(ADMIN_SESSION_COOKIE, { ...base, httpOnly: true });
    res.clearCookie(ADMIN_CSRF_COOKIE, { ...base, httpOnly: false });
}

function issueAdminSession(res: express.Response): void {
    const admin = getAdminCredentials();
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const token = jwt.sign(
        { admin: true, sessionVersion: admin.sessionVersion, csrfToken },
        getJwtSecret(),
        { expiresIn: '12h' },
    );
    res.cookie(ADMIN_SESSION_COOKIE, token, adminCookieOptions());
    res.cookie(ADMIN_CSRF_COOKIE, csrfToken, csrfCookieOptions());
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 login requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again after 15 minutes.' }
});

const twoFactorLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification attempts. Please sign in again.' }
});

// --- ADMIN AUTH ROUTES ---

app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const admin = getAdminCredentials();

    // Both username and password are verified via bcrypt.compare (timing-safe)
    const [usernameValid, passwordValid] = await Promise.all([
        verifyUsername(username, admin.username),
        bcrypt.compare(password, admin.password),
    ]);

    if (usernameValid && passwordValid) {
        const config = getConfig();
        if (isSmtpConfigured(config) && config.smtp) {
            try {
                const challengeId = await createTwoFactorChallenge(config.smtp, config.jwtSecret);
                return res.json({
                    success: false,
                    requiresTwoFactor: true,
                    challengeId,
                    message: 'Verification code sent to the configured admin email.',
                });
            } catch (err) {
                console.error('2FA email send error:', err);
                return res.status(503).json({ error: 'Could not send the verification email. Check SMTP settings.' });
            }
        }
        issueAdminSession(res);
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/login/verify', twoFactorLimiter, (req, res) => {
    const challengeId = typeof req.body?.challengeId === 'string' ? req.body.challengeId : '';
    const code = typeof req.body?.code === 'string' ? req.body.code : '';

    if (!challengeId || !code) {
        return res.status(400).json({ error: 'Verification challenge and code are required.' });
    }

    if (!verifyTwoFactorChallenge(challengeId, code, getJwtSecret())) {
        return res.status(401).json({ error: 'Invalid or expired verification code.' });
    }

    issueAdminSession(res);
    return res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
    clearAdminCookies(res);
    res.json({ success: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
    res.json({ admin: true });
});

function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]/g, '').trim();
}

function normalizeDays(value: unknown, fallback: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(365, Math.max(1, Math.floor(number)));
}

function normalizeLoggingInput(input: any): LoggingConfig {
    const defaults = getDefaultLoggingConfig();
    return {
        requests: {
            maxDaysRetention: normalizeDays(input?.requests?.maxDaysRetention, defaults.requests.maxDaysRetention),
            enableIpLogging: Boolean(input?.requests?.enableIpLogging),
        },
        logs: {
            maxDaysRetention: normalizeDays(input?.logs?.maxDaysRetention, defaults.logs.maxDaysRetention),
            enableIpLogging: Boolean(input?.logs?.enableIpLogging),
        },
    };
}

function validateEmailLike(value: string, field: string): void {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) {
        throw new Error(`${field} must be a valid email address.`);
    }
}

function normalizeSmtpInput(input: any, current?: SmtpConfig): SmtpConfig | null | undefined {
    if (input === undefined) return undefined;
    if (input?.clear === true) return null;

    const host = sanitizeHeaderValue(String(input.host || ''));
    const username = sanitizeHeaderValue(String(input.username || ''));
    const password = typeof input.password === 'string' && input.password.length > 0
        ? input.password
        : (current?.password || '');
    const fromEmail = sanitizeHeaderValue(String(input.fromEmail || username));
    const toEmail = sanitizeHeaderValue(String(input.toEmail || username));
    const port = Number(input.port || 587);
    const anyValue = Boolean(host || username || password || fromEmail || toEmail);

    if (!anyValue) return null;
    if (!host || host.length > 255) throw new Error('SMTP host is required.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP port must be between 1 and 65535.');
    if (!username || username.length > 320) throw new Error('SMTP username is required.');
    if (!password) throw new Error('SMTP password is required. Leave the field blank only when keeping an existing password.');
    validateEmailLike(fromEmail, 'SMTP from email');
    validateEmailLike(toEmail, 'SMTP recipient email');

    return {
        host,
        port,
        secure: Boolean(input.secure),
        username,
        password,
        fromEmail,
        toEmail,
    };
}

function securitySettingsPayload() {
    const config = getConfig();
    const smtp = config.smtp;
    return {
        smtp: smtp ? {
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            username: smtp.username,
            fromEmail: smtp.fromEmail,
            toEmail: smtp.toEmail,
            configured: isSmtpConfigured(config),
            passwordSet: Boolean(smtp.password),
        } : {
            host: '',
            port: 587,
            secure: false,
            username: '',
            fromEmail: '',
            toEmail: '',
            configured: false,
            passwordSet: false,
        },
        logging: config.logging || getDefaultLoggingConfig(),
    };
}

app.get('/api/admin/security-settings', requireAdmin, (_req, res) => {
    try {
        res.json(securitySettingsPayload());
    } catch (err) {
        console.error('Security settings read error:', err);
        res.status(500).json({ error: 'Failed to fetch security settings.' });
    }
});

app.post('/api/admin/security-settings', requireAdmin, (req, res) => {
    try {
        const current = getConfig();
        const smtp = normalizeSmtpInput(req.body?.smtp, current.smtp);
        const logging = req.body?.logging === undefined ? undefined : normalizeLoggingInput(req.body.logging);
        updateSecuritySettings({ smtp, logging });
        res.json({ success: true, ...securitySettingsPayload() });
    } catch (err: any) {
        res.status(400).json({ error: err.message || 'Failed to update security settings.' });
    }
});

// --- CREDENTIAL CHANGE ROUTE ---
//
// Allows an authenticated admin to rotate username and/or password from the
// Settings page. The current password is always required as a re-authentication
// step (defence in depth — a stolen session cookie alone must not be enough
// to lock the legitimate owner out of their own instance).
//
// The same complexity policy enforced at setup time applies here: min 8 chars,
// at least one uppercase, one lowercase, and one digit. Both new credentials
// are bcrypt-hashed (cost 12) before they ever leave this handler.
app.post('/api/admin/credentials', requireAdmin, async (req, res) => {
    try {
        const { currentPassword, newUsername, newPassword } = req.body || {};

        if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({ error: 'Current password is required.' });
        }
        if (!newUsername || typeof newUsername !== 'string' || !newUsername.trim()) {
            return res.status(400).json({ error: 'New username is required.' });
        }
        if (!newPassword || typeof newPassword !== 'string') {
            return res.status(400).json({ error: 'New password is required.' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }
        if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
            return res.status(400).json({ error: 'New password must contain at least one uppercase letter, one lowercase letter, and one digit.' });
        }

        const admin = getAdminCredentials();
        const currentValid = await bcrypt.compare(currentPassword, admin.password);
        if (!currentValid) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const [hashedUsername, hashedPassword] = await Promise.all([
            bcrypt.hash(newUsername.trim(), 12),
            bcrypt.hash(newPassword, 12),
        ]);

        updateAdminCredentials(hashedUsername, hashedPassword);

        // Invalidate the existing session so the admin must re-authenticate with
        // the new credentials. The cookie is httpOnly so the client cannot remove
        // it itself.
        clearAdminCookies(res);
        res.json({ success: true, message: 'Credentials updated. Please log in again.' });
    } catch (err: any) {
        console.error('Credentials change error:', err);
        const errMsg = process.env.NODE_ENV === 'production'
            ? 'Failed to update credentials. Please try again.'
            : 'Failed to update credentials: ' + err.message;
        res.status(500).json({ error: errMsg });
    }
});

// Simple in-memory store for PKCE verifiers keyed by state parameter
const authStates = new Map<string, string>();

/**
 * Extract an API key from the request, supporting all four conventions used
 * by Gemini, OpenAI, and Anthropic SDKs:
 *   - Authorization: Bearer <key>     (Gemini, OpenAI)
 *   - x-goog-api-key: <key>           (Gemini)
 *   - x-api-key: <key>                (Anthropic)
 *   - ?key=<key>                      (Gemini query string fallback)
 */
function extractApiKey(req: express.Request): string | null {
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
    return null;
}

/**
 * Build a protocol-appropriate 401 / 500 response.
 * `errorShape` lets each compatibility surface return errors in the format
 * its SDK expects, instead of leaking the Gemini-shape `{error: "..."}`.
 */
function sendAuthError(
    res: express.Response,
    status: number,
    message: string,
    shape: 'gemini' | 'openai' | 'anthropic',
): void {
    if (res.headersSent) return;
    if (shape === 'openai') {
        res.status(status).json({
            error: { message, type: 'invalid_request_error', param: null, code: status === 401 ? 'invalid_api_key' : null },
        });
        return;
    }
    if (shape === 'anthropic') {
        res.status(status).json({
            type: 'error',
            error: { type: status === 401 ? 'authentication_error' : 'api_error', message },
        });
        return;
    }
    res.status(status).json({ error: message });
}

function makeApiKeyMiddleware(shape: 'gemini' | 'openai' | 'anthropic') {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const apiKey = extractApiKey(req);
        if (!apiKey) {
            return sendAuthError(res, 401, 'Unauthorized. API Key required.', shape);
        }
        try {
            const isValid = await getDatabase().validateApiKey(apiKey);
            if (!isValid) {
                return sendAuthError(res, 401, 'Unauthorized. Invalid API Key.', shape);
            }
            (req as any).opengemApiKeyHash = hashAffinityValue(apiKey);
            next();
        } catch (err) {
            console.error('API Key validation error:', err);
            return sendAuthError(res, 500, 'Internal Server Error.', shape);
        }
    };
}

// Backwards-compatible alias used by the existing Gemini proxy route.
const requireApiKey = makeApiKeyMiddleware('gemini');

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// --- AUTH ROUTES ---

// 1. Redirect to Google Consent screen
app.get('/api/auth/login', requireAdmin, (req, res) => {
    const { verifier, challenge } = generatePkce();
    // Separate cryptographic state parameter for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');
    authStates.set(state, verifier);

    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        response_type: 'code',
        redirect_uri: OAUTH_CONFIG.redirectUri,
        scope: OAUTH_CONFIG.scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state,
        access_type: 'offline',
        prompt: 'consent',
    });

    res.redirect(`${OAUTH_CONFIG.authUrl}?${params.toString()}`);
});

// 2. Callback from Google
app.get('/api/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error || !code || !state) {
        return res.status(400).send(`OAuth Error: ${error || 'Missing parameters'}`);
    }

    const verifier = authStates.get(state as string);
    if (!verifier) {
        return res.status(400).send('Invalid or expired authentication state.');
    }
    authStates.delete(state as string);

    try {
        // Exchange code
        const tokens = await exchangeCodeForTokens(code as string, verifier);

        // Discover project ID and Email
        const email = await getUserEmail(tokens.accessToken);
        const projectId = await discoverProjectId(tokens.accessToken);

        // Check account tier
        const { isPro, tierName } = await checkAccountTier(tokens.accessToken);

        // Upsert into database
        await getDatabase().upsertAccount({
            id: email, // use email as ID
            email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            projectId,
            expiresAt: tokens.expiresAt,
            isActive: true,
            isPro,
            tierName,
            lastUsedAt: new Date(),
        });
        invalidateAccountCache(); // Newly added account should be available immediately

        res.redirect('/');
    } catch (err: any) {
        console.error('Callback error:', err);
        const errMsg = process.env.NODE_ENV === 'production' ? 'Authentication failed. Please try again.' : `Authentication failed: ${err.message}`;
        res.status(500).send(errMsg);
    }
});

// --- ACCOUNT MGMT ROUTES ---

app.get('/api/accounts', requireAdmin, async (req, res) => {
    const accounts = await getDatabase().getAllAccounts();
    res.json(accounts);
});

app.put('/api/accounts/:id/reactivate', requireAdmin, async (req, res) => {
    await getDatabase().reactivateAccount(String(req.params.id));
    invalidateAccountCache(); // Sync in-memory account list
    res.json({ success: true });
});

app.delete('/api/accounts/:id', requireAdmin, async (req, res) => {
    await getDatabase().deleteAccount(String(req.params.id));
    invalidateAccountCache(); // Sync in-memory account list
    res.json({ success: true });
});

// --- API KEYS ROUTES ---

app.get('/api/keys', requireAdmin, async (req, res) => {
    try {
        const keys = await getDatabase().getAllApiKeys();
        res.json(keys);
    } catch (err: any) {
        console.error('Get keys error:', err);
        res.status(500).json({ error: 'Failed to fetch API keys' });
    }
});

app.post('/api/keys', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Key name is required.' });
        }
        const trimmedName = String(name).trim();
        if (trimmedName.length > 80) {
            return res.status(400).json({ error: 'Key name must be 80 characters or fewer.' });
        }
        const key = generateApiKey();
        const apiKey = await getDatabase().createApiKey(trimmedName, key);
        res.json(apiKey);
    } catch (err: any) {
        console.error('Create key error:', err);
        res.status(500).json({ error: 'Failed to create API key' });
    }
});

app.delete('/api/keys/:id', requireAdmin, async (req, res) => {
    try {
        await getDatabase().deleteApiKey(String(req.params.id));
        res.json({ success: true });
    } catch (err: any) {
        console.error('Delete key error:', err);
        res.status(500).json({ error: 'Failed to delete API key' });
    }
});

// --- ADMIN CHAT HISTORY VALIDATION ---

const CHAT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;
const CHAT_SESSION_RE = /^[a-zA-Z0-9:_-]{8,140}$/;
const MAX_CHAT_TITLE_LENGTH = 120;
const MAX_CHAT_MODEL_LENGTH = 120;
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_TEXT_LENGTH = 100_000;
const MAX_CHAT_TOTAL_CHARS = 750_000;

function validChatId(value: unknown): value is string {
    return typeof value === 'string' && CHAT_ID_RE.test(value);
}

function cleanChatString(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\0/g, '').trim().slice(0, maxLength);
}

function cleanChatText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\0/g, '').slice(0, maxLength);
}

function cleanChatTimestamp(value: unknown, fallback: Date): string {
    if (!value) return fallback.toISOString();
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString();
}

function deriveChatTitle(title: unknown, messages: ChatConversationMessage[]): string {
    const explicit = cleanChatString(title, MAX_CHAT_TITLE_LENGTH);
    if (explicit) return explicit;
    const firstUserMessage = messages.find(message => message.role === 'user')?.text || '';
    const collapsed = firstUserMessage.replace(/\s+/g, ' ').trim();
    return (collapsed || 'New chat').slice(0, MAX_CHAT_TITLE_LENGTH);
}

function sanitizeChatMessages(rawMessages: unknown): { messages: ChatConversationMessage[]; error?: string } {
    if (!Array.isArray(rawMessages)) {
        return { messages: [], error: 'Messages must be an array.' };
    }
    if (rawMessages.length > MAX_CHAT_MESSAGES) {
        return { messages: [], error: `Chat history is limited to ${MAX_CHAT_MESSAGES} messages.` };
    }

    let totalChars = 0;
    const now = new Date();
    const messages: ChatConversationMessage[] = [];

    for (const raw of rawMessages) {
        if (!raw || typeof raw !== 'object') {
            return { messages: [], error: 'Each message must be an object.' };
        }

        const entry = raw as Record<string, unknown>;
        const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null;
        if (!role) {
            return { messages: [], error: 'Message role must be "user" or "assistant".' };
        }

        const text = cleanChatText(entry.text, MAX_CHAT_TEXT_LENGTH);
        const thought = cleanChatText(entry.thought, MAX_CHAT_TEXT_LENGTH);
        const error = cleanChatText(entry.error, 2_000);
        const model = cleanChatString(entry.model, MAX_CHAT_MODEL_LENGTH);
        totalChars += text.length + thought.length + error.length;
        if (totalChars > MAX_CHAT_TOTAL_CHARS) {
            return { messages: [], error: 'Chat history payload is too large.' };
        }

        messages.push({
            id: validChatId(entry.id) ? entry.id : crypto.randomUUID(),
            role,
            text,
            ...(thought ? { thought } : {}),
            ...(model ? { model } : {}),
            ...(error ? { error } : {}),
            createdAt: cleanChatTimestamp(entry.createdAt, now),
            ...(entry.editedAt ? { editedAt: cleanChatTimestamp(entry.editedAt, now) } : {}),
            ...(validChatId(entry.forkedFromMessageId) ? { forkedFromMessageId: entry.forkedFromMessageId } : {}),
        });
    }

    return { messages };
}

function sanitizeChatConversationPayload(id: string, body: any): { conversation?: ChatConversation; error?: string } {
    if (!validChatId(id)) {
        return { error: 'Invalid chat conversation id.' };
    }

    const { messages, error } = sanitizeChatMessages(body?.messages);
    if (error) return { error };

    const model = cleanChatString(body?.model, MAX_CHAT_MODEL_LENGTH) || DEFAULT_MODEL;
    const sessionId = CHAT_SESSION_RE.test(String(body?.sessionId || '')) ? String(body.sessionId) : id;
    const now = new Date();

    return {
        conversation: {
            id,
            title: deriveChatTitle(body?.title, messages),
            model,
            sessionId,
            messages,
            messageCount: messages.length,
            ...(validChatId(body?.forkedFromId) && { forkedFromId: body.forkedFromId }),
            createdAt: now,
            updatedAt: now,
        },
    };
}

// --- STATS & LOGS ROUTES ---

app.get('/api/stats', requireAdmin, async (req, res) => {
    try {
        const stats = await getDatabase().getStats();
        res.json(stats);
    } catch (err: any) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

async function sendRequestLogs(req: express.Request, res: express.Response): Promise<void> {
    try {
        const limit = clampInteger(req.query.limit, 50, 1, 500);
        const logs = await getDatabase().getRecentLogs(limit);
        res.json(logs);
    } catch (err: any) {
        console.error('Logs error:', err);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
}

app.get('/api/requests', requireAdmin, sendRequestLogs);

app.get('/api/logs', requireAdmin, sendRequestLogs);

app.get('/api/server-logs', requireAdmin, async (req, res) => {
    try {
        const limit = clampInteger(req.query.limit, 500, 1, 1000);
        const search = typeof req.query.search === 'string' ? req.query.search : '';
        res.json(getRecentAccessLogs(limit, search));
    } catch (err: any) {
        console.error('Server logs error:', err);
        res.status(500).json({ error: 'Failed to fetch server logs' });
    }
});

// --- DATABASE BACKEND ROUTES ---

app.get('/api/admin/db-status', requireAdmin, (req, res) => {
    try {
        const config = getConfig();
        res.json({ backend: config.dbBackend || 'firebase' });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to get DB status' });
    }
});

app.post('/api/admin/db-switch', requireAdmin, async (req, res) => {
    const { to, firebase } = req.body;

    if (to !== 'firebase' && to !== 'local') {
        return res.status(400).json({ error: 'Invalid backend. Must be "firebase" or "local".' });
    }

    const currentConfig = getConfig();
    const currentBackend = currentConfig.dbBackend || 'firebase';

    if (currentBackend === to) {
        return res.status(400).json({ error: `Already using ${to} backend.` });
    }

    // Validate Firebase config when switching to firebase
    if (to === 'firebase') {
        if (!firebase || !firebase.apiKey || !firebase.projectId || !firebase.authDomain ||
            !firebase.storageBucket || !firebase.messagingSenderId || !firebase.appId) {
            return res.status(400).json({ error: 'Missing required Firebase configuration fields.' });
        }
    }

    try {
        const sourceDb = getDatabase();

        // Update config FIRST so getDatabase() returns the new backend
        switchDatabaseBackend(to, to === 'firebase' ? firebase : undefined);
        invalidateDbCache();
        const targetDb = getDatabase();

        console.log(`🔄 Migrating data from ${currentBackend} → ${to}...`);

        // Migrate accounts (raw data — do not double-encrypt tokens)
        const accounts = await sourceDb.getAllAccounts();
        for (const account of accounts) {
            await targetDb.upsertAccount(account);
        }

        // Migrate API keys (re-create by name; we lost the original key text so regenerate)
        // Note: we cannot migrate key hashes cross-backend since we don't store the raw key.
        // Instead we copy the metadata, flagging that users may need to regenerate keys.
        // For now we skip key migration and let the user know.

        // Migrate logs
        const logs = await sourceDb.getRecentLogs(5000);
        for (const log of [...logs].reverse()) {
            await targetDb.addRequestLog({
                accountEmail: log.accountEmail,
                question: log.question,
                answer: log.answer,
                ...(log.systemInstruction && { systemInstruction: log.systemInstruction }),
                ...(log.model && { model: log.model }),
                ...(log.isFallback !== undefined && { isFallback: log.isFallback }),
                ...(log.affinityKeyHash && { affinityKeyHash: log.affinityKeyHash }),
                ...(log.affinitySource && { affinitySource: log.affinitySource }),
                ...(log.affinityHit !== undefined && { affinityHit: log.affinityHit }),
                ...(log.affinityRebound !== undefined && { affinityRebound: log.affinityRebound }),
                ...(log.promptTokens !== undefined && { promptTokens: log.promptTokens }),
                ...(log.completionTokens !== undefined && { completionTokens: log.completionTokens }),
                ...(log.effectiveTokensUsed !== undefined && { effectiveTokensUsed: log.effectiveTokensUsed }),
                ...(log.requestId && { requestId: log.requestId }),
                ...(log.level && { level: log.level }),
                ...(log.method && { method: log.method }),
                ...(log.url && { url: log.url }),
                ...(log.userApi && { userApi: log.userApi }),
                ...(log.status !== undefined && { status: log.status }),
                ...(log.execTimeMs !== undefined && { execTimeMs: log.execTimeMs }),
                ...(log.opengemKey && { opengemKey: log.opengemKey }),
                ...(log.userAgent && { userAgent: log.userAgent }),
                ...(log.remoteIp && { remoteIp: log.remoteIp }),
                tokensUsed: log.tokensUsed,
                success: log.success,
                timestamp: log.timestamp,
            });
        }

        const conversationSummaries = await sourceDb.getChatConversations(5000);
        let conversations = 0;
        for (const summary of conversationSummaries) {
            const conversation = await sourceDb.getChatConversation(summary.id);
            if (!conversation) continue;
            await targetDb.upsertChatConversation(conversation);
            conversations++;
        }

        console.log(`✅ Migration complete. ${accounts.length} accounts, ${logs.length} logs, ${conversations} chats migrated.`);

        res.json({
            success: true,
            backend: to,
            migrated: { accounts: accounts.length, logs: logs.length, conversations },
            note: 'API keys could not be automatically migrated. Please regenerate them in the Keys tab.',
        });

        // Restart the process so the new backend is fully initialised from a clean state.
        // nodemon / pm2 will automatically bring the server back up.
        console.log(`🔁 Restarting server to apply new database backend (${to})...`);
        // Exit with non-zero code so nodemon treats it as a crash and auto-restarts.
        // Exit 0 (clean) tells nodemon to wait for file changes — exit 1 forces restart.
        setTimeout(() => process.exit(1), 500);
    } catch (err: any) {
        console.error('DB switch error:', err);
        // Try to roll back config change
        try { switchDatabaseBackend(currentBackend as any); invalidateDbCache(); } catch { }
        const errMsg = process.env.NODE_ENV === 'production'
            ? 'Database switch failed. Please try again.'
            : 'Database switch failed: ' + err.message;
        res.status(500).json({ error: errMsg });
    }
});

// --- UPDATE ROUTES ---

// --- COMPATIBILITY CONTROLLERS ---

import { handleGenerateContent, handleAdminChat } from './controllers/chat';
import { handleOpenAIChatCompletions, handleOpenAIListModels } from './controllers/openai';
import { handleOpenAIResponses } from './controllers/openai-responses';
import { handleAnthropicMessages } from './controllers/anthropic';

// --- MODEL CONFIGURATION ROUTES ---



const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // Strict API limit per minute to prevent brute force / dos
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
});

// --- ADMIN CHAT HISTORY ROUTES ---

app.get('/api/admin/chat/conversations', requireAdmin, async (req, res) => {
    try {
        const requested = Number(req.query.limit || 50);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 100) : 50;
        res.json(await getDatabase().getChatConversations(limit));
    } catch (err: any) {
        console.error('Chat history list error:', err);
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

app.get('/api/admin/chat/conversations/:id', requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id);
        if (!validChatId(id)) {
            return res.status(400).json({ error: 'Invalid chat conversation id.' });
        }
        const conversation = await getDatabase().getChatConversation(id);
        if (!conversation) {
            return res.status(404).json({ error: 'Chat conversation not found.' });
        }
        res.json(conversation);
    } catch (err: any) {
        console.error('Chat history detail error:', err);
        res.status(500).json({ error: 'Failed to fetch chat conversation' });
    }
});

app.put('/api/admin/chat/conversations/:id', requireAdmin, async (req, res) => {
    try {
        const { conversation, error } = sanitizeChatConversationPayload(String(req.params.id), req.body || {});
        if (error || !conversation) {
            return res.status(400).json({ error: error || 'Invalid chat conversation.' });
        }
        const saved = await getDatabase().upsertChatConversation(conversation);
        res.json(saved);
    } catch (err: any) {
        console.error('Chat history save error:', err);
        res.status(500).json({ error: 'Failed to save chat conversation' });
    }
});

app.delete('/api/admin/chat/conversations/:id', requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id);
        if (!validChatId(id)) {
            return res.status(400).json({ error: 'Invalid chat conversation id.' });
        }
        await getDatabase().deleteChatConversation(id);
        res.json({ success: true });
    } catch (err: any) {
        console.error('Chat history delete error:', err);
        res.status(500).json({ error: 'Failed to delete chat conversation' });
    }
});

// --- ADMIN CHAT ROUTE ---
app.post('/api/admin/chat', requireAdmin, (req, res) => {
    handleAdminChat(req, res);
});

// --- SPA ROUTING ---

app.get(/^\/(overview|accounts|keys|logs|requests|docs|chat|settings)\/?$/, (req, res) => {
    sendWebPage(res, req.path.replace(/\/$/, ''));
});

app.get('/', (req, res) => {
    sendWebPage(res, '/');
});

app.post('/v1beta/models/:model\\::action', apiLimiter, requireApiKey, (req, res, next) => {
    if (req.params.action === 'generateContent' || req.params.action === 'streamGenerateContent') {
        return handleGenerateContent(req, res);
    }
    return res.status(404).json({ error: 'Not found or unsupported action' });
});

// --- OPENAI-COMPATIBLE ROUTES ---

const requireApiKeyOpenAI = makeApiKeyMiddleware('openai');
const requireApiKeyAnthropic = makeApiKeyMiddleware('anthropic');

app.post('/v1/chat/completions', apiLimiter, requireApiKeyOpenAI, (req, res) => {
    handleOpenAIChatCompletions(req, res);
});

app.post('/v1/responses', apiLimiter, requireApiKeyOpenAI, (req, res) => {
    handleOpenAIResponses(req, res);
});

app.get('/v1/models', requireApiKeyOpenAI, (req, res) => {
    handleOpenAIListModels(req, res);
});

// OpenRouter-compatible base path aliases. These routes intentionally share
// the exact same auth, rate limits and controllers as `/v1/*`.
app.post('/api/v1/chat/completions', apiLimiter, requireApiKeyOpenAI, (req, res) => {
    handleOpenAIChatCompletions(req, res);
});

app.post('/api/v1/responses', apiLimiter, requireApiKeyOpenAI, (req, res) => {
    handleOpenAIResponses(req, res);
});

app.get('/api/v1/models', requireApiKeyOpenAI, (req, res) => {
    handleOpenAIListModels(req, res);
});

// --- ANTHROPIC-COMPATIBLE ROUTES ---

app.post('/v1/messages', apiLimiter, requireApiKeyAnthropic, (req, res) => {
    handleAnthropicMessages(req, res);
});

app.post('/api/v1/messages', apiLimiter, requireApiKeyAnthropic, (req, res) => {
    handleAnthropicMessages(req, res);
});

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: `Request body too large. Limit is ${BODY_LIMIT}.` });
    }
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Malformed JSON request body.' });
    }
    console.error('Unhandled request error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = Number(process.env.PORT) || 3050;
// Bind to loopback by default — production deployments behind nginx/Cloudflare
// should never expose this Node process directly to the public internet.
// Operators who run OpenGem on the open internet (rare) can opt in by setting
// HOST=0.0.0.0 explicitly.
const HOST = process.env.HOST || '127.0.0.1';
const EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

app.listen(PORT, HOST, async () => {
    console.log(`🚀 OpenGem running on http://${HOST}:${PORT}`);

    if (!isConfigured()) {
        console.log(`⚙️  Setup required! Visit http://localhost:${PORT}/setup to configure.`);
    } else {
        console.log(`✅ System configured and ready.`);
        // Warm the in-memory account cache so the first request is instant
        warmAccountCache().catch(err => console.error('Account cache warm failed:', err));
    }

    // Background job: auto-reactivate exhausted accounts every 5 minutes
    setInterval(async () => {
        if (!isConfigured()) return;
        try {
            const count = await getDatabase().reactivateExhaustedAccounts(EXHAUSTION_COOLDOWN_MS);
            if (count > 0) {
                console.log(`♻️ Background job: reactivated ${count} exhausted account(s).`);
                invalidateAccountCache(); // Refresh cache after reactivations
            }
        } catch (err) {
            console.error('❌ Background reactivation check failed:', err);
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
});

// Export the Express app (for potential future use)
export default app;
