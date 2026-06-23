import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { getConfigPath, getRuntimeEnvPath } from './paths';

const CONFIG_PATH = getConfigPath();

// --- Encryption Constants ---
const ENCRYPTION_PREFIX = 'enc:v1:';
const BCRYPT_PREFIX = '$2b$';
const SCRYPT_SALT = 'opengem-config-key-derivation-2026'; // Fixed application-level salt for key derivation
const SCRYPT_KEYLEN = 32; // 256 bits for AES-256
const SCRYPT_COST = 2 ** 14; // N parameter (16384 — secure and within Node.js 32MB maxmem)
const SCRYPT_BLOCK_SIZE = 8; // r parameter
const SCRYPT_PARALLELIZATION = 1; // p parameter
const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

// --- Types ---

export interface AppConfig {
    firebase?: {
        apiKey: string;
        authDomain: string;
        projectId: string;
        storageBucket: string;
        messagingSenderId: string;
        appId: string;
        measurementId?: string;
    };
    admin: {
        username: string;
        password: string;
        sessionVersion?: string;
    };
    jwtSecret: string;
    setupCompleted: boolean;
    setupCompletedAt?: string;
    /** Which database backend to use. Defaults to 'firebase' for backward compat. */
    dbBackend?: 'firebase' | 'local';
    smtp?: SmtpConfig;
    logging?: LoggingConfig;
}

export interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromEmail: string;
    toEmail: string;
}

export interface LogPageConfig {
    maxDaysRetention: number;
    enableIpLogging: boolean;
}

export interface LoggingConfig {
    requests: LogPageConfig;
    logs: LogPageConfig;
}

// The raw JSON shape on disk (encrypted values are strings)
interface EncryptedConfig {
    firebase?: {
        apiKey: string;
        authDomain: string;
        projectId: string;
        storageBucket: string;
        messagingSenderId: string;
        appId: string;
        measurementId?: string;
    };
    admin: {
        username: string; // bcrypt hash
        password: string; // bcrypt hash
        sessionVersion?: string;
    };
    jwtSecret: string; // AES-256-GCM encrypted
    setupCompleted: boolean;
    setupCompletedAt?: string;
    dbBackend?: 'firebase' | 'local';
    smtp?: {
        host: string;
        port: number;
        secure: boolean;
        username: string;
        password: string;
        fromEmail: string;
        toEmail: string;
    };
    logging?: {
        requests?: Partial<LogPageConfig>;
        logs?: Partial<LogPageConfig>;
    };
}

const DEFAULT_LOGGING_CONFIG: LoggingConfig = {
    requests: {
        maxDaysRetention: 30,
        enableIpLogging: false,
    },
    logs: {
        maxDaysRetention: 14,
        enableIpLogging: false,
    },
};

// --- Encryption Key Management ---

let _derivedKey: Buffer | null = null;
let _fallbackAdminSessionVersion: string | null = null;

function getEncryptionKey(): Buffer {
    if (_derivedKey) return _derivedKey;

    let masterKey = process.env.CONFIG_ENCRYPTION_KEY;

    if (!masterKey) {
        // Auto-generate and persist to .env if not present
        masterKey = crypto.randomBytes(64).toString('hex');
        const envPath = getRuntimeEnvPath();
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
        }
        envContent += `\n# Auto-generated config encryption key — DO NOT SHARE OR LOSE THIS\nCONFIG_ENCRYPTION_KEY=${masterKey}\n`;
        fs.writeFileSync(envPath, envContent, 'utf-8');
        process.env.CONFIG_ENCRYPTION_KEY = masterKey;
        console.log('🔐 Generated new CONFIG_ENCRYPTION_KEY and saved to .env');
    }

    // Derive a 256-bit AES key using scrypt (key stretching)
    _derivedKey = crypto.scryptSync(
        masterKey,
        SCRYPT_SALT,
        SCRYPT_KEYLEN,
        { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION }
    );

    return _derivedKey;
}

// --- AES-256-GCM Encryption / Decryption ---

export function encrypt(plaintext: string): string {
    if (!plaintext || typeof plaintext !== 'string') {
        return '';
    }
    if (plaintext.startsWith(ENCRYPTION_PREFIX)) {
        return plaintext;
    }
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: enc:v1:<base64(iv + authTag + ciphertext)>
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return ENCRYPTION_PREFIX + combined.toString('base64');
}

export function decrypt(encryptedValue: string): string {
    if (!encryptedValue || typeof encryptedValue !== 'string') {
        return '';
    }
    if (!encryptedValue.startsWith(ENCRYPTION_PREFIX)) {
        // Not encrypted — return as-is (for backward compatibility / migration)
        return encryptedValue;
    }

    const key = getEncryptionKey();
    const combined = Buffer.from(encryptedValue.slice(ENCRYPTION_PREFIX.length), 'base64');

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
}

