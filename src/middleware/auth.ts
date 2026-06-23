import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getConfig, isConfigured } from '../services/config';

export interface AdminRequest extends Request {
    admin?: boolean;
}

interface AdminJwtPayload {
    admin: boolean;
    sessionVersion?: string;
    csrfToken?: string;
}

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function constantTimeEquals(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a);
    const bBuffer = Buffer.from(b);
    return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

export const requireAdmin = (req: AdminRequest, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
        return res.status(503).json({ error: 'System not configured. Please complete setup.' });
    }
    const config = getConfig();
    const JWT_SECRET = config.jwtSecret;

    // Check for the admin_session cookie
    const token = req.cookies.admin_session;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized. Admin login required.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as AdminJwtPayload;
        if (decoded.admin) {
            if (!decoded.sessionVersion || decoded.sessionVersion !== config.admin.sessionVersion) {
                return res.status(401).json({ error: 'Unauthorized. Session has been revoked.' });
            }
            if (unsafeMethods.has(req.method)) {
                const csrfHeader = req.header('x-csrf-token') || '';
                const csrfCookie = req.cookies.admin_csrf || '';
                const expected = decoded.csrfToken || '';
                if (
                    !csrfHeader ||
                    !csrfCookie ||
                    !expected ||
                    !constantTimeEquals(csrfHeader, expected) ||
                    !constantTimeEquals(csrfCookie, expected)
                ) {
                    return res.status(403).json({ error: 'Forbidden. Missing or invalid CSRF token.' });
                }
            }
            req.admin = true;
            next();
        } else {
            return res.status(403).json({ error: 'Forbidden. Invalid token credentials.' });
        }
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
    }
};
