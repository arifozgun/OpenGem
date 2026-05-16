import { StringDecoder } from 'string_decoder';
import { Request, Response } from 'express';
import { getDatabase } from '../services/database';
import { nativeFetch, nativeFetchStream } from '../services/http';
import { GEMINI_API_BASE, DEFAULT_MODEL, getFirstFallbackModel, getSecondFallbackModel } from '../services/gemini';
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
import { geminiRequestSemaphore, geminiStreamSemaphore, updateConcurrencyLimits } from '../services/concurrency';
import { getReadyAccounts, ensureFreshToken } from '../services/account-manager';
import {
    StreamSink,
    GeminiNativeSink,
    normalizeGeminiChunk,
    safeEnd,
    safeWrite,
} from '../services/streaming';

// ─── Constants ────────────────────────────────────────────

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
const JITTER_FACTOR = 0.2;
const MAX_ATTEMPTS = 5;
// Small stagger between accounts within a round — reduces burst rate seen from our IP.
// Without this, 9 accounts fire back-to-back from the same IP and all get 429.
const INTER_ACCOUNT_STAGGER_MS = 150;
// Non-stream generateContent buffers the entire response upstream, so the socket
// stays idle while the model generates. The default 30s socket-inactivity timeout
// in `nativeFetch` is far too aggressive for long completions (essays, code, etc.)
// and was the root cause of "Request timeout after 30s" failures on long outputs
// that streaming did not exhibit (each chunk resets the inactivity timer).
const GENERATE_CONTENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
 *  primary → fallback → fallbackV2 → null (no more fallbacks)
 */
function getFallbackModel(current: string): string | null {
    const fb1 = getFirstFallbackModel();
    const fb2 = getSecondFallbackModel();
    if (current === fb2) return null;   // Already on last resort
    if (current === fb1) return fb2;    // fallback → fallbackV2
    return fb1;                          // primary → fallback
}

function resolveModel(model: string): string {
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

function logRequest(db: any, email: string, contents: any[], answer: string, tokens: number, success: boolean, systemInstruction?: any, model?: string, isFallback?: boolean) {
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
    else if (systemInstruction?.content?.parts) si = systemInstruction.content.parts.map((p: any) => p.text || '').filter(Boolean).join('\n');

    db.addRequestLog({
        accountEmail: email, question, answer,
        ...(si && { systemInstruction: si }),
        ...(model && { model }),
        ...(isFallback !== undefined && { isFallback }),
        tokensUsed: tokens, success, timestamp: new Date(),
    }).catch((err: any) => console.error('Log write error:', err));
}

// ─── Public entry point ───────────────────────────────────

export const handleGenerateContent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { contents, generationConfig, systemInstruction, system_instruction, tools, toolConfig, tool_config } = req.body;
        const finalSystemInstruction = systemInstruction || system_instruction;
        const model = resolveModel(req.params.model as string);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }
        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const finalToolConfig = toolConfig || tool_config;
        if (req.params.action === 'streamGenerateContent') {
            const sink = new GeminiNativeSink(res, /* headersAlreadyWritten */ false, /* unwrapEnvelope */ true);
            await streamGeminiWithSink({
                model,
                contents,
                generationConfig,
                systemInstruction: finalSystemInstruction,
                tools,
                toolConfig: finalToolConfig,
                res,
                sink,
            });
            return;
        }

        const result = await tryGenerateContentWithAccounts(model, contents, generationConfig, finalSystemInstruction, tools, finalToolConfig);
        if (!result) { res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' }); return; }
        res.json(result);
    } catch (e: any) {
        console.error('Generate Content Error:', e);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error', ...(process.env.NODE_ENV !== 'production' && { message: e.message }) });
        } else if (!res.writableEnded) {
            safeEnd(res);
        }
    }
};

// ─── Non-streaming rotation ───────────────────────────────

export interface GeminiNonStreamResult {
    /** The unwrapped Gemini response object (candidates, usageMetadata, etc.). */
    response: any;
    /** The Gemini model that actually served the request. */
    usedModel: string;
}

/**
 * Public, return-rich variant for adapter use. Kept separate so that the
 * legacy `tryGenerateContentWithAccounts` retains its exact return shape.
 */
