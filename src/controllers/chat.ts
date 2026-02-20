import { Request, Response } from 'express';
import { getDatabase } from '../services/database';
import { nativeFetch, nativeFetchStream } from '../services/http';
import { refreshAccessToken, GEMINI_API_BASE, DEFAULT_MODEL, FALLBACK_MODEL } from '../services/gemini';

const EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

// ─── Helpers ─────────────────────────────────────────────

async function getReadyAccount(db: any) {
    const reactivated = await db.reactivateExhaustedAccounts(EXHAUSTION_COOLDOWN_MS);
    if (reactivated > 0) {
        console.log(`♻️ Auto-reactivated ${reactivated} previously exhausted account(s).`);
    }
    return db.getActiveAccounts();
}

async function ensureFreshToken(db: any, account: any): Promise<string> {
    const tokenExpireTime = account.expiresAt instanceof Date ? account.expiresAt.getTime() : account.expiresAt as number;
    const tokenExpired = Date.now() > (tokenExpireTime - 5 * 60 * 1000);
    if (!tokenExpired) return account.accessToken;

    console.log(`🔄 Refreshing token for ${account.email}...`);
    const newTokens = await refreshAccessToken(account.refreshToken);
    await db.updateAccount(account.email, {
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresAt: newTokens.expiresAt,
    });
    return newTokens.accessToken;
}

function buildGeminiHeaders(accessToken: string) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Goog-Api-Client': 'gl-node/openclaw',
        'User-Agent': 'GeminiCLI/0.26.0 (darwin; arm64)',
    };
}

function resolveModel(model: string): string {
    // gemini-3.1-pro-preview is not yet natively available — fall back
    if (model === 'gemini-3.1-pro-preview') return FALLBACK_MODEL;
    return model || DEFAULT_MODEL;
}

// ─── Standard (non-streaming) generateContent ───────────

export const handleGenerateContent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { contents, generationConfig, systemInstruction } = req.body;
        let model = resolveModel(req.params.model as string);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }

        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const action = req.params.action;
        if (action === 'streamGenerateContent') {
            return handleStreamGenerateContent(req, res, model, contents, generationConfig, systemInstruction);
        }

        const result = await tryGenerateContentWithAccounts(model, contents, generationConfig, systemInstruction);

        if (!result) {
            res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
            return;
        }

        res.json(result);
    } catch (e: any) {
        console.error('Generate Content Error:', e);
        res.status(500).json({ error: 'Internal Server Error', ...(process.env.NODE_ENV !== 'production' && { message: e.message }) });
    }
};

// ─── Non-streaming account rotation ─────────────────────

export async function tryGenerateContentWithAccounts(model: string, contents: any[], generationConfig?: any, systemInstruction?: any): Promise<any | null> {
    const db = getDatabase();
    const accounts = await getReadyAccount(db);

    if (accounts.length === 0) {
        console.error('❌ No active Google accounts available to fulfill request.');
        return null;
    }

    for (const account of accounts) {
        try {
            const accessToken = await ensureFreshToken(db, account);

            const requestPayload: any = { contents };
            if (generationConfig) requestPayload.generationConfig = generationConfig;
            if (systemInstruction) requestPayload.systemInstruction = systemInstruction;

            const response = await nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                method: 'POST',
                headers: buildGeminiHeaders(accessToken),
                body: JSON.stringify({
                    model: model || DEFAULT_MODEL,
                    project: account.projectId,
                    user_prompt_id: 'default-prompt',
                    request: requestPayload,
                }),
            });

            if (response.status === 429) {
                console.warn(`⏳ Account ${account.email} hit 429 — trying fallback model...`);

                // Try fallback model before exhausting the account
                if (model !== FALLBACK_MODEL && model !== DEFAULT_MODEL) {
                    const fallbackResponse = await nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                        method: 'POST',
                        headers: buildGeminiHeaders(accessToken),
                        body: JSON.stringify({
                            model: FALLBACK_MODEL,
                            project: account.projectId,
                            user_prompt_id: 'default-prompt',
                            request: requestPayload,
                        }),
                    });
                    if (fallbackResponse.ok) {
                        const data = await fallbackResponse.json() as any;
                        const candidate = data.response?.candidates?.[0];
                        const content = candidate?.content?.parts?.[0]?.text;
                        const tokenUsage = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;
                        if (content) {
                            await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });
                            logRequest(db, account.email, contents, content, tokenUsage, true);
                            console.log(`✅ Fallback fulfilled by ${account.email} [${FALLBACK_MODEL}]`);
                            return data.response;
                        }
                    }
                }

                // Mark account as exhausted
                await db.updateAccount(account.email, { isActive: false, lastUsedAt: new Date(), exhaustedAt: new Date() });
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                logRequest(db, account.email, contents, 'ERROR 429: Account exhausted / Quota Limit Reached', 0, false);
                continue;
            }

            if (!response.ok) {
                const text = await response.text();
                console.error(`❌ API error ${response.status} for ${account.email}: ${text}`);
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                logRequest(db, account.email, contents, `ERROR ${response.status}: ${text.substring(0, 100)}`, 0, false);
                continue;
            }

            const data = await response.json() as any;
            const candidate = data.response?.candidates?.[0];
            const content = candidate?.content?.parts?.[0]?.text;
            const tokenUsage = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;

            if (content) {
                await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });
                logRequest(db, account.email, contents, content, tokenUsage, true);
                console.log(`✅ Request fulfilled by account ${account.email}`);
                return data.response;
            }
        } catch (e: any) {
            console.error(`❌ Network/Processing error with account ${account.email}:`, e);
            await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
            logRequest(db, account.email, contents, `ERROR: ${e.message?.substring(0, 100) || 'Network/Processing Error'}`, 0, false);
            continue;
        }
    }

    return null;
}

