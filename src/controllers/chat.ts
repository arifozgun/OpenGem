import { Request, Response } from 'express';
import { getDatabase } from '../services/database';
import { nativeFetch, nativeFetchStream } from '../services/http';
import { GEMINI_API_BASE, DEFAULT_MODEL, FALLBACK_MODEL, FALLBACK_MODEL_V2 } from '../services/gemini';
import { accountRateLimiter } from '../services/rate-limiter';
import { classifyError } from '../services/error-classifier';
import {
    isAccountInCooldown,
    shouldProbeAccount,
    recordProbe,
    markAccountCooldown,
    markAccountSuccess,
    clearExpiredCooldowns,
} from '../services/account-cooldown';
import { geminiRequestSemaphore } from '../services/concurrency';
import { getReadyAccounts, ensureFreshToken } from '../services/account-manager';

// ─── Constants ────────────────────────────────────────────

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
const JITTER_FACTOR = 0.2;
const MAX_ATTEMPTS = 5;
// Small stagger between accounts within a round — reduces burst rate seen from our IP.
// Without this, 9 accounts fire back-to-back from the same IP and all get 429.
const INTER_ACCOUNT_STAGGER_MS = 150;

// ─── Misc helpers ─────────────────────────────────────────

function applyJitter(delayMs: number): number {
    const offset = (Math.random() * 2 - 1) * JITTER_FACTOR;
    return Math.max(0, Math.round(delayMs * (1 + offset)));
}

function computeBackoffDelay(attempt: number): number {
    return applyJitter(Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS));
}

function classify429(text: string): 'quota' | 'rate_limit' {
    const cat = classifyError(text);
    return (cat === 'quota' || cat === 'auth' || cat === 'billing') ? 'quota' : 'rate_limit';
}

/** Returns the next model to try after a 429:
 *  flash → pro → pro-3.1 → null (no more fallbacks)
 */
function getFallbackModel(current: string): string | null {
    if (current === FALLBACK_MODEL_V2) return null;          // Already on last resort
    if (current === FALLBACK_MODEL) return FALLBACK_MODEL_V2; // pro → pro-3.1
    return FALLBACK_MODEL;                                    // flash → pro
}

function resolveModel(model: string): string {
    if (model === 'gemini-3.1-pro-preview') return FALLBACK_MODEL;
    return model || DEFAULT_MODEL;
}

function buildHeaders(token: string) {
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Goog-Api-Client': 'gl-node/openclaw',
        'User-Agent': 'GeminiCLI/0.26.0 (darwin; arm64)',
    };
}

function buildPayload(contents: any[], generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any) {
    const p: any = { contents };
    if (generationConfig) p.generationConfig = generationConfig;
    if (systemInstruction) p.systemInstruction = systemInstruction;
    if (tools) p.tools = tools;
    if (toolConfig) p.toolConfig = toolConfig;
    return p;
}

