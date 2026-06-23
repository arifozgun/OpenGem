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
import { getConfig, encrypt, decrypt, getLoggingConfig } from './config';
import type { IDatabase, Account, ApiKey, RequestLog, DbStats, ChatConversation, ChatConversationSummary } from './database';
import { mergeEffectiveTokenStats } from './token-stats';
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
        if (!config.firebase) {
            throw new Error('Firebase config is missing. Please run setup with Firebase backend selected.');
        }
        app = initializeApp(config.firebase);
        db = getFirestore(app);
    }
    return db;
}

const ACCOUNTS_COLLECTION = 'accounts';
const LOGS_COLLECTION = 'request_logs';
const API_KEYS_COLLECTION = 'api_keys';
const MAX_LOG_ROWS = 5000;
const CHAT_CONVERSATIONS_COLLECTION = 'chat_conversations';

// Secure one-way hash for API key storage
function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Firestore rejects `undefined` field values with:
 *   "Unsupported field value: undefined"
 * Convert any `undefined` values to `null` before writing.
 */
function sanitize(obj: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
        out[key] = obj[key] === undefined ? null : obj[key];
    }
    return out;
}

async function trimRequestLogs(): Promise<void> {
    const logsRef = collection(getDb(), LOGS_COLLECTION);
    const snapshot = await getDocs(logsRef);
    const retentionDays = getLoggingConfig().requests.maxDaysRetention;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const docs = snapshot.docs
        .map(docSnap => {
            const data = docSnap.data();
            const timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
            return { id: docSnap.id, timestamp: isNaN(timestamp.getTime()) ? new Date(0) : timestamp };
        })
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const overflowCount = Math.max(0, docs.length - MAX_LOG_ROWS);
    const toDelete = docs.filter((item, index) => item.timestamp.getTime() < cutoff || index < overflowCount);
    await Promise.all(toDelete.map(item => deleteDoc(doc(getDb(), LOGS_COLLECTION, item.id))));
}

// Re-export types for any existing code that imported from firebase.ts
function toDate(val: any): Date | undefined {
    if (!val) return undefined;
    if (typeof val.toDate === 'function') {
        return val.toDate();
    }
    const d = new Date(val);
    return isNaN(d.getTime()) ? undefined : d;
}

function mapDocToAccount(doc: any): Account {
    const data = doc.data();
    return {
        ...data,
        id: doc.id,
        accessToken: data.accessToken ? decrypt(data.accessToken) : '',
        refreshToken: data.refreshToken ? decrypt(data.refreshToken) : '',
        expiresAt: toDate(data.expiresAt) || new Date(0),
        lastUsedAt: toDate(data.lastUsedAt) || new Date(0),
        exhaustedAt: toDate(data.exhaustedAt),
        createdAt: toDate(data.createdAt),
        updatedAt: toDate(data.updatedAt)
    } as Account;
}

function mapDocToChatSummary(docSnap: any): ChatConversationSummary {
    const data = docSnap.data();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    return {
        id: docSnap.id,
        title: data.title || 'Untitled chat',
        model: data.model || '',
        sessionId: data.sessionId || docSnap.id,
        messageCount: Number(data.messageCount ?? messages.length) || 0,
        ...(data.forkedFromId && { forkedFromId: data.forkedFromId }),
        createdAt: toDate(data.createdAt) || new Date(0),
        updatedAt: toDate(data.updatedAt) || new Date(0),
    };
}

function mapDocToChatConversation(docSnap: any): ChatConversation {
    const data = docSnap.data();
    return {
        ...mapDocToChatSummary(docSnap),
        messages: Array.isArray(data.messages) ? data.messages : [],
    };
}

export type { Account, ApiKey, RequestLog, DbStats };

