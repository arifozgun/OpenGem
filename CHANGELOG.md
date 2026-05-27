# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-05-28

### Added
- **Task-aware account affinity** — Automated agent tasks can now stay on the same upstream Google account across turns via `x-opengem-session-id`, `x-opengem-task-id`, OpenAI `user`, Anthropic `metadata.user_id`, or automatic task fingerprinting. Sticky tasks still soft-fail over and rebind when the bound account hits quota, rate limits, or transient failures. (`src/services/account-affinity.ts`, `src/controllers/chat.ts`, `src/controllers/openai.ts`, `src/controllers/anthropic.ts`)
- **Affinity log metadata** — Request logs now store affinity source, hit/rebind state, prompt tokens, completion tokens, and effective token counts. The admin log detail view exposes sticky/effective-token metadata for debugging. (`src/services/database.ts`, `src/services/sqliteDb.ts`, `src/services/firebase.ts`, `app/opengem-console.jsx`)
- **Admin chat session affinity** — The dashboard chat now sends the full message history with a stable per-chat session id so multi-turn chat stays on the same upstream account and benefits from the gateway's context affinity. (`app/opengem-console.jsx`)
- **Documentation account affinity guide** — The Documentation page now lists the sticky-routing headers for session affinity, task affinity, and per-request opt-out. (`app/opengem-console.jsx`)

### Fixed
- **Overview Token Accounting** — Overview and per-account token totals now use effective token accounting for sticky tasks instead of blindly summing every repeated full-context request. Existing sticky logs without effective-token metadata are grouped by affinity key and counted once by their maximum raw token count. (`src/services/token-stats.ts`, `src/services/sqliteDb.ts`, `src/services/firebase.ts`)
- **Mobile Sidebar Clipping** — The mobile dashboard sidebar now respects the top safe area and gives the horizontal nav enough vertical room so active items are not clipped at the top. (`app/opengem-console.jsx`)
- **Mobile API Cards** — Documentation and Settings compatibility cards now wrap long endpoint/auth strings instead of overflowing their card containers on small screens. (`app/opengem-console.jsx`)
- **Responsive Button Wrapping** — Dashboard buttons and button rows now wrap within their containers instead of overflowing when multiple actions sit side by side on narrow screens. (`components/ui/button.jsx`, `app/opengem-console.jsx`)
- **Log Detail Copy Tooltip** — Opening a log detail dialog no longer autofocuses the first copy button, preventing the System Prompt copy tooltip from appearing automatically. (`app/opengem-console.jsx`)

### Changed
- **Dashboard Model Defaults** — Chat and Documentation playground model selectors now default to `gemini-3.1-flash-lite`, including after starting a new chat. (`app/opengem-console.jsx`)
- Incremented package version to `0.5.1`.

## [0.5.0] - 2026-05-26

### Added
- **Next.js Admin Console** — Replaced the legacy hand-written HTML/CSS/JS frontend with a Next.js App. The new console covers login, overview, accounts, API keys, logs, documentation, playground, chat, settings and setup. (`app/`, `components/ui/`, `lib/`, `next.config.mjs`, `postcss.config.mjs`)
- **New Setup Wizard** — Rebuilt setup as a React route with the same backend choices, Firebase JSON paste support and admin credential validation as before. (`app/setup/`)
- **SQLite Local Backend (`node:sqlite`)** — Replaced the legacy JSON-file local database with SQLite using Node.js' native `node:sqlite` module. Existing `data/db.json` files are migrated once and renamed to `db.json.bak`. (`src/services/sqliteDb.ts`, `src/services/database.ts`)
- **Node 22.5 engine constraint** — Declared `engines.node >= 22.5.0` because the local backend uses built-in SQLite. (`package.json`)
- **Antigravity CLI (`agy`) Migration** — OAuth token acquisition and refresh now use credentials extracted from Antigravity CLI instead of the legacy Gemini CLI flow. (`src/services/antigravity.ts`)
- **Antigravity CLI User-Agent** — Upstream requests now use the `antigravity/1.0.2` CLI-style user-agent headers. (`src/controllers/chat.ts`)

### Removed
- **Legacy `public/` frontend** — Removed `public/index.html`, `public/setup.html`, `public/admin.css`, `public/setup.css`, `public/admin.js`, `public/setup.js` and then removed the `public/` directory entirely. UI assets now live under `app/assets/` and are imported by Next.
- **Legacy JSON-file `localDb.ts`** — Superseded by `sqliteDb.ts`. Existing JSON databases still auto-migrate on first run.
- **Legacy Fallback Models** — Removed the obsolete model fallback rotation chain and related model configuration UI. On 429, OpenGem cools down the account and rotates to another account. (`src/controllers/chat.ts`, `src/services/adapters/model-aliases.ts`, `src/index.ts`, `src/services/config.ts`)

