import crypto from 'crypto';
import type { Request } from 'express';
import type { Account, RequestLog } from './database';
import { isAccountInCooldown } from './account-cooldown';

export type AffinitySource = 'header-session' | 'header-task' | 'openai-user' | 'anthropic-user' | 'auto-task';

export interface AccountAffinityContext {
    keyHash: string;
    source: AffinitySource;
    hit: boolean;
    rebound: boolean;
    boundEmail?: string;
}

export interface AccountAffinityOptions {
    req?: Request;
    model: string;
    contents: any[];
    systemInstruction?: any;
    explicitUserId?: string;
    explicitUserSource?: Extract<AffinitySource, 'openai-user' | 'anthropic-user'>;
}

interface Binding {
    accountEmail: string;
    source: AffinitySource;
    expiresAt: number;
    lastUsedAt: number;
}

export interface TokenUsageDetails {
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
}

const AFFINITY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BINDINGS = 5_000;
const HASH_LEN = 64;

const bindings = new Map<string, Binding>();
const pendingBindings = new Map<string, string>();
const tokenBaselines = new Map<string, { promptTokens: number; totalTokens: number; lastUsedAt: number }>();

export function hashAffinityValue(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, HASH_LEN);
}

export function createAccountAffinityContext(options: AccountAffinityOptions): AccountAffinityContext | undefined {
    const disabled = readHeader(options.req, 'x-opengem-affinity')?.toLowerCase();
    if (disabled && ['off', 'none', 'false', '0'].includes(disabled)) return undefined;

    const apiKeyHash = getRequestApiKeyHash(options.req);
    const scope = apiKeyHash ? `api:${apiKeyHash}` : 'admin';
    const model = options.model || 'default';

    const sessionId = readHeader(options.req, 'x-opengem-session-id');
    if (sessionId) return buildContext(scope, model, 'header-session', sessionId);

    const taskId = readHeader(options.req, 'x-opengem-task-id');
    if (taskId) return buildContext(scope, model, 'header-task', taskId);

    if (options.explicitUserId && options.explicitUserSource) {
        return buildContext(scope, model, options.explicitUserSource, options.explicitUserId);
    }

    const taskFingerprint = extractTaskFingerprint(options.contents, options.systemInstruction);
    if (!taskFingerprint) return undefined;

    return buildContext(scope, model, 'auto-task', taskFingerprint);
}

export function orderAccountsForAffinity(accounts: Account[], affinity?: AccountAffinityContext): Account[] {
    if (!affinity || accounts.length === 0) return accounts;

    pruneBindings();

    const binding = getBinding(affinity.keyHash);
    const preferredEmail = binding?.accountEmail || pendingBindings.get(affinity.keyHash);
    affinity.boundEmail = preferredEmail;

    if (!preferredEmail || isAccountInCooldown(preferredEmail)) return accounts;

    const preferredIndex = accounts.findIndex(account => account.email === preferredEmail);
    if (preferredIndex <= 0) {
        affinity.hit = preferredIndex === 0;
        return accounts;
    }

    affinity.hit = true;
    return [
        accounts[preferredIndex],
        ...accounts.slice(0, preferredIndex),
        ...accounts.slice(preferredIndex + 1),
    ];
}

export function reserveAffinityAccount(affinity: AccountAffinityContext | undefined, accountEmail: string): void {
    if (!affinity) return;
    if (getBinding(affinity.keyHash)) return;
    if (!pendingBindings.has(affinity.keyHash)) {
        pendingBindings.set(affinity.keyHash, accountEmail);
        affinity.boundEmail = accountEmail;
    }
}

export function releaseAffinityReservation(affinity: AccountAffinityContext | undefined, accountEmail: string): void {
    if (!affinity) return;
    if (pendingBindings.get(affinity.keyHash) === accountEmail) {
        pendingBindings.delete(affinity.keyHash);
    }
}

export function bindAffinityAccount(affinity: AccountAffinityContext | undefined, accountEmail: string): void {
    if (!affinity) return;

    const previous = getBinding(affinity.keyHash)?.accountEmail || pendingBindings.get(affinity.keyHash);
    affinity.rebound = Boolean(previous && previous !== accountEmail);
    affinity.boundEmail = accountEmail;
    pendingBindings.delete(affinity.keyHash);
    bindings.set(affinity.keyHash, {
        accountEmail,
        source: affinity.source,
        expiresAt: Date.now() + AFFINITY_TTL_MS,
        lastUsedAt: Date.now(),
    });
    pruneBindings();
}

export function getAffinityLogFields(affinity?: AccountAffinityContext): Partial<RequestLog> {
    if (!affinity) return {};
    return {
        affinityKeyHash: affinity.keyHash,
        affinitySource: affinity.source,
        affinityHit: affinity.hit,
        affinityRebound: affinity.rebound,
    };
}

export function getAffinityPromptId(affinity?: AccountAffinityContext): string {
    return affinity ? `opengem-${affinity.keyHash.slice(0, 32)}` : 'default-prompt';
}