// ─── SSE Streaming ──────────────────────────────────────

async function handleStreamGenerateContent(req: Request, res: Response, model: string, contents: any[], generationConfig?: any, systemInstruction?: any): Promise<void> {
    const db = getDatabase();
    const accounts = await getReadyAccount(db);

    if (accounts.length === 0) {
        res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
        return;
    }

    for (const account of accounts) {
        try {
            const accessToken = await ensureFreshToken(db, account);

            const requestPayload: any = { contents };
            if (generationConfig) requestPayload.generationConfig = generationConfig;
            if (systemInstruction) requestPayload.systemInstruction = systemInstruction;

            const { status, stream } = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                method: 'POST',
                headers: buildGeminiHeaders(accessToken),
                body: JSON.stringify({
                    model: model || DEFAULT_MODEL,
                    project: account.projectId,
                    user_prompt_id: 'default-prompt',
                    request: requestPayload,
                }),
            });

            if (status === 429) {
                console.warn(`⏳ Stream: Account ${account.email} hit 429 — trying next account...`);
                await db.updateAccount(account.email, { isActive: false, lastUsedAt: new Date(), exhaustedAt: new Date() });
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                stream.resume(); // drain it
                continue;
            }

            if (status < 200 || status >= 300) {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(chunk as Buffer);
                const text = Buffer.concat(chunks).toString('utf-8');
                console.error(`❌ Stream API error ${status} for ${account.email}: ${text.substring(0, 200)}`);
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                continue;
            }

            // Success — set SSE headers and pipe stream
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            let fullAnswer = '';
            let buffer = '';
            let tokenUsage = 0;

            stream.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf-8');
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(jsonStr);
                            const parts = parsed.candidates?.[0]?.content?.parts
                                || parsed.response?.candidates?.[0]?.content?.parts;
                            if (parts) {
                                for (const part of parts) {
                                    if (part.text && !part.thought) {
                                        fullAnswer += part.text;
                                    }
                                }
                            }
                            // Extract token usage from usageMetadata (present in last chunk)
                            const usage = parsed.usageMetadata || parsed.response?.usageMetadata;
                            if (usage?.totalTokenCount) {
                                tokenUsage = usage.totalTokenCount;
                            }
                        } catch { /* ignore parse errors */ }
                        res.write(line + '\n\n');
                    }
                }
            });

            stream.on('end', () => {
                res.write('data: [DONE]\n\n');
                res.end();

                db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage }).catch(() => { });
                logRequest(db, account.email, contents, fullAnswer || '(streamed)', tokenUsage, true);
                console.log(`✅ Stream fulfilled by ${account.email} [${model}]`);
            });

            stream.on('error', (err: Error) => {
                console.error(`❌ Stream error for ${account.email}:`, err);
                if (!res.writableEnded) res.end();
            });

            // Successfully started streaming — stop trying more accounts
            return;
        } catch (e: any) {
            console.error(`❌ Stream Network error with account ${account.email}:`, e);
            await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
            continue;
        }
    }

    // All accounts failed
    if (!res.headersSent) {
        res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
    }
}

