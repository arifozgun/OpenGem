import { Request, Response } from 'express';
import firebaseDb from '../services/firebase';
import { nativeFetch } from '../services/http';
import { refreshAccessToken, GEMINI_API_BASE, DEFAULT_MODEL, FALLBACK_MODEL } from '../services/gemini';

export const handleGenerateContent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { contents, generationConfig, systemInstruction } = req.body;
        let model = (req.params.model as string) || DEFAULT_MODEL;

        if (model === 'gemini-3.1-pro-preview') {
            model = FALLBACK_MODEL;
        }

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }

        // Ensure all contents have a role, default to user
        contents.forEach(c => {
            if (!c.role) c.role = 'user';
        });

        // Get an active account sorted by least recently used and make the request
        const result = await tryGenerateContentWithAccounts(model, contents, generationConfig, systemInstruction);

        if (!result) {
            res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
            return;
        }

        // Return the raw candidate response correctly structured for SDK clients
        res.json(result);
    } catch (e: any) {
        console.error('Generate Content Error:', e);
        res.status(500).json({ error: 'Internal Server Error', ...(process.env.NODE_ENV !== 'production' && { message: e.message }) });
    }
};

const EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

async function tryGenerateContentWithAccounts(model: string, contents: any[], generationConfig?: any, systemInstruction?: any): Promise<any | null> {
    // Auto-reactivate accounts that have been exhausted for longer than the cooldown period
    const reactivated = await firebaseDb.reactivateExhaustedAccounts(EXHAUSTION_COOLDOWN_MS);
    if (reactivated > 0) {
        console.log(`♻️ Auto-reactivated ${reactivated} previously exhausted account(s).`);
    }

    const accounts = await firebaseDb.getActiveAccounts();

    if (accounts.length === 0) {
        console.error('❌ No active Google accounts available to fulfill request.');
        return null; // Handle this carefully, maybe wait or reject
    }

    for (const account of accounts) {
        try {
            // Check if token expired (add 5 mins buffer)
            const tokenExpireTime = account.expiresAt instanceof Date ? account.expiresAt.getTime() : account.expiresAt as number;
            const tokenExpired = Date.now() > (tokenExpireTime - 5 * 60 * 1000);
            let accessToken = account.accessToken;

            if (tokenExpired) {
                console.log(`🔄 Refreshing token for ${account.email}...`);
                const newTokens = await refreshAccessToken(account.refreshToken);

                await firebaseDb.updateAccount(account.email, {
                    accessToken: newTokens.accessToken,
                    refreshToken: newTokens.refreshToken,
                    expiresAt: newTokens.expiresAt
                });
                accessToken = newTokens.accessToken;
            }

            // Build payload
            const requestPayload: any = {
                contents,
            };
            if (generationConfig) requestPayload.generationConfig = generationConfig;
            if (systemInstruction) requestPayload.systemInstruction = systemInstruction;

            // Make the API request
            const response = await nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Client': 'gl-node/openclaw',
                    'User-Agent': 'GeminiCLI/0.26.0 (darwin; arm64)',
                },
                body: JSON.stringify({
                    model: model || DEFAULT_MODEL,
                    project: account.projectId,
                    user_prompt_id: 'default-prompt',
                    request: requestPayload,
                }),
            });

            if (response.status === 429) {
                // Rate limited / Quota Exceeded!
                console.warn(`⏳ Account ${account.email} hit 429 Quota Limit! Disabling for ${EXHAUSTION_COOLDOWN_MS / 60000} minutes.`);
                await firebaseDb.updateAccount(account.email, {
                    isActive: false,
                    lastUsedAt: new Date(),
                    exhaustedAt: new Date()
                });
                await firebaseDb.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });

                // Log error
                firebaseDb.addRequestLog({
                    accountEmail: account.email,
                    question: contents?.[contents.length - 1]?.parts?.[0]?.text?.substring(0, 500) || 'Unknown Request',
                    answer: 'ERROR 429: Account exhausted / Quota Limit Reached',
                    tokensUsed: 0,
                    success: false,
                    timestamp: new Date()
                }).catch(err => console.error('Log write error:', err));

                // Switch to next account by continuing the loop
                continue;
            }

            if (!response.ok) {
                const text = await response.text();
                console.error(`❌ API error ${response.status} for ${account.email}: ${text}`);
                await firebaseDb.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });

                // Log error
                firebaseDb.addRequestLog({
                    accountEmail: account.email,
                    question: contents?.[contents.length - 1]?.parts?.[0]?.text?.substring(0, 500) || 'Unknown Request',
                    answer: `ERROR ${response.status}: ${text.substring(0, 100)}`,
                    tokensUsed: 0,
                    success: false,
                    timestamp: new Date()
                }).catch(err => console.error('Log write error:', err));

                // Could be other errors (400, 403, etc). Don't disable account yet, just continue or throw
                continue;
            }

            const data = await response.json() as any;
            const candidate = data.response?.candidates?.[0];
            const content = candidate?.content?.parts?.[0]?.text;
            const tokenUsage = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;

            if (content) {
                // Success! Record stats
                await firebaseDb.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });

                // Log request for dashboard
                const lastUserMessage = contents[contents.length - 1];
                const questionText = lastUserMessage?.parts?.[0]?.text || '';
                firebaseDb.addRequestLog({
                    accountEmail: account.email,
                    question: questionText.substring(0, 500),
                    answer: content.substring(0, 500),
                    tokensUsed: tokenUsage,
                    success: true,
                    timestamp: new Date()
                }).catch(err => console.error('Log write error:', err));

                console.log(`✅ Request fulfilled by account ${account.email}`);

                // Return exactly what the client expects by extracting the internal `response` payload which matches public Gemini API shape
                return data.response;
            }

        } catch (e: any) {
            console.error(`❌ Network/Processing error with account ${account.email}:`, e);
            await firebaseDb.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });

            // Log error
            firebaseDb.addRequestLog({
                accountEmail: account.email,
                question: contents?.[contents.length - 1]?.parts?.[0]?.text?.substring(0, 500) || 'Unknown Request',
                answer: `ERROR: ${e.message?.substring(0, 100) || 'Network/Processing Error'}`,
                tokensUsed: 0,
                success: false,
                timestamp: new Date()
            }).catch(err => console.error('Log write error:', err));

            // Move to next account
            continue;
        }
    }

    // If loop finished, all accounts failed
    return null;
}
