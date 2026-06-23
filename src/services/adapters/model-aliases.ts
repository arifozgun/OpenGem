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
    const normalized = lower.includes('/') ? lower.split('/').filter(Boolean).pop() || lower : lower;
    
    // 1. Exact matches for the 5 supported Antigravity slugs
    if (normalized === 'gemini-3-flash-agent') return 'gemini-3-flash-agent';
    if (normalized === 'gemini-3-flash') return 'gemini-3-flash';
    if (normalized === 'gemini-pro-agent') return 'gemini-pro-agent';
    if (normalized === 'gemini-3.5-flash-low') return 'gemini-3.5-flash-low';
    if (normalized === 'gemini-3.1-flash-lite') return 'gemini-3.1-flash-lite';
    
    // 2. Map Gemini 3 / 3.5 friendly names
    if (normalized === 'gemini-3.5-flash' || normalized === 'gemini-3.5-flash-preview') {
        return 'gemini-3-flash-agent'; // Gemini 3.5 Flash (High)
    }
    if (normalized === 'gemini-3-flash-preview') {
        return 'gemini-3-flash'; // Gemini 3 Flash
    }
    if (normalized === 'gemini-3-pro-preview' || normalized === 'gemini-3.1-pro-preview' || normalized === 'gemini-3.5-pro' || normalized === 'gemini-3.5-pro-preview' || normalized === 'gemini-3-pro') {
        return 'gemini-pro-agent'; // Gemini 3.1 Pro (High)
    }

    // 3. Provider-style ids from routers such as OpenRouter keep the provider
    // prefix client-side, but route by the terminal model slug internally.
    if (/^(gpt-5|gpt-4\.1|o[1-9]|claude-(opus|sonnet))/.test(normalized)) {
        if (normalized.includes('mini') || normalized.includes('nano') || normalized.includes('haiku')) {
            return 'gemini-3.1-flash-lite';
        }
        return 'gemini-pro-agent';
    }
    if (normalized.startsWith('gpt-4o') || normalized.startsWith('gpt-3.5') || normalized.includes('haiku')) {
        return normalized.includes('mini') || normalized.includes('haiku')
            ? 'gemini-3.1-flash-lite'
            : 'gemini-3-flash-agent';
    }
    
    // 4. Prevent any 2.5 or older/other legacy models from being used, mapping them to 3x equivalents.
    // Pro models -> gemini-pro-agent (Gemini 3.1 Pro High)
    if (normalized.includes('pro')) {
        return 'gemini-pro-agent';
    }
    // Flash Lite/8B models -> gemini-3.1-flash-lite (Gemini 3.1 Flash Lite)
    if (normalized.includes('flash-lite') || normalized.includes('lite') || normalized.includes('8b')) {
        return 'gemini-3.1-flash-lite';
    }
    // Flash models -> gemini-3-flash-agent (Gemini 3.5 Flash High)
    if (normalized.includes('flash')) {
        return 'gemini-3-flash-agent';
    }
    
    // 5. Default fallback for any other gemini- or general requests
    if (normalized.startsWith('gemini-')) {
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
    push('gpt-5');
    push('gpt-5-mini');
    push('gpt-4.1');
    push('gpt-4.1-mini');
    push('gpt-4o');
    push('gpt-4o-mini');
    push('gpt-4-turbo');
    push('gpt-4');
    push('gpt-3.5-turbo');
    push('openai/gpt-5');
    push('openai/gpt-4o');

    // Common Anthropic aliases
    push('claude-sonnet-4-5');
    push('claude-opus-4-1');
    push('claude-3-5-sonnet-latest');
    push('claude-3-5-haiku-latest');
    push('claude-3-opus-latest');
    push('claude-3-sonnet-latest');
    push('claude-3-haiku-latest');
    push('anthropic/claude-sonnet-4-5');

    return Array.from(seen);
}
