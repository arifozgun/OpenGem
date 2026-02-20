/**
 * Unit tests for src/services/config.ts
 *
 * All functions tested are pure (no file system side effects) because:
 *  - CONFIG_ENCRYPTION_KEY is set by tests/setup.ts
 *  - isConfigured / saveConfig / getConfig are NOT tested here (they touch disk);
 *    those are exercised indirectly via the HTTP integration tests.
 */

import { encrypt, decrypt, generateApiKey, generateJwtSecret, verifyUsername } from '../src/services/config';

// ─────────────────────────────────────────────
// encrypt / decrypt
// ─────────────────────────────────────────────

describe('encrypt / decrypt', () => {
    test('round-trips plaintext correctly', () => {
        const plain = 'super-secret-value';
        expect(decrypt(encrypt(plain))).toBe(plain);
    });

    test('produces ciphertext with enc:v1: prefix', () => {
        expect(encrypt('hello')).toMatch(/^enc:v1:/);
    });

    test('two encryptions of the same value produce different ciphertexts (random IV)', () => {
        const a = encrypt('same');
        const b = encrypt('same');
        expect(a).not.toBe(b);
    });

    test('decrypting a tampered ciphertext throws', () => {
        const ct = encrypt('value');
        const tampered = ct.slice(0, -4) + 'XXXX';
        expect(() => decrypt(tampered)).toThrow();
    });

    test('decrypt returns non-encrypted strings as-is (backward compat)', () => {
        expect(decrypt('plaintext')).toBe('plaintext');
    });

    test('round-trips unicode strings', () => {
        const unicode = '😀 Hello, 世界!';
        expect(decrypt(encrypt(unicode))).toBe(unicode);
    });
});

// ─────────────────────────────────────────────
// generateApiKey
// ─────────────────────────────────────────────

describe('generateApiKey', () => {
    test('starts with sk-', () => {
        expect(generateApiKey()).toMatch(/^sk-/);
    });

    test('is at least 40 characters long', () => {
        expect(generateApiKey().length).toBeGreaterThanOrEqual(40);
    });

    test('two calls produce different keys', () => {
        expect(generateApiKey()).not.toBe(generateApiKey());
    });
});

// ─────────────────────────────────────────────
// generateJwtSecret
// ─────────────────────────────────────────────

describe('generateJwtSecret', () => {
    test('returns a 128-char hex string', () => {
        const s = generateJwtSecret();
        expect(s).toMatch(/^[0-9a-f]{128}$/);
    });

    test('two calls produce different secrets', () => {
        expect(generateJwtSecret()).not.toBe(generateJwtSecret());
    });
});

// ─────────────────────────────────────────────
// verifyUsername
// ─────────────────────────────────────────────

describe('verifyUsername', () => {
    test('returns true for correct plaintext vs bcrypt hash', async () => {
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash('admin', 4);
        expect(await verifyUsername('admin', hash)).toBe(true);
    });

    test('returns false for wrong plaintext', async () => {
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash('admin', 4);
        expect(await verifyUsername('wrong', hash)).toBe(false);
    });

    test('falls back to direct comparison for un-migrated (non-bcrypt) values', async () => {
        expect(await verifyUsername('admin', 'admin')).toBe(true);
        expect(await verifyUsername('admin', 'other')).toBe(false);
    });
});
