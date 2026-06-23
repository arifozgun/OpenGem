import { StringDecoder } from 'string_decoder';
import { Request, Response } from 'express';
import { getDatabase } from '../services/database';
import { nativeFetch, nativeFetchStream } from '../services/http';
import { GEMINI_API_BASE, DEFAULT_MODEL } from '../services/antigravity';
import { classifyError } from '../services/error-classifier';
import {
    markAccountCooldown,
    markAccountSuccess,
    clearExpiredCooldowns,
    parseRetryAfterMs,
} from '../services/account-cooldown';
import { geminiRequestSemaphore, geminiStreamSemaphore, updateConcurrencyLimits } from '../services/concurrency';
import { getReadyAccounts, ensureFreshToken } from '../services/account-manager';
import {
    beginAccountAttempt,
    planAccountAttempts,
    releaseAccountAttempt,
} from '../services/account-balancer';
import {
    AccountAffinityContext,
    bindAffinityAccount,
    computeEffectiveTokenUsage,
    createAccountAffinityContext,
    getAffinityLogFields,
    getAffinityPromptId,
    releaseAffinityReservation,
} from '../services/account-affinity';
import {
    StreamSink,
    GeminiNativeSink,
    normalizeGeminiChunk,
    safeEnd,
    safeWrite,
} from '../services/streaming';
import { resolveCompatibilityModel } from '../services/adapters/model-aliases';
import { getRequestLogMetadata, RequestLogMetadata } from '../services/access-log';

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

