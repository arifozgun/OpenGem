/**
 * Model aliasing for OpenAI / Anthropic compatibility.
 *
 * When a client requests a non-Gemini model name (e.g. `gpt-4o`,
 * `claude-3-5-sonnet-latest`) we transparently route it to the configured
 * Gemini model. Clients still see the model id they requested in every
 * response (including streaming chunks) — this is purely an internal mapping.
 *
 * Any model id starting with `gemini-` is passed through untouched so callers
 * can still target a specific Gemini model by name.
 */

import {
    DEFAULT_MODEL,
    getFirstFallbackModel,
    getSecondFallbackModel,
} from '../gemini';

/**
 * Returns the Gemini model id that should actually serve the request.
 * - Empty / falsy → DEFAULT_MODEL
 * - `gemini-...`  → passthrough (case-insensitive prefix match)
 * - everything else → DEFAULT_MODEL
 */
export function resolveCompatibilityModel(requested: string | undefined | null): string {
    if (!requested || typeof requested !== 'string') return DEFAULT_MODEL;
    if (requested.toLowerCase().startsWith('gemini-')) return requested;
    return DEFAULT_MODEL;
}

/**
 * The list of model ids surfaced via /v1/models. We expose the natively
 * supported Gemini models plus a curated set of well-known OpenAI / Anthropic
 * aliases so SDK auto-discovery flows have something to pick from.
 */
export function listCompatibilityModelIds(): string[] {
    const seen = new Set<string>();
    const push = (id: string) => {
        if (id && !seen.has(id)) seen.add(id);
    };

    // Native Gemini ids (default + configured fallbacks)
    push(DEFAULT_MODEL);
    push(getFirstFallbackModel());
    push(getSecondFallbackModel());

    // Common OpenAI aliases
    push('gpt-4o');
    push('gpt-4o-mini');
    push('gpt-4-turbo');
    push('gpt-4');
    push('gpt-3.5-turbo');

    // Common Anthropic aliases
    push('claude-3-5-sonnet-latest');
    push('claude-3-5-haiku-latest');
    push('claude-3-opus-latest');
    push('claude-3-sonnet-latest');
    push('claude-3-haiku-latest');

    return Array.from(seen);
}
