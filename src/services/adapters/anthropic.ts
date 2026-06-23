/**
 * Anthropic Messages API ↔ Gemini protocol adapter.
 *
 * Maps the public Anthropic Messages API
 * (https://docs.anthropic.com/en/api/messages) onto the internal Gemini
 * `generateContent` / `streamGenerateContent` schema and back.
 *
 * The Anthropic stream protocol is the most complex of the three formats:
 * each response is a sequence of typed events
 *   message_start → content_block_start → content_block_delta* → content_block_stop
 *                 (… repeat blocks …) → message_delta → message_stop
 * Tool use blocks emit `input_json_delta` events instead of `text_delta`.
 *
 * Because Gemini emits tool calls atomically (full args in one chunk), we
 * translate each Gemini functionCall into one tool_use block with a single
 * `input_json_delta` carrying the complete JSON. Text deltas are forwarded
 * incrementally inside a long-lived text content block.
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

export interface AnthropicMessageRequest {
    model: string;
    messages: AnthropicMessage[];
    system?: string | Array<{ type: 'text'; text: string }>;
    max_tokens: number;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    tools?: Array<{ name: string; description?: string; input_schema?: any }>;
    tool_choice?:
        | { type: 'auto' }
        | { type: 'any' }
        | { type: 'none' }
        | { type: 'tool'; name: string };
    metadata?: { user_id?: string };
    session_id?: string;
}

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: AnthropicImageSource }
    | { type: 'tool_use'; id: string; name: string; input: any }
    | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string }>; is_error?: boolean };

export type AnthropicImageSource =
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };

export interface GeminiTranslated {
    model: string;
    contents: any[];
    systemInstruction?: any;
    generationConfig?: any;
    tools?: any[];
    toolConfig?: any;
    stream: boolean;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class AnthropicRequestError extends Error {
    constructor(public readonly status: number, public readonly type: string, message: string) {
        super(message);
        this.name = 'AnthropicRequestError';
    }
}

export function buildAnthropicErrorBody(message: string, type: string) {
    return {
        type: 'error',
        error: { type, message },
    };
}

// ─── Request translation ─────────────────────────────────────────────────────

function safeJsonParse(text: string): any {
    try { return JSON.parse(text); } catch { return undefined; }
}

function flattenAnthropicText(content: AnthropicMessage['content']): string {
    if (typeof content === 'string') return content;
    return content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
        .map(b => b.text)
        .join('');
}

export function translateAnthropicRequest(req: AnthropicMessageRequest): GeminiTranslated {
    if (!req || typeof req !== 'object') {
        throw new AnthropicRequestError(400, 'invalid_request_error', 'Request body must be a JSON object.');
    }
    if (typeof req.model !== 'string' || req.model.length === 0) {
        throw new AnthropicRequestError(400, 'invalid_request_error', '`model` is required.');
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
        throw new AnthropicRequestError(400, 'invalid_request_error', '`messages` must be a non-empty array.');
    }
    if (typeof req.max_tokens !== 'number' || req.max_tokens <= 0) {
        throw new AnthropicRequestError(400, 'invalid_request_error', '`max_tokens` is required and must be a positive integer.');
    }

    const contents: any[] = [];
    const systemTexts: string[] = [];
    const toolUseIdToName = new Map<string, string>();

    if (req.system) {
        if (typeof req.system === 'string') systemTexts.push(req.system);
        else if (Array.isArray(req.system)) {
            for (const block of req.system) {
                if (block?.type === 'text' && typeof block.text === 'string') systemTexts.push(block.text);
            }
        }
    }

    for (const msg of req.messages) {
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) {
            throw new AnthropicRequestError(400, 'invalid_request_error', 'Each message must have role "user" or "assistant".');
        }

        const parts: any[] = [];

        if (typeof msg.content === 'string') {
            if (msg.content.length > 0) parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (!block || typeof block !== 'object') continue;
                switch (block.type) {
                    case 'text':
                        if (typeof block.text === 'string' && block.text.length > 0) parts.push({ text: block.text });
                        break;

                    case 'image': {
                        const src = block.source;
                        if (src?.type === 'base64' && src.data) {
                            parts.push({ inlineData: { mimeType: src.media_type || 'image/png', data: src.data } });
                        } else if (src?.type === 'url' && src.url) {
                            if (!/^https?:\/\//i.test(src.url)) {
                                throw new AnthropicRequestError(400, 'invalid_request_error', 'Only http and https image URLs are supported.');
                            }
                            parts.push({ fileData: { fileUri: src.url, mimeType: 'image/*' } });
                        }
                        break;
                    }

                    case 'tool_use': {
                        if (!block.name) break;
                        toolUseIdToName.set(block.id, block.name);
                        parts.push({ functionCall: { name: block.name, args: block.input ?? {} } });
                        break;
                    }

                    case 'tool_result': {
                        if (!block.tool_use_id) break;
                        const name = toolUseIdToName.get(block.tool_use_id) || 'tool';
                        let raw: string;
                        if (typeof block.content === 'string') raw = block.content;
                        else if (Array.isArray(block.content)) {
                            raw = block.content.filter((c): c is { type: 'text'; text: string } => c?.type === 'text').map(c => c.text).join('');
                        } else {
                            raw = '';
                        }
                        const parsed = safeJsonParse(raw);
                        const responseObj = parsed !== undefined && typeof parsed === 'object' && parsed !== null
                            ? parsed
                            : { result: raw, ...(block.is_error ? { isError: true } : {}) };
                        parts.push({ functionResponse: { name, response: responseObj } });
                        break;
                    }
                }
            }
        }

        if (parts.length === 0) parts.push({ text: '' });
        contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
    }

    const generationConfig: any = { maxOutputTokens: req.max_tokens };
    if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
    if (typeof req.top_p === 'number') generationConfig.topP = req.top_p;
    if (typeof req.top_k === 'number') generationConfig.topK = req.top_k;
    if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
        generationConfig.stopSequences = req.stop_sequences.slice(0, 5);
    }

    let tools: any[] | undefined;
    if (Array.isArray(req.tools) && req.tools.length > 0) {
        const declarations = req.tools
            .filter(t => t && typeof t.name === 'string' && t.name.length > 0)
            .map(t => ({
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} },
            }));
        if (declarations.length > 0) tools = [{ functionDeclarations: declarations }];
    }

    let toolConfig: any | undefined;
    if (req.tool_choice) {
        switch (req.tool_choice.type) {
            case 'auto': toolConfig = { functionCallingConfig: { mode: 'AUTO' } }; break;
            case 'any': toolConfig = { functionCallingConfig: { mode: 'ANY' } }; break;
            case 'none': toolConfig = { functionCallingConfig: { mode: 'NONE' } }; break;
            case 'tool':
                toolConfig = {
                    functionCallingConfig: {
                        mode: 'ANY',
                        allowedFunctionNames: [req.tool_choice.name],
                    },
                };
                break;
        }
    }

    return {
        model: req.model,
        contents,
        systemInstruction: systemTexts.length > 0 ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
        generationConfig,
        tools,
        toolConfig,
        stream: req.stream === true,
    };
}

// ─── Response translation (non-stream) ──────────────────────────────────────

function genId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function mapStopReason(geminiReason: string | undefined, hasToolUse: boolean, hadStopSequence: string | null): string {
    if (hasToolUse) return 'tool_use';
    if (!geminiReason) return 'end_turn';
    switch (geminiReason) {
        case 'STOP': return hadStopSequence ? 'stop_sequence' : 'end_turn';
        case 'MAX_TOKENS': return 'max_tokens';
        case 'SAFETY':
        case 'RECITATION':
        case 'PROHIBITED_CONTENT':
        case 'BLOCKLIST':
            return 'end_turn';
        default: return 'end_turn';
    }
}

export function translateGeminiToAnthropic(geminiResp: any, requestedModel: string): any {
    const candidate = geminiResp?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];

    const content: any[] = [];
    let toolIdx = 0;
    let hasToolUse = false;

    for (const p of parts) {
        if (typeof p?.text === 'string' && p.text.length > 0) {
            content.push({ type: 'text', text: p.text });
        } else if (p?.functionCall) {
            content.push({
                type: 'tool_use',
                id: genId('toolu') + `_${toolIdx++}`,
                name: String(p.functionCall.name || ''),
                input: p.functionCall.args ?? {},
            });
            hasToolUse = true;
        }
    }

    if (content.length === 0) content.push({ type: 'text', text: '' });

    const usage = geminiResp?.usageMetadata || {};
    const stopReason = mapStopReason(candidate?.finishReason, hasToolUse, null);

    return {
        id: genId('msg'),
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: Number(usage.promptTokenCount || 0),
            output_tokens: Number(usage.candidatesTokenCount || 0),
        },
    };
}

// ─── Stream sink ─────────────────────────────────────────────────────────────

interface BlockState {
    type: 'text' | 'tool_use';
    index: number;
    // for tool_use:
    toolId?: string;
    toolName?: string;
}

/**
 * Streams Gemini SSE chunks as Anthropic Messages API SSE events.
 *
 * Each event is a pair of `event:` + `data:` lines, terminated by a blank line.
 */