export async function generateContentWithAccounts(
    model: string,
    contents: any[],
    generationConfig?: any,
    systemInstruction?: any,
    tools?: any[],
    toolConfig?: any,
): Promise<GeminiNonStreamResult | null> {
    const db = getDatabase();
    await updateConcurrencyLimits();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const accounts = await selectReadyAccounts();
        if (accounts.length === 0) { console.error('❌ No active accounts.'); return null; }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];

            if (isAccountInCooldown(account.email)) {
                if (shouldProbeAccount(account.email)) { console.log(`🔍 Probing ${account.email}...`); recordProbe(account.email); }
                else continue;
            }

            if (!accountRateLimiter.consume(account.email).allowed) {
                console.warn(`🚦 ${account.email} locally rate limited. Skipping.`);
                continue;
            }

            if (i > 0) await new Promise(r => setTimeout(r, INTER_ACCOUNT_STAGGER_MS));

            try {
                const token = await ensureFreshToken(account);
                const requestPayload = buildPayload(contents, generationConfig, systemInstruction, tools, toolConfig);
                let usedModel = model || DEFAULT_MODEL;

                const geminiBody = (m: string) => ({
                    model: m, project: account.projectId,
                    user_prompt_id: 'default-prompt', request: requestPayload,
                });

                const response = await geminiRequestSemaphore.run(() =>
                    nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                        method: 'POST', headers: buildHeaders(token),
                        body: JSON.stringify(geminiBody(usedModel)),
                        timeoutMs: GENERATE_CONTENT_TIMEOUT_MS,
                    })
                );

                if (response.status === 429) {
                    const fallback = getFallbackModel(usedModel);
                    if (fallback) {
                        console.warn(`⏳ ${account.email} 429 on ${usedModel} — trying ${fallback}...`);
                        const fbResp = await nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                            method: 'POST', headers: buildHeaders(token),
                            body: JSON.stringify(geminiBody(fallback)),
                            timeoutMs: GENERATE_CONTENT_TIMEOUT_MS,
                        });
                        if (fbResp.ok) {
                            const data = await fbResp.json() as any;
                            const text = extractText(data.response?.candidates?.[0]);
                            const tokens = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;
                            if (text || data.response?.candidates?.[0]) {
                                markAccountSuccess(account.email);
                                await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens });
                                logRequest(db, account.email, contents, text, tokens, true, systemInstruction, fallback, true);
                                console.log(`✅ Fallback fulfilled by ${account.email} [${fallback}]`);
                                return { response: data.response, usedModel: fallback };
                            }
                        }
                    }

                    let errCategory: 'quota' | 'rate_limit' = 'rate_limit';
                    try { errCategory = classify429(await response.text()); } catch { /* ignore */ }
                    markAccountCooldown(account.email, errCategory === 'quota' ? 'quota' : 'rate_limit');
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    logRequest(db, account.email, contents, `ERROR 429: ${errCategory} cooldown`, 0, false, systemInstruction, usedModel, false);
                    continue;
                }

                if (!response.ok) {
                    const text = await response.text();
                    console.error(`❌ API error ${response.status} for ${account.email}: ${text}`);
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    logRequest(db, account.email, contents, `ERROR ${response.status}: ${text.substring(0, 100)}`, 0, false, systemInstruction, usedModel, false);
                    continue;
                }

                const data = await response.json() as any;
                const text = extractText(data.response?.candidates?.[0]);
                const tokens = data.usageMetadata?.totalTokenCount || data.response?.usageMetadata?.totalTokenCount || 0;
                if (data.response?.candidates?.[0]) {
                    markAccountSuccess(account.email);
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens });
                    logRequest(db, account.email, contents, text, tokens, true, systemInstruction, usedModel, false);
                    console.log(`✅ Fulfilled by ${account.email}`);
                    return { response: data.response, usedModel };
                }
            } catch (e: any) {
                console.error(`❌ Error with ${account.email}:`, e);
                const cat = classifyError(e.message || '');
                markAccountCooldown(account.email, cat);
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                logRequest(db, account.email, contents, `ERROR: ${e.message?.substring(0, 100) || 'Network Error'}`, 0, false, systemInstruction, model || DEFAULT_MODEL, false);
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

/** Legacy signature kept for backward compatibility — returns `data.response` only. */
export async function tryGenerateContentWithAccounts(
    model: string, contents: any[],
    generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any
): Promise<any | null> {
    const result = await generateContentWithAccounts(model, contents, generationConfig, systemInstruction, tools, toolConfig);
    return result ? result.response : null;
}

// ─── Streaming pipeline (sink-driven) ─────────────────────

interface PipeStreamResult {
    fullAnswer: string;
    tokenUsage: number;
    finishReason?: string;
}

/**
 * Reads a Gemini SSE stream and forwards each parsed chunk to the sink.
 * Tracks the assembled answer + token usage for logging purposes.
 *
 * Design notes:
 *  - The function does NOT call `sink.finalize()` — the caller does, after
 *    incrementing stats / writing logs. This keeps the sink lifecycle
 *    explicit at the call site.
 *  - Errors thrown by the sink propagate up so the engine can roll over to
 *    another account (only possible if no chunks have been written yet).
 */
async function pipeStream(stream: any, sink: StreamSink): Promise<PipeStreamResult> {
    return new Promise<PipeStreamResult>((resolve, reject) => {
        let fullAnswer = '';
        let tokenUsage = 0;
        let finishReason: string | undefined;
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        let settled = false;

        const settle = (action: () => void) => {
            if (settled) return;
            settled = true;
            action();
        };

        stream.on('data', (chunk: Buffer) => {
            buffer += decoder.write(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const jsonStr = line.substring(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    const normalized = normalizeGeminiChunk(parsed);

                    for (const t of normalized.textDeltas) fullAnswer += t;
                    for (const fc of normalized.functionCalls) {
                        fullAnswer += `\n\n[Tool Call: ${fc.name}]\n${JSON.stringify(fc.args, null, 2)}\n\n`;
                    }
                    if (normalized.usage?.totalTokens) tokenUsage = normalized.usage.totalTokens;
                    if (normalized.finishReason) finishReason = normalized.finishReason;

                    try {
                        sink.forwardChunk(parsed, normalized, jsonStr);
                    } catch (sinkErr: any) {
                        // A sink error after content was already streamed is not
                        // recoverable — bubble it up.
                        settle(() => reject(sinkErr));
                        return;
                    }
                } catch {
                    // Non-JSON SSE line (rare). Drop it; protocols can't reliably
                    // forward malformed envelopes.
                }
            }
        });

        stream.on('end', () => {
            // Flush any buffered partial chunk (defensive — Gemini ends on \n).
            if (buffer.trim().length > 0 && buffer.startsWith('data: ')) {
                const jsonStr = buffer.substring(6).trim();
                if (jsonStr && jsonStr !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(jsonStr);
                        const normalized = normalizeGeminiChunk(parsed);
                        for (const t of normalized.textDeltas) fullAnswer += t;
                        if (normalized.usage?.totalTokens) tokenUsage = normalized.usage.totalTokens;
                        if (normalized.finishReason) finishReason = normalized.finishReason;
                        sink.forwardChunk(parsed, normalized, jsonStr);
                    } catch { /* ignore */ }
                }
            }
            settle(() => resolve({ fullAnswer, tokenUsage, finishReason }));
        });

        stream.on('error', (err: Error) => {
            settle(() => reject(err));
        });
    });
}

