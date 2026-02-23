import { Request, Response } from 'express';
import { getDatabase } from '../services/database';
import { nativeFetch, nativeFetchStream } from '../services/http';
import { refreshAccessToken, GEMINI_API_BASE, DEFAULT_MODEL, FALLBACK_MODEL } from '../services/gemini';
import { accountRateLimiter } from '../services/rate-limiter';
import { classifyError, type ErrorCategory } from '../services/error-classifier';
import { isAccountInCooldown, shouldProbeAccount, recordProbe, markAccountCooldown, markAccountSuccess, clearExpiredCooldowns } from '../services/account-cooldown';
import { geminiRequestSemaphore } from '../services/concurrency';

const EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
const INTER_ACCOUNT_DELAY_MS = 500; // Small delay between trying different accounts on same IP
const BASE_RETRY_DELAY_MS = 2000; // Base delay for exponential backoff between rounds
const MAX_RETRY_DELAY_MS = 60_000;
const JITTER_FACTOR = 0.2; // ±20% randomness

// ─── Helpers ─────────────────────────────────────────────

function applyJitter(delayMs: number): number {
    const offset = (Math.random() * 2 - 1) * JITTER_FACTOR;
    return Math.max(0, Math.round(delayMs * (1 + offset)));
}

function computeBackoffDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
        // Server told us how long to wait — respect it but apply jitter
        return applyJitter(Math.max(retryAfterMs, BASE_RETRY_DELAY_MS));
    }
    // Exponential backoff: 2s → 4s → 8s → 16s → 32s (capped at 60s)
    const baseDelay = BASE_RETRY_DELAY_MS * 2 ** attempt;
    return applyJitter(Math.min(baseDelay, MAX_RETRY_DELAY_MS));
}

/**
 * Parse Retry-After from a 429 response (seconds or HTTP-date).
 */
function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
    if (!headers) return undefined;
    const retryAfter = headers['retry-after'];
    if (!retryAfter) return undefined;
    const seconds = Number(retryAfter);
    if (!isNaN(seconds)) return seconds * 1000;
    // Try HTTP-date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
    return undefined;
}

/**
 * Classify error text using the comprehensive error classifier.
 * Maps to simplified 'quota' | 'rate_limit' for backward compatibility.
 */
function classify429Error(text: string): 'quota' | 'rate_limit' {
    const category = classifyError(text);
    if (category === 'quota' || category === 'auth' || category === 'billing') return 'quota';
    return 'rate_limit';
}

/**
 * Determine the fallback model for a given model.
 * Key fix: Flash → Pro fallback now works.
 */
function getFallbackModel(currentModel: string): string | null {
    // Don't fallback if already on fallback model
    if (currentModel === FALLBACK_MODEL) return null;
    // Flash → Pro fallback (this was the critical bug)
    if (currentModel === DEFAULT_MODEL) return FALLBACK_MODEL;
    // Custom model → Pro fallback
    return FALLBACK_MODEL;
}

async function getReadyAccount(db: any) {
    // Clear any expired cooldowns first (from openclaw's clearExpiredCooldowns pattern)
    const cleared = clearExpiredCooldowns();
    if (cleared > 0) {
        console.log(`🧹 Cleared ${cleared} expired cooldown(s).`);
    }

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
        const { contents, generationConfig, systemInstruction, tools, toolConfig, tool_config } = req.body;
        let model = resolveModel(req.params.model as string);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }

        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const action = req.params.action;
        const finalToolConfig = toolConfig || tool_config;

        if (action === 'streamGenerateContent') {
            return handleStreamGenerateContent(req, res, model, contents, generationConfig, systemInstruction, tools, finalToolConfig);
        }

        const result = await tryGenerateContentWithAccounts(model, contents, generationConfig, systemInstruction, tools, finalToolConfig);

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

