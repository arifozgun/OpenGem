<div align="center">

<p align="center">
  <img src="https://api.speakblend.com/api/files/pbc_3307824350/8r1mh0hua000cwt/opengem_bcpoammn3u.png" alt="OpenGem - Self-hosted AI API gateway for Gemini, OpenAI-compatible and Anthropic-compatible clients" />
</p>

[![Version](https://img.shields.io/badge/Version-0.5.0-orange.svg)](https://github.com/arifozgun/OpenGem/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.5+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://typescriptlang.org)

[Quick Start](#quick-start) · [API Usage](#api-usage) · [Admin Console](#admin-console) · [Configuration](#configuration)

</div>

---

## What Is OpenGem?

OpenGem turns one or more Google accounts into a local, load-balanced Gemini gateway. It exposes the native Gemini API shape and also accepts OpenAI Chat Completions and Anthropic Messages requests, so most SDKs can point at your OpenGem server with only a base URL change.

It is designed for personal, educational and research usage. You run the gateway, connect your own Google accounts, create your own API keys, and monitor usage from the admin console.

## Highlights

- **Next.js admin console** with a rebuilt setup wizard, dashboard, logs, API keys, docs, settings and chat playground.
- **Native Gemini endpoint**: `POST /v1beta/models/{model}:generateContent`.
- **OpenAI-compatible endpoint**: `POST /v1/chat/completions` and `GET /v1/models`.
- **Anthropic-compatible endpoint**: `POST /v1/messages`.
- **Multi-account rotation** with cooldowns, retries, quota handling and automatic account reactivation.
- **Local SQLite backend** using Node.js `node:sqlite`, plus optional Firebase Firestore.
- **Secure API key store** with hashed keys, JWT admin sessions, rate limiting and Helmet headers.
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
- **Request Logs**: inspect prompt, response, model, fallback and token metadata.
- **Documentation**: endpoint quick reference and an API playground.
- **Chat**: authenticated Gemini chat with streamed responses and thinking sections.
- **Settings**: database backend switching, credential rotation and privacy mode.

## Configuration

OpenGem stores runtime configuration in `config.json` after setup. Local data lives in `data/db.sqlite` when SQLite is selected. Both are ignored by git.

Useful environment variables:

```bash
PORT=3050
HOST=127.0.0.1
CORS_ORIGIN=https://your-domain.example
```

When using Firebase, paste the Web app config in the setup wizard or in Settings when switching backends.

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
- Place production deployments behind nginx, Cloudflare or another trusted reverse proxy.
- Keep the Node process bound to loopback unless you know why it must be exposed.
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
