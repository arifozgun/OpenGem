import https from 'https';
import http from 'http';
import { URL } from 'url';

interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

interface HttpResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<any>;
    text: () => Promise<string>;
}

/**
 * A lightweight fetch replacement using Node.js native https/http modules.
 * This avoids undici's WebAssembly dependency which crashes on
 * memory-constrained shared hosting (cPanel).
 */
export function nativeFetchStream(url: string, options: RequestOptions = {}): Promise<{ status: number; stream: import('http').IncomingMessage }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        const headers: Record<string, string> = { ...(options.headers || {}) };
        if (options.body) {
            headers['Content-Length'] = Buffer.byteLength(options.body).toString();
        }

        const reqOptions: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers,
        };

        const req = lib.request(reqOptions, (res) => {
            resolve({ status: res.statusCode || 0, stream: res });
        });

        req.on('error', (err) => reject(err));
        req.setTimeout(120000, () => {
            req.destroy(new Error('Stream request timeout after 120s'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

export function nativeFetch(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        const headers: Record<string, string> = { ...(options.headers || {}) };

        // CRITICAL: Set Content-Length for POST/PUT bodies.
        // Without it, Node.js uses chunked transfer encoding which
        // causes Google's OAuth endpoints to hang indefinitely.
        if (options.body) {
            headers['Content-Length'] = Buffer.byteLength(options.body).toString();
        }

        const reqOptions: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers,
        };

        const req = lib.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];

            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const bodyText = Buffer.concat(chunks).toString('utf-8');
                const status = res.statusCode || 0;

                const response: HttpResponse = {
                    ok: status >= 200 && status < 300,
                    status,
                    statusText: res.statusMessage || '',
                    json: () => Promise.resolve(JSON.parse(bodyText)),
                    text: () => Promise.resolve(bodyText),
                };

                resolve(response);
            });
        });

        req.on('error', (err) => reject(err));
        req.setTimeout(30000, () => {
            req.destroy(new Error('Request timeout after 30s'));
        });

        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}
