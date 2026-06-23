/**
 * OpenAI ↔ Gemini protocol adapter.
 *
 * Maps the public OpenAI Chat Completions schema (https://platform.openai.com/docs/api-reference/chat)
 * onto the internal Gemini `generateContent` / `streamGenerateContent` schema and back.
 *
 * Design constraints:
 *  - The translation must be loss-less for everything OpenAI clients expect:
 *    role mapping, tool calls, tool results, multimodal content, finish reasons,
 *    usage stats, and stop sequences.
 *  - Tool call IDs are an OpenAI-only concept; Gemini matches on function name.
 *    We keep a per-conversation map so that downstream tool result messages
 *    can be looked up reliably even if multiple calls share the same name.
 *  - Streaming must produce a wire-correct sequence of `chat.completion.chunk`
 *    events terminated by `data: [DONE]\n\n`, including a final empty delta
 *    carrying `finish_reason`.
 */

import crypto from 'crypto';
import type { Response } from 'express';
import {
    NormalizedChunk,
    StreamSink,
    safeEnd,
    safeWrite,
    writeSseHead,
} from '../streaming';

// ─── Public types ────────────────────────────────────────────────────────────

export interface OpenAIChatRequest {
    model?: string;
    models?: string[];
    messages: OpenAIMessage[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    n?: number;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    response_format?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: { schema?: any } };
    tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: any } }>;
    tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
    seed?: number;
    user?: string;
    session_id?: string;
    metadata?: Record<string, string>;
    provider?: Record<string, any>;
    route?: any;
    reasoning?: Record<string, any>;
    service_tier?: string;
    safety_identifier?: string;
    parallel_tool_calls?: boolean;
    stream_options?: { include_usage?: boolean };
}

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
    content?: string | Array<OpenAIContentPart> | null;
    name?: string;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
}

export type OpenAIContentPart =
    | { type: 'text'; text: string }
    | { type: 'input_text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: string } | string }
    | { type: 'input_audio'; input_audio: { data: string; format: string } };

export interface GeminiTranslated {
    model: string;                  // user-requested model id (passed through to clients)
    contents: any[];
    systemInstruction?: any;
    generationConfig?: any;
    tools?: any[];
    toolConfig?: any;
    stream: boolean;
    includeUsage: boolean;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export class OpenAIRequestError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message);
        this.name = 'OpenAIRequestError';
    }
}

export function buildOpenAIErrorBody(message: string, type: string, code: string | null) {
    return {
        error: {
            message,
            type,
            param: null,
            code,
        },
    };
}

// ─── Request translation ─────────────────────────────────────────────────────

function partsFromContent(content: OpenAIMessage['content']): any[] {
    if (content == null) return [];
    if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : [];

    const parts: any[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        switch (part.type) {
            case 'text':
            case 'input_text': {
                if (typeof part.text === 'string' && part.text.length > 0) parts.push({ text: part.text });
                break;
            }
            case 'image_url': {
                const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? '';
                const dataMatch = url.match(/^data:([^;,]+);base64,(.+)$/i);
                if (dataMatch) {
                    parts.push({ inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } });
                } else if (url.length > 0) {
                    if (!/^https?:\/\//i.test(url)) {
                        throw new OpenAIRequestError(400, 'invalid_request_error', 'Only data, http, and https image URLs are supported.');
                    }
                    // Gemini supports remote file URIs via fileData. For privacy / security we
                    // forward the URI verbatim; we do NOT fetch it server-side.
                    parts.push({ fileData: { fileUri: url, mimeType: 'image/*' } });
                }
                break;
            }
            // Audio content is not supported by Gemini's text-completion stream;
            // we silently ignore it instead of failing the request.
            default:
                break;
        }
    }
    return parts;
}

function safeJsonParse(text: string): any {
    try { return JSON.parse(text); } catch { return undefined; }
}

function pickRequestedModel(req: OpenAIChatRequest): string | undefined {
    if (typeof req.model === 'string' && req.model.trim()) return req.model.trim();
    if (Array.isArray(req.models)) {
        const first = req.models.find(model => typeof model === 'string' && model.trim());
        if (first) return first.trim();
    }
    return undefined;
}