// --- Helpers ---

function isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTION_PREFIX);
}

function isBcryptHash(value: string): boolean {
    return value.startsWith(BCRYPT_PREFIX);
}

function normalizeRetentionDays(value: unknown, fallback: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(365, Math.max(1, Math.floor(number)));
}

function normalizePort(value: unknown, fallback: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(65535, Math.max(1, Math.floor(number)));
}

function normalizeLoggingConfig(logging?: EncryptedConfig['logging'] | LoggingConfig): LoggingConfig {
    return {
        requests: {
            maxDaysRetention: normalizeRetentionDays(
                logging?.requests?.maxDaysRetention,
                DEFAULT_LOGGING_CONFIG.requests.maxDaysRetention,
            ),
            enableIpLogging: Boolean(logging?.requests?.enableIpLogging),
        },
        logs: {
            maxDaysRetention: normalizeRetentionDays(
                logging?.logs?.maxDaysRetention,
                DEFAULT_LOGGING_CONFIG.logs.maxDaysRetention,
            ),
            enableIpLogging: Boolean(logging?.logs?.enableIpLogging),
        },
    };
}

function encryptSmtpConfig(smtp: SmtpConfig): EncryptedConfig['smtp'] {
    return {
        host: encrypt(smtp.host),
        port: smtp.port,
        secure: Boolean(smtp.secure),
        username: encrypt(smtp.username),
        password: encrypt(smtp.password),
        fromEmail: encrypt(smtp.fromEmail),
        toEmail: encrypt(smtp.toEmail),
    };
}

function decryptSmtpConfig(smtp?: EncryptedConfig['smtp']): SmtpConfig | undefined {
    if (!smtp) return undefined;
    const decrypted = {
        host: decrypt(smtp.host),
        port: normalizePort(smtp.port, 587),
        secure: Boolean(smtp.secure),
        username: decrypt(smtp.username),
        password: decrypt(smtp.password),
        fromEmail: decrypt(smtp.fromEmail),
        toEmail: decrypt(smtp.toEmail),
    };
    if (!decrypted.host || !decrypted.username || !decrypted.password || !decrypted.toEmail) {
        return undefined;
    }
    return decrypted;
}

function smtpNeedsMigration(smtp?: EncryptedConfig['smtp']): boolean {
    if (!smtp) return false;
    return [smtp.host, smtp.username, smtp.password, smtp.fromEmail, smtp.toEmail]
        .filter(Boolean)
        .some(value => !isEncrypted(String(value)));
}

export function getDefaultLoggingConfig(): LoggingConfig {
    return JSON.parse(JSON.stringify(DEFAULT_LOGGING_CONFIG));
}

// --- Config Read / Write ---

export function isConfigured(): boolean {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return false;
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(raw) as EncryptedConfig;
        return config.setupCompleted === true;
    } catch {
        return false;
    }
}

/**
 * Reads and decrypts the config file.
 * Returns plaintext AppConfig for use in the application.
 */
export function getConfig(): AppConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error('Config file not found. Please run the setup wizard.');
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const encrypted = JSON.parse(raw) as EncryptedConfig;

    // Check if migration is needed (plaintext values on disk)
    let needsMigration = false;

    const dbBackend = encrypted.dbBackend || 'firebase';

    // Decrypt Firebase fields (only if firebase backend is configured)
    let firebase: AppConfig['firebase'] | undefined;
    if (encrypted.firebase) {
        firebase = {
            apiKey: decrypt(encrypted.firebase.apiKey),
            authDomain: decrypt(encrypted.firebase.authDomain),
            projectId: decrypt(encrypted.firebase.projectId),
            storageBucket: decrypt(encrypted.firebase.storageBucket),
            messagingSenderId: decrypt(encrypted.firebase.messagingSenderId),
            appId: decrypt(encrypted.firebase.appId),
            measurementId: encrypted.firebase.measurementId ? decrypt(encrypted.firebase.measurementId) : undefined,
        };

        // Check if Firebase values were not encrypted (migration needed)
        if (!isEncrypted(encrypted.firebase.apiKey)) {
            needsMigration = true;
        }
    }

    // Decrypt JWT secret
    const jwtSecret = decrypt(encrypted.jwtSecret);
    if (!isEncrypted(encrypted.jwtSecret)) {
        needsMigration = true;
    }
    if (smtpNeedsMigration(encrypted.smtp)) {
        needsMigration = true;
    }

    // Admin credentials stay as bcrypt hashes — they are verified via bcrypt.compare.
    // A sessionVersion rotates all outstanding admin JWTs after credential changes.
    const sessionVersion = encrypted.admin.sessionVersion || (_fallbackAdminSessionVersion ||= generateSessionVersion());
    if (!isBcryptHash(encrypted.admin.username)) {
        needsMigration = true;
    }
    if (!encrypted.admin.sessionVersion) needsMigration = true;

    const config: AppConfig = {
        firebase,
        admin: {
            username: encrypted.admin.username, // bcrypt hash (or plaintext if migration needed)
            password: encrypted.admin.password, // bcrypt hash
            sessionVersion,
        },
        jwtSecret,
        setupCompleted: encrypted.setupCompleted,
        setupCompletedAt: encrypted.setupCompletedAt,
        dbBackend,
        smtp: decryptSmtpConfig(encrypted.smtp),
        logging: normalizeLoggingConfig(encrypted.logging),
    };

    // Auto-migrate plaintext config to encrypted format
    if (needsMigration && encrypted.setupCompleted) {
        console.log('🔄 Migrating config.json to encrypted format...');
        migrateConfig(encrypted, sessionVersion);
    }

    return config;
}