### Changed
- **Express Static Serving** — The server now serves the built Next export from `out/`, supports clean dashboard routes (`/`, `/accounts`, `/keys`, `/logs`, `/docs`, `/chat`, `/settings`, `/setup`) and provides `/robots.txt` directly from Express. (`src/index.ts`)
- **Build Pipeline** — Split TypeScript configs so backend compilation uses `tsconfig.server.json`, while Next uses `tsconfig.json`. `npm run build` now runs both backend and frontend builds. (`package.json`, `tsconfig.json`, `tsconfig.server.json`)
- **README** — Rewrote the README to be shorter, clearer and current with the Next.js UI, SQLite backend and removed `public/` frontend. (`README.md`)
- **Service Name Update** — Renamed `gemini.ts` to `antigravity.ts` to reflect the toolchain platform rename. (`src/services/antigravity.ts`)
- **Setup Wizard / Settings Wording** — Local storage is now consistently described as "Local SQLite (`data/db.sqlite`)" instead of the old JSON-file backend.

### Fixed
- **Admin Chat Friendly Model Names** — Dashboard chat and native `/v1beta/models/:model:action` now route friendly model ids through `resolveCompatibilityModel()`, mapping names such as `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview` and `gemini-3-pro-preview` to valid Antigravity slugs. (`src/controllers/chat.ts`)
- **Local DB Request Logs** — Fixed the old local backend behaviour where log rows could show `undefined`, `—` or incorrect error previews because core fields were dropped. The SQLite implementation returns full log records consistently.
- Incremented package version to `0.5.0`.

## [0.3.2] - 2026-05-24

### Added
- **Administrator Credential Rotation from Settings** — A new "Account Credentials" card on the Settings page lets an authenticated admin change their username and password without re-running the setup wizard or hand-editing `config.json`. The current password is required for re-authentication, the new password is validated against the same complexity policy used at setup (≥8 chars, 1 uppercase, 1 lowercase, 1 digit), both values are bcrypt-hashed at cost 12 before persistence, and the session cookie is invalidated on success so the operator must sign in again with the new credentials. (`src/index.ts`, `src/services/config.ts`, `public/index.html`, `public/admin.js`)
- **`updateAdminCredentials()` config helper** — Field-scoped writer that updates only the `admin.username` and `admin.password` entries of `config.json`, refusing to accept anything other than pre-computed bcrypt hashes. Encryption keys, Firebase configuration, model overrides and database backend are left strictly untouched. (`src/services/config.ts`)
- **`gemini-3.5-flash` Model Support** — Added the newly released `gemini-3.5-flash` model to every model picker in the dashboard (Playground, Chat, Settings → Fallback / Fallback V2) and the public Documentation page's "Available Models" grid. The model is proxied through the same `/v1beta/models/:model:action` route as every other Gemini id, with no new server-side code path required. (`public/index.html`)

### Security
- **Loopback-Only Default Bind** — The Node.js process now listens on `127.0.0.1:3050` by default instead of `0.0.0.0:3050`. Production deployments fronted by nginx / Cloudflare get an additional defense-in-depth layer: even if the host firewall is misconfigured, the OpenGem process is unreachable from the public internet. Operators who genuinely want a directly-exposed listener can opt back in with `HOST=0.0.0.0`. (`src/index.ts`)

### Changed
- Incremented package version to `0.3.2`.

## [0.3.1] - 2026-05-16