export function translateOpenAIRequest(req: OpenAIChatRequest): GeminiTranslated {
    if (!req || typeof req !== 'object') {
        throw new OpenAIRequestError(400, 'invalid_request_error', 'Request body must be a JSON object.');
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
        throw new OpenAIRequestError(400, 'invalid_request_error', '`messages` must be a non-empty array.');
    }
    const requestedModel = pickRequestedModel(req);
    if (!requestedModel) {
        throw new OpenAIRequestError(400, 'invalid_request_error', '`model` is required.');
    }

    const contents: any[] = [];
    const systemTexts: string[] = [];
    const toolCallIdToName = new Map<string, string>();

    for (const msg of req.messages) {
        if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string') {
            throw new OpenAIRequestError(400, 'invalid_request_error', 'Each message must include a `role`.');
        }

        switch (msg.role) {
            case 'system':
            case 'developer': {
                if (typeof msg.content === 'string') systemTexts.push(msg.content);
                else if (Array.isArray(msg.content)) {
                    for (const c of msg.content) if ((c?.type === 'text' || c?.type === 'input_text') && c.text) systemTexts.push(c.text);
                }
                break;
            }

            case 'user': {
                const parts = partsFromContent(msg.content);
                if (parts.length === 0) parts.push({ text: '' });
                contents.push({ role: 'user', parts });
                break;
            }

            case 'assistant': {
                const parts: any[] = [];
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content
                            .filter((c): c is { type: 'text' | 'input_text'; text: string } => c?.type === 'text' || c?.type === 'input_text')
                            .map(c => c.text)
                            .join('')
                        : '';
                if (text) parts.push({ text });

                if (Array.isArray(msg.tool_calls)) {
                    for (const tc of msg.tool_calls) {
                        if (tc?.type !== 'function' || !tc.function?.name) continue;
                        toolCallIdToName.set(tc.id, tc.function.name);
                        const args = safeJsonParse(tc.function.arguments || '{}') ?? {};
                        parts.push({ functionCall: { name: tc.function.name, args } });
                    }
                }
                if (parts.length === 0) parts.push({ text: '' });
                contents.push({ role: 'model', parts });
                break;
            }

            case 'tool': {
                if (!msg.tool_call_id) {
                    throw new OpenAIRequestError(400, 'invalid_request_error', 'Tool messages must include `tool_call_id`.');
                }
                const name = toolCallIdToName.get(msg.tool_call_id) || msg.name || 'tool';
                const rawText = typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content
                            .filter((c): c is { type: 'text' | 'input_text'; text: string } => c?.type === 'text' || c?.type === 'input_text')
                            .map(c => c.text)
                            .join('')
                        : '';
                const parsed = safeJsonParse(rawText);
                const responseObj =
                    parsed !== undefined && typeof parsed === 'object' && parsed !== null
                        ? parsed
                        : { result: rawText };
                contents.push({
                    role: 'user',
                    parts: [{ functionResponse: { name, response: responseObj } }],
                });
                break;
            }

            default:
                throw new OpenAIRequestError(400, 'invalid_request_error', `Unsupported role: ${msg.role}`);
        }
    }

    // ── generationConfig ──
    const generationConfig: any = {};
    if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
    if (typeof req.top_p === 'number') generationConfig.topP = req.top_p;
    const maxTokens = req.max_completion_tokens ?? req.max_tokens;
    if (typeof maxTokens === 'number' && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
    if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    if (typeof req.presence_penalty === 'number') generationConfig.presencePenalty = req.presence_penalty;
    if (typeof req.frequency_penalty === 'number') generationConfig.frequencyPenalty = req.frequency_penalty;
    if (typeof req.seed === 'number') generationConfig.seed = req.seed;
    if (req.response_format?.type === 'json_object' || req.response_format?.type === 'json_schema') {
        generationConfig.responseMimeType = 'application/json';
        if (req.response_format.type === 'json_schema' && req.response_format.json_schema?.schema) {
            generationConfig.responseSchema = req.response_format.json_schema.schema;
        }
    }

    // ── tools / toolConfig ──
    let tools: any[] | undefined;
    if (Array.isArray(req.tools) && req.tools.length > 0) {
        const declarations = req.tools
            .filter(t => t?.type === 'function' && t.function?.name)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                parameters: t.function.parameters || { type: 'object', properties: {} },
            }));
        if (declarations.length > 0) tools = [{ functionDeclarations: declarations }];
    }

    let toolConfig: any | undefined;
    if (req.tool_choice !== undefined) {
        if (req.tool_choice === 'auto') toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        else if (req.tool_choice === 'none') toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        else if (req.tool_choice === 'required') toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        else if (typeof req.tool_choice === 'object' && req.tool_choice.type === 'function') {
            toolConfig = {
                functionCallingConfig: {
                    mode: 'ANY',
                    allowedFunctionNames: [req.tool_choice.function.name],
                },
            };
        }
    }

    return {
        model: requestedModel,
        contents,
        systemInstruction: systemTexts.length > 0 ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
        generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
        tools,
        toolConfig,
        stream: req.stream === true,
        includeUsage: req.stream_options?.include_usage !== false, // default true
    };
}

