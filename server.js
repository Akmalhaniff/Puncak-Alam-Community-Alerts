import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, timingSafeEqual } from 'crypto';
import { db, ensureSchema } from './src/db/index.ts';
import { hotspots, pushSubscriptions, reportConfirmations, reportFlags, reportPhotos, reports, users } from './src/db/schema.ts';
import { asc, desc, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import { adminAuth } from './src/lib/firebase-admin.ts';
import * as webpush from 'web-push';
import fs from 'fs';
import { STATUSES, TYPES, cleanText, inBounds, validateHotspot, validateReport } from './src/lib/validation.js';
import { parsePhoto } from './src/lib/photos.js';
import { coordsFromGoogleMapsUrl, distanceKm, isAllowedMapsLink } from './src/lib/geo.js';
import { metaTags, previewFor } from './src/lib/og.js';
import { HOTSPOT_SEED } from './src/lib/hotspots-seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// PORT=0 means "any free port" (used by the tests); empty or unset means 3000.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = '0.0.0.0';

// The one admin account, fixed in code so it can't be changed through settings or the API.
// Stored as a SHA-256 fingerprint of the admin's verified Google email (lowercased),
// so the email address itself never appears in the repository.
const ADMIN_EMAIL_SHA256 = 'c7a6c722479da7e171185723ab6ef8b56aac1119721d4bb6fd67427f542d83ee';

// Cloud Run and most hosts sit behind exactly one proxy; this makes req.ip the real client IP.
app.set('trust proxy', 1);
const smallJson = express.json({ limit: '10kb' });
const reportJson = express.json({ limit: '800kb' });
app.use((req, res, next) => (req.method === 'POST' && req.path === '/api/reports' ? reportJson : smallJson)(req, res, next));

// Only serve the files the browser needs — never the server code, src/ or node_modules.
const PUBLIC_FILES = {
  '/firebase-applet-config.json': 'firebase-applet-config.json',
  '/admin': 'admin.html',
  '/favicon.ico': 'favicon.ico',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js': 'sw.js',
  '/icons/icon-192.png': 'icons/icon-192.png',
  '/icons/icon-512.png': 'icons/icon-512.png',
  '/icons/maskable-512.png': 'icons/maskable-512.png',
  '/icons/apple-touch-icon.png': 'icons/apple-touch-icon.png',
  '/icons/og-image.png': 'icons/og-image.png',
};
for (const [route, file] of Object.entries(PUBLIC_FILES)) {
  app.get(route, (_req, res) => {
    // The service worker must always be fresh so app updates reach installed phones.
    if (route === '/sw.js') res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, file));
  });
}

// Any successful change through the API makes the cached report list stale.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) { invalidateReportsCache(); invalidateHotspotsCache(); } });
  next();
});

// ---------- helpers ----------

// Simple in-memory limiter: max N writes per IP per window. Resets on restart, which is fine for a community board.
const WRITE_LIMIT = 5;
const WRITE_WINDOW_MS = 10 * 60 * 1000;
const writeHits = new Map();
function rateLimitWrites(req, res, next) {
  const now = Date.now();
  const recent = (writeHits.get(req.ip) || []).filter(t => now - t < WRITE_WINDOW_MS);
  if (recent.length >= WRITE_LIMIT) {
    res.set('Retry-After', String(Math.ceil((WRITE_WINDOW_MS - (now - recent[0])) / 1000)));
    return res.status(429).json({ error: 'Too many reports from this connection. Please wait a few minutes.' });
  }
  recent.push(now);
  writeHits.set(req.ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of writeHits) {
    if (!hits.some(t => now - t < WRITE_WINDOW_MS)) writeHits.delete(ip);
  }
}, WRITE_WINDOW_MS).unref();

// Verifies the Firebase ID token (if any). Needs no database, so admin checks work even when the DB is down.
async function verifyToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return await adminAuth.verifyIdToken(header.slice(7));
  } catch (err) {
    console.warn('Auth verification failed:', err.message);
    return null;
  }
}

