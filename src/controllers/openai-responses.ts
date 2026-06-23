/**
 * OpenAI Responses API compatibility controller.
 *
 * Implements `POST /v1/responses` for modern OpenAI SDK clients. The endpoint
 * stays stateless: callers should send the conversation context in `input`.
 */

import { Request, Response } from 'express';
import { createAccountAffinityContext } from '../services/account-affinity';
import { resolveCompatibilityModel } from '../services/adapters/model-aliases';
import {
    OpenAIResponsesRequest,
    OpenAIResponsesStreamSink,
    translateGeminiToOpenAIResponse,
    translateOpenAIResponsesRequest,
} from '../services/adapters/openai-responses';
import { OpenAIRequestError, buildOpenAIErrorBody } from '../services/adapters/openai';
import { getRequestLogMetadata } from '../services/access-log';
import { generateContentWithAccounts, streamGeminiWithSink } from './chat';

function sendOpenAIError(res: Response, status: number, message: string, type = 'invalid_request_error', code: string | null = null): void {
    if (res.headersSent) return;
    res.status(status).json(buildOpenAIErrorBody(message, type, code));
}

function readString(value: any): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function handleOpenAIResponses(req: Request, res: Response): Promise<void> {
    let translated: ReturnType<typeof translateOpenAIResponsesRequest>;
    try {
        translated = translateOpenAIResponsesRequest(req.body as OpenAIResponsesRequest);
    } catch (err: any) {
        if (err instanceof OpenAIRequestError) {
            return sendOpenAIError(res, err.status, err.message, err.code);
        }
        console.error('OpenAI Responses translation error:', err);
        return sendOpenAIError(res, 400, 'Invalid request payload.');
    }

    const requestedModel = translated.model;
    const geminiModel = resolveCompatibilityModel(requestedModel);
    const body = req.body as OpenAIResponsesRequest;
    const sessionId = readString(body?.session_id);
    const metadataUserId = readString(body?.metadata?.user_id);
    const affinity = createAccountAffinityContext({
        req,
        model: requestedModel,
        contents: translated.contents,
        systemInstruction: translated.systemInstruction,
        explicitUserId: sessionId || metadataUserId || readString(body?.user),
        explicitUserSource: sessionId ? 'openrouter-session' : 'openai-user',
    });
    const requestMeta = () => getRequestLogMetadata(req);

    try {
        if (translated.stream) {
            const sink = new OpenAIResponsesStreamSink(res, translated);

            req.on('close', () => {
                if (!res.writableEnded) res.end();
            });

            await streamGeminiWithSink({
                model: geminiModel,
                contents: translated.contents,
                generationConfig: translated.generationConfig,
                systemInstruction: translated.systemInstruction,
                tools: translated.tools,
                toolConfig: translated.toolConfig,
                res,
                sink,
                affinity,
                logModel: requestedModel,
                requestMeta,
            });
            return;
        }

        const result = await generateContentWithAccounts(
            geminiModel,
            translated.contents,
            translated.generationConfig,
            translated.systemInstruction,
            translated.tools,
            translated.toolConfig,
            requestedModel,
            affinity,
            requestMeta,
        );

        if (!result) {
            return sendOpenAIError(res, 503, 'All upstream accounts are exhausted or failed.', 'server_error', 'upstream_unavailable');
        }

        res.json(translateGeminiToOpenAIResponse(result.response, translated));
    } catch (err: any) {
        console.error('OpenAI Responses error:', err);
        if (!res.headersSent) {
            const detail = process.env.NODE_ENV === 'production' ? 'Internal Server Error.' : (err?.message || 'Internal Server Error.');
            return sendOpenAIError(res, 500, detail, 'server_error');
        }
        if (!res.writableEnded) res.end();
    }
}