export function computeEffectiveTokenUsage(
    affinity: AccountAffinityContext | undefined,
    accountEmail: string,
    usage: TokenUsageDetails,
): number {
    const totalTokens = Math.max(0, Math.floor(usage.totalTokens || 0));
    if (!affinity) return totalTokens;

    const key = `${affinity.keyHash}:${accountEmail}`;
    const previous = tokenBaselines.get(key);
    const promptTokens = Math.max(0, Math.floor(usage.promptTokens ?? totalTokens));
    const completionTokens = Math.max(0, Math.floor(usage.completionTokens ?? 0));

    let effectiveTokens: number;
    if (previous && usage.promptTokens !== undefined) {
        effectiveTokens = Math.max(0, promptTokens - previous.promptTokens) + completionTokens;
    } else if (previous) {
        effectiveTokens = Math.max(0, totalTokens - previous.totalTokens);
    } else {
        effectiveTokens = totalTokens;
    }

    tokenBaselines.set(key, {
        promptTokens: Math.max(previous?.promptTokens ?? 0, promptTokens),
        totalTokens: Math.max(previous?.totalTokens ?? 0, totalTokens),
        lastUsedAt: Date.now(),
    });

    return effectiveTokens;
}

function buildContext(scope: string, model: string, source: AffinitySource, value: string): AccountAffinityContext {
    return {
        keyHash: hashAffinityValue(`${scope}:${model}:${source}:${value.trim()}`),
        source,
        hit: false,
        rebound: false,
    };
}

function getBinding(keyHash: string): Binding | undefined {
    const binding = bindings.get(keyHash);
    if (!binding) return undefined;
    if (binding.expiresAt <= Date.now()) {
        bindings.delete(keyHash);
        return undefined;
    }
    binding.lastUsedAt = Date.now();
    binding.expiresAt = Date.now() + AFFINITY_TTL_MS;
    return binding;
}

function pruneBindings(): void {
    const now = Date.now();
    for (const [key, binding] of bindings) {
        if (binding.expiresAt <= now) bindings.delete(key);
    }
    for (const [key, baseline] of tokenBaselines) {
        if (now - baseline.lastUsedAt > AFFINITY_TTL_MS) tokenBaselines.delete(key);
    }
    if (bindings.size <= MAX_BINDINGS) return;

    const overflow = bindings.size - MAX_BINDINGS;
    const oldest = Array.from(bindings.entries())
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
        .slice(0, overflow);
    for (const [key] of oldest) bindings.delete(key);
}

function readHeader(req: Request | undefined, name: string): string | undefined {
    const value = req?.header(name);
    return value && value.trim() ? value.trim() : undefined;
}

function getRequestApiKeyHash(req: Request | undefined): string | undefined {
    const hash = (req as any)?.opengemApiKeyHash;
    return typeof hash === 'string' && hash ? hash : undefined;
}

function extractTaskFingerprint(contents: any[], systemInstruction?: any): string | undefined {
    const texts = [
        ...extractTextParts(systemInstruction),
        ...extractTextParts(contents),
    ].filter(Boolean);
    if (texts.length === 0) return undefined;

    const fullText = texts.join('\n\n');
    if (!looksLikeAgentTask(fullText)) return undefined;

    const taskText = extractStableTaskText(texts, fullText);
    const normalized = normalizeTaskText(taskText);
    return normalized ? hashAffinityValue(normalized) : undefined;
}

function extractTextParts(value: any): string[] {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(extractTextParts);
    if (typeof value !== 'object') return [];

    const out: string[] = [];
    if (typeof value.text === 'string') out.push(value.text);
    if (Array.isArray(value.parts)) out.push(...value.parts.flatMap(extractTextParts));
    if (value.content) out.push(...extractTextParts(value.content));
    if (value.functionCall?.name) out.push(`[Tool Call: ${value.functionCall.name}]`);
    if (value.functionResponse?.name) out.push(`[Tool Response: ${value.functionResponse.name}]`);
    return out;
}

function looksLikeAgentTask(text: string): boolean {
    return /<task>|<\/task>|\[TASK RESUMPTION\]|<environment_details>|<environment_context>|\[Tool Response:|\[Tool Call:|Automated Agent Task/i.test(text);
}

function extractStableTaskText(texts: string[], fullText: string): string {
    const taskMatch = fullText.match(/<task>([\s\S]*?)<\/task>/i);
    if (taskMatch?.[1]) return taskMatch[1];

    const resumptionMatch = fullText.match(/\[TASK RESUMPTION\]([\s\S]*?)(?:<environment_details>|<environment_context>|\[Tool Response:|$)/i);
    if (resumptionMatch?.[1]) return resumptionMatch[1];

    const taskLike = texts.find(text => /<task>|\[TASK RESUMPTION\]|Automated Agent Task/i.test(text));
    if (taskLike) return taskLike;

    return fullText;
}

function normalizeTaskText(text: string): string {
    return text
        .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, ' ')
        .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
        .replace(/\[Tool Response:[\s\S]*?(?=\n\S|\n\[|$)/gi, ' ')
        .replace(/\[Tool Call:[\s\S]*?(?=\n\S|\n\[|$)/gi, ' ')
        .replace(/\b(?:\d+\s*(?:ms|s|m|h)\s+ago|Just now)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8_000);
}
