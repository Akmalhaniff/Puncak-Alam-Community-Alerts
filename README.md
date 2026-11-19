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
- **Water level**: flood reports can say ankle, knee, waist, or cars under water (tap an icon).
- **Use my location**: fills the report's map point from the phone's GPS.
- **I see it too (+1)**: one vote per person per report, so neighbours can confirm a report.
- **Share on WhatsApp**: each report has a share button with a link that opens that report on the map (`/?r=<id>`).
- **Rain radar**: optional overlay from [RainViewer](https://www.rainviewer.com/) (free for small community use; credited on the map).
- **Install as an app**: web app manifest, icons and a service worker (`sw.js`). Android/desktop show an install button; iPhone shows how to "Add to Home Screen".
- **Flood alerts near me**: push notifications when a flood is reported within 2, 5 or 10 km of a chosen spot. On iPhone this works from the installed app (iOS 16.4+).
- **Report a problem (🚩)**: anyone can flag a wrong, fake or unsuitable report. After 3 different people flag it, the report and its photo are hidden until the admin checks it (Admin → Reports → 🚩 Flagged → Keep or Delete).
- **Link previews**: shared links show a proper preview in WhatsApp; a report link (`/?r=<id>`) shows that report's title, water level and photo.
- **Hotspots**: the flood-prone spots on the map live in the database and are edited in Admin → Hotspots (paste a Google Maps link to fill in the location).
- **Shared cache**: the report list is cached for 30 seconds on the server, so many viewers cost the database the same as one and Neon's free compute can sleep.
- **Spam limits**: the server checks every report (known types and statuses only, length limits, map point must be near Puncak Alam). Each connection can post at most 5 reports or "now clear" updates per 10 minutes.

## Admin page

Open `/admin` (an **Admin** link appears in the header when the admin is signed in). It shows:

- **Overview**: database status, report counts, active floods in the last 24 hours, and user count.
- **Reports**: search and filter every report, edit type/status/text, delete one or many at once.
- **Users**: everyone who has signed in, with their report count; delete all reports from one user.
- **Maintenance**: the exact database error if Cloud SQL is unreachable, and bulk-delete reports older than N days.

Every `/api/admin/*` endpoint checks the admin's Google sign-in on the server; the page itself holds no special access.

## Database setup (free, with Neon)

1. Create a free account at [neon.tech](https://neon.tech) and a project in the **Singapore** region (`aws-ap-southeast-1`, closest to Malaysia; queries are ~15 ms instead of ~240 ms from the US).
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
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | For flood alerts | Web-push keys (`npx web-push generate-vapid-keys`). Without them the alerts button is hidden |
| `DATABASE_URL` | Yes (or the `SQL_*` set below) | Postgres connection string, e.g. Neon's *pooled* connection string ending in `?sslmode=require` |
| `SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME` | Only without `DATABASE_URL` | Separate connection settings (the original Cloud SQL setup) |
| `PORT` | No (default `3000`) | Port to listen on; set automatically by Cloud Run and most hosts |

Firebase project settings come from `firebase-applet-config.json`. These are public web-app values, not secrets.

## Tests

```sh
npm test
```

Runs unit tests and API tests against the real server with an in-memory Postgres ([PGlite](https://pglite.dev/)), so no database account is needed. GitHub Actions runs the same on every push and pull request (`.github/workflows/ci.yml`).

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/reports` | Latest 500 reports, newest first |
| `POST` | `/api/reports` | Create a report. Rate-limited; a sign-in token is optional |
| `POST` | `/api/reports/:id/clear` | Post a "now clear" follow-up. Rate-limited |
| `DELETE` | `/api/reports/:id` | Author or the admin only; requires a sign-in token |
| `POST` | `/api/reports/:id/confirm` | "I see it too" (one per person) |
| `POST` | `/api/reports/:id/flag` | Report a problem (one per person; 3 hide the report) |
| `GET` | `/api/hotspots` | Flood-prone spots shown on the map |
| `GET` | `/api/me` | The signed-in user's id and admin flag |

The server only serves `index.html` and `firebase-applet-config.json` to browsers. Server code, `src/` and `node_modules/` are never exposed.

## Map data

Map tiles © [OpenFreeMap](https://openfreemap.org/), © [OpenMapTiles](https://openmaptiles.org/), data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Report pins are approximate unless the reporter picked an exact point.