function sleep(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

function shouldCooldownForCategory(category: ReturnType<typeof classifyError>): boolean {
    return !['format', 'model_not_found'].includes(category);
}

function classify429(text: string): 'quota' | 'rate_limit' {
    const cat = classifyError(text);
    return (cat === 'quota' || cat === 'auth' || cat === 'billing') ? 'quota' : 'rate_limit';
}

function resolveModel(model: string): string {
    return resolveCompatibilityModel(model || DEFAULT_MODEL);
}

function buildHeaders(token: string) {
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Goog-Api-Client': 'gl-node/openclaw',
        'User-Agent': 'antigravity/1.0.2 (darwin; arm64)',
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

interface RequestTokenUsage {
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
    effectiveTokens?: number;
}

function toPositiveNumber(value: any): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function extractGeminiUsage(meta: any): RequestTokenUsage {
    const promptTokens = toPositiveNumber(meta?.promptTokenCount);
    const completionTokens = toPositiveNumber(meta?.candidatesTokenCount ?? meta?.candidateTokenCount ?? meta?.completionTokenCount);
    const totalTokens = toPositiveNumber(meta?.totalTokenCount)
        ?? ((promptTokens ?? 0) + (completionTokens ?? 0));

    return {
        totalTokens,
        ...(promptTokens !== undefined && { promptTokens }),
        ...(completionTokens !== undefined && { completionTokens }),
    };
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

function logRequest(
    db: any,
    email: string,
    contents: any[],
    answer: string,
    tokens: number,
    success: boolean,
    systemInstruction?: any,
    model?: string,
    isFallback?: boolean,
    affinity?: AccountAffinityContext,
    usage?: RequestTokenUsage,
    requestMeta?: RequestLogMetadata,
) {
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
        ...getAffinityLogFields(affinity),
        ...(usage?.promptTokens !== undefined && { promptTokens: usage.promptTokens }),
        ...(usage?.completionTokens !== undefined && { completionTokens: usage.completionTokens }),
        ...(usage?.effectiveTokens !== undefined && { effectiveTokensUsed: usage.effectiveTokens }),
        ...(requestMeta && {
            requestId: requestMeta.requestId,
            level: success ? 'info' : 'warn',
            method: requestMeta.method,
            url: requestMeta.url,
            userApi: requestMeta.userApi,
            status: success ? 200 : 502,
            execTimeMs: requestMeta.execTimeMs,
            opengemKey: requestMeta.opengemKey,
            userAgent: requestMeta.userAgent,
            remoteIp: requestMeta.remoteIp,
        }),
        tokensUsed: tokens, success, timestamp: new Date(),
    }).catch((err: any) => console.error('Log write error:', err));
}

// ─── Public entry point ───────────────────────────────────

export const handleGenerateContent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { contents, generationConfig, systemInstruction, system_instruction, tools, toolConfig, tool_config } = req.body;
        const finalSystemInstruction = systemInstruction || system_instruction;
        const requestedModelLabel = (req.params.model as string) || DEFAULT_MODEL;
        const model = resolveModel(req.params.model as string);

        if (!contents || !Array.isArray(contents)) {
            res.status(400).json({ error: 'Invalid contents payload' });
            return;
        }
        contents.forEach((c: any) => { if (!c.role) c.role = 'user'; });

        const finalToolConfig = toolConfig || tool_config;
        const affinity = createAccountAffinityContext({
            req,
            model: requestedModelLabel,
            contents,
            systemInstruction: finalSystemInstruction,
        });
        const requestMeta = () => getRequestLogMetadata(req);
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
                logModel: requestedModelLabel,
                affinity,
                requestMeta,
            });
            return;
        }

        const result = await tryGenerateContentWithAccounts(model, contents, generationConfig, finalSystemInstruction, tools, finalToolConfig, requestedModelLabel, affinity, requestMeta);
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
    logModel?: string,
    affinity?: AccountAffinityContext,
    requestMeta?: () => RequestLogMetadata,
): Promise<GeminiNonStreamResult | null> {
    const modelForLog = logModel || model;
    const db = getDatabase();
    await updateConcurrencyLimits();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const accountPlan = planAccountAttempts(await selectReadyAccounts(), { affinity, mode: 'non-stream' });
        if (!accountPlan.hasActiveAccounts) { console.error('❌ No active accounts.'); return null; }

        if (accountPlan.candidates.length === 0) {
            if (attempt >= MAX_ATTEMPTS - 1) break;
            const backoffDelay = computeBackoffDelay(attempt);
            const delay = Math.min(accountPlan.nextRetryAfterMs ?? backoffDelay, backoffDelay);
            console.log(`⚠️ No account currently available. Waiting ${delay}ms before replanning...`);
            await sleep(delay);
            continue;
        }

        for (let i = 0; i < accountPlan.candidates.length; i++) {
            const lease = beginAccountAttempt(accountPlan.candidates[i], affinity);
            if (!lease) continue;
            const account = lease.account;

            if (i > 0) await sleep(INTER_ACCOUNT_STAGGER_MS);

            try {
                const token = await ensureFreshToken(account);
                const requestPayload = buildPayload(contents, generationConfig, systemInstruction, tools, toolConfig);
                let usedModel = model || DEFAULT_MODEL;
                const userPromptId = getAffinityPromptId(affinity);

                const geminiBody = (m: string) => ({
                    model: m, project: account.projectId,
                    user_prompt_id: userPromptId, request: requestPayload,
                });

                const response = await geminiRequestSemaphore.run(() =>
                    nativeFetch(`${GEMINI_API_BASE}:generateContent`, {
                        method: 'POST', headers: buildHeaders(token),
                        body: JSON.stringify(geminiBody(usedModel)),
                        timeoutMs: GENERATE_CONTENT_TIMEOUT_MS,
                    })
                );

                if (response.status === 429) {
                    let errCategory: 'quota' | 'rate_limit' = 'rate_limit';
                    try { errCategory = classify429(await response.text()); } catch { /* ignore */ }
                    const category = errCategory === 'quota' ? 'quota' : 'rate_limit';
                    markAccountCooldown(account.email, category, { retryAfterMs: parseRetryAfterMs(response.headers['retry-after']) });
                    releaseAffinityReservation(affinity, account.email);
                    releaseAccountAttempt(lease, { success: false, category });
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    logRequest(db, account.email, contents, `ERROR 429: ${errCategory} cooldown`, 0, false, systemInstruction, modelForLog, false, affinity, undefined, requestMeta?.());
                    continue;
                }

                if (!response.ok) {
                    const text = await response.text();
                    const category = classifyError(`${response.status} ${text}`);
                    console.error(`❌ API error ${response.status} for ${account.email}: ${text}`);
                    if (shouldCooldownForCategory(category)) {
                        markAccountCooldown(account.email, category, { retryAfterMs: parseRetryAfterMs(response.headers['retry-after']) });
                    }
                    releaseAffinityReservation(affinity, account.email);
                    releaseAccountAttempt(lease, { success: false, category });
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    logRequest(db, account.email, contents, `ERROR ${response.status}: ${text.substring(0, 100)}`, 0, false, systemInstruction, modelForLog, false, affinity, undefined, requestMeta?.());
                    continue;
                }

                const data = await response.json() as any;
                const text = extractText(data.response?.candidates?.[0]);
                const usage = extractGeminiUsage(data.usageMetadata || data.response?.usageMetadata);
                if (data.response?.candidates?.[0]) {
                    markAccountSuccess(account.email);
                    usage.effectiveTokens = computeEffectiveTokenUsage(affinity, account.email, usage);
                    bindAffinityAccount(affinity, account.email);
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: usage.effectiveTokens });
                    logRequest(db, account.email, contents, text, usage.totalTokens, true, systemInstruction, modelForLog, false, affinity, usage, requestMeta?.());
                    releaseAccountAttempt(lease, { success: true });
                    console.log(`✅ Fulfilled by ${account.email}`);
                    return { response: data.response, usedModel };
                }
                releaseAffinityReservation(affinity, account.email);
                releaseAccountAttempt(lease, { success: false, category: 'unknown' });
            } catch (e: any) {
                console.error(`❌ Error with ${account.email}:`, e);
                const cat = classifyError(e.message || '');
                if (shouldCooldownForCategory(cat)) markAccountCooldown(account.email, cat);
                releaseAffinityReservation(affinity, account.email);
                releaseAccountAttempt(lease, { success: false, category: cat });
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                logRequest(db, account.email, contents, `ERROR: ${e.message?.substring(0, 100) || 'Network Error'}`, 0, false, systemInstruction, modelForLog, false, affinity, undefined, requestMeta?.());
            }
        }

        if (attempt < MAX_ATTEMPTS - 1) {
            const delay = computeBackoffDelay(attempt);
            console.log(`⚠️ All accounts failed (${attempt + 1}/${MAX_ATTEMPTS}). Backoff: ${delay}ms...`);
            await sleep(delay);
        }
    }
    return null;
}

