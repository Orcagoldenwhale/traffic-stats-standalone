# Changelog

## v1.3 — 2026-05-19 — Data Safety & DevOps

### Fixed
- **BAN campaigns retain last metrics** — campaigns with BAN status no longer lose their cached data. Google Sheets polling is skipped (as intended), but the last successfully read metrics are preserved and visible in the dashboard.

### Added
- **Automated S3 backups** — daily backup of `saved_sessions/` to Timeweb S3 (cron 22:30 UTC), 30 local archives retained. Telegram alert on failure.
- **Safe deploy script** (`scripts/deploy.sh`) — pre-deploy backup → git pull → npm install → PM2 restart → health check with automatic rollback on failure.
- **Backup script** (`scripts/backup.sh`) — standalone backup to S3, used by deploy and cron.

### Changed
- `.gitignore` — expanded to exclude all runtime data, campaign configs, snapshots, analytics, and `.bak` files.
- GitHub repo synced with production server as source of truth.

---

## v1.2 — 2026-05 — Traffic Admin & Campaign Statuses

### Added
- **Traffic Admin page** (`traffic-admin.html`) — separate dashboard for admin-level campaign management.
- **Campaign status system** — four statuses: WARMUP, VERIF, LIVE, BAN with color-coded badges.
- **Move campaigns** between traffic and admin dashboards.
- **Cost alerts** — Telegram notification when campaign spend exceeds threshold.
- **Keyword alerts** — Telegram notification for secondary keywords with >$15 spend.
- **Daily snapshots** — "yesterday" data saved at 21:50 UTC+1 for comparison.
- **Daily analytics** — generated at 21:55 UTC+1.
- **Currency conversion** — exchange rates from open.er-api.com, cached 6 hours.
- **Campaign fields** — costAlert, campTask, campTimer, primaryKeyword, siteUrl.

---

## v1.1 — 2026-03-19 — Reliability & UX

### Added
- **Version label** — `v1.1` displayed next to TRAFFIC_STATS logo.
- **Mutation guard** — `mutationVersion` ref prevents background polling from overwriting local reorder/comment changes (race condition fix).
- **Debounced auto-save for comments** — comments save automatically 800ms after typing (not only on blur). Spinner indicator shows save in progress.
- **`keepalive: true`** on reorder and comment fetch requests — ensures save completes even if user refreshes the page.

### Fixed
- **Reorder not persisting after refresh** — race condition where an in-flight `fetchDashboardData` would overwrite local reorder and consume the server timestamp, preventing corrective re-fetch.
- **Deduplicated config names** in reorder payload — `[...new Set()]` prevents duplicate configs if multiple campaigns share a sheet.

---

## 2026-03-19 — Logging, Reliability, Documentation

### Added
- **Audit log** — all data mutations (save, delete, restore, refresh, reorder, patch) are now logged to `saved_sessions/_audit.log` in JSONL format. Each entry records UTC timestamp, action type, data target, client IP, and a human-readable summary. Log auto-rotates at 2 MB with up to 3 archives.
- **README.md** — full project documentation: stack, structure, API reference, data safety mechanisms, deployment guide.
- **CHANGELOG.md** — this file.

### Fixed
- **UTC timezone marker** — `sheetLastUpdated` from Google Sheets metadata is now normalized with a `Z` suffix (`2026-03-19T12:00:00Z` instead of `2026-03-19T12:00:00`). This fixes inconsistent "table not updated" warnings across browsers in different timezones.
- **Traffic data cache validation** — `GET /api/traffic-data` now validates JSON before sending. Corrupted cache files return a safe empty response instead of broken JSON.

### Changed
- `.gitignore` — added `saved_sessions/_audit.log*` to exclude audit logs from version control.

## 2026-03-19 — Initial Release

- Express API server with file-based JSON storage
- React SPA frontend (CDN-loaded, single HTML file)
- Background worker fetching Google Sheets campaign data every 60 minutes
- Atomic writes (temp file + rename) for all data mutations
- Backup system: 20 timestamped backups per file with auto-pruning
- Conflict detection via version timestamps
- Backup restore API with reversible restore
- Campaign CRUD: add, edit, delete, reorder
- Chessboard (traffic grid) management
- Asset manager (landings & accounts)
- Session save/load system