/**
 * Migrates a plaintext or partially encrypted config to fully encrypted format.
 */
async function migrateConfig(raw: EncryptedConfig, sessionVersion: string): Promise<void> {
    try {
        const encryptedConfig: EncryptedConfig = {
            firebase: raw.firebase ? {
                apiKey: isEncrypted(raw.firebase.apiKey) ? raw.firebase.apiKey : encrypt(raw.firebase.apiKey),
                authDomain: isEncrypted(raw.firebase.authDomain) ? raw.firebase.authDomain : encrypt(raw.firebase.authDomain),
                projectId: isEncrypted(raw.firebase.projectId) ? raw.firebase.projectId : encrypt(raw.firebase.projectId),
                storageBucket: isEncrypted(raw.firebase.storageBucket) ? raw.firebase.storageBucket : encrypt(raw.firebase.storageBucket),
                messagingSenderId: isEncrypted(raw.firebase.messagingSenderId) ? raw.firebase.messagingSenderId : encrypt(raw.firebase.messagingSenderId),
                appId: isEncrypted(raw.firebase.appId) ? raw.firebase.appId : encrypt(raw.firebase.appId),
                measurementId: raw.firebase.measurementId
                    ? (isEncrypted(raw.firebase.measurementId) ? raw.firebase.measurementId : encrypt(raw.firebase.measurementId))
                    : undefined,
            } : undefined,
            admin: {
                username: isBcryptHash(raw.admin.username) ? raw.admin.username : await bcrypt.hash(raw.admin.username, 12),
                password: isBcryptHash(raw.admin.password) ? raw.admin.password : await bcrypt.hash(raw.admin.password, 12),
                sessionVersion,
            },
            jwtSecret: isEncrypted(raw.jwtSecret) ? raw.jwtSecret : encrypt(raw.jwtSecret),
            setupCompleted: raw.setupCompleted,
            setupCompletedAt: raw.setupCompletedAt,
            dbBackend: raw.dbBackend || 'firebase',
            smtp: raw.smtp ? {
                host: isEncrypted(raw.smtp.host || '') ? raw.smtp.host : encrypt(raw.smtp.host || ''),
                port: normalizePort(raw.smtp.port, 587),
                secure: Boolean(raw.smtp.secure),
                username: isEncrypted(raw.smtp.username || '') ? raw.smtp.username : encrypt(raw.smtp.username || ''),
                password: isEncrypted(raw.smtp.password || '') ? raw.smtp.password : encrypt(raw.smtp.password || ''),
                fromEmail: isEncrypted(raw.smtp.fromEmail || '') ? raw.smtp.fromEmail : encrypt(raw.smtp.fromEmail || ''),
                toEmail: isEncrypted(raw.smtp.toEmail || '') ? raw.smtp.toEmail : encrypt(raw.smtp.toEmail || ''),
            } : undefined,
            logging: normalizeLoggingConfig(raw.logging),
        };

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(encryptedConfig, null, 2), 'utf-8');
        console.log('✅ Config migration complete. All sensitive data is now encrypted.');
    } catch (err) {
        console.error('❌ Config migration failed:', err);
    }
}

/**
 * Saves config with all sensitive fields encrypted/hashed.
 * Expects PLAINTEXT values for firebase & jwtSecret, and PRE-HASHED values for admin credentials.
 */