/** Legacy signature kept for backward compatibility — returns `data.response` only. */
export async function tryGenerateContentWithAccounts(
    model: string, contents: any[],
    generationConfig?: any, systemInstruction?: any, tools?: any[], toolConfig?: any, logModel?: string, affinity?: AccountAffinityContext, requestMeta?: () => RequestLogMetadata
): Promise<any | null> {
    const result = await generateContentWithAccounts(model, contents, generationConfig, systemInstruction, tools, toolConfig, logModel, affinity, requestMeta);
    return result ? result.response : null;
}

// ─── Streaming pipeline (sink-driven) ─────────────────────

interface PipeStreamResult {
    fullAnswer: string;
    usage: RequestTokenUsage;
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
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
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
                    if (normalized.usage?.promptTokens) promptTokens = normalized.usage.promptTokens;
                    if (normalized.usage?.completionTokens) completionTokens = normalized.usage.completionTokens;
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
                        if (normalized.usage?.promptTokens) promptTokens = normalized.usage.promptTokens;
                        if (normalized.usage?.completionTokens) completionTokens = normalized.usage.completionTokens;
                        if (normalized.finishReason) finishReason = normalized.finishReason;
                        sink.forwardChunk(parsed, normalized, jsonStr);
                    } catch { /* ignore */ }
                }
            }
            settle(() => resolve({
                fullAnswer,
                usage: {
                    totalTokens: tokenUsage,
                    ...(promptTokens !== undefined && { promptTokens }),
                    ...(completionTokens !== undefined && { completionTokens }),
                },
                finishReason,
            }));
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
    /** Client-facing model label to record in request logs (overrides upstream slug). */
    logModel?: string;
    affinity?: AccountAffinityContext;
    requestMeta?: () => RequestLogMetadata;
}

/**
 * Core streaming engine. Rotates across accounts, tries fallback models on 429,
 * and pipes the first successful upstream stream through the provided sink.
 *
 * Errors are reported via the sink; the engine itself never writes to `res`
 * directly (apart from issuing a JSON 503 *before* the sink has started).
 */