export async function tryGenerateContentWithAccounts(model: string, contents: any[], generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any): Promise<any | null> {
    const db = getDatabase();
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        const accounts = await getReadyAccount(db);

        if (accounts.length === 0) {
            console.error('❌ No active Google accounts available to fulfill request.');
            return null;
        }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];

            // Account cooldown check (from openclaw's auth-profiles pattern)
            if (isAccountInCooldown(account.email)) {
                // Probe recovery: periodically test exhausted accounts
                if (shouldProbeAccount(account.email)) {
                    console.log(`🔍 Probing account ${account.email} for recovery...`);
                    recordProbe(account.email);
                } else {
                    continue; // Skip accounts in cooldown
                }
            }

            // Client-side rate limiting: check budget before sending request
            const rateLimitCheck = accountRateLimiter.consume(account.email);
            if (!rateLimitCheck.allowed) {
                console.warn(`🚦 Account ${account.email} rate limited locally (retry in ${rateLimitCheck.retryAfterMs}ms). Skipping.`);
                continue;
            }

            try {
                const accessToken = await ensureFreshToken(db, account);

                const requestPayload: any = { contents };
                if (generationConfig) requestPayload.generationConfig = generationConfig;
                if (systemInstruction) requestPayload.systemInstruction = systemInstruction;
                if (tools) requestPayload.tools = tools;
                if (toolConfig) requestPayload.toolConfig = toolConfig;

                // Wrap with concurrency semaphore (from openclaw's concurrency pattern)
                const response = await geminiRequestSemaphore.run(() =>
                    nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                        method: 'POST',
                        headers: buildGeminiHeaders(accessToken),
                        body: JSON.stringify({
                            model: model || DEFAULT_MODEL,
                            project: account.projectId,
                            user_prompt_id: 'default-prompt',
                            request: requestPayload,
                        }),
                    })
                );

                if (response.status === 429) {
                    console.warn(`⏳ Account ${account.email} hit 429 — trying fallback model...`);

                    // Try fallback model (Fixed: now works for DEFAULT_MODEL too)
                    const fallbackModel = getFallbackModel(model || DEFAULT_MODEL);
                    if (fallbackModel) {
                        const fallbackResponse = await nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                            method: 'POST',
                            headers: buildGeminiHeaders(accessToken),
                            body: JSON.stringify({
                                model: fallbackModel,
                                project: account.projectId,
                                user_prompt_id: 'default-prompt',
                                request: requestPayload,
                            }),
                        });
                        if (fallbackResponse.ok) {
                            const data = await fallbackResponse.json() as any;
                            const candidate = data.response?.candidates?.[0];
                            const content = candidate?.content?.parts?.map((p: any) => {
                                if (p.text) return p.text;
                                if (p.functionCall) return `[Tool Call: ${p.functionCall.name}]\n${JSON.stringify(p.functionCall.args, null, 2)}`;
                                return '';
                            }).filter(Boolean).join('\n\n').trim();
                            const tokenUsage = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;
                            if (content) {
                                await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });
                                logRequest(db, account.email, contents, content, tokenUsage, true, systemInstruction);
                                console.log(`✅ Fallback fulfilled by ${account.email} [${fallbackModel}]`);
                                return data.response;
                            }
                        }
                    }

                    // Comprehensive error classification (from openclaw's errors.ts)
                    let errorCategory: 'quota' | 'rate_limit' = 'rate_limit';
                    try {
                        const text = await response.text();
                        errorCategory = classify429Error(text);
                    } catch (e) { /* ignore */ }

                    // Mark cooldown (from openclaw's auth-profiles pattern)
                    markAccountCooldown(account.email, errorCategory === 'quota' ? 'quota' : 'rate_limit');

                    if (errorCategory === 'quota') {
                        // Cooldown only — NEVER deactivate permanently (openclaw approach)
                        await db.updateAccount(account.email, { lastUsedAt: new Date() });
                        await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                        logRequest(db, account.email, contents, 'ERROR 429: Quota cooldown (auto-recovers)', 0, false, systemInstruction);
                    } else {
                        // Temporary rate limit — bounce to bottom of queue
                        await db.updateAccount(account.email, { lastUsedAt: new Date() });
                    }

                    // Inter-account delay to avoid hammering same IP
                    if (i < accounts.length - 1) {
                        await new Promise(res => setTimeout(res, INTER_ACCOUNT_DELAY_MS));
                    }
                    continue;
                }

                if (!response.ok) {
                    const text = await response.text();
                    console.error(`❌ API error ${response.status} for ${account.email}: ${text}`);
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    logRequest(db, account.email, contents, `ERROR ${response.status}: ${text.substring(0, 100)}`, 0, false, systemInstruction);
                    continue;
                }

                const data = await response.json() as any;
                const candidate = data.response?.candidates?.[0];
                const content = candidate?.content?.parts?.map((p: any) => {
                    if (p.text) return p.text;
                    if (p.functionCall) return `[Tool Call: ${p.functionCall.name}]\n${JSON.stringify(p.functionCall.args, null, 2)}`;
                    return '';
                }).filter(Boolean).join('\n\n').trim();
                const tokenUsage = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;

                if (content) {
                    markAccountSuccess(account.email); // Clear cooldown on success
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });
                    logRequest(db, account.email, contents, content, tokenUsage, true, systemInstruction);
                    console.log(`✅ Request fulfilled by account ${account.email}`);
                    return data.response;
                }
            } catch (e: any) {
                console.error(`❌ Network/Processing error with account ${account.email}:`, e);
                // Use error classifier for all errors (from openclaw's classifyFailoverReason)
                const errCategory = classifyError(e.message || '');

                // Cooldown only — NEVER deactivate permanently
                markAccountCooldown(account.email, errCategory);
                console.log(`⏸️ Account ${account.email} in cooldown (${errCategory}), will auto-recover.`);

                await db.updateAccount(account.email, { lastUsedAt: new Date() });
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                logRequest(db, account.email, contents, `ERROR: ${e.message?.substring(0, 100) || 'Network/Processing Error'}`, 0, false, systemInstruction);
                continue;
            }
        }

        attempts++;
        if (attempts < maxAttempts) {
            const delay = computeBackoffDelay(attempts);
            console.log(`⚠️ All accounts failed (${attempts}/${maxAttempts}). Exponential backoff: ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }

    return null;
}

// ─── SSE Streaming ──────────────────────────────────────

async function handleStreamGenerateContent(req: Request, res: Response, model: string, contents: any[], generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any): Promise<void> {
    const db = getDatabase();
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        const accounts = await getReadyAccount(db);

        if (accounts.length === 0) {
            if (!res.headersSent) res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
            return;
        }

        for (const account of accounts) {
            try {
                const accessToken = await ensureFreshToken(db, account);

                const requestPayload: any = { contents };
                if (generationConfig) requestPayload.generationConfig = generationConfig;
                if (systemInstruction) requestPayload.systemInstruction = systemInstruction;
                if (tools) requestPayload.tools = tools;
                if (toolConfig) requestPayload.toolConfig = toolConfig;

                let { status, stream } = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                    method: 'POST',
                    headers: buildGeminiHeaders(accessToken),
                    body: JSON.stringify({
                        model: model || DEFAULT_MODEL,
                        project: account.projectId,
                        user_prompt_id: 'default-prompt',
                        request: requestPayload,
                    }),
                });

                let usedModel = model || DEFAULT_MODEL;

                if (status === 429) {
                    console.warn(`⏳ Stream: Account ${account.email} hit 429 — trying fallback model...`);

                    const fallbackModel = getFallbackModel(model || DEFAULT_MODEL);
                    let fallbackStreamRes: any = null;
                    if (fallbackModel) {
                        fallbackStreamRes = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                            method: 'POST',
                            headers: buildGeminiHeaders(accessToken),
                            body: JSON.stringify({
                                model: fallbackModel,
                                project: account.projectId,
                                user_prompt_id: 'default-prompt',
                                request: requestPayload,
                            }),
                        });
                    }

                    if (fallbackStreamRes && fallbackStreamRes.status === 200) {
                        console.log(`✅ Stream Fallback accepted by ${account.email} [${fallbackModel}]`);
                        stream = fallbackStreamRes.stream;
                        usedModel = fallbackModel!;
                        status = 200;
                        // Let it fall through to the success block
                    } else {
                        if (fallbackStreamRes && fallbackStreamRes.stream) {
                            try { for await (const _ of fallbackStreamRes.stream) { } } catch { }
                        }

                        let errorCategory: 'quota' | 'rate_limit' = 'rate_limit';
                        try {
                            const chunks: Buffer[] = [];
                            for await (const chunk of stream) chunks.push(chunk as Buffer);
                            const text = Buffer.concat(chunks).toString('utf-8');
                            errorCategory = classify429Error(text);
                        } catch {
                            // If we can't parse it, we must drain the stream anyway
                            stream.resume();
                        }

                        if (errorCategory === 'quota') {
                            // Cooldown only — NEVER deactivate permanently
                            markAccountCooldown(account.email, 'quota');
                            await db.updateAccount(account.email, { lastUsedAt: new Date() });
                            await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                        } else {
                            markAccountCooldown(account.email, 'rate_limit');
                            await db.updateAccount(account.email, { lastUsedAt: new Date() });
                        }

                        continue;
                    }
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
                                        if (part.text) {
                                            fullAnswer += part.text;
                                        } else if (part.functionCall) {
                                            fullAnswer += `\n\n[Tool Call: ${part.functionCall.name}]\n${JSON.stringify(part.functionCall.args, null, 2)}\n\n`;
                                        }
                                    }
                                }
                                // Extract token usage from usageMetadata (present in last chunk)
                                const usage = parsed.usageMetadata || parsed.response?.usageMetadata;
                                if (usage?.totalTokenCount) {
                                    tokenUsage = usage.totalTokenCount;
                                }

                                // Unwrap v1internal format → standard Gemini API format
                                // Upstream: {response: {candidates:[...]}, usageMetadata:{...}}
                                // Standard: {candidates:[...], usageMetadata:{...}}
                                let forwarded = parsed;
                                if (parsed.response) {
                                    forwarded = { ...parsed.response };
                                    if (parsed.usageMetadata) {
                                        forwarded.usageMetadata = parsed.usageMetadata;
                                    }
                                }
                                res.write(`data: ${JSON.stringify(forwarded)}\n\n`);
                            } catch {
                                // Forward raw line if parse fails
                                res.write(line + '\n\n');
                            }
                        }
                    }
                });

                stream.on('end', () => {
                    res.end();

                    db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage }).catch(() => { });
                    logRequest(db, account.email, contents, fullAnswer, tokenUsage, true, systemInstruction);
                    console.log(`✅ Stream fulfilled by ${account.email} [${usedModel}]`);
                });

                stream.on('error', (err: Error) => {
                    console.error(`❌ Stream error for ${account.email}:`, err);
                    if (!res.writableEnded) res.end();
                });

                // Successfully started streaming — stop trying more accounts
                return;
            } catch (e: any) {
                console.error(`❌ Stream Network error with account ${account.email}:`, e);
                // Cooldown only — NEVER deactivate permanently
                const errCategory = classifyError(e.message || '');
                markAccountCooldown(account.email, errCategory);
                console.log(`⏸️ Account ${account.email} in cooldown (${errCategory}), will auto-recover.`);
                await db.updateAccount(account.email, { lastUsedAt: new Date() });
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                continue;
            }
        }

        attempts++;
        if (attempts < maxAttempts) {
            const delay = computeBackoffDelay(attempts);
            console.log(`⚠️ Stream: All accounts failed (${attempts}/${maxAttempts}). Exponential backoff: ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
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
        const { contents, model: requestedModel, generationConfig, systemInstruction, tools, toolConfig, tool_config } = req.body;
        const model = resolveModel(requestedModel || DEFAULT_MODEL);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }

        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const db = getDatabase();
        let attempts = 0;
        const maxAttempts = 5;

        // Set up SSE early, as it's streaming regardless of retry logic
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        while (attempts < maxAttempts) {
            const accounts = await getReadyAccount(db);

            if (accounts.length === 0) {
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ error: 'All accounts exhausted or failed.' })}\n\n`);
                    res.end();
                }
                return;
            }

            for (const account of accounts) {
                try {
                    const accessToken = await ensureFreshToken(db, account);

                    const requestPayload: any = { contents };
                    if (generationConfig) requestPayload.generationConfig = generationConfig;
                    if (systemInstruction) requestPayload.systemInstruction = systemInstruction;
                    const finalToolConfig = toolConfig || tool_config;
                    if (tools) requestPayload.tools = tools;
                    if (finalToolConfig) requestPayload.toolConfig = finalToolConfig;

                    let { status, stream } = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                        method: 'POST',
                        headers: buildGeminiHeaders(accessToken),
                        body: JSON.stringify({
                            model,
                            project: account.projectId,
                            user_prompt_id: 'default-prompt',
                            request: requestPayload,
                        }),
                    });

                    let usedModel = model;

                    if (status === 429) {
                        console.warn(`⏳ Chat: Account ${account.email} hit 429 — trying fallback model...`);

                        const fallbackModel = getFallbackModel(model);
                        let fallbackStreamRes: any = null;
                        if (fallbackModel) {
                            fallbackStreamRes = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                                method: 'POST',
                                headers: buildGeminiHeaders(accessToken),
                                body: JSON.stringify({
                                    model: fallbackModel,
                                    project: account.projectId,
                                    user_prompt_id: 'default-prompt',
                                    request: requestPayload,
                                }),
                            });
                        }

                        if (fallbackStreamRes && fallbackStreamRes.status === 200) {
                            console.log(`✅ Chat Fallback accepted by ${account.email} [${fallbackModel}]`);
                            stream = fallbackStreamRes.stream;
                            usedModel = FALLBACK_MODEL;
                            status = 200;
                            // Fall through to success
                        } else {
                            if (fallbackStreamRes && fallbackStreamRes.stream) {
                                try { for await (const _ of fallbackStreamRes.stream) { } } catch { }
                            }

                            let errorCategory: 'quota' | 'rate_limit' = 'rate_limit';
                            try {
                                const chunks: Buffer[] = [];
                                for await (const chunk of stream) chunks.push(chunk as Buffer);
                                const text = Buffer.concat(chunks).toString('utf-8');
                                errorCategory = classify429Error(text);
                            } catch {
                                stream.resume();
                            }

                            if (errorCategory === 'quota') {
                                // Cooldown only — NEVER deactivate permanently
                                markAccountCooldown(account.email, 'quota');
                                await db.updateAccount(account.email, { lastUsedAt: new Date() });
                            } else {
                                markAccountCooldown(account.email, 'rate_limit');
                                await db.updateAccount(account.email, { lastUsedAt: new Date() });
                            }

                            continue;
                        }
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
                                            if (part.text) {
                                                fullAnswer += part.text;
                                            } else if (part.functionCall) {
                                                fullAnswer += `\n\n[Tool Call: ${part.functionCall.name}]\n${JSON.stringify(part.functionCall.args, null, 2)}\n\n`;
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
                            res.end();
                            db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage }).catch(() => { });
                            logRequest(db, account.email, contents, fullAnswer, tokenUsage, true, systemInstruction);
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
                    // Cooldown only — NEVER deactivate permanently
                    const errCategory = classifyError(e.message || '');
                    markAccountCooldown(account.email, errCategory);
                    console.log(`⏸️ Account ${account.email} in cooldown (${errCategory}), will auto-recover.`);
                    await db.updateAccount(account.email, { lastUsedAt: new Date() });
                    continue;
                }
            }

            attempts++;
            if (attempts < maxAttempts) {
                const delay = computeBackoffDelay(attempts);
                console.log(`⚠️ Admin Chat: All accounts failed (${attempts}/${maxAttempts}). Exponential backoff: ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
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

