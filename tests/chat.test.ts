import { Request, Response } from 'express';
import { closeDb } from '../src/services/sqlite';

// Mock external dependencies before importing the controller
jest.mock('../src/services/http', () => ({
    nativeFetch: jest.fn(),
}));

jest.mock('../src/services/gemini', () => ({
    ...jest.requireActual('../src/services/gemini'),
    refreshAccessToken: jest.fn(),
}));

// Mock the database factory so tests control which backend is used
jest.mock('../src/services/database', () => {
    const actual = jest.requireActual('../src/services/database');
    return {
        ...actual,
        getDatabase: jest.fn(() => {
            const { sqliteDb } = require('../src/services/sqlite');
            return sqliteDb;
        }),
    };
});

import { nativeFetch } from '../src/services/http';
import { refreshAccessToken } from '../src/services/gemini';
import { handleGenerateContent } from '../src/controllers/chat';
import { sqliteDb } from '../src/services/sqlite';

const mockFetch = nativeFetch as jest.Mock;
const mockRefresh = refreshAccessToken as jest.Mock;

// Helper to build a minimal Express Request/Response pair
function makeReqRes(body: object, params = { model: 'gemini-2.5-flash', action: 'generateContent' }) {
    const req = { body, params } as unknown as Request;
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    return { req, res };
}

// A minimal active account fixture
const activeAccount = {
    id: 'chat@example.com',
    email: 'chat@example.com',
    accessToken: 'valid-access-token',
    refreshToken: 'valid-refresh-token',
    projectId: 'test-project',
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    isActive: true,
    lastUsedAt: new Date(),
};

// A valid Gemini-shaped success response
const geminiSuccess = {
    ok: true,
    status: 200,
    json: async () => ({
        response: {
            candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
            usageMetadata: { totalTokenCount: 42 },
        },
        usageMetadata: { totalTokenCount: 42 },
    }),
    text: async () => '',
};

beforeAll(async () => {
    await sqliteDb.upsertAccount(activeAccount);
});

afterAll(async () => {
    await sqliteDb.deleteAccount(activeAccount.email);
    closeDb();
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ─────────────────────────────────────────────
// HAPPY PATH
// ─────────────────────────────────────────────

describe('handleGenerateContent — success', () => {
    test('returns 200 with Gemini response when account is active', async () => {
        mockFetch.mockResolvedValue(geminiSuccess);
        const { req, res } = makeReqRes({ contents: [{ parts: [{ text: 'Hello' }] }] });

        await handleGenerateContent(req, res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ candidates: expect.any(Array) })
        );
        const statusCalls = (res.status as jest.Mock).mock.calls.flat();
        expect(statusCalls.some((code: number) => code >= 400)).toBe(false);
    });

    test('adds default role to content items that have none', async () => {
        mockFetch.mockResolvedValue(geminiSuccess);
        const contents = [{ parts: [{ text: 'Hi' }] }]; // no role
        const { req, res } = makeReqRes({ contents });

        await handleGenerateContent(req, res);

        expect(contents[0]).toHaveProperty('role', 'user');
    });

    test('passes systemInstruction through to Gemini', async () => {
        mockFetch.mockResolvedValue(geminiSuccess);
        const { req, res } = makeReqRes({
            contents: [{ parts: [{ text: 'Hi' }] }],
            systemInstruction: { parts: [{ text: 'Be concise.' }] },
        });

        await handleGenerateContent(req, res);

        const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(callBody.request.systemInstruction).toBeDefined();
    });

    test('passes generationConfig through to Gemini', async () => {
        mockFetch.mockResolvedValue(geminiSuccess);
        const { req, res } = makeReqRes({
            contents: [{ parts: [{ text: 'Hi' }] }],
            generationConfig: { temperature: 0.5 },
        });

        await handleGenerateContent(req, res);

        const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(callBody.request.generationConfig).toEqual({ temperature: 0.5 });
    });
});

// ─────────────────────────────────────────────
// INPUT VALIDATION
// ─────────────────────────────────────────────

describe('handleGenerateContent — input validation', () => {
    test('returns 400 when contents is missing', async () => {
        const { req, res } = makeReqRes({});
        await handleGenerateContent(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 400 when contents is not an array', async () => {
        const { req, res } = makeReqRes({ contents: 'not-an-array' });
        await handleGenerateContent(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
    });
});

// ─────────────────────────────────────────────
// TOKEN REFRESH
// ─────────────────────────────────────────────

describe('handleGenerateContent — token refresh', () => {
    test('refreshes token when expired and retries', async () => {
        // Override account with expired token
        await sqliteDb.updateAccount(activeAccount.email, { expiresAt: Date.now() - 1000 });
        mockRefresh.mockResolvedValue({
            accessToken: 'refreshed-token',
            refreshToken: 'new-refresh',
            expiresAt: new Date(Date.now() + 3_600_000),
        });
        mockFetch.mockResolvedValue(geminiSuccess);

        const { req, res } = makeReqRes({ contents: [{ parts: [{ text: 'Hi' }] }] });
        await handleGenerateContent(req, res);

        expect(mockRefresh).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.any(Array) }));

        // Restore non-expired token for subsequent tests
        await sqliteDb.updateAccount(activeAccount.email, { expiresAt: Date.now() + 3_600_000 });
    });
});

// ─────────────────────────────────────────────
// 429 EXHAUSTION
// ─────────────────────────────────────────────

describe('handleGenerateContent — 429 quota exhaustion', () => {
    test('marks account exhausted on 429 and returns 503 when all accounts fail', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 429,
            json: async () => ({}),
            text: async () => 'Quota exceeded',
        });

        const { req, res } = makeReqRes({ contents: [{ parts: [{ text: 'Hi' }] }] });
        await handleGenerateContent(req, res);

        expect(res.status).toHaveBeenCalledWith(503);

        // Account should be marked inactive
        const accounts = await sqliteDb.getAllAccounts();
        const account = accounts.find(a => a.email === activeAccount.email);
        expect(account?.isActive).toBe(false);

        // Reactivate for subsequent tests
        await sqliteDb.reactivateAccount(activeAccount.email);
    });
});

// ─────────────────────────────────────────────
// NO ACCOUNTS
// ─────────────────────────────────────────────

describe('handleGenerateContent — no accounts', () => {
    test('returns 503 when no active accounts exist', async () => {
        // Deactivate our account temporarily
        await sqliteDb.updateAccount(activeAccount.email, { isActive: false });

        const { req, res } = makeReqRes({ contents: [{ parts: [{ text: 'Hi' }] }] });
        await handleGenerateContent(req, res);

        expect(res.status).toHaveBeenCalledWith(503);

        await sqliteDb.reactivateAccount(activeAccount.email);
    });
});