// Returns { decoded, dbUser }, creating the user row on first use. Null if not signed in or the DB is unavailable.
async function getSignedInUser(req) {
  const decoded = await verifyToken(req);
  if (!decoded) return null;
  try {
    let [dbUser] = await db.select().from(users).where(eq(users.uid, decoded.uid)).limit(1);
    if (!dbUser) {
      [dbUser] = await db.insert(users).values({
        uid: decoded.uid,
        email: decoded.email || 'user@community.local',
        displayName: decoded.name || null,
      }).returning();
    }
    return { decoded, dbUser };
  } catch (err) {
    console.warn('User lookup failed:', err.message);
    return null;
  }
}

// Admin only if Google has verified the email AND its fingerprint matches the admin's.
function isAdmin(signedIn) {
  const email = signedIn?.decoded.email;
  if (!email || signedIn.decoded.email_verified !== true) return false;
  const fingerprint = createHash('sha256').update(email.trim().toLowerCase()).digest();
  const expected = Buffer.from(ADMIN_EMAIL_SHA256, 'hex');
  return fingerprint.length === expected.length && timingSafeEqual(fingerprint, expected);
}

// Signed-in posters always appear under their Google name, so nobody can post as them.
function posterName(signedIn, typedName) {
  if (signedIn) return cleanText(signedIn.decoded.name || signedIn.decoded.email?.split('@')[0] || '', 40) || 'Community member';
  return typedName || 'Community member';
}

// ---------- report list cache ----------
// Every open page refreshes the list each minute. Serving one shared copy for 30 seconds means the
// database is asked at most twice a minute however many people are watching, so Neon's free compute
// can still sleep when nobody is using the site and the monthly allowance isn't burned during a flood.
const REPORTS_CACHE_MS = 30 * 1000;
let reportsCache = null; // { at, data }
let reportsInFlight = null;
function invalidateReportsCache() { reportsCache = null; }

async function loadReports() {
  return db.select({
    ...getTableColumns(reports),
    hasPhoto: sql`exists (select 1 from report_photos p where p.report_id = ${reports.id})`.mapWith(Boolean),
    confirmCount: sql`(select count(*)::int from report_confirmations c where c.report_id = ${reports.id})`.mapWith(Number),
  }).from(reports).where(sql`not ${isHidden}`).orderBy(desc(reports.time)).limit(500);
}
async function getReportsCached() {
  if (reportsCache && Date.now() - reportsCache.at < REPORTS_CACHE_MS) return reportsCache.data;
  if (!reportsInFlight) {
    reportsInFlight = loadReports()
      .then(data => { reportsCache = { at: Date.now(), data }; return data; })
      .finally(() => { reportsInFlight = null; });
  }
  return reportsInFlight;
}

// ---------- "I see it too" confirmations ----------
// One vote per person per report: the Google account when signed in, otherwise a salted hash of the
// connection (the raw IP is never stored).
const VOTER_SALT = process.env.VOTER_SALT || ADMIN_EMAIL_SHA256;
const voterKey = (req, decoded) => decoded ? `u:${decoded.uid}` : `ip:${createHash('sha256').update(VOTER_SALT + req.ip).digest('hex').slice(0, 32)}`;

const CONFIRM_LIMIT = 30;
const confirmHits = new Map();
function rateLimitConfirms(req, res, next) {
  const now = Date.now();
  const recent = (confirmHits.get(req.ip) || []).filter(t => now - t < WRITE_WINDOW_MS);
  if (recent.length >= CONFIRM_LIMIT) return res.status(429).json({ error: 'Too many reports from this connection. Please wait a few minutes.' });
  recent.push(now);
  confirmHits.set(req.ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of confirmHits) if (!hits.some(t => now - t < WRITE_WINDOW_MS)) confirmHits.delete(ip);
}, WRITE_WINDOW_MS).unref();

// ---------- rain radar (RainViewer, free for small community use; credit shown on the map) ----------
const RADAR_CACHE_MS = 5 * 60 * 1000;
let radarCache = null;
async function getRadarFrame() {
  if (radarCache && Date.now() - radarCache.at < RADAR_CACHE_MS) return radarCache.data;
  const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
  const json = await res.json();
  const latest = json?.radar?.past?.at(-1);
  if (!latest || typeof json.host !== 'string' || typeof latest.path !== 'string') throw new Error('Unexpected RainViewer response');
  const data = { tiles: `${json.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`, time: latest.time * 1000 };
  radarCache = { at: Date.now(), data };
  return data;
}

// ---------- push notifications ----------
// Needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (generate once with `npx web-push generate-vapid-keys`).
const PUSH_ENABLED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://puncak-alam-community-alerts.ai.studio',
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
const PUSH_RADII = new Set([2, 5, 10]);

