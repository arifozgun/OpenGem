import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig, isConfigured } from '../services/config';

export interface AdminRequest extends Request {
    admin?: boolean;
}

export const requireAdmin = (req: AdminRequest, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
        return res.status(503).json({ error: 'System not configured. Please complete setup.' });
    }
    const JWT_SECRET = getConfig().jwtSecret;

    // Check for the admin_session cookie
    const token = req.cookies.admin_session;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized. Admin login required.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { admin: boolean };
        if (decoded.admin) {
            req.admin = true;
            next();
        } else {
            return res.status(403).json({ error: 'Forbidden. Invalid token credentials.' });
        }
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
    }
};