// ─── Response translation (non-stream) ──────────────────────────────────────

function genId(prefix: string): string {
    return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

function mapFinishReason(geminiReason: string | undefined, hasToolCalls: boolean): string {
    if (hasToolCalls) return 'tool_calls';
    if (!geminiReason) return 'stop';
    switch (geminiReason) {
        case 'STOP': return 'stop';
        case 'MAX_TOKENS': return 'length';
        case 'SAFETY':
        case 'RECITATION':
        case 'PROHIBITED_CONTENT':
        case 'BLOCKLIST':
            return 'content_filter';
        default: return 'stop';
    }
}

export function translateGeminiToOpenAI(geminiResp: any, requestedModel: string): any {
    const candidate = geminiResp?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];

    let text = '';
    const toolCalls: any[] = [];
    let toolIdx = 0;
    for (const p of parts) {
        if (typeof p?.text === 'string') text += p.text;
        else if (p?.functionCall) {
            toolCalls.push({
                id: `call_${crypto.randomBytes(12).toString('hex')}_${toolIdx++}`,
                type: 'function',
                function: {
                    name: String(p.functionCall.name || ''),
                    arguments: JSON.stringify(p.functionCall.args ?? {}),
                },
            });
        }
    }

    const usage = geminiResp?.usageMetadata || {};
    const finishReason = mapFinishReason(candidate?.finishReason, toolCalls.length > 0);

    return {
        id: genId('chatcmpl'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: text.length > 0 ? text : null,
                    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
                    refusal: null,
                },
                logprobs: null,
                finish_reason: finishReason,
            },
        ],
        usage: {
            prompt_tokens: Number(usage.promptTokenCount || 0),
            completion_tokens: Number(usage.candidatesTokenCount || 0),
            total_tokens: Number(usage.totalTokenCount || 0),
        },
        system_fingerprint: null,
    };
}

// ─── Stream sink ─────────────────────────────────────────────────────────────

interface ToolCallStreamState {
    id: string;
    name: string;
    argsJson: string;       // accumulated JSON string for arguments
    streamedHeader: boolean; // whether we've already emitted the {id, type, function: {name, ...}} header
    index: number;
}

/**
 * Streams Gemini SSE chunks as OpenAI `chat.completion.chunk` SSE events.
 *
 * Wire spec:
 *   data: { ...chunk, choices: [{index:0, delta:{role:"assistant"}, finish_reason:null}] }
 *   data: { ..., choices: [{index:0, delta:{content:"Hello"}, finish_reason:null}] }
 *   data: { ..., choices: [{index:0, delta:{}, finish_reason:"stop"}] }
 *   data: { ..., choices: [], usage: { prompt_tokens, completion_tokens, total_tokens } }   // optional
 *   data: [DONE]
 */
export class OpenAIStreamSink implements StreamSink {
    public readonly headersAlreadyWritten = false;

    private readonly id = genId('chatcmpl');
    private readonly created = Math.floor(Date.now() / 1000);
    private roleEmitted = false;
    private toolCalls: ToolCallStreamState[] = [];
    private finalUsage: { prompt: number; completion: number; total: number } | null = null;

    constructor(
        private readonly res: Response,
        private readonly requestedModel: string,
        private readonly includeUsage: boolean,
    ) {}

