# Traffic Stats Standalone

Dashboard for monitoring Google Ads campaign statistics pulled from Google Sheets.

## Stack

- **Backend:** Node.js 20+, Express
- **Frontend:** React 18 (CDN), Tailwind CSS (CDN), Babel in-browser
- **Data storage:** JSON files on disk (`saved_sessions/`)
- **Process manager:** PM2 (production)

## Quick Start

```bash
npm install
npm start          # production: serves on port 3001
npm run dev        # development: server + vite dev server
```

The app is available at `http://localhost:3001`. The root URL redirects to `/traffic.html`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3001`  | HTTP port   |

## Project Structure

```
server.js                  Express API + background worker
public/traffic.html        Main SPA (React via CDN)
saved_sessions/            Data directory (auto-created)
  _traffic.json            Campaign config (Google Sheet URLs)
  _traffic_data.json       Cached campaign data (auto-refreshed)
  _current_data.json       Active workspace data
  _chessboard.json         Traffic grid data
  _assets.json             Landings & accounts
  _audit.log               Append-only audit log (JSONL)
  backups/                 Timestamped backups (20 per file)
  *.json                   Saved sessions
```

## API Endpoints

### Status
- `GET /api/status` — sync timestamps for all data types

### Current Data
- `GET /api/data` — read active workspace
- `POST /api/data?version=N` — save (conflict detection via version)
- `DELETE /api/data` — clear

### Sessions
- `GET /api/sessions` — list all saved sessions
- `POST /api/sessions` — save/update session (requires `id` in body)
- `DELETE /api/sessions/:id` — delete session

### Chessboard (Traffic Grid)
- `GET /api/chessboard` — read grid data
- `POST /api/chessboard?version=N` — save (array, conflict detection)
- `DELETE /api/chessboard` — clear

### Assets
- `GET /api/assets` — read landings & accounts
- `POST /api/assets?version=N` — save (object, conflict detection)
- `DELETE /api/assets` — clear

### Traffic Config
- `GET /api/traffic` — list campaign configs
- `POST /api/traffic?version=N` — save all configs (array)
- `DELETE /api/traffic/:name` — delete single campaign
- `PATCH /api/traffic/:name` — update campaign properties
- `PUT /api/traffic/reorder` — reorder campaigns (`{ names: [...] }`)

### Traffic Data
- `GET /api/traffic-data` — cached campaign stats from Google Sheets
- `POST /api/traffic/refresh` — force re-fetch from Google Sheets

### Backups
- `GET /api/backups` — list all backups
- `POST /api/backups/restore` — restore a backup (`{ file: "..." }`)

## Data Safety

### Atomic Writes
Every file mutation uses a write-to-temp + rename pattern to prevent partial writes on crash.

### Backup System
Before every overwrite, a timestamped copy is saved in `saved_sessions/backups/`. Up to 20 backups per file are retained; older ones are pruned automatically. Restoring a backup also creates a backup of the current state first (reversible restore).

### Conflict Detection
POST endpoints accept a `?version=N` query parameter. If the server's version is newer, a `409 Conflict` response is returned, preventing data loss from concurrent tab edits.

### Audit Log
All mutations (save, delete, restore, refresh, reorder, patch) are logged to `saved_sessions/_audit.log` in JSONL format with timestamp, action, target, client IP, and summary. The log auto-rotates at 2 MB, keeping up to 3 archives.

## Background Worker

`refreshTrafficData()` fetches campaign stats and search terms from Google Sheets via CSV export:
- Runs 3 seconds after server start
- Repeats every 60 minutes
- Also triggers immediately on config changes (save/delete/patch/reorder)
- Results cached in `_traffic_data.json`

## Deployment (VDS + PM2)

```bash
# On the server
cd /var/www/traffic-stats-standalone
git pull
npm install --production
pm2 restart traffic-stats

# First-time setup
pm2 start server.js --name traffic-stats
pm2 startup
pm2 save
```

The server listens on `0.0.0.0:3001`. For HTTPS, configure Nginx reverse proxy to forward traffic from port 80/443 to 3001.
