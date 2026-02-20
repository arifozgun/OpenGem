import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from './services/db';
import { requireAdmin } from './middleware/auth';
import { isConfigured, getConfig, saveConfig, generateJwtSecret, generateApiKey, verifyUsername } from './services/config';
import {
    OAUTH_CONFIG,
    generatePkce,
    exchangeCodeForTokens,
    discoverProjectId,
    getUserEmail,
    refreshAccessToken,
    GEMINI_API_BASE,
    DEFAULT_MODEL,
    FALLBACK_MODEL
} from './services/gemini';

dotenv.config();

const app = express();
app.set('trust proxy', 1); // Trust first proxy (LiteSpeed/cPanel)
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : false)
        : true,
    credentials: true
}));
app.use(express.json());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
        }
    }
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// --- SETUP MIDDLEWARE ---
// Redirect all requests to /setup if not configured (except setup routes and static files)
app.use((req, res, next) => {
    // Always allow setup routes, static assets
    if (
        req.path === '/setup.html' ||
        req.path === '/setup.css' ||
        req.path === '/setup.js' ||
        req.path === '/api/setup' ||
        req.path === '/api/setup/status' ||
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
        return res.redirect('/setup.html');
    }

    next();
});

// --- SETUP ROUTES ---

app.get('/api/setup/status', (req, res) => {
    res.json({
        configured: isConfigured(),
        sqliteMode: process.env.DB_PROVIDER === 'sqlite',
    });
});

app.post('/api/setup', async (req, res) => {
    // Prevent re-setup if already configured
    if (isConfigured()) {
        return res.status(400).json({ error: 'System is already configured. Reset config.json to reconfigure.' });
    }

    const { firebase, admin } = req.body;
    const isSqliteMode = process.env.DB_PROVIDER === 'sqlite';

    if (!isSqliteMode) {
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
        // Hash both admin credentials with bcrypt (cost factor 12 for 2026 standards)
        const [hashedUsername, hashedPassword] = await Promise.all([
            bcrypt.hash(admin.username, 12),
            bcrypt.hash(admin.password, 12),
        ]);

        const config = {
            firebase: isSqliteMode ? {
                apiKey: '', authDomain: '', projectId: '',
                storageBucket: '', messagingSenderId: '', appId: '',
            } : {
                apiKey: firebase.apiKey,
                authDomain: firebase.authDomain,
                projectId: firebase.projectId,
                storageBucket: firebase.storageBucket,
                messagingSenderId: firebase.messagingSenderId,
                appId: firebase.appId,
                measurementId: firebase.measurementId || '',
            },
            admin: {
                username: hashedUsername,
                password: hashedPassword,
            },
            jwtSecret: generateJwtSecret(),
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString(),
        };

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
    return { username: config.admin.username, password: config.admin.password };
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 login requests per windowMs
    message: { error: 'Too many login attempts, please try again after 15 minutes.' }
});

// --- ADMIN AUTH ROUTES ---

app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const admin = getAdminCredentials();

    // Both username and password are verified via bcrypt.compare (timing-safe)
    const [usernameValid, passwordValid] = await Promise.all([
        verifyUsername(username, admin.username),
        bcrypt.compare(password, admin.password),
    ]);

    if (usernameValid && passwordValid) {
        const token = jwt.sign({ admin: true }, getJwtSecret(), { expiresIn: '12h' });
        res.cookie('admin_session', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 12 * 60 * 60 * 1000 // 12 hours
        });
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_session');
    res.json({ success: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
    res.json({ admin: true });
});

// Simple in-memory store for PKCE verifiers keyed by state parameter
const authStates = new Map<string, string>();

// API Key middleware — validates against Firebase-stored keys
const requireApiKey = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.header('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || (req.query.key as string) || req.header('x-goog-api-key');

    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized. API Key required.' });
    }

    try {
        const isValid = await db.validateApiKey(apiKey);
        if (!isValid) {
            return res.status(401).json({ error: 'Unauthorized. Invalid API Key.' });
        }
        next();
    } catch (err) {
        console.error('API Key validation error:', err);
        return res.status(500).json({ error: 'Internal Server Error.' });
    }
};

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

        // Upsert into database
        await db.upsertAccount({
            id: email, // use email as ID
            email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            projectId,
            expiresAt: tokens.expiresAt,
            isActive: true,
            lastUsedAt: new Date(),
        });

        res.redirect('/');
    } catch (err: any) {
        console.error('Callback error:', err);
        const errMsg = process.env.NODE_ENV === 'production' ? 'Authentication failed. Please try again.' : `Authentication failed: ${err.message}`;
        res.status(500).send(errMsg);
    }
});

