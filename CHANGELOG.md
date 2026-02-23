# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
