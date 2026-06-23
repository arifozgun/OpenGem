/**
 * Anthropic Messages API compatibility controller.
 *
 * Implements `POST /v1/messages` in Anthropic's official wire format. All
 * routing decisions, retries and account rotation are delegated to the
 * existing Gemini engine; this layer only translates protocols.
 */

import { Request, Response } from 'express';
import {
    AnthropicMessageRequest,
    AnthropicRequestError,
    AnthropicStreamSink,
    buildAnthropicErrorBody,
    translateAnthropicRequest,
    translateGeminiToAnthropic,
} from '../services/adapters/anthropic';
import { resolveCompatibilityModel } from '../services/adapters/model-aliases';
import { createAccountAffinityContext } from '../services/account-affinity';
import { getRequestLogMetadata } from '../services/access-log';
import { generateContentWithAccounts, streamGeminiWithSink } from './chat';

function sendAnthropicError(res: Response, status: number, message: string, type = 'invalid_request_error'): void {
    if (res.headersSent) return;
    res.status(status).json(buildAnthropicErrorBody(message, type));
}

export async function handleAnthropicMessages(req: Request, res: Response): Promise<void> {
    let translated: ReturnType<typeof translateAnthropicRequest>;
    try {
        translated = translateAnthropicRequest(req.body as AnthropicMessageRequest);
    } catch (err: any) {
        if (err instanceof AnthropicRequestError) {
            return sendAnthropicError(res, err.status, err.message, err.type);
        }
        console.error('Anthropic request translation error:', err);
        return sendAnthropicError(res, 400, 'Invalid request payload.');
    }

    const requestedModel = translated.model;
    const geminiModel = resolveCompatibilityModel(requestedModel);
    const body = req.body as AnthropicMessageRequest;
    const sessionId = typeof body?.session_id === 'string' ? body.session_id : undefined;
    const affinity = createAccountAffinityContext({
        req,
        model: requestedModel,
        contents: translated.contents,
        systemInstruction: translated.systemInstruction,
        explicitUserId: sessionId || (typeof body?.metadata?.user_id === 'string' ? body.metadata.user_id : undefined),
        explicitUserSource: sessionId ? 'openrouter-session' : 'anthropic-user',
    });
    const requestMeta = () => getRequestLogMetadata(req);

    try {
        if (translated.stream) {
            const sink = new AnthropicStreamSink(res, requestedModel);

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
            return sendAnthropicError(res, 503, 'All upstream accounts are exhausted or failed.', 'overloaded_error');
        }

        const anthropicResp = translateGeminiToAnthropic(result.response, requestedModel);
        res.json(anthropicResp);
    } catch (err: any) {
        console.error('Anthropic messages error:', err);
        if (!res.headersSent) {
            const detail = process.env.NODE_ENV === 'production' ? 'Internal server error.' : (err?.message || 'Internal server error.');
            return sendAnthropicError(res, 500, detail, 'api_error');
        }
        if (!res.writableEnded) res.end();
    }
}