const PUSH_TEXT = {
  ms: { title: '⚠️ Banjir dilapor dekat anda', level: { ankle: 'paras buku lali', knee: 'paras lutut', waist: 'paras pinggang', car: 'kereta tenggelam' } },
  en: { title: '⚠️ Flood reported near you', level: { ankle: 'ankle deep', knee: 'knee deep', waist: 'waist deep', car: 'cars submerged' } },
};

// Sends a notification about a new flood report to everyone watching an area that includes it.
async function notifyNearby(report) {
  if (!PUSH_ENABLED || report.status !== 'danger' || report.lat == null || report.lng == null) return;
  try {
    const subs = await db.select().from(pushSubscriptions);
    const targets = subs.filter(s => distanceKm(s.lat, s.lng, report.lat, report.lng) <= s.radiusKm);
    await Promise.all(targets.map(async s => {
      const text = PUSH_TEXT[s.lang] || PUSH_TEXT.ms;
      const level = report.waterLevel ? ` · ${text.level[report.waterLevel]}` : '';
      const payload = JSON.stringify({ title: text.title, body: `${report.area}${level}`, url: `/?r=${report.id}`, tag: `report-${report.id}` });
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      } catch (err) {
        // 404/410: the phone unsubscribed or the app was removed. Forget it.
        if (err.statusCode === 404 || err.statusCode === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
        else console.warn('Push failed:', err.statusCode || err.message);
      }
    }));
    if (targets.length) console.log(`Push: notified ${targets.length} subscriber(s) about report ${report.id}.`);
  } catch (err) {
    console.warn('Push notify failed:', err.message);
  }
}

// ---------- "report a problem" flags ----------
// Only signed-in Google accounts can flag, one flag per account per report. After FLAG_HIDE_THRESHOLD different
// accounts flag a report, it's hidden from the public until the admin reviews it ("Keep" un-hides it for good;
// "Delete" removes it). Photos of hidden reports aren't served. Older flags made without signing in
// (voter_key 'ip:…') are ignored.
const FLAG_HIDE_THRESHOLD = 3;
const flagCount = sql`(select count(*)::int from report_flags f where f.report_id = ${reports.id} and f.voter_key like 'u:%')`;
const isHidden = sql`(coalesce(${reports.reviewed}, false) = false and ${flagCount} >= ${FLAG_HIDE_THRESHOLD})`;

// ---------- hotspots (flood-prone spots, edited in /admin) ----------
const HOTSPOTS_CACHE_MS = 5 * 60 * 1000;
let hotspotsCache = null;
function invalidateHotspotsCache() { hotspotsCache = null; }
const hotspotJson = h => ({ id: h.id, name: { ms: h.nameMs, en: h.nameEn }, note: { ms: h.noteMs, en: h.noteEn }, lat: h.lat, lng: h.lng, days: h.days });
async function getHotspotsCached() {
  if (hotspotsCache && Date.now() - hotspotsCache.at < HOTSPOTS_CACHE_MS) return hotspotsCache.data;
  const rows = await db.select().from(hotspots).orderBy(desc(hotspots.days), asc(hotspots.id));
  const data = rows.map(hotspotJson);
  hotspotsCache = { at: Date.now(), data };
  return data;
}
async function seedHotspots() {
  const [{ n }] = await db.select({ n: sql`count(*)::int`.mapWith(Number) }).from(hotspots);
  if (n > 0) return;
  await db.insert(hotspots).values(HOTSPOT_SEED.map(h => ({
    nameMs: h.name.ms, nameEn: h.name.en, noteMs: h.note.ms, noteEn: h.note.en, lat: h.lat, lng: h.lng, days: h.days,
  })));
  console.log(`Hotspots: added ${HOTSPOT_SEED.length} starting spots.`);
}

// ---------- the page, with link previews for WhatsApp ----------
const INDEX_TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const OG_MARKER = '<!--OG-->';
// Public address for link previews. AI Studio's proxy hands the app an internal Host (localhost:3000), and
// WhatsApp needs a public image URL, so internal hosts are replaced by PUBLIC_URL. Set PUBLIC_URL to change it,
// or to an empty string to always use the request's own host.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://puncak-alam-community-alerts.ai.studio').replace(/\/+$/, '');
function siteOrigin(req) {
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const internal = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host);
  if ((internal || !host) && PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}
