import nodemailer from 'nodemailer';
import type { SmtpConfig } from './config';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export async function sendTwoFactorCode(smtp: SmtpConfig, code: string): Promise<void> {
    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: {
            user: smtp.username,
            pass: smtp.password,
        },
        requireTLS: !smtp.secure,
    });

    const from = smtp.fromEmail || smtp.username;
    await transporter.sendMail({
        from,
        to: smtp.toEmail,
        subject: 'OpenGem admin verification code',
        text: [
            `Your OpenGem admin verification code is ${code}.`,
            '',
            'This code expires in 10 minutes. If you did not request it, rotate your admin credentials and API keys.',
        ].join('\n'),
        html: [
            '<p>Your OpenGem admin verification code is:</p>',
            `<p style="font-size:24px;font-weight:700;letter-spacing:6px;">${escapeHtml(code)}</p>`,
            '<p>This code expires in 10 minutes. If you did not request it, rotate your admin credentials and API keys.</p>',
        ].join(''),
    });
}