export class AnthropicStreamSink implements StreamSink {
    public readonly headersAlreadyWritten = false;

    private readonly messageId = genId('msg');
    private inputTokens = 0;
    private outputTokens = 0;
    private blocks: BlockState[] = [];
    private currentTextBlock: BlockState | null = null;
    private finalized = false;

    constructor(
        private readonly res: Response,
        private readonly requestedModel: string,
    ) {}

    private writeEvent(event: string, data: any): void {
        // The official SDK requires both `event:` and `data:` to be present.
        safeWrite(this.res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    start(_usedModel: string, _requestedModel: string): void {
        writeSseHead(this.res);

        this.writeEvent('message_start', {
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                model: this.requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        });

        // Anthropic emits a `ping` event to keep middleboxes from buffering.
        this.writeEvent('ping', { type: 'ping' });
    }

    private ensureTextBlock(): BlockState {
        if (this.currentTextBlock) return this.currentTextBlock;
        const idx = this.blocks.length;
        const block: BlockState = { type: 'text', index: idx };
        this.blocks.push(block);
        this.currentTextBlock = block;

        this.writeEvent('content_block_start', {
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'text', text: '' },
        });
        return block;
    }

    private closeCurrentTextBlock(): void {
        if (!this.currentTextBlock) return;
        this.writeEvent('content_block_stop', {
            type: 'content_block_stop',
            index: this.currentTextBlock.index,
        });
        this.currentTextBlock = null;
    }

    forwardChunk(_parsed: any, normalized: NormalizedChunk): void {
        if (this.finalized) return;

        // Text deltas → ensure an open text block, then emit text_delta events.
        for (const text of normalized.textDeltas) {
            if (!text) continue;
            const block = this.ensureTextBlock();
            this.writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: block.index,
                delta: { type: 'text_delta', text },
            });
        }