export function saveConfig(config: AppConfig): void {
    const encryptedConfig: EncryptedConfig = {
        firebase: config.firebase ? {
            apiKey: encrypt(config.firebase.apiKey),
            authDomain: encrypt(config.firebase.authDomain),
            projectId: encrypt(config.firebase.projectId),
            storageBucket: encrypt(config.firebase.storageBucket),
            messagingSenderId: encrypt(config.firebase.messagingSenderId),
            appId: encrypt(config.firebase.appId),
            measurementId: config.firebase.measurementId ? encrypt(config.firebase.measurementId) : undefined,
        } : undefined,
        admin: {
            username: config.admin.username, // Already bcrypt hashed by caller
            password: config.admin.password, // Already bcrypt hashed by caller
            sessionVersion: config.admin.sessionVersion || generateSessionVersion(),
        },
        jwtSecret: encrypt(config.jwtSecret),
        setupCompleted: config.setupCompleted,
        setupCompletedAt: config.setupCompletedAt,
        dbBackend: config.dbBackend || 'firebase',
        smtp: config.smtp ? encryptSmtpConfig(config.smtp) : undefined,
        logging: normalizeLoggingConfig(config.logging),
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(encryptedConfig, null, 2), 'utf-8');
}

/**
 * Updates only the dbBackend field in config.json without touching any other values.
 * Also updates the Firebase config if switching to firebase.
 */
export function switchDatabaseBackend(
    to: 'firebase' | 'local',
    firebaseConfig?: AppConfig['firebase']
): void {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error('Config not found.');
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    raw.dbBackend = to;
    if (to === 'firebase' && firebaseConfig) {
        raw.firebase = {
            apiKey: encrypt(firebaseConfig.apiKey),
            authDomain: encrypt(firebaseConfig.authDomain),
            projectId: encrypt(firebaseConfig.projectId),
            storageBucket: encrypt(firebaseConfig.storageBucket),
            messagingSenderId: encrypt(firebaseConfig.messagingSenderId),
            appId: encrypt(firebaseConfig.appId),
            measurementId: firebaseConfig.measurementId ? encrypt(firebaseConfig.measurementId) : undefined,
        };
    }
    if (to === 'local') {
        // Keep firebase credentials in case they switch back, just change backend flag
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');
}

export function getLoggingConfig(): LoggingConfig {
    try {
        return normalizeLoggingConfig(getConfig().logging);
    } catch {
        return getDefaultLoggingConfig();
    }
}

export function isSmtpConfigured(config: AppConfig = getConfig()): boolean {
    const smtp = config.smtp;
    return Boolean(
        smtp?.host?.trim() &&
        smtp?.port &&
        smtp?.username?.trim() &&
        smtp?.password &&
        smtp?.toEmail?.trim()
    );
}

export function updateSecuritySettings(settings: { smtp?: SmtpConfig | null; logging?: LoggingConfig }): void {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error('Config not found.');
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as EncryptedConfig;

    if (settings.smtp !== undefined) {
        if (settings.smtp === null) {
            delete raw.smtp;
        } else {
            raw.smtp = encryptSmtpConfig({
                ...settings.smtp,
                port: normalizePort(settings.smtp.port, 587),
                secure: Boolean(settings.smtp.secure),
            });
        }
    }

    if (settings.logging !== undefined) {
        raw.logging = normalizeLoggingConfig(settings.logging);
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');
}

// --- Utility Functions ---

export function generateJwtSecret(): string {
    return crypto.randomBytes(64).toString('hex');
}

export function generateSessionVersion(): string {
    return crypto.randomBytes(32).toString('hex');
}

export function generateApiKey(): string {
    const prefix = 'sk-';
    const key = crypto.randomBytes(32).toString('base64url');
    return prefix + key;
}

/**
 * Verifies a plaintext username against the stored bcrypt hash.
 */


export async function verifyUsername(plaintext: string, hash: string): Promise<boolean> {
    if (!isBcryptHash(hash)) {
        // Fallback: direct comparison for un-migrated configs
        return plaintext === hash;
    }
    return bcrypt.compare(plaintext, hash);
}

/**
 * Updates the admin username and/or password in config.json, preserving all
 * other fields (firebase, jwtSecret, models, dbBackend, ...) intact.
 *
 * Both values are already-hashed bcrypt strings produced by the caller.
 * The caller is responsible for verifying the current password before invoking
 * this function. Plaintext credentials must never reach this layer.
 */
export function updateAdminCredentials(hashedUsername: string, hashedPassword: string): void {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error('Config not found.');
    }
    if (!isBcryptHash(hashedUsername) || !isBcryptHash(hashedPassword)) {
        throw new Error('updateAdminCredentials expects bcrypt hashes, not plaintext.');
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    raw.admin = raw.admin || {};
    raw.admin.username = hashedUsername;
    raw.admin.password = hashedPassword;
    raw.admin.sessionVersion = generateSessionVersion();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');
}