### Added
- **OpenAI Chat Completions Compatibility** — New `POST /v1/chat/completions` and `GET /v1/models` endpoints serving the canonical OpenAI wire format. Existing tooling (OpenAI SDKs, LangChain, LlamaIndex, OpenWebUI, Cline, Cursor, etc.) connects out-of-the-box by setting `base_url` to OpenGem. Streaming, tool calling, multimodal images, JSON mode (`response_format`), and `stream_options.include_usage` are fully supported. (`src/controllers/openai.ts`, `src/services/adapters/openai.ts`)
- **Anthropic Messages API Compatibility** — New `POST /v1/messages` endpoint serving Anthropic's official Messages API wire format with full event-stream protocol support (`message_start` → `content_block_*` → `message_delta` → `message_stop`). Tool use, base64 images, system prompts and `top_k` are all wired through. (`src/controllers/anthropic.ts`, `src/services/adapters/anthropic.ts`)
- **Pluggable Stream Sink Architecture** — Introduced a `StreamSink` abstraction so that the same multi-account rotation, retry, cooldown and logging engine drives Gemini-native, OpenAI and Anthropic streams without duplication. Each protocol owns only its wire-format-specific writer. (`src/services/streaming.ts`)
- **Generic `generateContentWithAccounts()`** — Non-streaming engine helper that returns both the unwrapped Gemini response and the model that actually served the request, enabling adapters to preserve the requested model id in client-facing responses. (`src/controllers/chat.ts`)
- **Transparent Model Aliasing** — Common OpenAI / Anthropic model names (e.g. `gpt-4o`, `gpt-4o-mini`, `claude-3-5-sonnet-latest`, `claude-3-opus-latest`) are routed onto the configured default Gemini model while the requested id is preserved verbatim in every response and stream chunk. Any `gemini-*` id is passed through unchanged. (`src/services/adapters/model-aliases.ts`)
- **Multi-format API Key Extraction** — `requireApiKey` now accepts every convention used by the supported SDK families: `Authorization: Bearer`, `x-api-key` (Anthropic), `x-goog-api-key` (Gemini), and the `?key=` query string fallback. The same hashed key store and per-IP rate limit (120 req/min) protect every endpoint. (`src/index.ts`)
- **Protocol-aware Auth Errors** — 401/500 responses are emitted in each protocol's native error envelope (OpenAI: `{error:{message,type,code}}`, Anthropic: `{type:"error",error:{type,message}}`, Gemini: `{error}`) so SDK consumers get the error shape they expect. (`src/index.ts`)
- **Provider-aware Documentation UI** — The dashboard's Documentation page now showcases all three compatible providers (Gemini / OpenAI / Anthropic) with branded provider cards and dedicated SDK code tabs (OpenAI Python, OpenAI JS, Anthropic Python, Anthropic JS). (`public/index.html`, `public/admin.css`)
- **API Compatibility Settings Panel** — A new "API Compatibility" card on the Settings page lists the three live endpoints with their authentication conventions and provider icons for quick at-a-glance reference. (`public/index.html`)

### Fixed
- **Stream Write Safety** — Every SSE write now goes through `safeWrite()`/`safeEnd()` helpers that check `writableEnded`/`destroyed` state before touching the socket, preventing crashes when clients disconnect mid-stream. (`src/services/streaming.ts`)
- **Double-Resolve Guard in `pipeStream`** — Added a `settled` flag preventing simultaneous resolve/reject when the upstream stream emits `end` and `error` in close succession. (`src/controllers/chat.ts`)
- **Buffered Tail Chunk Flush** — The streaming pipeline now drains any partial buffered SSE line on `stream.end`, ensuring the very last chunk is never silently dropped. (`src/controllers/chat.ts`)
- **Mid-Stream Failure Recovery** — When an upstream stream errors after the response has been committed, the responsible sink now writes a protocol-appropriate terminal frame (OpenAI error chunk + `[DONE]`, Anthropic `event: error`, Gemini clean end) instead of leaving the SSE channel half-open. (`src/services/streaming.ts`, `src/services/adapters/*`)

### Changed
- **`chat.ts` Refactor** — The streaming engine was decoupled from Gemini's wire format and now operates exclusively through the `StreamSink` interface. Behaviour for the existing `/v1beta/...` proxy and admin chat is preserved bit-for-bit; the public surface (`tryGenerateContentWithAccounts`, `handleAdminChat`, `handleGenerateContent`) is unchanged.
- **README & Project Structure** — Documented the new endpoints, SDK quick-starts (Python + Node.js for OpenAI and Anthropic) and feature coverage matrix; updated the directory tree to include `src/services/adapters/` and `src/services/streaming.ts`.
- Incremented package version to `0.3.1`.

## [0.3.0] - 2026-04-22

### Added
- **Dynamic Concurrency Scaling:** Replaced hardcoded concurrency limits with a dynamic scaling algorithm. OpenGem now automatically scales its concurrent request capacity based on the number of active Google accounts (2 concurrent requests per active account, minimum 3). This prevents bottlenecks when AI agents like Claude Code perform massive parallel tool calls. (`src/services/concurrency.ts`)
- **Advanced Streaming Concurrency Control:** Introduced a dedicated `geminiStreamSemaphore` specifically to throttle concurrent Server-Sent Events (SSE) streams, protecting the host IP from rate limit bans when an agent attempts to open 20+ streams simultaneously. (`src/controllers/chat.ts`)
- **HTTP Payload Decompression:** OpenGem now requests `gzip, deflate, br` encoding from the Gemini API and seamlessly decompresses the inbound response streams using Node.js `zlib`. This dramatically reduces network transfer times when AI agents download massive code blocks or JSON structures. (`src/services/http.ts`)