async function sendIndex(req, res) {
  let report = null;
  const id = Number(req.query.r);
  if (Number.isInteger(id) && id > 0) {
    try { report = (await getReportsCached()).find(r => r.id === id) || null; } catch { /* database asleep or down: plain preview */ }
  }
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(INDEX_TEMPLATE.replace(OG_MARKER, metaTags(previewFor(report, siteOrigin(req)))));
}

// ---------- retention ----------

// Reports (and their photos, via ON DELETE CASCADE) are deleted automatically after this many days.
const RETENTION_DAYS = 7;

async function deleteExpiredReports() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
    const removed = await db.delete(reports).where(lt(reports.time, cutoff)).returning({ id: reports.id });
    if (removed.length) {
      invalidateReportsCache();
      console.log(`Auto-clear: deleted ${removed.length} report(s) older than ${RETENTION_DAYS} days.`);
    }
  } catch (err) {
    console.warn('Auto-clear failed (will retry next hour):', err.cause?.message || err.message);
  }
}

// Set up tables, then start the hourly auto-clear. Retries while the database wakes up (Neon's free tier sleeps when idle).
async function prepareDatabase(attempt = 1) {
  try {
    await ensureSchema();
    await seedHotspots();
    await deleteExpiredReports();
    console.log('Database ready.');
    setInterval(deleteExpiredReports, 60 * 60 * 1000).unref();
  } catch (err) {
    const retryIn = Math.min(60, 5 * attempt);
    console.warn(`Database not ready (attempt ${attempt}): ${err.cause?.message || err.message}. Retrying in ${retryIn}s.`);
    if (attempt < 10) setTimeout(() => prepareDatabase(attempt + 1), retryIn * 1000).unref();
  }
}

setTimeout(prepareDatabase, 1000);

// ---------- API ----------

app.get('/api/reports', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getReportsCached());
  } catch (error) {
    console.error('Failed to fetch reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

app.get('/api/reports/:id/photo', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).end();
  const full = req.query.size === 'full';
  try {
    const [row] = await db.select({ mime: reportPhotos.mime, data: full ? reportPhotos.fullImage : reportPhotos.thumb })
      .from(reportPhotos).innerJoin(reports, eq(reports.id, reportPhotos.reportId))
      .where(sql`${reportPhotos.reportId} = ${id} and not ${isHidden}`).limit(1);
    if (!row) return res.status(404).end();
    res.set({
      'Content-Type': row.mime,
      'Cache-Control': `public, max-age=${RETENTION_DAYS * 86400}, immutable`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.send(row.data);
  } catch (err) {
    console.error('Failed to load photo:', err);
    res.status(500).end();
  }
});

// "Report a problem": signed-in accounts only, one flag per account per report; enough flags hide the report
// until the admin reviews it.
app.post('/api/reports/:id/flag', rateLimitConfirms, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report id.' });
  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Sign in to report a problem.' });
  try {
    const [report] = await db.select({ id: reports.id }).from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    await db.insert(reportFlags).values({ reportId: id, voterKey: voterKey(req, decoded) }).onConflictDoNothing();
    res.json({ id, flagged: true });
  } catch (err) {
    console.error('Failed to flag report:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

app.get('/api/hotspots', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await getHotspotsCached());
  } catch (err) {
    console.error('Failed to load hotspots:', err);
    res.status(500).json({ error: 'Failed to load hotspots' });
  }
});

// "I see it too": one vote per person per report.
app.post('/api/reports/:id/confirm', rateLimitConfirms, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const decoded = await verifyToken(req);
    const [report] = await db.select({ id: reports.id }).from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    await db.insert(reportConfirmations).values({ reportId: id, voterKey: voterKey(req, decoded) }).onConflictDoNothing();
    const [{ count }] = await db.select({ count: sql`count(*)::int`.mapWith(Number) }).from(reportConfirmations).where(eq(reportConfirmations.reportId, id));
    res.json({ id, confirmCount: count });
  } catch (err) {
    console.error('Failed to confirm report:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

app.get('/api/radar', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await getRadarFrame());
  } catch (err) {
    console.warn('Radar unavailable:', err.message);
    res.status(503).json({ error: 'Radar unavailable' });
  }
});

app.get('/api/push/key', (_req, res) => {
  if (!PUSH_ENABLED) return res.status(404).json({ error: 'Notifications are not set up.' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', rateLimitConfirms, async (req, res) => {
  if (!PUSH_ENABLED) return res.status(404).json({ error: 'Notifications are not set up.' });
  const sub = req.body?.subscription;
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng), radiusKm = Number(req.body?.radiusKm);
  const lang = req.body?.lang === 'en' ? 'en' : 'ms';
  const endpointOk = typeof sub?.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length <= 1000;
  const keysOk = typeof sub?.keys?.p256dh === 'string' && typeof sub?.keys?.auth === 'string' && sub.keys.p256dh.length <= 200 && sub.keys.auth.length <= 100;
  if (!endpointOk || !keysOk) return res.status(400).json({ error: 'Invalid subscription.' });
  if (!inBounds(lat, lng)) return res.status(400).json({ error: 'Map point must be in the Puncak Alam area.' });
  if (!PUSH_RADII.has(radiusKm)) return res.status(400).json({ error: 'Invalid distance.' });
  try {
    const values = { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, lat, lng, radiusKm, lang };
    await db.insert(pushSubscriptions).values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { lat, lng, radiusKm, lang, p256dh: values.p256dh, auth: values.auth } });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Failed to save subscription:', err);
    res.status(500).json({ error: 'Failed to save' });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Invalid subscription.' });
  try {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to remove subscription:', err);
    res.status(500).json({ error: 'Failed to remove' });
  }
});

// Who am I? Lets the page show "Remove" on the viewer's own reports (or all, for admins).
app.get('/api/me', async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return res.json({ signedIn: false });
  const signedIn = await getSignedInUser(req);
  res.json({ signedIn: true, userId: signedIn?.dbUser.id ?? null, isAdmin: isAdmin({ decoded }) });
});

