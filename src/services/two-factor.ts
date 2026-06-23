import crypto from 'crypto';
import type { SmtpConfig } from './config';
import { sendTwoFactorCode } from './mail';

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CHALLENGES = 500;

interface Challenge {
    codeHash: string;
    expiresAt: number;
    attempts: number;
    createdAt: number;
}

const challenges = new Map<string, Challenge>();

function hashCode(challengeId: string, code: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(`${challengeId}:${code}`)
        .digest('hex');
}

function timingSafeEqualHex(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function pruneChallenges(): void {
    const now = Date.now();
    for (const [id, challenge] of challenges.entries()) {
        if (challenge.expiresAt <= now || challenge.attempts >= MAX_ATTEMPTS) {
            challenges.delete(id);
        }
    }

    if (challenges.size <= MAX_CHALLENGES) return;
    const oldest = [...challenges.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, challenges.size - MAX_CHALLENGES);
    for (const [id] of oldest) challenges.delete(id);
}

export async function createTwoFactorChallenge(smtp: SmtpConfig, jwtSecret: string): Promise<string> {
    pruneChallenges();

    const challengeId = crypto.randomBytes(32).toString('base64url');
    const code = String(crypto.randomInt(100000, 1000000));
    challenges.set(challengeId, {
        codeHash: hashCode(challengeId, code, jwtSecret),
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
        attempts: 0,
        createdAt: Date.now(),
    });

    try {
        await sendTwoFactorCode(smtp, code);
    } catch (err) {
        challenges.delete(challengeId);
        throw err;
    }

    return challengeId;
}

export function verifyTwoFactorChallenge(challengeId: string, code: string, jwtSecret: string): boolean {
    pruneChallenges();

    const challenge = challenges.get(challengeId);
    if (!challenge || challenge.expiresAt <= Date.now()) {
        challenges.delete(challengeId);
        return false;
    }

    challenge.attempts += 1;
    const normalizedCode = String(code || '').replace(/\s+/g, '');
    const expected = challenge.codeHash;
    const actual = hashCode(challengeId, normalizedCode, jwtSecret);
    const valid = /^\d{6}$/.test(normalizedCode) && timingSafeEqualHex(actual, expected);

    if (valid || challenge.attempts >= MAX_ATTEMPTS) {
        challenges.delete(challengeId);
    }

    return valid;
}