### Fixed
- **UTF-8 Stream Chunking Corruption:** Fixed a critical bug in the Server-Sent Events (SSE) streaming pipeline where multi-byte UTF-8 characters (like emojis or special symbols) split across buffer chunks were corrupted by raw `.toString('utf-8')` calls, causing `JSON.parse` to crash. Implemented Node.js `StringDecoder` to properly buffer and decode partial character sequences. (`src/controllers/chat.ts`)
- **Streaming CPU Bottleneck:** Optimized the SSE proxying mechanism to forward raw JSON strings directly to the client when envelope unwrapping is not required, bypassing expensive and redundant `JSON.parse()` and `JSON.stringify()` operations. This significantly lowers CPU usage and event-loop blocking during high-speed token generation. (`src/controllers/chat.ts`)

### Changed
- Incremented package version to `0.3.0`.


## [0.2.5] - 2026-03-07

### Added
- **Dynamic Model Configuration** — Fallback models can now be changed from the **Settings** page in the admin dashboard, eliminating the need to modify source code. (`src/services/gemini.ts`, `src/services/config.ts`)
- **Model Configuration API** — New admin endpoints `GET /POST /api/admin/models` for reading and updating the fallback model chain. (`src/index.ts`)
- **Settings UI** — Added a "Model Configuration" card to the Settings page with two input fields and a save button for managing the fallback model chain. (`public/index.html`, `public/admin.js`)

### Fixed
- **Primary Model Configuration** — Removed the primary model configuration setting from the dashboard and backend, as the primary model is already specified dynamically via API payloads. The setting is now cleanly dedicated to managing fallback models. (`src/services/config.ts`, `src/services/gemini.ts`, `src/index.ts`, `src/controllers/chat.ts`, `public/admin.js`, `public/index.html`)
- **System Prompt Logging** — Fixed a bug where system prompts were not being saved in request logs. Both database backends (`localDb.ts`, `firebase.ts`) were explicitly listing fields to save but omitting `systemInstruction`. Also added support for the `system_instruction` (snake_case) request body variant and nested `content.parts` format. (`src/controllers/chat.ts`, `src/services/localDb.ts`, `src/services/firebase.ts`)

### Changed
- Refactored `chat.ts` to use dynamic model getters (`getDefaultModel()`, `getFirstFallbackModel()`, `getSecondFallbackModel()`) instead of hardcoded constants for runtime configurability.
- Model configuration is stored in `config.json` under the `models` key (unencrypted — model names are not sensitive).
- Incremented package version to `0.2.5`.

## [0.2.1] - 2026-02-26

### Added
- **Third Model Fallback** — Added `gemini-3.1-pro-preview` as the third fallback model step in the rotation chain (`flash` → `pro` → `pro-3.1`). (`src/services/gemini.ts`)

### Fixed
- **Input Stream Termination** — Resolved the `Network error: Error in input stream` issue by automatically appending `data: [DONE]\n\n` prior to closing the HTTP response in SSE streaming.
- **Frontend Fetch Error** — Fixed a mid-stream `NetworkError` on the frontend by stopping any further account rotation attempts if SSE headers have already been sent to the client.
- **False Quota Exhaustion** — Fixed a misclassification bug where `resource_exhausted` errors from the Code Assist API were incorrectly handled as a 1-hour quota exhaustion instead of a brief `rate_limit` (RPM burst). (`src/services/error-classifier.ts`)

### Changed
- **In-Memory Caching** — Refactored the local database handler (`localDb.ts`) to use an in-memory cache for drastically faster and smoother account switching.
- **Reduced API Concurrency** — Concurrently active Gemini API requests lowered from 8 to 3 to prevent overwhelming Google servers and triggering bulk closures.
- **Improved Rotation Staggering** — Implemented a 150ms stagger between rotational account fallback attempts to mitigate Google's burst IP throttling.
- **Chat Controller Optimization** — Streamlined the entire account switching flow in the backend controller by removing redundant delays and duplicate loops.
- Incremented package version to `0.2.1`.

## [0.2.0] - 2026-02-23