function logRequest(db: any, email: string, contents: any[], answer: string, tokens: number, success: boolean, systemInstruction?: any) {
    let questionText = 'Unknown';

    if (contents && contents.length > 0) {
        const lastContent = contents[contents.length - 1];
        if (lastContent && Array.isArray(lastContent.parts)) {
            const partsTexts = lastContent.parts.map((part: any) => {
                if (part.text) return part.text;
                if (part.functionCall) return `[Tool Call: ${part.functionCall.name}]`;
                if (part.functionResponse) return `[Tool Response: ${part.functionResponse.name}]`;
                return '';
            }).filter(Boolean);

            if (partsTexts.length > 0) {
                questionText = partsTexts.join('\\n');
            }
        }
    }

    // Extract system instruction text
    let systemInstructionText: string | undefined;
    if (systemInstruction) {
        if (typeof systemInstruction === 'string') {
            systemInstructionText = systemInstruction;
        } else if (systemInstruction.parts && Array.isArray(systemInstruction.parts)) {
            systemInstructionText = systemInstruction.parts
                .map((p: any) => p.text || '')
                .filter(Boolean)
                .join('\n');
        } else if (systemInstruction.text) {
            systemInstructionText = systemInstruction.text;
        }
    }

    db.addRequestLog({
        accountEmail: email,
        question: questionText,
        answer: answer,
        ...(systemInstructionText && { systemInstruction: systemInstructionText }),
        tokensUsed: tokens,
        success,
        timestamp: new Date(),
    }).catch((err: any) => console.error('Log write error:', err));
}
