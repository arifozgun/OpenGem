// Must run before any module imports (via jest setupFiles)
// Sets up a safe, isolated test environment — no real DB, no real encryption key needed.
process.env.CONFIG_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-only-never-use-in-production-aabbccdd';
process.env.SQLITE_PATH = ':memory:';
process.env.DB_PROVIDER = 'sqlite';