function extractText(candidate: any): string {
    return (candidate?.content?.parts ?? [])
        .map((p: any) => {
            if (p.text) return p.text;
            if (p.functionCall) return `[Tool Call: ${p.functionCall.name}]\n${JSON.stringify(p.functionCall.args, null, 2)}`;
            return '';
        })
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

async function drainStream(stream: any): Promise<string> {
    const chunks: Buffer[] = [];
    try { for await (const chunk of stream) chunks.push(chunk as Buffer); } catch { /* ignore */ }
    return Buffer.concat(chunks).toString('utf-8');
}

// ─── Account selection ────────────────────────────────────

async function selectReadyAccounts() {
    const cleared = clearExpiredCooldowns();
    if (cleared > 0) console.log(`🧹 Cleared ${cleared} expired cooldown(s).`);
    return getReadyAccounts();
}

// ─── Request logging ──────────────────────────────────────

function logRequest(db: any, email: string, contents: any[], answer: string, tokens: number, success: boolean, systemInstruction?: any) {
    let question = 'Unknown';
    const last = contents?.[contents.length - 1];
    if (last?.parts) {
        const texts = last.parts.map((p: any) => {
            if (p.text) return p.text;
            if (p.functionCall) return `[Tool Call: ${p.functionCall.name}]`;
            if (p.functionResponse) return `[Tool Response: ${p.functionResponse.name}]`;
            return '';
        }).filter(Boolean);
        if (texts.length) question = texts.join('\\n');
    }

    let si: string | undefined;
    if (typeof systemInstruction === 'string') si = systemInstruction;
    else if (systemInstruction?.parts) si = systemInstruction.parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
    else if (systemInstruction?.text) si = systemInstruction.text;

    db.addRequestLog({
        accountEmail: email, question, answer,
        ...(si && { systemInstruction: si }),
        tokensUsed: tokens, success, timestamp: new Date(),
    }).catch((err: any) => console.error('Log write error:', err));
}

// ─── Public entry point ───────────────────────────────────

export const handleGenerateContent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { contents, generationConfig, systemInstruction, tools, toolConfig, tool_config } = req.body;
        const model = resolveModel(req.params.model as string);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }
        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const finalToolConfig = toolConfig || tool_config;
        if (req.params.action === 'streamGenerateContent') {
            return handleStreamGenerateContent(req, res, model, contents, generationConfig, systemInstruction, tools, finalToolConfig);
        }

        const result = await tryGenerateContentWithAccounts(model, contents, generationConfig, systemInstruction, tools, finalToolConfig);
        if (!result) { res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' }); return; }
        res.json(result);
    } catch (e: any) {
        console.error('Generate Content Error:', e);
        res.status(500).json({ error: 'Internal Server Error', ...(process.env.NODE_ENV !== 'production' && { message: e.message }) });
    }
};

// ─── Non-streaming rotation ───────────────────────────────

