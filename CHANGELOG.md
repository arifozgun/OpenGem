# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-02-21

### Added
- Tools support (`tools`, `toolConfig`, `tool_config`) added to Gemini API payload construction.
- Request detail logs now properly format tool calls (`functionCall` and `functionResponse`) within the question text.
- Modified JSON body payload limit in Express to support huge payloads up to `50mb`.

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
