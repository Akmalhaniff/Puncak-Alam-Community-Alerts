# Puncak Alam Community Alerts

A community map for sharing flood, heavy-rain, and road-condition observations around Puncak Alam.

Residents pin a report on the map with the area, what they're seeing, and when. Everyone sees the same board, and it refreshes every minute.

> These are community observations, not official alerts. Never drive or walk through floodwater. For immediate danger in Malaysia, call **999**.

## Features

- **Map**: [MapLibre GL JS](https://maplibre.org/) with free [OpenFreeMap](https://openfreemap.org/) tiles. No API key and no usage limits.
- **Reports**: flood, road, or rain updates, with an optional exact map point. Reports are stored in PostgreSQL via Drizzle ORM. Any Postgres works; the free tier of [Neon](https://neon.tech) is recommended.
- **Now clear**: anyone can mark a flood or road report as passable. This posts a follow-up "clear" report, and the original is shown as *later reported clear* and taken off the map.
- **Freshness**: reports older than 2 hours fade. Reports older than 24 hours are hidden behind a "Show older reports" button.
- **Google Sign-In (optional)**: signed-in reports show a ✓ and always use the poster's Google name. Signed-in users can remove their own reports.
- **Admin**: one admin account, fixed in `server.js` (`ADMIN_EMAIL_SHA256`), can remove any report. It is matched by a SHA-256 fingerprint of a verified Google email, so it can't be changed through settings and the email isn't stored in the repo.
- **Spam limits**: the server checks every report (known types and statuses only, length limits, map point must be near Puncak Alam). Each connection can post at most 5 reports or "now clear" updates per 10 minutes.

## Admin page

Open `/admin` (an **Admin** link appears in the header when the admin is signed in). It shows:

- **Overview**: database status, report counts, active floods in the last 24 hours, and user count.
- **Reports**: search and filter every report, edit type/status/text, delete one or many at once.
- **Users**: everyone who has signed in, with their report count; delete all reports from one user.
- **Maintenance**: the exact database error if Cloud SQL is unreachable, and bulk-delete reports older than N days.

Every `/api/admin/*` endpoint checks the admin's Google sign-in on the server; the page itself holds no special access.

## Database setup (free, with Neon)

1. Create a free account at [neon.tech](https://neon.tech) and a project in the **Singapore** region (closest to Malaysia).
2. Copy the **pooled** connection string from the dashboard (*Connect* → enable *Connection pooling*).
3. Set it as the `DATABASE_URL` secret/environment variable and restart the app.

On start-up the server creates the tables if they don't exist and adds a few sample reports, so a brand-new database needs no extra steps. Neon's free tier sleeps when idle; the first request after a quiet period takes a second or two longer.

## Running

Requires Node.js 22.18 or newer, because the server imports TypeScript files directly.

```sh
npm install
npm start
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes (or the `SQL_*` set below) | Postgres connection string, e.g. Neon's *pooled* connection string ending in `?sslmode=require` |
| `SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME` | Only without `DATABASE_URL` | Separate connection settings (the original Cloud SQL setup) |
| `PORT` | No (default `3000`) | Port to listen on; set automatically by Cloud Run and most hosts |

Firebase project settings come from `firebase-applet-config.json`. These are public web-app values, not secrets.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/reports` | Latest 500 reports, newest first |
| `POST` | `/api/reports` | Create a report. Rate-limited; a sign-in token is optional |
| `POST` | `/api/reports/:id/clear` | Post a "now clear" follow-up. Rate-limited |
| `DELETE` | `/api/reports/:id` | Author or the admin only; requires a sign-in token |
| `GET` | `/api/me` | The signed-in user's id and admin flag |

The server only serves `index.html` and `firebase-applet-config.json` to browsers. Server code, `src/` and `node_modules/` are never exposed.

## Map data

Map tiles © [OpenFreeMap](https://openfreemap.org/), © [OpenMapTiles](https://openmaptiles.org/), data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Report pins are approximate unless the reporter picked an exact point.
