<div align="center">

<p align="center">
  <img src="https://api.speakblend.com/api/files/pbc_3307824350/8r1mh0hua000cwt/opengem_bcpoammn3u.png" alt="OpenGem - Self-hosted AI API gateway for Gemini, OpenAI-compatible and Anthropic-compatible clients" />
</p>

[![Version](https://img.shields.io/badge/Version-0.6.0-orange.svg)](https://github.com/arifozgun/OpenGem/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.5+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://typescriptlang.org)

[Quick Start](#quick-start) · [API Usage](#api-usage) · [Admin Console](#admin-console) · [Configuration](#configuration)

</div>

---

## What Is OpenGem?

OpenGem turns one or more Google accounts into a local, load-balanced Gemini gateway. It exposes the native Gemini API shape and also accepts OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and OpenRouter-style requests, so most SDKs can point at your OpenGem server with only a base URL change.

It is designed for personal, educational and research usage. You run the gateway, connect your own Google accounts, create your own API keys, and monitor usage from the admin console.

## Highlights

- **Next.js admin console** with a rebuilt setup wizard, dashboard, Logs, Requests, API keys, docs, settings and chat playground.
- **Native Gemini endpoint**: `POST /v1beta/models/{model}:generateContent`.
- **OpenAI-compatible endpoints**: `POST /v1/responses`, `POST /v1/chat/completions` and `GET /v1/models`.
- **OpenRouter-style aliases**: `/api/v1/chat/completions`, `/api/v1/responses`, `/api/v1/models` and `/api/v1/messages`.
- **Anthropic-compatible endpoint**: `POST /v1/messages`.
- **Adaptive multi-account balancing** with health scoring, cooldowns, Retry-After handling, local request windows and automatic account reactivation.
- **Local SQLite backend** using Node.js `node:sqlite`, plus optional Firebase Firestore.
- **Secure API key store** with hashed keys, JWT admin sessions, optional SMTP email 2FA, rate limiting and Helmet headers.
- **Streaming support** across Gemini, OpenAI-compatible and Anthropic-compatible surfaces.
- **Function calling, system prompts, tool payloads, image payloads and request logging**.
- **No legacy `public/` frontend**: the UI is now built through Next static export and served from `out/`.

## Quick Start

### Requirements

- Node.js `22.5.0` or newer
- npm
- At least one Google account
- Optional: Firebase project, only if you choose Firestore instead of local SQLite

### Install And Run

```bash
git clone https://github.com/arifozgun/OpenGem.git
cd OpenGem
npm install
npm run build
npm start
```

Open `http://localhost:3050`.

On a fresh install, OpenGem redirects to `/setup` where you choose the database backend and create the admin account. After setup, sign in, connect Google accounts, then create an API key from the dashboard.

For development:

```bash
npm run dev
```

The default server bind is `127.0.0.1:3050`. Use `HOST=0.0.0.0` only when you intentionally expose the process behind your own network controls.

## API Usage

All endpoints accept the same OpenGem API keys.

```text
Authorization: Bearer sk-your-api-key
x-goog-api-key: sk-your-api-key
x-api-key: sk-your-api-key
?key=sk-your-api-key
```

Optional account-affinity headers keep multi-turn agent tasks on the same upstream Google account while still failing over on quota or rate-limit errors:

```text
x-opengem-session-id: stable-session-or-thread-id
x-session-id: stable-session-or-thread-id
x-opengem-task-id: stable-task-id
x-opengem-affinity: off
```

OpenAI/OpenRouter-compatible request bodies can also use `session_id`, `user` or `metadata.user_id` for affinity scoping.

OpenGem 0.6.0 plans every upstream call through an adaptive balancer. It scores local in-flight work, account health, recent 429/quota signals, Retry-After headers, latency, Pro account status and affinity bindings before choosing a Google account. Conservative defaults can be tuned with:

```bash
OPENGEM_ACCOUNT_RATE_LIMIT_PER_MINUTE=45
OPENGEM_PRO_ACCOUNT_RATE_LIMIT_PER_MINUTE=75
OPENGEM_ACCOUNT_MAX_IN_FLIGHT=2
OPENGEM_PRO_ACCOUNT_MAX_IN_FLIGHT=3
OPENGEM_STREAM_ACCOUNT_MAX_IN_FLIGHT=2
OPENGEM_MIN_GLOBAL_CONCURRENCY=3
OPENGEM_MAX_GLOBAL_CONCURRENCY=24
```

### Gemini

```bash
curl -X POST "http://localhost:3050/v1beta/models/gemini-3.1-pro-preview:generateContent?key=sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello from OpenGem"}]}]}'
```

```js
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: "sk-your-api-key",
  baseUrl: "http://localhost:3050",
});

const response = await ai.models.generateContent({
  model: "gemini-3.1-pro-preview",
  contents: "Explain OpenGem in one paragraph.",
});

console.log(response.text);
```

### OpenAI Compatible

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-your-api-key",
  baseURL: "http://localhost:3050/v1",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

The modern OpenAI Responses API is also available:

```js
const response = await client.responses.create({
  model: "gpt-5-mini",
  input: "Explain OpenGem in one paragraph.",
  max_output_tokens: 512,
});

console.log(response.output_text);
```

For OpenRouter-style clients, use `/api/v1` as the base URL. OpenGem accepts `models[]`, `provider` hints and `session_id`, then safely normalizes the request to its Gemini backend:

```js
const routerClient = new OpenAI({
  apiKey: "sk-your-api-key",
  baseURL: "http://localhost:3050/api/v1",
});

const response = await routerClient.chat.completions.create({
  model: "openai/gpt-5",
  models: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
  session_id: "agent-run-42",
  provider: { order: ["openai", "anthropic"], allow_fallbacks: true },
  messages: [{ role: "user", content: "Continue the task." }],
});
```

### Anthropic Compatible

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "sk-your-api-key",
  baseURL: "http://localhost:3050",
});

const response = await client.messages.create({
  model: "claude-3-5-sonnet-latest",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a short haiku." }],
});

console.log(response.content);
```

## Admin Console

The dashboard includes:

- **Overview**: request totals, success rate, active accounts and token usage.
- **Accounts**: connect Google accounts, reactivate cooled-down accounts and remove accounts.
- **API Keys**: create, copy-once and revoke gateway keys.
- **Logs**: review incoming API traffic with request IDs, methods, URLs, status, execution time, user agents and redacted OpenGem keys.
- **Requests**: inspect prompt, response, model, fallback, routing and token metadata.
- **Documentation**: endpoint quick reference and an API playground.
- **Chat**: authenticated Gemini chat with persisted history, resume, fork, copy and edit-and-resend workflows.
- **Settings**: database backend switching, credential rotation, email 2FA, log retention, dark mode, highlight color and privacy mode.

## Configuration

OpenGem stores runtime configuration in `config.json` after setup. Local data lives in `data/db.sqlite` when SQLite is selected. Both are ignored by git.

Useful environment variables:

```bash
PORT=3050
HOST=127.0.0.1
CORS_ORIGIN=https://your-domain.example
TRUST_PROXY=loopback
OPENGEM_BODY_LIMIT=10mb
OPENGEM_HOME=/opt/opengem
```

When using Firebase, paste the Web app config in the setup wizard or in Settings when switching backends.

SMTP settings in Settings enable email-based 2FA for the admin login. Once configured, OpenGem sends a short-lived code after valid admin credentials and only creates the admin session after the code is verified.

## Build Output

The backend is still Express + TypeScript, while the UI is a static Next.js export.

```bash
npm run build:server  # compiles src/ to dist/
npm run build:web     # exports app/ to out/
npm run build         # runs both
```

`npm start` serves API routes and the built Next UI from the same port.

## Project Structure

```text
OpenGem/
├── app/                    # Next.js admin console and setup wizard
│   ├── assets/             # UI images/icons imported by Next
│   ├── setup/              # Setup wizard route
│   └── opengem-console.jsx # Dashboard application
├── components/ui/          # shadcn-style UI primitives
├── lib/                    # Frontend utilities
├── src/
│   ├── controllers/        # Gemini, OpenAI and Anthropic handlers
│   ├── middleware/         # Admin auth middleware
│   └── services/           # Config, database, OAuth, streaming, retry logic
├── dist/                   # Compiled backend output
├── out/                    # Next static export output
├── data/                   # Local SQLite data, ignored by git
├── config.json             # Runtime config, ignored by git
├── app.js                  # Production entry for Passenger/cPanel
└── package.json
```

## Security Notes

- Keep `config.json`, `.env` and `data/` private.
- Admin chat history is stored in the selected database backend; treat saved prompts and responses as sensitive operational data.
- Place production deployments behind nginx, Cloudflare or another trusted reverse proxy.
- Keep the Node process bound to loopback unless you know why it must be exposed.
- Admin POST/PUT/DELETE routes require same-origin requests plus a CSRF token tied to the signed admin session.
- SMTP email 2FA is optional, encrypted in `config.json`, and enforced automatically when complete SMTP credentials are saved.
- Logs and Requests support retention limits from Settings; IP address storage is disabled by default and can be enabled separately for each page.
- `CORS_ORIGIN=*` is allowed only for non-credentialed public API access; credentialed admin access remains same-origin.
- `TRUST_PROXY` defaults to `loopback` so public clients cannot spoof rate-limit IPs with `X-Forwarded-For`.
- `OPENGEM_BODY_LIMIT` defaults to `10mb`; raise it only for trusted deployments that need unusually large prompts.
- Regenerate API keys after switching database backends; raw key material is intentionally not recoverable.

## Star History

<a href="https://www.star-history.com/?repos=opengem%2Fopengem%2Carifozgun%2Fopengem&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=opengem/opengem%2Carifozgun/opengem&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=opengem/opengem%2Carifozgun/opengem&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=opengem/opengem%2Carifozgun/opengem&type=date&legend=bottom-right" />
 </picture>
</a>

## License

MIT. See [LICENSE](LICENSE).