// --- ACCOUNT MGMT ROUTES ---

app.get('/api/accounts', requireAdmin, async (req, res) => {
    const accounts = await db.getAllAccounts();
    res.json(accounts);
});

app.put('/api/accounts/:id/reactivate', requireAdmin, async (req, res) => {
    await db.reactivateAccount(String(req.params.id));
    res.json({ success: true });
});

app.delete('/api/accounts/:id', requireAdmin, async (req, res) => {
    await db.deleteAccount(String(req.params.id));
    res.json({ success: true });
});

// --- API KEYS ROUTES ---

app.get('/api/keys', requireAdmin, async (req, res) => {
    try {
        const keys = await db.getAllApiKeys();
        res.json(keys);
    } catch (err: any) {
        console.error('Get keys error:', err);
        res.status(500).json({ error: 'Failed to fetch API keys' });
    }
});

app.post('/api/keys', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Key name is required.' });
        }
        const key = generateApiKey();
        const apiKey = await db.createApiKey(name.trim(), key);
        res.json(apiKey);
    } catch (err: any) {
        console.error('Create key error:', err);
        res.status(500).json({ error: 'Failed to create API key' });
    }
});

app.delete('/api/keys/:id', requireAdmin, async (req, res) => {
    try {
        await db.deleteApiKey(String(req.params.id));
        res.json({ success: true });
    } catch (err: any) {
        console.error('Delete key error:', err);
        res.status(500).json({ error: 'Failed to delete API key' });
    }
});

// --- STATS & LOGS ROUTES ---

app.get('/api/stats', requireAdmin, async (req, res) => {
    try {
        const stats = await db.getStats();
        res.json(stats);
    } catch (err: any) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/logs', requireAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 50;
        const logs = await db.getRecentLogs(limit);
        res.json(logs);
    } catch (err: any) {
        console.error('Logs error:', err);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// --- GEMINI PROXY ROUTE ---

import { handleGenerateContent } from './controllers/chat';

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // Strict API limit per minute to prevent brute force / dos
    message: { error: 'Too many requests. Please try again later.' }
});

// --- SPA ROUTING ---
app.get(['/overview', '/accounts', '/keys', '/logs', '/docs'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.post('/v1beta/models/:model\\::action', apiLimiter, requireApiKey, (req, res, next) => {
    if (req.params.action === 'generateContent' || req.params.action === 'streamGenerateContent') {
        return handleGenerateContent(req, res);
    }
    return res.status(404).json({ error: 'Not found or unsupported action' });
});

const PORT = process.env.PORT || 3050;
const EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

app.listen(PORT, () => {
    console.log(`🚀 OpenGem running on http://localhost:${PORT}`);

    if (!isConfigured()) {
        console.log(`⚙️  Setup required! Visit http://localhost:${PORT}/setup.html to configure.`);
    } else {
        console.log(`✅ System configured and ready.`);
    }

    // Background job: auto-reactivate exhausted accounts every 5 minutes
    setInterval(async () => {
        if (!isConfigured()) return;
        try {
            const count = await db.reactivateExhaustedAccounts(EXHAUSTION_COOLDOWN_MS);
            if (count > 0) {
                console.log(`♻️ Background job: reactivated ${count} exhausted account(s).`);
            }
        } catch (err) {
            console.error('❌ Background reactivation check failed:', err);
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
});

// Export the Express app (for potential future use)
export default app;
