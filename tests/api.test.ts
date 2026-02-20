import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { closeDb } from '../src/services/sqlite';

// Mock the config module — keeps tests hermetic (no config.json on disk needed)
jest.mock('../src/services/config', () => {
    const actual = jest.requireActual('../src/services/config');
    return {
        ...actual,
        isConfigured: jest.fn().mockReturnValue(true),
        getConfig: jest.fn(),
        saveConfig: jest.fn(),
    };
});

const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-chars-xxxx';
const TEST_USERNAME = 'admin';
const TEST_PASSWORD = 'Admin1234';

// Lazy-loaded after mocks are set up (typed as any to satisfy supertest's App type)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
let isConfiguredMock: jest.Mock;
let getConfigMock: jest.Mock;

beforeAll(async () => {
    // Generate real bcrypt hashes (cost 4 = fast for tests)
    const [hashedUsername, hashedPassword] = await Promise.all([
        bcrypt.hash(TEST_USERNAME, 4),
        bcrypt.hash(TEST_PASSWORD, 4),
    ]);

    // Wire up the config mock return values
    const { isConfigured, getConfig } = require('../src/services/config');
    isConfiguredMock = isConfigured as jest.Mock;
    getConfigMock = getConfig as jest.Mock;

    getConfigMock.mockReturnValue({
        jwtSecret: TEST_JWT_SECRET,
        admin: { username: hashedUsername, password: hashedPassword },
        firebase: { apiKey: '', authDomain: '', projectId: '', storageBucket: '', messagingSenderId: '', appId: '' },
        setupCompleted: true,
        dbBackend: 'sqlite',
    });

    // Import app after mocks are configured
    app = require('../src/index').default;
});

afterAll(() => closeDb());

// Helper: get a valid admin JWT as a cookie string
function makeAdminCookie(): string {
    const token = jwt.sign({ admin: true }, TEST_JWT_SECRET, { expiresIn: '1h' });
    return `admin_session=${token}`;
}

// ─────────────────────────────────────────────
// SETUP ROUTES
// ─────────────────────────────────────────────

describe('GET /api/setup/status', () => {
    test('returns configured flag', async () => {
        const res = await request(app).get('/api/setup/status');
        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(true);
    });
});

describe('POST /api/setup', () => {
    test('returns 400 when already configured', async () => {
        const res = await request(app).post('/api/setup').send({
            firebase: { apiKey: 'x', authDomain: 'x', projectId: 'x', storageBucket: 'x', messagingSenderId: 'x', appId: 'x' },
            admin: { username: 'admin', password: 'Admin1234' },
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already configured/i);
    });

    test('validates admin password requirements when not yet configured', async () => {
        isConfiguredMock.mockReturnValueOnce(false);
        const res = await request(app).post('/api/setup').send({
            admin: { username: 'admin', password: 'weak' },
            dbBackend: 'sqlite',
        });
        expect(res.status).toBe(400);
    });
});

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────

describe('POST /api/admin/login', () => {
    test('returns 200 and sets cookie for correct credentials', async () => {
        const res = await request(app).post('/api/admin/login')
            .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.headers['set-cookie']).toBeDefined();
        const cookie = res.headers['set-cookie'][0];
        expect(cookie).toContain('admin_session=');
        expect(cookie).toContain('HttpOnly');
    });

    test('returns 401 for wrong password', async () => {
        const res = await request(app).post('/api/admin/login')
            .send({ username: TEST_USERNAME, password: 'WrongPass1' });
        expect(res.status).toBe(401);
    });

    test('returns 401 for wrong username', async () => {
        const res = await request(app).post('/api/admin/login')
            .send({ username: 'hacker', password: TEST_PASSWORD });
        expect(res.status).toBe(401);
    });
});

describe('POST /api/admin/logout', () => {
    test('clears the session cookie', async () => {
        const res = await request(app).post('/api/admin/logout');
        expect(res.status).toBe(200);
        const cookie = res.headers['set-cookie']?.[0] ?? '';
        expect(cookie).toContain('admin_session=;');
    });
});

// ─────────────────────────────────────────────
// PROTECTED ROUTES — NO AUTH
// ─────────────────────────────────────────────