    private writeChunk(payload: any): void {
        safeWrite(this.res, `data: ${JSON.stringify(payload)}\n\n`);
    }

    private buildEnvelope(extra: { delta?: any; finish_reason?: string | null; usage?: any }): any {
        const base: any = {
            id: this.id,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.requestedModel,
            system_fingerprint: null,
        };

        if (extra.usage !== undefined) {
            base.choices = [];
            base.usage = extra.usage;
        } else {
            base.choices = [
                {
                    index: 0,
                    delta: extra.delta ?? {},
                    logprobs: null,
                    finish_reason: extra.finish_reason ?? null,
                },
            ];
        }
        return base;
    }

    start(_usedModel: string, _requestedModel: string): void {
        writeSseHead(this.res);
        // Initial role-only delta (canonical OpenAI behaviour).
        this.writeChunk(this.buildEnvelope({ delta: { role: 'assistant', content: '' } }));
        this.roleEmitted = true;
    }

    forwardChunk(_parsed: any, normalized: NormalizedChunk): void {
        // 1) Text deltas
        for (const text of normalized.textDeltas) {
            if (!text) continue;
            this.writeChunk(this.buildEnvelope({ delta: { content: text } }));
        }

        // 2) Function calls — Gemini emits the call atomically; map to OpenAI's
        //    incremental tool_call format with a single header + arguments delta.
        for (const fc of normalized.functionCalls) {
            const idx = this.toolCalls.length;
            const state: ToolCallStreamState = {
                id: `call_${crypto.randomBytes(12).toString('hex')}`,
                name: fc.name,
                argsJson: JSON.stringify(fc.args ?? {}),
                streamedHeader: false,
                index: idx,
            };
            this.toolCalls.push(state);

            // Emit the header (id, type, function.name, arguments="").
            this.writeChunk(
                this.buildEnvelope({
                    delta: {
                        tool_calls: [
                            {
                                index: state.index,
                                id: state.id,
                                type: 'function',
                                function: { name: state.name, arguments: '' },
                            },
                        ],
                    },
                }),
            );
            state.streamedHeader = true;

            // Emit the full arguments JSON in one go (Gemini doesn't stream args).
            if (state.argsJson && state.argsJson !== '{}') {
                this.writeChunk(
                    this.buildEnvelope({
                        delta: {
                            tool_calls: [
                                {
                                    index: state.index,
                                    function: { arguments: state.argsJson },
                                },
                            ],
                        },
                    }),
                );
            }
        }

        // 3) Track usage
        if (normalized.usage) {
            this.finalUsage = {
                prompt: normalized.usage.promptTokens,
                completion: normalized.usage.completionTokens,
                total: normalized.usage.totalTokens,
            };
        }
    }

    finalize(state: { finishReason?: string }): void {
        const finishReason = mapFinishReason(state.finishReason, this.toolCalls.length > 0);
        // Final empty delta carrying the finish_reason.
        this.writeChunk(this.buildEnvelope({ delta: {}, finish_reason: finishReason }));

        // Optional usage chunk (OpenAI emits it last when stream_options.include_usage=true).
        if (this.includeUsage && this.finalUsage) {
            this.writeChunk(
                this.buildEnvelope({
                    usage: {
                        prompt_tokens: this.finalUsage.prompt,
                        completion_tokens: this.finalUsage.completion,
                        total_tokens: this.finalUsage.total,
                    },
                }),
            );
        }

        safeWrite(this.res, 'data: [DONE]\n\n');
        safeEnd(this.res);
    }

    abortAfterStart(err: Error): void {
        // Emit a sentinel error chunk so well-behaved SDKs surface a meaningful failure.
        const message = err?.message?.replace(/\s+/g, ' ').slice(0, 500) || 'Upstream stream failed.';
        // OpenAI doesn't define a streamed error frame, but emitting an error wrapped
        // in the standard SSE envelope is the de-facto convention used by proxies.
        this.writeChunk({
            error: {
                message,
                type: 'server_error',
                param: null,
                code: 'stream_failed',
            },
        });
        safeWrite(this.res, 'data: [DONE]\n\n');
        safeEnd(this.res);
    }
}