export async function tryGenerateContentWithAccounts(
    model: string, contents: any[],
    generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any
): Promise<any | null> {
    const db = getDatabase();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const accounts = await selectReadyAccounts();
        if (accounts.length === 0) { console.error('❌ No active accounts.'); return null; }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];

            // Skip accounts in cooldown (unless probe window reached)
            if (isAccountInCooldown(account.email)) {
                if (shouldProbeAccount(account.email)) { console.log(`🔍 Probing ${account.email}...`); recordProbe(account.email); }
                else continue;
            }

            if (!accountRateLimiter.consume(account.email).allowed) {
                console.warn(`🚦 ${account.email} locally rate limited. Skipping.`);
                continue;
            }

            // Stagger account attempts to avoid IP-level burst throttling
            if (i > 0) await new Promise(r => setTimeout(r, INTER_ACCOUNT_STAGGER_MS));

            try {
                const token = await ensureFreshToken(account);
                const requestPayload = buildPayload(contents, generationConfig, systemInstruction, tools, toolConfig);
                let usedModel = model || DEFAULT_MODEL;

                // First try with requested model
                const geminiBody = (m: string) => ({
                    model: m, project: account.projectId,
                    user_prompt_id: 'default-prompt', request: requestPayload,
                });

                const response = await geminiRequestSemaphore.run(() =>
                    nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                        method: 'POST', headers: buildHeaders(token),
                        body: JSON.stringify(geminiBody(usedModel)),
                    })
                );

                if (response.status === 429) {
                    // Try fallback model before marking cooldown
                    const fallback = getFallbackModel(usedModel);
                    if (fallback) {
                        console.warn(`⏳ ${account.email} 429 on ${usedModel} — trying ${fallback}...`);
                        const fbResp = await nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                            method: 'POST', headers: buildHeaders(token),
                            body: JSON.stringify(geminiBody(fallback)),
                        });
                        if (fbResp.ok) {
                            const data = await fbResp.json() as any;
                            const text = extractText(data.response?.candidates?.[0]);
                            const tokens = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;
                            if (text) {
                                markAccountSuccess(account.email);
                                await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens });
                                logRequest(db, account.email, contents, text, tokens, true, systemInstruction);
                                console.log(`✅ Fallback fulfilled by ${account.email} [${fallback}]`);
                                return data.response;
                            }
                        }
                    }

                    // Classify and apply cooldown
                    let errCategory: 'quota' | 'rate_limit' = 'rate_limit';
                    try { errCategory = classify429(await response.text()); } catch { /* ignore */ }
                    markAccountCooldown(account.email, errCategory === 'quota' ? 'quota' : 'rate_limit');
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    logRequest(db, account.email, contents, `ERROR 429: ${errCategory} cooldown`, 0, false, systemInstruction);
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
                const text = extractText(data.response?.candidates?.[0]);
                const tokens = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;
                if (text) {
                    markAccountSuccess(account.email);
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens });
                    logRequest(db, account.email, contents, text, tokens, true, systemInstruction);
                    console.log(`✅ Fulfilled by ${account.email}`);
                    return data.response;
                }
            } catch (e: any) {
                console.error(`❌ Error with ${account.email}:`, e);
                const cat = classifyError(e.message || '');
                markAccountCooldown(account.email, cat);
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                logRequest(db, account.email, contents, `ERROR: ${e.message?.substring(0, 100) || 'Network Error'}`, 0, false, systemInstruction);
            }
        }

        if (attempt < MAX_ATTEMPTS - 1) {
            const delay = computeBackoffDelay(attempt);
            console.log(`⚠️ All accounts failed (${attempt + 1}/${MAX_ATTEMPTS}). Backoff: ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return null;
}

// ─── Streaming: pipe SSE to client ───────────────────────

async function pipeStream(stream: any, res: Response, unwrapEnvelope: boolean): Promise<{ fullAnswer: string; tokenUsage: number }> {
    return new Promise((resolve, reject) => {
        let fullAnswer = '';
        let buffer = '';
        let tokenUsage = 0;

        stream.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const jsonStr = line.substring(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    const parts = parsed.candidates?.[0]?.content?.parts
                        || parsed.response?.candidates?.[0]?.content?.parts;
                    if (parts) {
                        for (const p of parts) {
                            if (p.text) fullAnswer += p.text;
                            else if (p.functionCall) fullAnswer += `\n\n[Tool Call: ${p.functionCall.name}]\n${JSON.stringify(p.functionCall.args, null, 2)}\n\n`;
                        }
                    }
                    const usage = parsed.usageMetadata || parsed.response?.usageMetadata;
                    if (usage?.totalTokenCount) tokenUsage = usage.totalTokenCount;

                    let forwarded = parsed;
                    if (unwrapEnvelope && parsed.response) {
                        forwarded = { ...parsed.response };
                        if (parsed.usageMetadata) forwarded.usageMetadata = parsed.usageMetadata;
                    }
                    res.write(`data: ${JSON.stringify(forwarded)}\n\n`);
                } catch {
                    res.write(line + '\n\n');
                }
            }
        });

        stream.on('end', () => {
            res.write('data: [DONE]\n\n');
            res.end();
            resolve({ fullAnswer, tokenUsage });
        });
        stream.on('error', (err: Error) => { if (!res.writableEnded) res.end(); reject(err); });
    });
}

// ─── Unified streaming account rotation ──────────────────

async function streamWithAccounts(
    model: string, contents: any[],
    generationConfig: any, systemInstruction: any,
    tools: any[] | undefined, toolConfig: any,
    res: Response,
    headersAlreadySent: boolean  // true = admin chat (SSE headers sent before this call)
): Promise<void> {
    const db = getDatabase();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const accounts = await selectReadyAccounts();

        if (accounts.length === 0) {
            if (!res.headersSent) res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
            else if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: 'All accounts exhausted.' })}\n\n`); res.end(); }
            return;
        }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];

            if (isAccountInCooldown(account.email)) {
                if (shouldProbeAccount(account.email)) { console.log(`🔍 Probing ${account.email}...`); recordProbe(account.email); }
                else continue;
            }

            // Stagger account attempts to avoid IP-level burst throttling
            if (i > 0) await new Promise(r => setTimeout(r, INTER_ACCOUNT_STAGGER_MS));

            try {
                const token = await ensureFreshToken(account);
                const requestPayload = buildPayload(contents, generationConfig, systemInstruction, tools, toolConfig);
                let usedModel = model || DEFAULT_MODEL;

                const geminiBody = (m: string) => ({
                    model: m, project: account.projectId,
                    user_prompt_id: 'default-prompt', request: requestPayload,
                });

                let { status, stream } = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                    method: 'POST', headers: buildHeaders(token),
                    body: JSON.stringify(geminiBody(usedModel)),
                });

                if (status === 429) {
                    console.warn(`⏳ Stream: ${account.email} 429 on ${usedModel} — trying fallback...`);
                    const fallback = getFallbackModel(usedModel);

                    if (fallback) {
                        const fbResult = await nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                            method: 'POST', headers: buildHeaders(token),
                            body: JSON.stringify(geminiBody(fallback)),
                        });

                        if (fbResult.status === 200) {
                            console.log(`✅ Stream fallback accepted by ${account.email} [${fallback}]`);
                            // Drain and discard the original 429 stream
                            stream.resume();
                            stream = fbResult.stream;
                            usedModel = fallback;
                            status = 200;
                            // Fall through to success handling below
                        } else {
                            // Drain both streams before continuing
                            await drainStream(fbResult.stream);
                            const errText = await drainStream(stream);
                            const cat = classify429(errText);
                            markAccountCooldown(account.email, cat === 'quota' ? 'quota' : 'rate_limit');
                            await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                            continue;
                        }
                    } else {
                        const errText = await drainStream(stream);
                        const cat = classify429(errText);
                        markAccountCooldown(account.email, cat === 'quota' ? 'quota' : 'rate_limit');
                        await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                        continue;
                    }
                }

                if (status < 200 || status >= 300) {
                    const text = await drainStream(stream);
                    console.error(`❌ Stream API error ${status} for ${account.email}: ${text.substring(0, 200)}`);
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    continue;
                }

                // ── Success: pipe stream to client ──
                if (!headersAlreadySent && !res.headersSent) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no',
                    });
                }

                try {
                    const { fullAnswer, tokenUsage } = await pipeStream(stream, res, !headersAlreadySent);
                    markAccountSuccess(account.email);
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });
                    logRequest(db, account.email, contents, fullAnswer, tokenUsage, true, systemInstruction);
                    console.log(`✅ Stream fulfilled by ${account.email} [${usedModel}]`);
                    return; // done
                } catch (streamErr: any) {
                    console.error(`❌ Stream pipe error for ${account.email}:`, streamErr);
                    const cat = classifyError(streamErr.message || '');
                    markAccountCooldown(account.email, cat);
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });

                    // If headers were already sent, the HTTP response is committed.
                    // Retrying with another account would write to an already-committed response,
                    // causing a hard disconnect (NetworkError in browser).
                    // End cleanly instead.
                    if (res.headersSent) {
                        if (!res.writableEnded) res.end();
                        return;
                    }
                    continue;
                }

            } catch (e: any) {
                console.error(`❌ Stream network error with ${account.email}:`, e);
                const cat = classifyError(e.message || '');
                markAccountCooldown(account.email, cat);
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
            }
        }

        if (attempt < MAX_ATTEMPTS - 1) {
            const delay = computeBackoffDelay(attempt);
            console.log(`⚠️ Stream: All accounts failed (${attempt + 1}/${MAX_ATTEMPTS}). Backoff: ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    if (!res.headersSent) res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
    else if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: 'All accounts exhausted.' })}\n\n`); res.end(); }
}

// ─── Public streaming (proxy) ─────────────────────────────

function handleStreamGenerateContent(
    req: Request, res: Response, model: string, contents: any[],
    generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any
): void {
    streamWithAccounts(model, contents, generationConfig, systemInstruction, tools, toolConfig, res, false);
}

// ─── Admin chat ───────────────────────────────────────────

export async function handleAdminChat(req: Request, res: Response): Promise<void> {
    try {
        const { contents, model: reqModel, generationConfig, systemInstruction, tools, toolConfig, tool_config } = req.body;
        const model = resolveModel(reqModel || DEFAULT_MODEL);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }
        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        // Admin chat sends SSE headers first, then rotates
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        await streamWithAccounts(model, contents, generationConfig, systemInstruction, tools, toolConfig || tool_config, res, true);
    } catch (e: any) {
        console.error('Admin Chat Error:', e);
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
}