// ─── Admin Chat endpoint ────────────────────────────────

export async function handleAdminChat(req: Request, res: Response): Promise<void> {
    try {
        const { contents, model: requestedModel, generationConfig, systemInstruction } = req.body;
        const model = resolveModel(requestedModel || DEFAULT_MODEL);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }

        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const db = getDatabase();
        const accounts = await getReadyAccount(db);

        if (accounts.length === 0) {
            res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
            return;
        }

        // Set up SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        for (const account of accounts) {
            try {
                const accessToken = await ensureFreshToken(db, account);

                const requestPayload: any = { contents };
                if (generationConfig) requestPayload.generationConfig = generationConfig;
                if (systemInstruction) requestPayload.systemInstruction = systemInstruction;

                const { status, stream } = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                    method: 'POST',
                    headers: buildGeminiHeaders(accessToken),
                    body: JSON.stringify({
                        model,
                        project: account.projectId,
                        user_prompt_id: 'default-prompt',
                        request: requestPayload,
                    }),
                });

                if (status === 429) {
                    console.warn(`⏳ Chat: Account ${account.email} hit 429 — trying next...`);
                    await db.updateAccount(account.email, { isActive: false, lastUsedAt: new Date(), exhaustedAt: new Date() });
                    stream.resume();
                    continue;
                }

                if (status < 200 || status >= 300) {
                    const chunks: Buffer[] = [];
                    for await (const chunk of stream) chunks.push(chunk as Buffer);
                    const errText = Buffer.concat(chunks).toString('utf-8');
                    console.error(`❌ Chat API error ${status} for ${account.email}: ${errText.substring(0, 200)}`);
                    continue;
                }

                // Pipe the stream to client
                let fullAnswer = '';
                let buffer = '';
                let tokenUsage = 0;

                stream.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf-8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const jsonStr = line.substring(6).trim();
                            if (!jsonStr || jsonStr === '[DONE]') continue;
                            try {
                                const parsed = JSON.parse(jsonStr);
                                const parts = parsed.candidates?.[0]?.content?.parts
                                    || parsed.response?.candidates?.[0]?.content?.parts;
                                if (parts) {
                                    for (const part of parts) {
                                        if (part.text && !part.thought) {
                                            fullAnswer += part.text;
                                        }
                                    }
                                }
                                // Extract token usage from usageMetadata (present in last chunk)
                                const usage = parsed.usageMetadata || parsed.response?.usageMetadata;
                                if (usage?.totalTokenCount) {
                                    tokenUsage = usage.totalTokenCount;
                                }
                            } catch { /* ignore */ }
                            res.write(line + '\n\n');
                        }
                    }
                });

                await new Promise<void>((resolve, reject) => {
                    stream.on('end', () => {
                        res.write('data: [DONE]\n\n');
                        res.end();
                        db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage }).catch(() => { });
                        logRequest(db, account.email, contents, fullAnswer || '(chat streamed)', tokenUsage, true);
                        console.log(`✅ Chat stream fulfilled by ${account.email} [${model}]`);
                        resolve();
                    });
                    stream.on('error', (err: Error) => {
                        console.error(`❌ Chat stream error:`, err);
                        if (!res.writableEnded) res.end();
                        reject(err);
                    });
                });

                return; // success
            } catch (e: any) {
                console.error(`❌ Chat error with ${account.email}:`, e);
                continue;
            }
        }

        // All accounts failed
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: 'All accounts exhausted.' })}\n\n`);
            res.end();
        }
    } catch (e: any) {
        console.error('Admin Chat Error:', e);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}

// ─── Logging helper ─────────────────────────────────────

function logRequest(db: any, email: string, contents: any[], answer: string, tokens: number, success: boolean) {
    const questionText = contents?.[contents.length - 1]?.parts?.[0]?.text || 'Unknown';
    db.addRequestLog({
        accountEmail: email,
        question: questionText,
        answer: answer,
        tokensUsed: tokens,
        success,
        timestamp: new Date(),
    }).catch((err: any) => console.error('Log write error:', err));
}