        // Function calls → close any open text block, then open/emit/close a tool_use block.
        for (const fc of normalized.functionCalls) {
            this.closeCurrentTextBlock();

            const idx = this.blocks.length;
            const toolId = `toolu_${crypto.randomBytes(12).toString('hex')}`;
            const block: BlockState = {
                type: 'tool_use',
                index: idx,
                toolId,
                toolName: fc.name,
            };
            this.blocks.push(block);

            this.writeEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: {
                    type: 'tool_use',
                    id: toolId,
                    name: fc.name,
                    input: {},
                },
            });

            // Emit the entire arguments JSON in one input_json_delta.
            const argsJson = JSON.stringify(fc.args ?? {});
            if (argsJson && argsJson !== '{}') {
                this.writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: idx,
                    delta: { type: 'input_json_delta', partial_json: argsJson },
                });
            }

            this.writeEvent('content_block_stop', {
                type: 'content_block_stop',
                index: idx,
            });
        }

        if (normalized.usage) {
            // Anthropic reports input_tokens once on message_start and updates
            // output_tokens on message_delta. We capture the last seen values.
            if (normalized.usage.promptTokens > 0) this.inputTokens = normalized.usage.promptTokens;
            if (normalized.usage.completionTokens > 0) this.outputTokens = normalized.usage.completionTokens;
        }
    }

    finalize(state: { finishReason?: string }): void {
        if (this.finalized) return;
        this.finalized = true;

        // Close any still-open text block.
        this.closeCurrentTextBlock();

        const hasToolUse = this.blocks.some(b => b.type === 'tool_use');
        const stopReason = mapStopReason(state.finishReason, hasToolUse, null);

        this.writeEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
        });
        this.writeEvent('message_stop', { type: 'message_stop' });

        safeEnd(this.res);
    }

    abortAfterStart(err: Error): void {
        if (this.finalized) return;
        this.finalized = true;
        // Close any open block first so well-behaved clients can flush UI state.
        this.closeCurrentTextBlock();
        const message = err?.message?.replace(/\s+/g, ' ').slice(0, 500) || 'Upstream stream failed.';
        this.writeEvent('error', {
            type: 'error',
            error: { type: 'overloaded_error', message },
        });
        safeEnd(this.res);
    }
}
