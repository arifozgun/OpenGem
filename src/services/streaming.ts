/**
 * Stream sink abstraction.
 *
 * The Gemini upstream always speaks SSE in its own envelope shape.
 * Each compatibility protocol (Gemini-native, OpenAI, Anthropic) needs to
 * translate those chunks into its own wire format, while sharing the
 * exact same multi-account rotation, retry, cooldown and logging logic.
 *
 * A `StreamSink` encapsulates everything wire-format-specific:
 *   - whether HTTP headers must be written (true for the public proxy,
 *     false when the response was already committed before rotation began,
 *     e.g. the admin chat endpoint)
 *   - how to forward a parsed Gemini SSE chunk
 *   - how to emit the optional model-change marker
 *   - how to terminate the stream cleanly (or with an error)
 *
 * Sinks MUST be tolerant of the underlying response being closed by the
 * client at any point — every write goes through `safeWrite()`.
 */

import type { Response } from 'express';

export interface NormalizedChunk {
    /** Plain-text deltas extracted from this Gemini chunk. */
    textDeltas: string[];
    /** Tool calls discovered in this chunk (Gemini emits the full call atomically). */
    functionCalls: Array<{ name: string; args: any }>;
    /** Cumulative token usage if Gemini reported it on this chunk. */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    /** Gemini finishReason on this chunk (only present on the last one). */
    finishReason?: string;
}

export interface StreamSink {
    /** Tell the engine whether HTTP headers are this sink's responsibility. */
    readonly headersAlreadyWritten: boolean;

    /** Called exactly once when an upstream stream is acquired. */
    start(usedModel: string, requestedModel: string): void;

    /**
     * Forward a parsed Gemini SSE chunk plus its normalized form.
     * `rawJson` is the original JSON string (without the `data: ` prefix).
     */
    forwardChunk(parsedRaw: any, normalized: NormalizedChunk, rawJson: string): void;

    /** Called when the upstream stream ends successfully. */
    finalize(state: { fullText: string; tokenUsage: number; finishReason?: string }): void;

    /**
     * Called when an irrecoverable error occurs after `start()` was invoked.
     * The sink must emit a protocol-appropriate error event and end the
     * response. The engine will not write to `res` after this.
     */
    abortAfterStart(err: Error): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write to the response only if it is still writable. Never throws. */
export function safeWrite(res: Response, chunk: string): void {
    if (res.writableEnded || res.destroyed) return;
    try {
        res.write(chunk);
    } catch {
        /* socket closed mid-write — ignore */
    }
}

/** End the response only if it is still open. Never throws. */
export function safeEnd(res: Response): void {
    if (res.writableEnded || res.destroyed) return;
    try {
        res.end();
    } catch {
        /* ignore */
    }
}

/** Write SSE headers only if not yet sent. */
export function writeSseHead(res: Response): void {
    if (res.headersSent) return;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Helps proxies and curl-style clients flush the head immediately.
    if (typeof (res as any).flushHeaders === 'function') {
        try { (res as any).flushHeaders(); } catch { /* ignore */ }
    }
}

/** Build a normalized view of a Gemini SSE chunk. */
export function normalizeGeminiChunk(parsed: any): NormalizedChunk {
    const inner = parsed?.response ?? parsed;
    const candidate = inner?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];

    const textDeltas: string[] = [];
    const functionCalls: NormalizedChunk['functionCalls'] = [];
    for (const p of parts) {
        if (typeof p?.text === 'string' && p.text.length > 0) textDeltas.push(p.text);
        else if (p?.functionCall) {
            functionCalls.push({
                name: String(p.functionCall.name || ''),
                args: p.functionCall.args ?? {},
            });
        }
    }

    const usageMeta = inner?.usageMetadata || parsed?.usageMetadata;
    const usage = usageMeta
        ? {
              promptTokens: Number(usageMeta.promptTokenCount || 0),
              completionTokens: Number(
                  usageMeta.candidatesTokenCount || usageMeta.responseTokenCount || 0,
              ),
              totalTokens: Number(usageMeta.totalTokenCount || 0),
          }
        : undefined;

    return {
        textDeltas,
        functionCalls,
        usage,
        finishReason: candidate?.finishReason,
    };
}

// ─── Gemini-native sink (preserves legacy behaviour) ─────────────────────────

/**
 * Sink that emits the response in Gemini's own SSE envelope.
 *
 * `unwrapEnvelope = true` → strip the outer `{response, usageMetadata}` shape
 *                          (used by the public proxy so SDKs see plain Gemini).
 * `unwrapEnvelope = false` → forward the raw chunk untouched
 *                           (used by the admin chat which understands envelopes).
 */
export class GeminiNativeSink implements StreamSink {
    constructor(
        private readonly res: Response,
        public readonly headersAlreadyWritten: boolean,
        private readonly unwrapEnvelope: boolean,
    ) {}

    start(usedModel: string, requestedModel: string): void {
        if (!this.headersAlreadyWritten) writeSseHead(this.res);
        if (usedModel !== requestedModel && requestedModel) {
            // Custom event so dashboards can show the actual model that served the request.
            safeWrite(this.res, `data: ${JSON.stringify({ openGemModelChange: usedModel })}\n\n`);
        }
    }

    forwardChunk(parsedRaw: any, _normalized: NormalizedChunk, rawJson: string): void {
        if (!this.unwrapEnvelope || !parsedRaw?.response) {
            safeWrite(this.res, `data: ${rawJson}\n\n`);
            return;
        }
        const forwarded = { ...parsedRaw.response };
        if (parsedRaw.usageMetadata) forwarded.usageMetadata = parsedRaw.usageMetadata;
        safeWrite(this.res, `data: ${JSON.stringify(forwarded)}\n\n`);
    }

    finalize(_state: { fullText: string; tokenUsage: number; finishReason?: string }): void {
        safeEnd(this.res);
    }

    abortAfterStart(_err: Error): void {
        // Response already committed — close the channel cleanly.
        safeEnd(this.res);
    }
}
