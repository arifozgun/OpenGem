import crypto from 'crypto';

import { nativeFetch } from './http';

export const GEMINI_CLI_CREDENTIALS = {
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: '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'
};

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const GEMINI_API_BASE = `${CODE_ASSIST_ENDPOINT}/v1internal`;
export const DEFAULT_MODEL = 'gemini-3-flash-preview';
export const FALLBACK_MODEL = 'gemini-3-pro-preview';

export const OAUTH_CONFIG = {
    clientId: GEMINI_CLI_CREDENTIALS.clientId,
    clientSecret: GEMINI_CLI_CREDENTIALS.clientSecret,
    redirectUri: process.env.OAUTH_REDIRECT_URI || 'http://127.0.0.1:3050/api/auth/callback',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
    ],
};

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function generatePkce() {
    const verifier = crypto.randomBytes(32).toString('hex');
    const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

export async function discoverProjectId(accessToken: string): Promise<string> {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'opengem-intelligence/1.0',
    };

    try {
        const loadResponse = await nativeFetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                metadata: {
                    ideType: 'IDE_UNSPECIFIED',
                    platform: 'PLATFORM_UNSPECIFIED',
                    pluginType: 'GEMINI',
                },
            }),
        });

        if (loadResponse.ok) {
            const data = await loadResponse.json() as any;
            if (data.cloudaicompanionProject) {
                const project = data.cloudaicompanionProject;
                if (typeof project === 'string') return project;
                if (project.id) return project.id;
            }
        }

        const onboardResponse = await nativeFetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                tierId: 'free-tier',
                metadata: {
                    ideType: 'IDE_UNSPECIFIED',
                    platform: 'PLATFORM_UNSPECIFIED',
                    pluginType: 'GEMINI',
                },
            }),
        });

        if (onboardResponse.ok) {
            const data = await onboardResponse.json() as any;
            const projectId = data.response?.cloudaicompanionProject?.id;
            if (projectId) return projectId;
        }

        throw new Error('Could not discover GCP project ID');
    } catch (error) {
        console.error('❌ Project discovery failed:', error);
        throw error;
    }
}

export async function exchangeCodeForTokens(code: string, verifier: string) {
    const response = await nativeFetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            client_secret: OAUTH_CONFIG.clientSecret,
            code,
            code_verifier: verifier,
            redirect_uri: OAUTH_CONFIG.redirectUri,
            grant_type: 'authorization_code',
        }).toString(),
    });

    if (!response.ok) {
        throw new Error(`Token exchange failed: ${await response.text()}`);
    }

    const data = await response.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
}

export async function refreshAccessToken(refreshToken: string) {
    const refreshParams = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    const response = await nativeFetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshParams.toString(),
    });

    if (!response.ok) {
        throw new Error(`Token refresh failed: ${await response.text()}`);
    }

    const data = await response.json();
    return {
        accessToken: data.access_token,
        // Optional because Google doesn't always return a new refresh token
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
}

export async function getUserEmail(accessToken: string): Promise<string> {
    const response = await nativeFetch(OAUTH_CONFIG.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch user email');
    }
    const data = await response.json() as any;
    return data.email;
}

export async function checkAccountTier(accessToken: string): Promise<{ isPro: boolean, tierName: string }> {
    try {
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'opengem-intelligence/1.0',
        };
        const loadResponse = await nativeFetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                metadata: {
                    ideType: 'IDE_UNSPECIFIED',
                    platform: 'PLATFORM_UNSPECIFIED',
                    pluginType: 'GEMINI',
                },
            }),
        });
        if (loadResponse.ok) {
            const data = await loadResponse.json() as any;
            const currentTier = data?.currentTier?.id || 'unknown';
            const paidTier = data?.paidTier?.id;
            const isPro = paidTier === 'g1-pro-tier' || currentTier === 'premium-tier' || paidTier === 'premium-tier';
            const tierName = data?.paidTier?.name || data?.currentTier?.name || currentTier;
            return { isPro, tierName };
        }
    } catch (err) {
        console.error('Failed to check account tier:', err);
    }
    return { isPro: false, tierName: 'Unknown' };
}
