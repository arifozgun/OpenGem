import { closeDb } from '../src/services/sqlite';

afterAll(() => closeDb());

describe('db factory', () => {
    test('returns an object with all required DatabaseService methods', () => {
        // DB_PROVIDER=sqlite is set in setup.ts
        const { db } = require('../src/services/db');

        const requiredMethods = [
            'getActiveAccounts',
            'getAllAccounts',
            'upsertAccount',
            'updateAccount',
            'incrementAccountStats',
            'reactivateExhaustedAccounts',
            'reactivateAccount',
            'deleteAccount',
            'createApiKey',
            'getAllApiKeys',
            'validateApiKey',
            'deleteApiKey',
            'addRequestLog',
            'getRecentLogs',
            'getStats',
        ];

        for (const method of requiredMethods) {
            expect(typeof db[method]).toBe('function');
        }
    });

    test('db is the sqlite backend when DB_PROVIDER=sqlite', () => {
        const { db } = require('../src/services/db');
        const { sqliteDb } = require('../src/services/sqlite');
        expect(db).toBe(sqliteDb);
    });
});