// ─── Streaming engine: account rotation with sink ────────

export interface StreamWithSinkOptions {
    model: string;
    contents: any[];
    generationConfig?: any;
    systemInstruction?: any;
    tools?: any[];
    toolConfig?: any;
    res: Response;
    sink: StreamSink;
}

/**
 * Core streaming engine. Rotates across accounts, tries fallback models on 429,
 * and pipes the first successful upstream stream through the provided sink.
 *
 * Errors are reported via the sink; the engine itself never writes to `res`
 * directly (apart from issuing a JSON 503 *before* the sink has started).
 */
export async function streamGeminiWithSink(opts: StreamWithSinkOptions): Promise<void> {
    const { model, contents, generationConfig, systemInstruction, tools, toolConfig, res, sink } = opts;
    const db = getDatabase();
    await updateConcurrencyLimits();

    const requestedModel = model || DEFAULT_MODEL;
    let sinkStarted = false;

    const reportNoAccounts = () => {
        // No upstream stream was acquired → we still own the response.
        if (sink.headersAlreadyWritten || res.headersSent) {
            // Headers already committed; we cannot send a JSON error. Use the
            // sink's abort path so it can write a protocol-appropriate event.
            sink.abortAfterStart(new Error('All Gemini accounts exhausted or failed.'));
        } else {
            res.status(503).json({ error: 'All Gemini accounts exhausted or failed.' });
        }
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const accounts = await selectReadyAccounts();

        if (accounts.length === 0) {
            reportNoAccounts();
            return;
        }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];

            if (isAccountInCooldown(account.email)) {
                if (shouldProbeAccount(account.email)) { console.log(`🔍 Probing ${account.email}...`); recordProbe(account.email); }
                else continue;
            }

            if (i > 0) await new Promise(r => setTimeout(r, INTER_ACCOUNT_STAGGER_MS));

            try {
                const token = await ensureFreshToken(account);
                const requestPayload = buildPayload(contents, generationConfig, systemInstruction, tools, toolConfig);
                let usedModel = requestedModel;

                const geminiBody = (m: string) => ({
                    model: m, project: account.projectId,
                    user_prompt_id: 'default-prompt', request: requestPayload,
                });

                let { status, stream } = await geminiStreamSemaphore.run(() => nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                    method: 'POST', headers: buildHeaders(token),
                    body: JSON.stringify(geminiBody(usedModel)),
                }));

                if (status === 429) {
                    console.warn(`⏳ Stream: ${account.email} 429 on ${usedModel} — trying fallback...`);
                    const fallback = getFallbackModel(usedModel);

                    if (fallback) {
                        const fbResult = await geminiStreamSemaphore.run(() =>
                            nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                                method: 'POST', headers: buildHeaders(token),
                                body: JSON.stringify(geminiBody(fallback)),
                            })
                        );

                        if (fbResult.status === 200) {
                            console.log(`✅ Stream fallback accepted by ${account.email} [${fallback}]`);
                            // Drain the original 429 stream and switch.
                            stream.resume();
                            stream = fbResult.stream;
                            usedModel = fallback;
                            status = 200;
                        } else {
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

                // ── Success path: hand the stream to the sink ──
                sink.start(usedModel, requestedModel);
                sinkStarted = true;

                try {
                    const { fullAnswer, tokenUsage, finishReason } = await pipeStream(stream, sink);
                    markAccountSuccess(account.email);
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: tokenUsage });
                    logRequest(db, account.email, contents, fullAnswer, tokenUsage, true, systemInstruction, usedModel, usedModel !== requestedModel);
                    sink.finalize({ fullText: fullAnswer, tokenUsage, finishReason });
                    console.log(`✅ Stream fulfilled by ${account.email} [${usedModel}]`);
                    return;
                } catch (streamErr: any) {
                    console.error(`❌ Stream pipe error for ${account.email}:`, streamErr);
                    const cat = classifyError(streamErr.message || '');
                    markAccountCooldown(account.email, cat);
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });

                    // Once the sink started writing, the response is committed. We
                    // cannot retry on another account without corrupting the wire
                    // format. End cleanly via the sink and stop.
                    sink.abortAfterStart(streamErr);
                    return;
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

    if (sinkStarted) {
        sink.abortAfterStart(new Error('All Gemini accounts exhausted or failed.'));
    } else {
        reportNoAccounts();
    }
}

// ─── Admin chat ───────────────────────────────────────────

export async function handleAdminChat(req: Request, res: Response): Promise<void> {
    try {
        const { contents, model: reqModel, generationConfig, systemInstruction, system_instruction, tools, toolConfig, tool_config } = req.body;
        const finalSystemInstruction = systemInstruction || system_instruction;
        const model = resolveModel(reqModel || DEFAULT_MODEL);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }
        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        // Admin chat commits SSE headers up-front; the sink must NOT rewrite them.
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const sink = new GeminiNativeSink(res, /* headersAlreadyWritten */ true, /* unwrapEnvelope */ false);
        await streamGeminiWithSink({
            model,
            contents,
            generationConfig,
            systemInstruction: finalSystemInstruction,
            tools,
            toolConfig: toolConfig || tool_config,
            res,
            sink,
        });
    } catch (e: any) {
        console.error('Admin Chat Error:', e);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        } else if (!res.writableEnded) {
            safeEnd(res);
        }
    }
}
