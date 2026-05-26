/**
 * Model aliasing for OpenAI / Anthropic compatibility.
 *
 * When a client requests a non-Gemini model name (e.g. `gpt-4o`,
 * `claude-3-5-sonnet-latest`) we transparently route it to the configured
 * Gemini model. Clients still see the model id they requested in every
 * response (including streaming chunks) — this is purely an internal mapping.
 *
 * Public Gemini ids and OpenGem-friendly aliases are normalized to the
 * Antigravity slug that the upstream endpoint actually accepts.
 */

import {
    DEFAULT_MODEL,
} from '../antigravity';

/**
 * Returns the Gemini model id that should actually serve the request.
 * - Empty / falsy → DEFAULT_MODEL
 * - known Gemini/OpenGem aliases → supported Antigravity slug
 * - unknown Gemini ids and everything else → DEFAULT_MODEL
 */
export function resolveCompatibilityModel(requested: string | undefined | null): string {
    if (!requested || typeof requested !== 'string') return DEFAULT_MODEL;
    
    const lower = requested.toLowerCase();
    
    // 1. Exact matches for the 5 supported Antigravity slugs
    if (lower === 'gemini-3-flash-agent') return 'gemini-3-flash-agent';
    if (lower === 'gemini-3-flash') return 'gemini-3-flash';
    if (lower === 'gemini-pro-agent') return 'gemini-pro-agent';
    if (lower === 'gemini-3.5-flash-low') return 'gemini-3.5-flash-low';
    if (lower === 'gemini-3.1-flash-lite') return 'gemini-3.1-flash-lite';
    
    // 2. Map Gemini 3 / 3.5 friendly names
    if (lower === 'gemini-3.5-flash' || lower === 'gemini-3.5-flash-preview') {
        return 'gemini-3-flash-agent'; // Gemini 3.5 Flash (High)
    }
    if (lower === 'gemini-3-flash-preview') {
        return 'gemini-3-flash'; // Gemini 3 Flash
    }
    if (lower === 'gemini-3-pro-preview' || lower === 'gemini-3.1-pro-preview' || lower === 'gemini-3.5-pro' || lower === 'gemini-3.5-pro-preview' || lower === 'gemini-3-pro') {
        return 'gemini-pro-agent'; // Gemini 3.1 Pro (High)
    }
    
    // 3. Prevent any 2.5 or older/other legacy models from being used, mapping them to 3x equivalents.
    // Pro models -> gemini-pro-agent (Gemini 3.1 Pro High)
    if (lower.includes('pro')) {
        return 'gemini-pro-agent';
    }
    // Flash Lite/8B models -> gemini-3.1-flash-lite (Gemini 3.1 Flash Lite)
    if (lower.includes('flash-lite') || lower.includes('lite') || lower.includes('8b')) {
        return 'gemini-3.1-flash-lite';
    }
    // Flash models -> gemini-3-flash-agent (Gemini 3.5 Flash High)
    if (lower.includes('flash')) {
        return 'gemini-3-flash-agent';
    }
    
    // 4. Default fallback for any other gemini- or general requests
    if (lower.startsWith('gemini-')) {
        return DEFAULT_MODEL;
    }
    
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

    // User-friendly Gemini 3x model names
    push('gemini-3.5-flash');
    push('gemini-3-flash-preview');
    push('gemini-3.1-pro-preview');
    push('gemini-3-pro-preview');
    push('gemini-3.1-flash-lite');

    // Native Antigravity/Gemini slugs
    push(DEFAULT_MODEL);
    push('gemini-3-flash');
    push('gemini-pro-agent');
    push('gemini-3.5-flash-low');
    push('gemini-3.1-flash-lite');

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