export const firebaseDb: IDatabase = {
    async getActiveAccounts(): Promise<Account[]> {
        const accountsRef = collection(getDb(), ACCOUNTS_COLLECTION);
        const q = query(
            accountsRef,
            where('isActive', '==', true),
        );

        const snapshot = await getDocs(q);
        const accounts: Account[] = [];

        snapshot.forEach(doc => {
            accounts.push(mapDocToAccount(doc));
        });

        // Sort by least recently used (ascending priority)
        return accounts.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
    },

    async getAllAccounts(): Promise<Account[]> {
        const accountsRef = collection(getDb(), ACCOUNTS_COLLECTION);
        const snapshot = await getDocs(accountsRef);
        const accounts: Account[] = [];

        snapshot.forEach(doc => {
            accounts.push(mapDocToAccount(doc));
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

        // Firestore rejects `undefined` values — replace with null
        await setDoc(docRef, sanitize(dataToSave), { merge: true });
    },

    async updateAccount(email: string, data: Partial<Account>): Promise<void> {
        const docRef = doc(getDb(), ACCOUNTS_COLLECTION, email);
        const encryptedData: any = { ...data, updatedAt: new Date() };
        if (encryptedData.accessToken) encryptedData.accessToken = encrypt(encryptedData.accessToken);
        if (encryptedData.refreshToken) encryptedData.refreshToken = encrypt(encryptedData.refreshToken);
        await setDoc(docRef, sanitize(encryptedData), { merge: true });
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
            success: log.success ?? true, // default to true if undefined for older code
            timestamp: log.timestamp ? new Date(log.timestamp) : new Date()
        });
        if (Math.random() < 0.05) trimRequestLogs().catch(err => console.error('Firestore request log trim error:', err));
    },

    async getRecentLogs(limitCount: number = 50): Promise<RequestLog[]> {
        const logsRef = collection(getDb(), LOGS_COLLECTION);
        const snapshot = await getDocs(logsRef);
        const logs: RequestLog[] = [];

        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
            logs.push({
                id: docSnap.id,
                accountEmail: data.accountEmail,
                question: data.question,
                answer: data.answer,
                ...(data.systemInstruction && { systemInstruction: data.systemInstruction }),
                ...(data.model && { model: data.model }),
                ...(data.isFallback !== undefined && { isFallback: data.isFallback }),
                ...(data.affinityKeyHash && { affinityKeyHash: data.affinityKeyHash }),
                ...(data.affinitySource && { affinitySource: data.affinitySource }),
                ...(data.affinityHit !== undefined && { affinityHit: data.affinityHit }),
                ...(data.affinityRebound !== undefined && { affinityRebound: data.affinityRebound }),
                ...(data.promptTokens !== undefined && { promptTokens: data.promptTokens }),
                ...(data.completionTokens !== undefined && { completionTokens: data.completionTokens }),
                ...(data.effectiveTokensUsed !== undefined && { effectiveTokensUsed: data.effectiveTokensUsed }),
                ...(data.requestId && { requestId: data.requestId }),
                ...(data.level && { level: data.level }),
                ...(data.method && { method: data.method }),
                ...(data.url && { url: data.url }),
                ...(data.userApi && { userApi: data.userApi }),
                ...(data.status !== undefined && { status: data.status }),
                ...(data.execTimeMs !== undefined && { execTimeMs: data.execTimeMs }),
                ...(data.opengemKey && { opengemKey: data.opengemKey }),
                ...(data.userAgent && { userAgent: data.userAgent }),
                ...(data.remoteIp && { remoteIp: data.remoteIp }),
                tokensUsed: data.tokensUsed || 0,
                success: data.success,
                timestamp
            });
        });

        // Sort by timestamp descending (most recent first)
        const cutoff = Date.now() - getLoggingConfig().requests.maxDaysRetention * 24 * 60 * 60 * 1000;
        const retained = logs.filter(log => new Date(log.timestamp).getTime() >= cutoff);
        retained.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return retained.slice(0, limitCount);
    },

    // --- ADMIN CHAT HISTORY ---

    async upsertChatConversation(conversation: ChatConversation): Promise<ChatConversation> {
        const docRef = doc(getDb(), CHAT_CONVERSATIONS_COLLECTION, conversation.id);
        const existing = await getDoc(docRef);
        const now = new Date();
        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];

        await setDoc(docRef, sanitize({
            title: conversation.title,
            model: conversation.model,
            sessionId: conversation.sessionId,
            messages,
            messageCount: messages.length,
            forkedFromId: conversation.forkedFromId || null,
            createdAt: existing.exists()
                ? existing.data().createdAt
                : (conversation.createdAt ? new Date(conversation.createdAt) : now),
            updatedAt: conversation.updatedAt ? new Date(conversation.updatedAt) : now,
        }), { merge: true });

        const saved = await getDoc(docRef);
        return saved.exists()
            ? mapDocToChatConversation(saved)
            : { ...conversation, messageCount: messages.length, createdAt: now, updatedAt: now };
    },

    async getChatConversations(limitCount: number = 50): Promise<ChatConversationSummary[]> {
        const conversationsRef = collection(getDb(), CHAT_CONVERSATIONS_COLLECTION);
        const q = query(conversationsRef, orderBy('updatedAt', 'desc'), firestoreLimit(limitCount));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(mapDocToChatSummary);
    },

    async getChatConversation(id: string): Promise<ChatConversation | null> {
        const docRef = doc(getDb(), CHAT_CONVERSATIONS_COLLECTION, id);
        const snapshot = await getDoc(docRef);
        return snapshot.exists() ? mapDocToChatConversation(snapshot) : null;
    },

    async deleteChatConversation(id: string): Promise<void> {
        await deleteDoc(doc(getDb(), CHAT_CONVERSATIONS_COLLECTION, id));
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
            isPro?: boolean;
        }>;
    }> {
        const accounts = await this.getAllAccounts();
        const logs = await this.getRecentLogs(5000);
        const tokenStats = mergeEffectiveTokenStats(accounts, logs);

        let totalRequests = 0;
        let successfulRequests = 0;
        let failedRequests = 0;
        let activeAccounts = 0;

        const accountStats = accounts.map(acc => {
            const accTotal = acc.totalRequests || 0;
            const accSuccess = acc.successfulRequests || 0;
            const accFailed = acc.failedRequests || 0;
            const accTokens = tokenStats.byAccount[acc.email] || 0;

            totalRequests += accTotal;
            successfulRequests += accSuccess;
            failedRequests += accFailed;
            if (acc.isActive) activeAccounts++;

            return {
                email: acc.email,
                totalRequests: accTotal,
                successfulRequests: accSuccess,
                failedRequests: accFailed,
                totalTokensUsed: accTokens,
                isActive: acc.isActive,
                isPro: acc.isPro
            };
        });

        return {
            totalRequests,
            successfulRequests,
            failedRequests,
            totalTokensUsed: tokenStats.totalTokensUsed,
            activeAccounts,
            totalAccounts: accounts.length,
            accountStats
        };
    }
};

export default firebaseDb;