export async function streamGeminiWithSink(opts: StreamWithSinkOptions): Promise<void> {
    const { model, contents, generationConfig, systemInstruction, tools, toolConfig, res, sink, logModel, affinity, requestMeta } = opts;
    const modelForLog = logModel || model || DEFAULT_MODEL;
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
        const accountPlan = planAccountAttempts(await selectReadyAccounts(), { affinity, mode: 'stream' });

        if (!accountPlan.hasActiveAccounts) {
            reportNoAccounts();
            return;
        }

        if (accountPlan.candidates.length === 0) {
            if (attempt >= MAX_ATTEMPTS - 1) break;
            const backoffDelay = computeBackoffDelay(attempt);
            const delay = Math.min(accountPlan.nextRetryAfterMs ?? backoffDelay, backoffDelay);
            console.log(`⚠️ Stream: no account currently available. Waiting ${delay}ms before replanning...`);
            await sleep(delay);
            continue;
        }

        for (let i = 0; i < accountPlan.candidates.length; i++) {
            const lease = beginAccountAttempt(accountPlan.candidates[i], affinity);
            if (!lease) continue;
            const account = lease.account;

            if (i > 0) await sleep(INTER_ACCOUNT_STAGGER_MS);

            try {
                const token = await ensureFreshToken(account);
                const requestPayload = buildPayload(contents, generationConfig, systemInstruction, tools, toolConfig);
                let usedModel = requestedModel;
                const userPromptId = getAffinityPromptId(affinity);

                const geminiBody = (m: string) => ({
                    model: m, project: account.projectId,
                    user_prompt_id: userPromptId, request: requestPayload,
                });

                let { status, headers, stream } = await geminiStreamSemaphore.run(() => nativeFetchStream(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
                    method: 'POST', headers: buildHeaders(token),
                    body: JSON.stringify(geminiBody(usedModel)),
                }));

                if (status === 429) {
                    const errText = await drainStream(stream);
                    const cat = classify429(errText);
                    const category = cat === 'quota' ? 'quota' : 'rate_limit';
                    markAccountCooldown(account.email, category, { retryAfterMs: parseRetryAfterMs(headers['retry-after']) });
                    releaseAffinityReservation(affinity, account.email);
                    releaseAccountAttempt(lease, { success: false, category });
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    continue;
                }

                if (status < 200 || status >= 300) {
                    const text = await drainStream(stream);
                    const category = classifyError(`${status} ${text}`);
                    console.error(`❌ Stream API error ${status} for ${account.email}: ${text.substring(0, 200)}`);
                    if (shouldCooldownForCategory(category)) {
                        markAccountCooldown(account.email, category, { retryAfterMs: parseRetryAfterMs(headers['retry-after']) });
                    }
                    releaseAffinityReservation(affinity, account.email);
                    releaseAccountAttempt(lease, { success: false, category });
                    await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
                    continue;
                }

                // ── Success path: hand the stream to the sink ──
                sink.start(usedModel, requestedModel);
                sinkStarted = true;

                try {
                    const { fullAnswer, usage, finishReason } = await pipeStream(stream, sink);
                    markAccountSuccess(account.email);
                    usage.effectiveTokens = computeEffectiveTokenUsage(affinity, account.email, usage);
                    bindAffinityAccount(affinity, account.email);
                    await db.incrementAccountStats(account.email, { successful: 1, failed: 0, tokens: usage.effectiveTokens });
                    logRequest(db, account.email, contents, fullAnswer, usage.totalTokens, true, systemInstruction, modelForLog, usedModel !== requestedModel, affinity, usage, requestMeta?.());
                    sink.finalize({ fullText: fullAnswer, tokenUsage: usage.totalTokens, finishReason });
                    releaseAccountAttempt(lease, { success: true });
                    console.log(`✅ Stream fulfilled by ${account.email} [${usedModel}]`);
                    return;
                } catch (streamErr: any) {
                    console.error(`❌ Stream pipe error for ${account.email}:`, streamErr);
                    const cat = classifyError(streamErr.message || '');
                    if (shouldCooldownForCategory(cat)) markAccountCooldown(account.email, cat);
                    releaseAffinityReservation(affinity, account.email);
                    releaseAccountAttempt(lease, { success: false, category: cat });
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
                if (shouldCooldownForCategory(cat)) markAccountCooldown(account.email, cat);
                releaseAffinityReservation(affinity, account.email);
                releaseAccountAttempt(lease, { success: false, category: cat });
                await db.incrementAccountStats(account.email, { successful: 0, failed: 1, tokens: 0 });
            }
        }

        if (attempt < MAX_ATTEMPTS - 1) {
            const delay = computeBackoffDelay(attempt);
            console.log(`⚠️ Stream: All accounts failed (${attempt + 1}/${MAX_ATTEMPTS}). Backoff: ${delay}ms...`);
            await sleep(delay);
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
        const model = resolveCompatibilityModel(reqModel || DEFAULT_MODEL);

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
        const affinity = createAccountAffinityContext({
            req,
            model: reqModel || DEFAULT_MODEL,
            contents,
            systemInstruction: finalSystemInstruction,
        });
        const requestMeta = () => getRequestLogMetadata(req);
        await streamGeminiWithSink({
            model,
            contents,
            generationConfig,
            systemInstruction: finalSystemInstruction,
            tools,
            toolConfig: toolConfig || tool_config,
            res,
            sink,
            affinity,
            requestMeta,
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