describe('protected routes without authentication', () => {
    const protectedRoutes = [
        { method: 'get', path: '/api/admin/me' },
        { method: 'get', path: '/api/accounts' },
        { method: 'get', path: '/api/keys' },
        { method: 'get', path: '/api/stats' },
        { method: 'get', path: '/api/logs' },
    ] as const;

    test.each(protectedRoutes)('$method $path returns 401', async ({ method, path }) => {
        const res = await (request(app) as any)[method](path);
        expect(res.status).toBe(401);
    });
});

// ─────────────────────────────────────────────
// PROTECTED ROUTES — WITH VALID JWT
// ─────────────────────────────────────────────

describe('GET /api/admin/me', () => {
    test('returns { admin: true } with valid cookie', async () => {
        const res = await request(app).get('/api/admin/me')
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);
        expect(res.body.admin).toBe(true);
    });
});

describe('GET /api/accounts', () => {
    test('returns an array', async () => {
        const res = await request(app).get('/api/accounts')
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('API key CRUD', () => {
    let createdKeyId: string;

    test('POST /api/keys creates a key', async () => {
        const res = await request(app).post('/api/keys')
            .set('Cookie', makeAdminCookie())
            .send({ name: 'Test Key' });
        expect(res.status).toBe(200);
        expect(res.body.key).toMatch(/^sk-/);
        createdKeyId = res.body.id;
    });

    test('GET /api/keys returns the created key', async () => {
        const res = await request(app).get('/api/keys')
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);
        expect(res.body.some((k: any) => k.id === createdKeyId)).toBe(true);
    });

    test('DELETE /api/keys/:id removes the key', async () => {
        const res = await request(app).delete(`/api/keys/${createdKeyId}`)
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);

        const list = await request(app).get('/api/keys').set('Cookie', makeAdminCookie());
        expect(list.body.some((k: any) => k.id === createdKeyId)).toBe(false);
    });

    test('POST /api/keys returns 400 when name is missing', async () => {
        const res = await request(app).post('/api/keys')
            .set('Cookie', makeAdminCookie())
            .send({});
        expect(res.status).toBe(400);
    });
});

describe('GET /api/stats', () => {
    test('returns stats object with expected fields', async () => {
        const res = await request(app).get('/api/stats')
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);
        expect(typeof res.body.totalRequests).toBe('number');
        expect(typeof res.body.successfulRequests).toBe('number');
        expect(Array.isArray(res.body.accountStats)).toBe(true);
    });
});

describe('GET /api/logs', () => {
    test('returns an array', async () => {
        const res = await request(app).get('/api/logs')
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('respects ?limit query param', async () => {
        const res = await request(app).get('/api/logs?limit=1')
            .set('Cookie', makeAdminCookie());
        expect(res.status).toBe(200);
        expect(res.body.length).toBeLessThanOrEqual(1);
    });
});

// ─────────────────────────────────────────────
// API KEY MIDDLEWARE
// ─────────────────────────────────────────────

describe('POST /v1beta/... API key guard', () => {
    test('returns 401 with no key', async () => {
        const res = await request(app)
            .post('/v1beta/models/gemini-2.5-flash:generateContent')
            .send({ contents: [{ parts: [{ text: 'hi' }] }] });
        expect(res.status).toBe(401);
    });

    test('returns 401 with an invalid key', async () => {
        const res = await request(app)
            .post('/v1beta/models/gemini-2.5-flash:generateContent')
            .set('Authorization', 'Bearer sk-fake-key-that-does-not-exist')
            .send({ contents: [{ parts: [{ text: 'hi' }] }] });
        expect(res.status).toBe(401);
    });
});

// ─────────────────────────────────────────────
// SETUP MIDDLEWARE
// ─────────────────────────────────────────────

describe('setup redirect middleware', () => {
    test('redirects non-static routes to /setup.html when not configured', async () => {
        isConfiguredMock.mockReturnValueOnce(false);
        const res = await request(app).get('/overview');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/setup');
    });

    test('allows /setup.html through even when not configured', async () => {
        isConfiguredMock.mockReturnValueOnce(false);
        const res = await request(app).get('/setup.html');
        expect(res.status).not.toBe(302);
    });

    test('allows /api/setup/status through even when not configured', async () => {
        isConfiguredMock.mockReturnValueOnce(false);
        const res = await request(app).get('/api/setup/status');
        expect(res.status).toBe(200);
    });
});
