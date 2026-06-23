/**
 * OpenAI Chat Completions compatibility controller.
 *
 * Implements `POST /v1/chat/completions` and `GET /v1/models` in the official
 * OpenAI wire format. All routing decisions, retries and account rotation are
 * delegated to the existing Gemini engine; this layer only translates protocols.
 */

import { Request, Response } from 'express';
import {
    OpenAIChatRequest,
    OpenAIRequestError,
    OpenAIStreamSink,
    buildOpenAIErrorBody,
    translateGeminiToOpenAI,
    translateOpenAIRequest,
} from '../services/adapters/openai';
import { resolveCompatibilityModel, listCompatibilityModelIds } from '../services/adapters/model-aliases';
import { createAccountAffinityContext } from '../services/account-affinity';
import { getRequestLogMetadata } from '../services/access-log';
import {
    generateContentWithAccounts,
    streamGeminiWithSink,
} from './chat';

function sendOpenAIError(res: Response, status: number, message: string, type = 'invalid_request_error', code: string | null = null): void {
    if (res.headersSent) return;
    res.status(status).json(buildOpenAIErrorBody(message, type, code));
}

export async function handleOpenAIChatCompletions(req: Request, res: Response): Promise<void> {
    let translated: ReturnType<typeof translateOpenAIRequest>;
    try {
        translated = translateOpenAIRequest(req.body as OpenAIChatRequest);
    } catch (err: any) {
        if (err instanceof OpenAIRequestError) {
            return sendOpenAIError(res, err.status, err.message, err.code);
        }
        console.error('OpenAI request translation error:', err);
        return sendOpenAIError(res, 400, 'Invalid request payload.');
    }

    const requestedModel = translated.model;
    const geminiModel = resolveCompatibilityModel(requestedModel);
    const body = req.body as OpenAIChatRequest;
    const sessionId = typeof body?.session_id === 'string' ? body.session_id : undefined;
    const metadataUserId = typeof body?.metadata?.user_id === 'string' ? body.metadata.user_id : undefined;
    const affinity = createAccountAffinityContext({
        req,
        model: requestedModel,
        contents: translated.contents,
        systemInstruction: translated.systemInstruction,
        explicitUserId: sessionId || metadataUserId || (typeof body?.user === 'string' ? body.user : undefined),
        explicitUserSource: sessionId ? 'openrouter-session' : 'openai-user',
    });
    const requestMeta = () => getRequestLogMetadata(req);

    try {
        if (translated.stream) {
            const sink = new OpenAIStreamSink(res, requestedModel, translated.includeUsage);

            // Detect early client disconnects so we can stop forwarding work.
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
            undefined,
            affinity,
            requestMeta,
        );

        if (!result) {
            return sendOpenAIError(res, 503, 'All upstream accounts are exhausted or failed.', 'server_error', 'upstream_unavailable');
        }

        const openAIResp = translateGeminiToOpenAI(result.response, requestedModel);
        res.json(openAIResp);
    } catch (err: any) {
        console.error('OpenAI completions error:', err);
        if (!res.headersSent) {
            const detail = process.env.NODE_ENV === 'production' ? 'Internal Server Error.' : (err?.message || 'Internal Server Error.');
            return sendOpenAIError(res, 500, detail, 'server_error');
        }
        if (!res.writableEnded) res.end();
    }
}

export function handleOpenAIListModels(_req: Request, res: Response): void {
    const ids = listCompatibilityModelIds();
    const created = Math.floor(Date.now() / 1000);
    const supportedParameters = [
        'messages',
        'max_tokens',
        'max_completion_tokens',
        'temperature',
        'top_p',
        'stop',
        'tools',
        'tool_choice',
        'response_format',
        'stream',
        'stream_options',
        'models',
        'provider',
        'session_id',
    ];
    res.json({
        object: 'list',
        data: ids.map((id: string) => ({
            id,
            object: 'model',
            created,
            owned_by: 'opengem',
            context_length: null,
            supported_parameters: supportedParameters,
        })),
    });
}
