/**
 * OpenAI Responses API ↔ Gemini protocol adapter.
 *
 * This implements the modern `POST /v1/responses` surface used by current
 * OpenAI SDKs while preserving OpenGem's stateless Gemini backend. Built-in
 * hosted tools such as web_search/file_search are intentionally rejected:
 * OpenGem can proxy client-defined function tools, but it must not imply that
 * OpenAI-hosted tools are available or executed safely.
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
import { DEFAULT_MODEL } from '../antigravity';
import { OpenAIRequestError } from './openai';

export interface OpenAIResponsesRequest {
    model?: string;
    models?: string[];
    input?: string | OpenAIResponseInputItem[];
    instructions?: string | OpenAIResponseInputItem[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
    max_completion_tokens?: number;
    max_tokens?: number;
    text?: { format?: any; verbosity?: string };
    response_format?: any;
    tools?: OpenAIResponsesTool[];
    tool_choice?: 'auto' | 'none' | 'required' | { type?: string; name?: string; function?: { name?: string } };
    user?: string;
    session_id?: string;
    previous_response_id?: string;
    metadata?: Record<string, any>;
    reasoning?: Record<string, any>;
    service_tier?: string;
    parallel_tool_calls?: boolean;
    store?: boolean;
}

export interface OpenAIResponseInputItem {
    type?: string;
    role?: 'system' | 'developer' | 'user' | 'assistant';
    content?: string | OpenAIResponseContentPart[];
    call_id?: string;
    id?: string;
    name?: string;
    arguments?: string;
    output?: string | OpenAIResponseContentPart[];
}

export type OpenAIResponseContentPart =
    | { type: 'input_text' | 'output_text' | 'text'; text: string }
    | { type: 'input_image'; image_url?: string; detail?: string; file_id?: string }
    | { type: 'input_file'; file_id?: string; filename?: string };

export type OpenAIResponsesTool =
    | { type: 'function'; name?: string; description?: string; parameters?: any; strict?: boolean; function?: { name?: string; description?: string; parameters?: any } }
    | { type: string; [key: string]: any };

export interface OpenAIResponsesTranslated {
    model: string;
    contents: any[];
    systemInstruction?: any;
    generationConfig?: any;
    tools?: any[];
    toolConfig?: any;
    stream: boolean;
    request: OpenAIResponsesRequest;
    metadata?: Record<string, string>;
}

function genId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function pickRequestedModel(req: OpenAIResponsesRequest): string {
    if (typeof req.model === 'string' && req.model.trim()) return req.model.trim();
    if (Array.isArray(req.models)) {
        const first = req.models.find(model => typeof model === 'string' && model.trim());
        if (first) return first.trim();
    }
    return DEFAULT_MODEL;
}

function safeJsonParse(text: string): any {
    try { return JSON.parse(text); } catch { return undefined; }
}

function sanitizeMetadata(metadata: Record<string, any> | undefined): Record<string, string> | undefined {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata).slice(0, 16)) {
        if (!key || key.length > 64) continue;
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        if (typeof stringValue === 'string') out[key] = stringValue.slice(0, 512);
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function textPartsFromContent(content: OpenAIResponseInputItem['content'] | OpenAIResponsesRequest['instructions']): string[] {
    if (!content) return [];
    if (typeof content === 'string') return content ? [content] : [];
    if (!Array.isArray(content)) return [];

    const texts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if ('text' in item && typeof item.text === 'string') texts.push(item.text);
        else if ('content' in item) texts.push(...textPartsFromContent(item.content));
    }
    return texts;
}

function geminiPartsFromContent(content: OpenAIResponseInputItem['content']): any[] {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) return [];

    const parts: any[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        switch (part.type) {
            case 'input_text':
            case 'output_text':
            case 'text':
                if (typeof part.text === 'string' && part.text.length > 0) parts.push({ text: part.text });
                break;
            case 'input_image':
                if (part.file_id) {
                    throw new OpenAIRequestError(400, 'unsupported_parameter', 'Responses input_image.file_id is not supported. Use image_url or a data URL.');
                }
                if (part.image_url) {
                    const dataMatch = part.image_url.match(/^data:([^;,]+);base64,(.+)$/i);
                    if (dataMatch) {
                        parts.push({ inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } });
                    } else {
                        if (!/^https?:\/\//i.test(part.image_url)) {
                            throw new OpenAIRequestError(400, 'invalid_request_error', 'Only data, http, and https image URLs are supported.');
                        }
                        parts.push({ fileData: { fileUri: part.image_url, mimeType: 'image/*' } });
                    }
                }
                break;
            case 'input_file':
                throw new OpenAIRequestError(400, 'unsupported_parameter', 'Responses file inputs are not supported by OpenGem.');
            default:
                break;
        }
    }
    return parts;
}

function addInputItem(item: OpenAIResponseInputItem, contents: any[], systemTexts: string[], toolCallIdToName: Map<string, string>): void {
    const role = item.role || (item.type === 'message' ? 'user' : undefined);

    if (role === 'system' || role === 'developer') {
        systemTexts.push(...textPartsFromContent(item.content));
        return;
    }

    if (role === 'user' || role === 'assistant' || item.type === 'message' || item.type === 'input_message') {
        const parts = geminiPartsFromContent(item.content);
        contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: parts.length > 0 ? parts : [{ text: '' }] });
        return;
    }

    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const name = String(item.name || '');
        if (!name) return;
        const args = typeof item.arguments === 'string' ? safeJsonParse(item.arguments) ?? {} : {};
        if (item.call_id || item.id) toolCallIdToName.set(String(item.call_id || item.id), name);
        contents.push({ role: 'model', parts: [{ functionCall: { name, args } }] });
        return;
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const callId = String(item.call_id || item.id || '');
        const name = toolCallIdToName.get(callId) || 'tool';
        const raw = typeof item.output === 'string' ? item.output : textPartsFromContent(item.output).join('');
        const parsed = safeJsonParse(raw);
        const response = parsed !== undefined && typeof parsed === 'object' && parsed !== null ? parsed : { result: raw };
        contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] });
    }
}

function translateResponsesTools(tools: OpenAIResponsesTool[] | undefined): any[] | undefined {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;

    const declarations: any[] = [];
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        if (tool.type !== 'function') {
            throw new OpenAIRequestError(400, 'unsupported_parameter', `Hosted tool "${tool.type}" is not available through OpenGem compatibility.`);
        }

        const name = tool.name || tool.function?.name;
        if (!name) continue;
        declarations.push({
            name,
            description: tool.description || tool.function?.description || '',
            parameters: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} },
        });
    }

    return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

function translateToolChoice(choice: OpenAIResponsesRequest['tool_choice']): any | undefined {
    if (choice === undefined) return undefined;
    if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
    if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
    if (typeof choice === 'object') {
        const name = choice.name || choice.function?.name;
        if (name) {
            return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
        }
    }
    return undefined;
}

export function translateOpenAIResponsesRequest(req: OpenAIResponsesRequest): OpenAIResponsesTranslated {
    if (!req || typeof req !== 'object') {
        throw new OpenAIRequestError(400, 'invalid_request_error', 'Request body must be a JSON object.');
    }

    const contents: any[] = [];
    const systemTexts = textPartsFromContent(req.instructions);
    const toolCallIdToName = new Map<string, string>();

    if (typeof req.input === 'string') {
        contents.push({ role: 'user', parts: req.input ? [{ text: req.input }] : [{ text: '' }] });
    } else if (Array.isArray(req.input)) {
        for (const item of req.input) addInputItem(item, contents, systemTexts, toolCallIdToName);
    }

    if (contents.length === 0) {
        throw new OpenAIRequestError(400, 'invalid_request_error', '`input` must contain at least one user or assistant message.');
    }

    const generationConfig: any = {};
    if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
    if (typeof req.top_p === 'number') generationConfig.topP = req.top_p;

    const maxTokens = req.max_output_tokens ?? req.max_completion_tokens ?? req.max_tokens;
    if (typeof maxTokens === 'number' && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;

    const responseFormat = req.text?.format || req.response_format;
    if (responseFormat?.type === 'json_object' || responseFormat?.type === 'json_schema') {
        generationConfig.responseMimeType = 'application/json';
        const schema = responseFormat.schema || responseFormat.json_schema?.schema;
        if (responseFormat.type === 'json_schema' && schema) generationConfig.responseSchema = schema;
    }

    const tools = translateResponsesTools(req.tools);

    return {
        model: pickRequestedModel(req),
        contents,
        systemInstruction: systemTexts.length > 0 ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
        generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
        tools,
        toolConfig: translateToolChoice(req.tool_choice),
        stream: req.stream === true,
        request: req,
        metadata: sanitizeMetadata(req.metadata),
    };
}

function mapStatus(geminiReason: string | undefined): { status: string; incomplete_details: any } {
    if (geminiReason === 'MAX_TOKENS') {
        return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    }
    return { status: 'completed', incomplete_details: null };
}

function buildUsage(geminiResp: any): any {
    const usage = geminiResp?.usageMetadata || {};
    const inputTokens = Number(usage.promptTokenCount || 0);
    const outputTokens = Number(usage.candidatesTokenCount || 0);
    const totalTokens = Number(usage.totalTokenCount || inputTokens + outputTokens);
    return {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: totalTokens,
    };
}

function outputFromParts(parts: any[]): { output: any[]; outputText: string } {
    const output: any[] = [];
    let outputText = '';

    const text = parts
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .filter(Boolean)
        .join('');
    if (text) {
        outputText = text;
        output.push({
            id: genId('msg'),
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
        });
    }

    let toolIndex = 0;
    for (const part of parts) {
        if (!part?.functionCall) continue;
        const callId = `call_${crypto.randomBytes(12).toString('hex')}_${toolIndex++}`;
        output.push({
            id: genId('fc'),
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name: String(part.functionCall.name || ''),
            arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
    }

    if (output.length === 0) {
        output.push({
            id: genId('msg'),
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }],
        });
    }

    return { output, outputText };
}

export function translateGeminiToOpenAIResponse(geminiResp: any, translated: OpenAIResponsesTranslated): any {
    const candidate = geminiResp?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];
    const { output, outputText } = outputFromParts(parts);
    const status = mapStatus(candidate?.finishReason);
    const now = Math.floor(Date.now() / 1000);

    return {
        id: genId('resp'),
        object: 'response',
        created_at: now,
        status: status.status,
        background: false,
        error: null,
        incomplete_details: status.incomplete_details,
        instructions: translated.request.instructions ?? null,
        max_output_tokens: translated.request.max_output_tokens ?? translated.request.max_completion_tokens ?? translated.request.max_tokens ?? null,
        model: translated.model,
        output,
        output_text: outputText,
        parallel_tool_calls: translated.request.parallel_tool_calls ?? true,
        previous_response_id: translated.request.previous_response_id ?? null,
        reasoning: translated.request.reasoning ?? null,
        service_tier: translated.request.service_tier ?? 'default',
        store: translated.request.store ?? false,
        temperature: translated.request.temperature ?? null,
        text: translated.request.text ?? { format: { type: 'text' } },
        tool_choice: translated.request.tool_choice ?? 'auto',
        tools: translated.request.tools ?? [],
        top_p: translated.request.top_p ?? null,
        truncation: 'disabled',
        usage: buildUsage(geminiResp),
        user: translated.request.user ?? null,
        metadata: translated.metadata ?? {},
    };
}

export class OpenAIResponsesStreamSink implements StreamSink {
    public readonly headersAlreadyWritten = false;

    private readonly responseId = genId('resp');
    private readonly createdAt = Math.floor(Date.now() / 1000);
    private readonly outputItemId = genId('msg');
    private outputText = '';
    private textStarted = false;
    private textOutputIndex: number | null = null;
    private sequenceNumber = 0;
    private outputItems: any[] = [];
    private usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    private finalized = false;

    constructor(
        private readonly res: Response,
        private readonly translated: OpenAIResponsesTranslated,
    ) {}

    private writeEvent(type: string, data: any): void {
        safeWrite(this.res, `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    }

    private responseEnvelope(status: 'in_progress' | 'completed' | 'failed' = 'in_progress', error: any = null): any {
        return {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            status,
            background: false,
            error,
            incomplete_details: null,
            instructions: this.translated.request.instructions ?? null,
            max_output_tokens: this.translated.request.max_output_tokens ?? null,
            model: this.translated.model,
            output: this.outputItems,
            output_text: status === 'completed' ? this.outputText : undefined,
            parallel_tool_calls: this.translated.request.parallel_tool_calls ?? true,
            previous_response_id: this.translated.request.previous_response_id ?? null,
            reasoning: this.translated.request.reasoning ?? null,
            service_tier: this.translated.request.service_tier ?? 'default',
            store: this.translated.request.store ?? false,
            temperature: this.translated.request.temperature ?? null,
            text: this.translated.request.text ?? { format: { type: 'text' } },
            tool_choice: this.translated.request.tool_choice ?? 'auto',
            tools: this.translated.request.tools ?? [],
            top_p: this.translated.request.top_p ?? null,
            truncation: 'disabled',
            usage: status === 'completed' ? {
                input_tokens: this.usage.input_tokens,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: this.usage.output_tokens,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: this.usage.total_tokens,
            } : null,
            user: this.translated.request.user ?? null,
            metadata: this.translated.metadata ?? {},
        };
    }

    start(_usedModel: string, _requestedModel: string): void {
        writeSseHead(this.res);
        this.writeEvent('response.created', { response: this.responseEnvelope('in_progress') });
        this.writeEvent('response.in_progress', { response: this.responseEnvelope('in_progress') });
    }

    private ensureTextOutput(): void {
        if (this.textStarted) return;
        this.textStarted = true;
        const item = {
            id: this.outputItemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
        };
        const outputIndex = this.outputItems.length;
        this.textOutputIndex = outputIndex;
        this.outputItems.push(item);
        this.writeEvent('response.output_item.added', { output_index: outputIndex, item });
        this.writeEvent('response.content_part.added', {
            output_index: outputIndex,
            content_index: 0,
            item_id: this.outputItemId,
            part: { type: 'output_text', text: '', annotations: [] },
        });
    }

    forwardChunk(_parsed: any, normalized: NormalizedChunk): void {
        if (this.finalized) return;

        for (const text of normalized.textDeltas) {
            if (!text) continue;
            this.ensureTextOutput();
            this.outputText += text;
            const outputIndex = this.textOutputIndex ?? 0;
            this.writeEvent('response.output_text.delta', {
                output_index: outputIndex,
                content_index: 0,
                item_id: this.outputItemId,
                delta: text,
                sequence_number: this.sequenceNumber++,
            });
        }

        for (const fc of normalized.functionCalls) {
            const item = {
                id: genId('fc'),
                type: 'function_call',
                status: 'completed',
                call_id: `call_${crypto.randomBytes(12).toString('hex')}`,
                name: fc.name,
                arguments: JSON.stringify(fc.args ?? {}),
            };
            const outputIndex = this.outputItems.length;
            this.outputItems.push(item);
            this.writeEvent('response.output_item.added', { output_index: outputIndex, item: { ...item, arguments: '' } });
            this.writeEvent('response.function_call_arguments.delta', {
                output_index: outputIndex,
                item_id: item.id,
                delta: item.arguments,
            });
            this.writeEvent('response.function_call_arguments.done', {
                output_index: outputIndex,
                item_id: item.id,
                arguments: item.arguments,
            });
            this.writeEvent('response.output_item.done', { output_index: outputIndex, item });
        }

        if (normalized.usage) {
            this.usage = {
                input_tokens: normalized.usage.promptTokens,
                output_tokens: normalized.usage.completionTokens,
                total_tokens: normalized.usage.totalTokens,
            };
        }
    }

    finalize(_state: { finishReason?: string }): void {
        if (this.finalized) return;
        this.finalized = true;

        if (this.textStarted) {
            const outputIndex = this.textOutputIndex ?? 0;
            const item = {
                id: this.outputItemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: this.outputText, annotations: [] }],
            };
            this.outputItems[outputIndex] = item;
            this.writeEvent('response.output_text.done', {
                output_index: outputIndex,
                content_index: 0,
                item_id: this.outputItemId,
                text: this.outputText,
            });
            this.writeEvent('response.content_part.done', {
                output_index: outputIndex,
                content_index: 0,
                item_id: this.outputItemId,
                part: item.content[0],
            });
            this.writeEvent('response.output_item.done', { output_index: outputIndex, item });
        }

        this.writeEvent('response.completed', { response: this.responseEnvelope('completed') });
        safeWrite(this.res, 'data: [DONE]\n\n');
        safeEnd(this.res);
    }

    abortAfterStart(err: Error): void {
        if (this.finalized) return;
        this.finalized = true;
        const message = err?.message?.replace(/\s+/g, ' ').slice(0, 500) || 'Upstream stream failed.';
        this.writeEvent('response.failed', {
            response: this.responseEnvelope('failed', { code: 'stream_failed', message }),
        });
        safeWrite(this.res, 'data: [DONE]\n\n');
        safeEnd(this.res);
    }
}