app.post('/api/reports', rateLimitWrites, async (req, res) => {
  const { value, error } = validateReport(req.body);
  if (error) return res.status(400).json({ error });
  const photo = parsePhoto(req.body?.photo);
  if (photo.error) return res.status(400).json({ error: photo.error });
  try {
    const signedIn = await getSignedInUser(req);
    const created = await db.transaction(async tx => {
      const [row] = await tx.insert(reports).values({
        ...value,
        userId: signedIn?.dbUser.id ?? null,
        who: posterName(signedIn, value.who),
        time: new Date(),
      }).returning();
      if (photo.value) {
        await tx.insert(reportPhotos).values({
          reportId: row.id, mime: 'image/jpeg', thumb: photo.value.thumb, fullImage: photo.value.full,
          bytes: photo.value.thumb.length + photo.value.full.length,
        });
      }
      return { ...row, hasPhoto: !!photo.value, confirmCount: 0 };
    });
    res.status(201).json(created);
    notifyNearby(created); // fire-and-forget; never delays the reply
  } catch (err) {
    console.error('Failed to create report:', err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// "Now clear": posts a follow-up 'clear' report at the same spot as an earlier one.
app.post('/api/reports/:id/clear', rateLimitWrites, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const [original] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!original) return res.status(404).json({ error: 'Report not found.' });
    if (original.status === 'clear') return res.status(400).json({ error: 'That report is already clear.' });
    const signedIn = await getSignedInUser(req);
    const note = cleanText(req.body?.details, 160);
    const [created] = await db.insert(reports).values({
      type: original.type,
      status: 'clear',
      area: original.area,
      details: note || 'Now clear — a resident reported this spot passable.',
      lat: original.lat,
      lng: original.lng,
      approximate: original.approximate,
      userId: signedIn?.dbUser.id ?? null,
      who: posterName(signedIn, cleanText(req.body?.who, 40)),
      time: new Date(),
    }).returning();
    res.status(201).json(created);
  } catch (err) {
    console.error('Failed to mark report clear:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// Remove a report: its signed-in author, or the admin.
app.delete('/api/reports/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report id.' });
  const signedIn = await getSignedInUser(req);
  if (!signedIn) return res.status(401).json({ error: 'Sign in to remove reports.' });
  try {
    const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const ownsReport = report.userId != null && report.userId === signedIn.dbUser.id;
    if (!ownsReport && !isAdmin(signedIn)) {
      return res.status(403).json({ error: 'You can only remove your own reports.' });
    }
    await db.delete(reports).where(eq(reports.id, id));
    res.status(204).end();
  } catch (err) {
    console.error('Failed to remove report:', err);
    res.status(500).json({ error: 'Failed to remove report' });
  }
});

// ---------- admin API (admin account only) ----------

async function requireAdmin(req, res, next) {
  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Sign in first.' });
  if (!isAdmin({ decoded })) return res.status(403).json({ error: 'Admin only.' });
  req.admin = decoded;
  next();
}
app.use('/api/admin', requireAdmin);

const parseIds = value => (Array.isArray(value) ? value : [])
  .map(Number).filter(Number.isInteger).slice(0, 500);

// Database health: lets the admin see the real DB error instead of a generic 500.
app.get('/api/admin/health', async (_req, res) => {
  const started = Date.now();
  try {
    const [{ count, photos, subscribers, flagged, size }] = await db.select({
      count: sql`count(*)::int`,
      photos: sql`(select count(*)::int from report_photos)`,
      subscribers: sql`(select count(*)::int from push_subscriptions)`,
      flagged: sql`(select count(*)::int from reports where ${isHidden})`,
      size: sql`pg_database_size(current_database())::bigint`.mapWith(Number),
    }).from(reports);
    res.json({ db: { ok: true, ms: Date.now() - started, reports: count, photos, subscribers, flagged, pushEnabled: PUSH_ENABLED, sizeMB: Math.round(size / 1048576 * 10) / 10, retentionDays: RETENTION_DAYS } });
  } catch (err) {
    res.json({ db: { ok: false, ms: Date.now() - started, error: err.cause?.message || err.message } });
  }
});

app.get('/api/admin/reports', async (_req, res) => {
  try {
    const rows = await db.select({
      id: reports.id, type: reports.type, status: reports.status, area: reports.area,
      details: reports.details, who: reports.who, lat: reports.lat, lng: reports.lng,
      approximate: reports.approximate, time: reports.time, userId: reports.userId,
      authorEmail: users.email,
      hasPhoto: sql`exists (select 1 from report_photos p where p.report_id = ${reports.id})`.mapWith(Boolean),
      waterLevel: reports.waterLevel,
      flagCount: flagCount.mapWith(Number),
      reviewed: reports.reviewed,
      hidden: isHidden.mapWith(Boolean),
    }).from(reports).leftJoin(users, eq(reports.userId, users.id)).orderBy(desc(reports.time)).limit(2000);
    res.json(rows);
  } catch (err) {
    console.error('Admin: failed to list reports:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

app.patch('/api/admin/reports/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report id.' });
  const changes = {};
  if (req.body?.type !== undefined) {
    if (!TYPES.has(req.body.type)) return res.status(400).json({ error: 'Invalid report type.' });
    changes.type = req.body.type;
  }
  if (req.body?.status !== undefined) {
    if (!STATUSES.has(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
    changes.status = req.body.status;
  }
  for (const [field, max] of [['area', 70], ['details', 240], ['who', 40]]) {
    if (req.body?.[field] !== undefined) {
      const value = cleanText(req.body[field], max);
      if (!value) return res.status(400).json({ error: `The ${field} field can not be empty.` });
      changes[field] = value;
    }
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to change.' });
  try {
    const [updated] = await db.update(reports).set(changes).where(eq(reports.id, id)).returning();
    if (!updated) return res.status(404).json({ error: 'Report not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Admin: failed to update report:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// "Keep": the admin checked a flagged report and it's fine. Clears its flags and stops it being auto-hidden again.
app.post('/api/admin/reports/:id/keep', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const [updated] = await db.update(reports).set({ reviewed: true }).where(eq(reports.id, id)).returning({ id: reports.id });
    if (!updated) return res.status(404).json({ error: 'Report not found.' });
    await db.delete(reportFlags).where(eq(reportFlags.reportId, id));
    res.json({ id, reviewed: true });
  } catch (err) {
    console.error('Admin: failed to keep report:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

app.get('/api/admin/hotspots', async (_req, res) => {
  try {
    const rows = await db.select().from(hotspots).orderBy(desc(hotspots.days), asc(hotspots.id));
    res.json(rows);
  } catch (err) {
    console.error('Admin: failed to list hotspots:', err);
    res.status(500).json({ error: 'Failed to load hotspots' });
  }
});

app.post('/api/admin/hotspots', async (req, res) => {
  const { value, error } = validateHotspot(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const [row] = await db.insert(hotspots).values(value).returning();
    res.status(201).json(row);
  } catch (err) {
    console.error('Admin: failed to add hotspot:', err);
    res.status(500).json({ error: 'Failed to add hotspot' });
  }
});

app.put('/api/admin/hotspots/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid hotspot id.' });
  const { value, error } = validateHotspot(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const [row] = await db.update(hotspots).set({ ...value, updatedAt: new Date() }).where(eq(hotspots.id, id)).returning();
    if (!row) return res.status(404).json({ error: 'Hotspot not found.' });
    res.json(row);
  } catch (err) {
    console.error('Admin: failed to update hotspot:', err);
    res.status(500).json({ error: 'Failed to update hotspot' });
  }
});

app.delete('/api/admin/hotspots/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid hotspot id.' });
  try {
    const removed = await db.delete(hotspots).where(eq(hotspots.id, id)).returning({ id: hotspots.id });
    if (!removed.length) return res.status(404).json({ error: 'Hotspot not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('Admin: failed to delete hotspot:', err);
    res.status(500).json({ error: 'Failed to delete hotspot' });
  }
});

// Turns a pasted Google Maps link (including maps.app.goo.gl short links) into coordinates.
// Only Google Maps hosts are fetched, one redirect hop at a time, so this can't be used to fetch other sites.
app.post('/api/admin/resolve-maps-link', async (req, res) => {
  let url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!isAllowedMapsLink(url)) return res.status(400).json({ error: 'Paste a Google Maps link.' });
  try {
    for (let hop = 0; hop < 5; hop++) {
      const coords = coordsFromGoogleMapsUrl(url);
      if (coords) return res.json({ lat: coords[0], lng: coords[1] });
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const next = r.headers.get('location');
      if (!next) break;
      url = new URL(next, url).toString();
      if (!isAllowedMapsLink(url)) break;
    }
    res.status(422).json({ error: 'Couldn’t find a location in that link.' });
  } catch (err) {
    console.warn('Resolve maps link failed:', err.message);
    res.status(502).json({ error: 'Couldn’t open that link.' });
  }
});

app.post('/api/admin/reports/delete', async (req, res) => {
  const ids = parseIds(req.body?.ids);
  if (!ids.length) return res.status(400).json({ error: 'No reports selected.' });
  try {
    const removed = await db.delete(reports).where(inArray(reports.id, ids)).returning({ id: reports.id });
    res.json({ removed: removed.length });
  } catch (err) {
    console.error('Admin: failed to delete reports:', err);
    res.status(500).json({ error: 'Failed to delete reports' });
  }
});

// Delete every report older than N days (1-365).
app.post('/api/admin/reports/purge', async (req, res) => {
  const days = Number(req.body?.olderThanDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: 'Choose between 1 and 365 days.' });
  try {
    const cutoff = new Date(Date.now() - days * 86400000);
    const removed = await db.delete(reports).where(lt(reports.time, cutoff)).returning({ id: reports.id });
    res.json({ removed: removed.length });
  } catch (err) {
    console.error('Admin: failed to purge reports:', err);
    res.status(500).json({ error: 'Failed to purge reports' });
  }
});

app.get('/api/admin/users', async (_req, res) => {
  try {
    const rows = await db.select({
      id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt,
      reportCount: sql`count(${reports.id})::int`,
      lastReport: sql`max(${reports.time})`,
    }).from(users).leftJoin(reports, eq(reports.userId, users.id)).groupBy(users.id).orderBy(desc(users.createdAt));
    res.json(rows);
  } catch (err) {
    console.error('Admin: failed to list users:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Remove all reports posted by one signed-in user (e.g. a spammer).
app.post('/api/admin/users/:id/delete-reports', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id.' });
  try {
    const removed = await db.delete(reports).where(eq(reports.userId, id)).returning({ id: reports.id });
    res.json({ removed: removed.length });
  } catch (err) {
    console.error('Admin: failed to delete user reports:', err);
    res.status(500).json({ error: 'Failed to delete reports' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// The app page (with link previews); any other page path falls back to it too.
app.get(['/', '/index.html'], sendIndex);
app.get('*', sendIndex);

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${server.address().port}`);
});
