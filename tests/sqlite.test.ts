import { sqliteDb, closeDb } from '../src/services/sqlite';

// Shared test account fixture
const baseAccount = {
    id: 'alice@example.com',
    email: 'alice@example.com',
    accessToken: 'access-token-abc',
    refreshToken: 'refresh-token-xyz',
    projectId: 'my-gcp-project',
    expiresAt: Date.now() + 3_600_000,
    isActive: true,
    lastUsedAt: new Date(),
};

afterAll(() => closeDb());

// ─────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────

describe('accounts', () => {
    beforeEach(async () => {
        // Clean slate for each test
        const all = await sqliteDb.getAllAccounts();
        for (const acc of all) await sqliteDb.deleteAccount(acc.email);
    });

    test('upsertAccount creates a new account with decrypted tokens', async () => {
        await sqliteDb.upsertAccount(baseAccount);
        const accounts = await sqliteDb.getAllAccounts();

        expect(accounts).toHaveLength(1);
        expect(accounts[0].email).toBe('alice@example.com');
        // Tokens should be returned decrypted
        expect(accounts[0].accessToken).toBe('access-token-abc');
        expect(accounts[0].refreshToken).toBe('refresh-token-xyz');
        // isActive should be boolean
        expect(accounts[0].isActive).toBe(true);
    });

    test('upsertAccount does not overwrite stats on re-upsert', async () => {
        await sqliteDb.upsertAccount(baseAccount);
        await sqliteDb.incrementAccountStats('alice@example.com', { successful: 5, failed: 1, tokens: 1000 });

        // Re-upsert (simulates token refresh)
        await sqliteDb.upsertAccount({ ...baseAccount, accessToken: 'new-token' });

        const [acc] = await sqliteDb.getAllAccounts();
        expect(acc.totalRequests).toBe(6);       // preserved
        expect(acc.accessToken).toBe('new-token'); // updated
    });

    test('upsertAccount preserves createdAt on re-upsert', async () => {
        const past = Date.now() - 100_000;
        await sqliteDb.upsertAccount({ ...baseAccount, createdAt: past });
        await sqliteDb.upsertAccount({ ...baseAccount, accessToken: 'updated' });

        const [acc] = await sqliteDb.getAllAccounts();
        // createdAt should not be overwritten
        expect(new Date(acc.createdAt!).getTime()).toBeCloseTo(past, -2);
    });

    test('getAllAccounts sorts by lastUsedAt ascending (LRU first)', async () => {
        const older = Date.now() - 10_000;
        const newer = Date.now();

        await sqliteDb.upsertAccount({ ...baseAccount, email: 'older@example.com', id: 'older@example.com', lastUsedAt: older });
        await sqliteDb.upsertAccount({ ...baseAccount, email: 'newer@example.com', id: 'newer@example.com', lastUsedAt: newer });

        const accounts = await sqliteDb.getAllAccounts();
        expect(accounts[0].email).toBe('older@example.com');
        expect(accounts[1].email).toBe('newer@example.com');
    });

    test('getActiveAccounts returns only active accounts', async () => {
        await sqliteDb.upsertAccount({ ...baseAccount, email: 'active@example.com', id: 'active@example.com', isActive: true });
        await sqliteDb.upsertAccount({ ...baseAccount, email: 'inactive@example.com', id: 'inactive@example.com', isActive: false });

        const active = await sqliteDb.getActiveAccounts();
        expect(active).toHaveLength(1);
        expect(active[0].email).toBe('active@example.com');
    });

    test('updateAccount updates specific fields without touching others', async () => {
        await sqliteDb.upsertAccount(baseAccount);
        await sqliteDb.incrementAccountStats('alice@example.com', { successful: 3, failed: 0, tokens: 500 });

        await sqliteDb.updateAccount('alice@example.com', {
            isActive: false,
            exhaustedAt: new Date(),
        });

        const [acc] = await sqliteDb.getAllAccounts();
        expect(acc.isActive).toBe(false);
        expect(acc.exhaustedAt).toBeDefined();
        expect(acc.totalRequests).toBe(3); // untouched
    });

    test('updateAccount encrypts tokens correctly', async () => {
        await sqliteDb.upsertAccount(baseAccount);
        await sqliteDb.updateAccount('alice@example.com', { accessToken: 'fresh-token' });

        const [acc] = await sqliteDb.getActiveAccounts();
        expect(acc.accessToken).toBe('fresh-token');
    });

    test('incrementAccountStats atomically adds to counters', async () => {
        await sqliteDb.upsertAccount(baseAccount);
        await sqliteDb.incrementAccountStats('alice@example.com', { successful: 2, failed: 1, tokens: 300 });
        await sqliteDb.incrementAccountStats('alice@example.com', { successful: 1, failed: 0, tokens: 150 });

        const [acc] = await sqliteDb.getAllAccounts();
        expect(acc.totalRequests).toBe(4);
        expect(acc.successfulRequests).toBe(3);
        expect(acc.failedRequests).toBe(1);
        expect(acc.totalTokensUsed).toBe(450);
    });

    test('reactivateExhaustedAccounts reactivates accounts past cooldown', async () => {
        const exhaustedLongAgo = Date.now() - 90 * 60 * 1000; // 90 min ago
        await sqliteDb.upsertAccount({
            ...baseAccount,
            isActive: false,
            exhaustedAt: exhaustedLongAgo,
        });

        const count = await sqliteDb.reactivateExhaustedAccounts(60 * 60 * 1000); // 60 min cooldown
        expect(count).toBe(1);

        const [acc] = await sqliteDb.getAllAccounts();
        expect(acc.isActive).toBe(true);
        expect(acc.exhaustedAt).toBeUndefined();
    });

    test('reactivateExhaustedAccounts skips accounts still in cooldown', async () => {
        const exhaustedRecently = Date.now() - 10 * 60 * 1000; // 10 min ago
        await sqliteDb.upsertAccount({
            ...baseAccount,
            isActive: false,
            exhaustedAt: exhaustedRecently,
        });

        const count = await sqliteDb.reactivateExhaustedAccounts(60 * 60 * 1000);
        expect(count).toBe(0);

        const [acc] = await sqliteDb.getAllAccounts();
        expect(acc.isActive).toBe(false);
    });

    test('reactivateAccount manually enables a specific account', async () => {
        await sqliteDb.upsertAccount({ ...baseAccount, isActive: false, exhaustedAt: Date.now() });
        await sqliteDb.reactivateAccount('alice@example.com');

        const [acc] = await sqliteDb.getAllAccounts();
        expect(acc.isActive).toBe(true);
        expect(acc.exhaustedAt).toBeUndefined();
    });

    test('deleteAccount removes account by email', async () => {
        await sqliteDb.upsertAccount(baseAccount);
        await sqliteDb.deleteAccount('alice@example.com');

        const accounts = await sqliteDb.getAllAccounts();
        expect(accounts).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────
// API KEYS
// ─────────────────────────────────────────────

describe('api keys', () => {
    let createdKeyId: string;
    let createdKeyValue: string;

    beforeAll(async () => {
        const result = await sqliteDb.createApiKey('Test Key', 'sk-testkey1234567890abcdefghijklmnopqrstu');
        createdKeyId = result.id!;
        createdKeyValue = result.key;
    });

    afterAll(async () => {
        const all = await sqliteDb.getAllApiKeys();
        for (const k of all) await sqliteDb.deleteApiKey(k.id!);
    });

    test('createApiKey returns the full key value once', async () => {
        // The returned key must be the actual key (not masked)
        expect(createdKeyValue).toBe('sk-testkey1234567890abcdefghijklmnopqrstu');
        expect(createdKeyId).toBeTruthy();
    });

    test('getAllApiKeys returns masked keys, never the hash', async () => {
        const keys = await sqliteDb.getAllApiKeys();
        const key = keys.find(k => k.id === createdKeyId)!;

        expect(key).toBeDefined();
        expect(key.name).toBe('Test Key');
        // Prefix preserved, rest masked
        expect(key.key.startsWith('sk-test')).toBe(true);
        expect(key.key).toContain('\u2022'); // bullet masking
        // Should NOT contain the full key
        expect(key.key).not.toBe(createdKeyValue);
    });

    test('validateApiKey returns true for a valid key and increments totalRequests', async () => {
        const isValid = await sqliteDb.validateApiKey(createdKeyValue);
        expect(isValid).toBe(true);

        const keys = await sqliteDb.getAllApiKeys();
        const key = keys.find(k => k.id === createdKeyId)!;
        expect(key.totalRequests).toBe(1);
    });

    test('validateApiKey returns false for an unknown key', async () => {
        const isValid = await sqliteDb.validateApiKey('sk-totally-fake-key-that-does-not-exist');
        expect(isValid).toBe(false);
    });

    test('deleteApiKey removes the key', async () => {
        const temp = await sqliteDb.createApiKey('Temp', 'sk-tempkey00000000000000000000000000000');
        await sqliteDb.deleteApiKey(temp.id!);

        const all = await sqliteDb.getAllApiKeys();
        expect(all.find(k => k.id === temp.id)).toBeUndefined();
    });
});

// ─────────────────────────────────────────────
// REQUEST LOGS
// ─────────────────────────────────────────────

describe('request logs', () => {
    beforeEach(async () => {
        // No direct "clear logs" method — rely on limit=0 not being an issue,
        // and use distinct data per test. Stats tests use dedicated accounts.
    });

    test('addRequestLog persists a log with a generated id', async () => {
        await sqliteDb.addRequestLog({
            accountEmail: 'logger@example.com',
            question: 'What is 2+2?',
            answer: '4',
            tokensUsed: 10,
            success: true,
            timestamp: new Date(),
        });

        const logs = await sqliteDb.getRecentLogs(10);
        const log = logs.find(l => l.accountEmail === 'logger@example.com');

        expect(log).toBeDefined();
        expect(log!.id).toBeTruthy();
        expect(log!.question).toBe('What is 2+2?');
        expect(log!.success).toBe(true);
        expect(log!.tokensUsed).toBe(10);
    });

    test('getRecentLogs returns entries newest-first', async () => {
        const t1 = Date.now() - 5000;
        const t2 = Date.now();

        await sqliteDb.addRequestLog({ accountEmail: 'order@example.com', question: 'first', answer: 'a', tokensUsed: 1, success: true, timestamp: t1 });
        await sqliteDb.addRequestLog({ accountEmail: 'order@example.com', question: 'second', answer: 'b', tokensUsed: 1, success: true, timestamp: t2 });

        const logs = await sqliteDb.getRecentLogs(100);
        const relevant = logs.filter(l => l.accountEmail === 'order@example.com');

        expect(relevant[0].question).toBe('second');
        expect(relevant[1].question).toBe('first');
    });

    test('getRecentLogs respects the limit', async () => {
        // Add 5 logs
        for (let i = 0; i < 5; i++) {
            await sqliteDb.addRequestLog({ accountEmail: 'limit@example.com', question: `q${i}`, answer: 'a', tokensUsed: 1, success: true, timestamp: Date.now() });
        }

        const logs = await sqliteDb.getRecentLogs(2);
        // We may have more from other tests, but the count must not exceed limit
        expect(logs.length).toBeLessThanOrEqual(2);
    });

    test('addRequestLog handles success=false correctly', async () => {
        await sqliteDb.addRequestLog({
            accountEmail: 'fail@example.com',
            question: 'bad request',
            answer: 'ERROR',
            tokensUsed: 0,
            success: false,
            timestamp: new Date(),
        });

        const logs = await sqliteDb.getRecentLogs(100);
        const log = logs.find(l => l.accountEmail === 'fail@example.com');
        expect(log!.success).toBe(false);
    });
});

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────

describe('getStats', () => {
    beforeAll(async () => {
        // Seed two accounts with known stats
        await sqliteDb.upsertAccount({ ...baseAccount, email: 'stats1@example.com', id: 'stats1@example.com', isActive: true });
        await sqliteDb.upsertAccount({ ...baseAccount, email: 'stats2@example.com', id: 'stats2@example.com', isActive: false });
        await sqliteDb.incrementAccountStats('stats1@example.com', { successful: 10, failed: 2, tokens: 5000 });
        await sqliteDb.incrementAccountStats('stats2@example.com', { successful: 5, failed: 5, tokens: 2000 });
    });

    afterAll(async () => {
        await sqliteDb.deleteAccount('stats1@example.com');
        await sqliteDb.deleteAccount('stats2@example.com');
    });

    test('getStats aggregates totals across all accounts', async () => {
        const stats = await sqliteDb.getStats();

        // stats1: 12 total, stats2: 10 total (plus any from earlier tests)
        expect(stats.totalRequests).toBeGreaterThanOrEqual(22);
        expect(stats.successfulRequests).toBeGreaterThanOrEqual(15);
        expect(stats.failedRequests).toBeGreaterThanOrEqual(7);
        expect(stats.totalTokensUsed).toBeGreaterThanOrEqual(7000);
    });

    test('getStats correctly counts active vs total accounts', async () => {
        const stats = await sqliteDb.getStats();
        const statsAccounts = stats.accountStats.filter(a =>
            a.email === 'stats1@example.com' || a.email === 'stats2@example.com'
        );

        const active = statsAccounts.filter(a => a.isActive);
        const inactive = statsAccounts.filter(a => !a.isActive);

        expect(active).toHaveLength(1);
        expect(active[0].email).toBe('stats1@example.com');
        expect(inactive[0].email).toBe('stats2@example.com');
    });

    test('getStats includes per-account breakdown', async () => {
        const stats = await sqliteDb.getStats();
        const acc1 = stats.accountStats.find(a => a.email === 'stats1@example.com')!;

        expect(acc1.totalRequests).toBe(12);
        expect(acc1.successfulRequests).toBe(10);
        expect(acc1.failedRequests).toBe(2);
        expect(acc1.totalTokensUsed).toBe(5000);
    });
});
