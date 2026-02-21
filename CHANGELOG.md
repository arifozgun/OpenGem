# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
