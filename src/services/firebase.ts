import { initializeApp, FirebaseApp } from 'firebase/app';
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    deleteDoc,
    addDoc,
    query,
    where,
    orderBy,
    limit as firestoreLimit,
    increment,
    deleteField,
    Firestore
} from 'firebase/firestore';
import { getConfig, encrypt, decrypt } from './config';
import crypto from 'crypto';

// Polyfill fetch for Firebase if needed (especially for Node.js environments lacking global fetch)
if (!globalThis.fetch) {
    const fetch = require('node-fetch');
    globalThis.fetch = fetch;
    globalThis.Headers = fetch.Headers;
    globalThis.Request = fetch.Request;
    globalThis.Response = fetch.Response;
}

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

function getDb(): Firestore {
    if (!db) {
        const config = getConfig();
        app = initializeApp(config.firebase);
        db = getFirestore(app);
    }
    return db;
}

const ACCOUNTS_COLLECTION = 'accounts';
const LOGS_COLLECTION = 'request_logs';
const API_KEYS_COLLECTION = 'api_keys';

// Secure one-way hash for API key storage
function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

export interface RequestLog {
    id?: string;
    accountEmail: string;
    question: string;
    answer: string;
    tokensUsed: number;
    success: boolean;
    timestamp: Date | number;
}

export interface Account {
    id: string; // The email will be used as the document ID for simplicity and uniqueness
    email: string;
    accessToken: string;
    refreshToken: string;
    projectId: string;
    expiresAt: Date | number; // Firestore usually prefers numerical timestamps or Date objects
    isActive: boolean;
    lastUsedAt: Date | number;
    exhaustedAt?: Date | number; // Timestamp when account was disabled due to 429
    createdAt?: Date | number;
    updatedAt?: Date | number;
    totalRequests?: number;
    successfulRequests?: number;
    failedRequests?: number;
    totalTokensUsed?: number;
}

export interface ApiKey {
    id?: string;
    name: string;
    key: string;
    createdAt: Date | number;
    lastUsedAt?: Date | number;
    totalRequests?: number;
}