### Added
- **Exponential Backoff with Jitter** — All retry delays now use exponential backoff (2s → 4s → 8s → 16s → 32s) with ±20% jitter to prevent thundering herd, replacing the previous flat 10s delay. (`src/services/retry.ts`)
- **Comprehensive Error Classifier** — 8-category error classification system with 50+ regex patterns covering rate_limit, quota, auth, timeout, overloaded, billing, model_not_found, and format errors. Adapted from openclaw's error handling. (`src/services/error-classifier.ts`)
- **Account Cooldown System** — Per-account cooldown tracking with escalating durations (15s → 30s → 60s → 120s for rate limits, 60min for quota) and automatic probe recovery every 30 seconds. Adapted from openclaw's auth-profiles. (`src/services/account-cooldown.ts`)
- **Client-Side Rate Limiter** — Per-account fixed-window rate limiter (10 requests per 60 seconds) prevents sending requests to accounts that are already at their limit. (`src/services/rate-limiter.ts`)
- **Request Concurrency Limiter** — Semaphore-based limiter caps concurrent Gemini API requests at 3 per process to prevent overwhelming the API from a single IP. (`src/services/concurrency.ts`)
- **Retry-After Header Parsing** — 429 responses now have their `Retry-After` header parsed and respected for intelligent backoff timing.
- **Inter-Account Delay** — 500ms delay between trying different accounts on the same IP to avoid cascading 429s.

### Fixed
- **Flash → Pro Model Fallback** — Critical bug fixed where the fallback from `DEFAULT_MODEL` (gemini-3-flash-preview) to `FALLBACK_MODEL` (gemini-3-pro-preview) was never triggered due to an incorrect condition. Fallback now works for all models.
- **Permanent Account Exhaustion Eliminated** — Accounts are **never** permanently deactivated (`isActive: false`) anymore. All errors now use temporary cooldowns that auto-expire, matching openclaw's approach. This is the most impactful stability fix — accounts will always auto-recover.
- **Improved 429 Error Classification** — `resource_exhausted`, `resource exhausted`, and `quota_exceeded` patterns are now correctly identified as quota errors instead of being treated as simple rate limits.

### Changed
- All three request handlers (`tryGenerateContentWithAccounts`, `handleStreamGenerateContent`, `handleAdminChat`) now share the same robust error handling, cooldown, and retry infrastructure.
- Error handling in catch blocks now uses `classifyError()` for consistent categorization instead of ad-hoc string matching.
- Incremented package version to `0.2.0`.

## [0.1.9] - 2026-02-23

### Fixed
- System prompts (`systemInstruction`) are now logged alongside questions and answers in request logs.
- Added a dedicated "System Prompt" section to the log detail modal in the Admin Dashboard for clear visibility.

### Changed
- Incremented package version to `0.1.9`.

## [0.1.8] - 2026-02-23

### Fixed
- Added `<environment_details>` and `[Tool Response:` as indicators for Automated Agent Tasks in the dashboard request logs.
- Fixed issue where agent task outputs utilizing `functionCall` responses (such as `attempt_completion`) were incorrectly omitted from request logs.
- Removed unintentional bold formatting from text output in the Admin Dashboard logs preview to render raw unformatted Agent outputs accurately.
- Updated `src/controllers/chat.ts` and `public/admin.js` to seamlessly display multi-part AI reasoning sequences and execution outcomes.

### Changed
- Incremented package version to `0.1.8`.

## [0.1.7] - 2026-02-21

### Added
- Tools support (\`tools\`, \`toolConfig\`, \`tool_config\`) added to Gemini API payload construction.
- Request detail logs now properly format tool calls (\`functionCall\` and \`functionResponse\`) within the question text.
- Modified JSON body payload limit in Express to support huge payloads up to \`50mb\`.

### Fixed
- Fixed SSE stream response formatting to unwrap native Gemini payload structure when streaming so standard OpenAI compatibility is retained.
- Stream payload no longer forcefully appends an invalid `[DONE]` terminator, fixing stream parsing issues with tools like Cline.
- Account Exhaustion (429) logic improved safely across endpoints to properly distinguish between real quota exhaustion vs rate limit (RPM bursts). Allows rate limited accounts to simply retry later instead of getting locked out.

### Changed
- Incremented package version to `0.1.7`.

## [0.1.5] - 2026-02-21

### Added
- Google One AI Pro account detection. The system now automatically detects and visually labels accounts that have an active Gemini Code Assist Google One AI Pro subscription directly within the admin dashboard.
- Account tier verification via the `v1internal:loadCodeAssist` API during account creation and background refresh.
- A "PRO" badge indicator in the Accounts table and the Overview dashboard for eligible instances.

### Changed
- Refactored `src/services/gemini.ts` to include `checkAccountTier` which queries the API for specific tier levels.
- Updated both `firebase.ts` and `localDb.ts` to save and serve `isPro` status along with individual account objects and system-wide stats.
- Updated `public/admin.js` to render the `badge-pro` dynamically during lazy loading and stats rendering.
- Incremented package version to `0.1.5`.