export const firebaseDb = {
    async getActiveAccounts(): Promise<Account[]> {
        const accountsRef = collection(getDb(), ACCOUNTS_COLLECTION);
        const q = query(
            accountsRef,
            where('isActive', '==', true),
        );

        const snapshot = await getDocs(q);
        const accounts: Account[] = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            accounts.push({
                ...data,
                id: doc.id,
                accessToken: decrypt(data.accessToken),
                refreshToken: decrypt(data.refreshToken),
                expiresAt: data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt),
                lastUsedAt: data.lastUsedAt?.toDate ? data.lastUsedAt.toDate() : new Date(data.lastUsedAt)
            } as Account);
        });

        // Sort by least recently used (ascending priority)
        return accounts.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
    },

    async getAllAccounts(): Promise<Account[]> {
        const accountsRef = collection(getDb(), ACCOUNTS_COLLECTION);
        const snapshot = await getDocs(accountsRef);
        const accounts: Account[] = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            accounts.push({
                ...data,
                id: doc.id,
                lastUsedAt: data.lastUsedAt?.toDate ? data.lastUsedAt.toDate() : new Date(data.lastUsedAt)
            } as Account);
        });

        return accounts.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
    },

    async upsertAccount(account: Account): Promise<void> {
        const docRef = doc(getDb(), ACCOUNTS_COLLECTION, account.email); // Using email as ID

        const dataToSave: any = {
            ...account,
            accessToken: encrypt(account.accessToken),
            refreshToken: encrypt(account.refreshToken),
            updatedAt: new Date()
        };

        const existingDoc = await getDoc(docRef);
        if (!existingDoc.exists()) {
            dataToSave.createdAt = new Date();
        }

        await setDoc(docRef, dataToSave, { merge: true });
    },

    async updateAccount(email: string, data: Partial<Account>): Promise<void> {
        const docRef = doc(getDb(), ACCOUNTS_COLLECTION, email);
        const encryptedData: any = { ...data, updatedAt: new Date() };
        if (encryptedData.accessToken) encryptedData.accessToken = encrypt(encryptedData.accessToken);
        if (encryptedData.refreshToken) encryptedData.refreshToken = encrypt(encryptedData.refreshToken);
        await setDoc(docRef, encryptedData, { merge: true });
    },

    async incrementAccountStats(email: string, stats: { successful: number, failed: number, tokens: number }): Promise<void> {
        const docRef = doc(getDb(), ACCOUNTS_COLLECTION, email);
        const dataToUpdate: any = {
            totalRequests: increment(stats.successful + stats.failed),
            updatedAt: new Date(),
            lastUsedAt: new Date()
        };

        if (stats.successful > 0) dataToUpdate.successfulRequests = increment(stats.successful);
        if (stats.failed > 0) dataToUpdate.failedRequests = increment(stats.failed);
        if (stats.tokens > 0) dataToUpdate.totalTokensUsed = increment(stats.tokens);

        await setDoc(docRef, dataToUpdate, { merge: true });
    },

    async reactivateExhaustedAccounts(cooldownMs: number): Promise<number> {
        const accountsRef = collection(getDb(), ACCOUNTS_COLLECTION);
        const q = query(accountsRef, where('isActive', '==', false));
        const snapshot = await getDocs(q);
        let reactivatedCount = 0;

        for (const docSnap of snapshot.docs) {
            const data = docSnap.data();
            if (!data.exhaustedAt) continue;

            const exhaustedTime = data.exhaustedAt?.toDate ? data.exhaustedAt.toDate().getTime() : new Date(data.exhaustedAt).getTime();
            if (Date.now() - exhaustedTime > cooldownMs) {
                await setDoc(doc(getDb(), ACCOUNTS_COLLECTION, docSnap.id), {
                    isActive: true,
                    exhaustedAt: null,
                    updatedAt: new Date()
                }, { merge: true });
                console.log(`♻️ Auto-reactivated account: ${docSnap.id}`);
                reactivatedCount++;
            }
        }
        return reactivatedCount;
    },

    async reactivateAccount(email: string): Promise<void> {
        const docRef = doc(getDb(), ACCOUNTS_COLLECTION, email);
        await setDoc(docRef, {
            isActive: true,
            exhaustedAt: null,
            updatedAt: new Date()
        }, { merge: true });
    },

    async deleteAccount(idOrEmail: string): Promise<void> {
        const docRef = doc(getDb(), ACCOUNTS_COLLECTION, idOrEmail);
        await deleteDoc(docRef);
    },

    // --- API KEYS ---

    async createApiKey(name: string, key: string): Promise<ApiKey> {
        const keysRef = collection(getDb(), API_KEYS_COLLECTION);
        const apiKeyData = {
            name,
            keyHash: hashApiKey(key),
            keyPrefix: key.substring(0, 7),
            createdAt: new Date(),
            totalRequests: 0
        };
        const docRef = await addDoc(keysRef, apiKeyData);
        return { ...apiKeyData, key, id: docRef.id } as ApiKey;
    },

    async getAllApiKeys(): Promise<ApiKey[]> {
        const keysRef = collection(getDb(), API_KEYS_COLLECTION);
        const snapshot = await getDocs(keysRef);
        const keys: ApiKey[] = [];

        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const maskedKey = data.keyPrefix
                ? (data.keyPrefix + '\u2022'.repeat(36))
                : (data.key ? data.key.substring(0, 7) + '\u2022'.repeat(36) : '\u2022'.repeat(43));
            keys.push({
                id: docSnap.id,
                name: data.name,
                key: maskedKey,
                createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt),
                lastUsedAt: data.lastUsedAt?.toDate ? data.lastUsedAt.toDate() : data.lastUsedAt ? new Date(data.lastUsedAt) : undefined,
                totalRequests: data.totalRequests || 0
            });
        });

        return keys.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    },

    async validateApiKey(key: string): Promise<boolean> {
        const keysRef = collection(getDb(), API_KEYS_COLLECTION);
        const keyHash = hashApiKey(key);

        // Try hash-based lookup first (new secure format)
        let q = query(keysRef, where('keyHash', '==', keyHash));
        let snapshot = await getDocs(q);

        if (snapshot.empty) {
            // Fallback: plaintext key lookup for backward compatibility
            q = query(keysRef, where('key', '==', key));
            snapshot = await getDocs(q);

            if (!snapshot.empty) {
                // Auto-migrate old key to hashed format
                const docSnap = snapshot.docs[0];
                await setDoc(doc(getDb(), API_KEYS_COLLECTION, docSnap.id), {
                    keyHash: keyHash,
                    keyPrefix: key.substring(0, 7),
                    key: deleteField(),
                    lastUsedAt: new Date(),
                    totalRequests: increment(1)
                }, { merge: true });
                return true;
            }
            return false;
        }

        const docSnap = snapshot.docs[0];
        await setDoc(doc(getDb(), API_KEYS_COLLECTION, docSnap.id), {
            lastUsedAt: new Date(),
            totalRequests: increment(1)
        }, { merge: true });
        return true;
    },

    async deleteApiKey(id: string): Promise<void> {
        const docRef = doc(getDb(), API_KEYS_COLLECTION, id);
        await deleteDoc(docRef);
    },

    // --- REQUEST LOGGING ---

    async addRequestLog(log: Omit<RequestLog, 'id'>): Promise<void> {
        const logsRef = collection(getDb(), LOGS_COLLECTION);
        // Explicitly extract the fields to ensure `success` is saved even if undefined
        await addDoc(logsRef, {
            accountEmail: log.accountEmail,
            question: log.question,
            answer: log.answer,
            tokensUsed: log.tokensUsed,
            success: log.success ?? true, // default to true if undefined for older code
            timestamp: new Date()
        });
    },

    async getRecentLogs(limitCount: number = 50): Promise<RequestLog[]> {
        const logsRef = collection(getDb(), LOGS_COLLECTION);
        const snapshot = await getDocs(logsRef);
        const logs: RequestLog[] = [];

        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            logs.push({
                id: docSnap.id,
                accountEmail: data.accountEmail,
                question: data.question,
                answer: data.answer,
                tokensUsed: data.tokensUsed || 0,
                success: data.success,
                timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : new Date(data.timestamp)
            });
        });

        // Sort by timestamp descending (most recent first)
        logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return logs.slice(0, limitCount);
    },

    async getStats(): Promise<{
        totalRequests: number;
        successfulRequests: number;
        failedRequests: number;
        totalTokensUsed: number;
        activeAccounts: number;
        totalAccounts: number;
        accountStats: Array<{
            email: string;
            totalRequests: number;
            successfulRequests: number;
            failedRequests: number;
            totalTokensUsed: number;
            isActive: boolean;
        }>;
    }> {
        const accounts = await this.getAllAccounts();

        let totalRequests = 0;
        let successfulRequests = 0;
        let failedRequests = 0;
        let totalTokensUsed = 0;
        let activeAccounts = 0;

        const accountStats = accounts.map(acc => {
            const accTotal = acc.totalRequests || 0;
            const accSuccess = acc.successfulRequests || 0;
            const accFailed = acc.failedRequests || 0;
            const accTokens = acc.totalTokensUsed || 0;

            totalRequests += accTotal;
            successfulRequests += accSuccess;
            failedRequests += accFailed;
            totalTokensUsed += accTokens;
            if (acc.isActive) activeAccounts++;

            return {
                email: acc.email,
                totalRequests: accTotal,
                successfulRequests: accSuccess,
                failedRequests: accFailed,
                totalTokensUsed: accTokens,
                isActive: acc.isActive
            };
        });

        return {
            totalRequests,
            successfulRequests,
            failedRequests,
            totalTokensUsed,
            activeAccounts,
            totalAccounts: accounts.length,
            accountStats
        };
    }
};

export default firebaseDb;
