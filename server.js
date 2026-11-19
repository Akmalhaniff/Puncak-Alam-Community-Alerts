import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, timingSafeEqual } from 'crypto';
import { db, ensureSchema } from './src/db/index.ts';
import { reportPhotos, reports, users } from './src/db/schema.ts';
import { desc, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import { adminAuth } from './src/lib/firebase-admin.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
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
  '/': 'index.html',
  '/index.html': 'index.html',
  '/firebase-applet-config.json': 'firebase-applet-config.json',
  '/admin': 'admin.html',
  '/favicon.ico': 'favicon.ico',
};
for (const [route, file] of Object.entries(PUBLIC_FILES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, file)));
}

// ---------- helpers ----------

const TYPES = new Set(['flood', 'road', 'weather']);
const STATUSES = new Set(['danger', 'uncertain', 'clear']);
// Generous box around Puncak Alam / Kuala Selangor so pins can't be dropped on the other side of the world.
const BOUNDS = { minLat: 2.9, maxLat: 3.6, minLng: 101.1, maxLng: 101.8 };

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function validateReport(body) {
  const type = body?.type;
  const status = body?.status;
  const area = cleanText(body?.area, 70);
  const details = cleanText(body?.details, 240);
  const who = cleanText(body?.who, 40);
  if (!TYPES.has(type)) return { error: 'Invalid report type.' };
  if (!STATUSES.has(status)) return { error: 'Invalid status.' };
  if (!area) return { error: 'Area is required.' };
  if (!details) return { error: 'Details are required.' };

  let lat = null;
  let lng = null;
  if (body.lat != null && body.lng != null) {
    lat = Number(body.lat);
    lng = Number(body.lng);
    const inBounds = Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng;
    if (!inBounds) return { error: 'Map point must be in the Puncak Alam area.' };
  }
  return { value: { type, status, area, details, who, lat, lng, approximate: lat == null } };
}

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

// ---------- photos ----------

const PHOTO_LIMITS = { thumb: 80 * 1024, full: 500 * 1024 };

// Removes metadata segments (EXIF incl. GPS location, XMP, IPTC, comments) from a JPEG; keeps the image data.
// Returns null if the bytes aren't a well-formed JPEG.
function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) { // start of scan / end of image: the rest is image data
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

function decodeJpegDataUrl(value, maxBytes) {
  if (typeof value !== 'string') return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64');
  if (!raw.length || raw.length > maxBytes) return null;
  return stripJpegMetadata(raw);
}

// photo: { thumb, full } as JPEG data URLs (the page compresses them before upload).
function parsePhoto(photo) {
  if (photo == null) return { value: null };
  const thumb = decodeJpegDataUrl(photo.thumb, PHOTO_LIMITS.thumb);
  const full = decodeJpegDataUrl(photo.full, PHOTO_LIMITS.full);
  if (!thumb || !full) return { error: 'Photo must be a JPEG under 500 KB. Please try another photo.' };
  return { value: { thumb, full } };
}

// ---------- retention ----------

// Reports (and their photos, via ON DELETE CASCADE) are deleted automatically after this many days.
const RETENTION_DAYS = 7;

async function deleteExpiredReports() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
    const removed = await db.delete(reports).where(lt(reports.time, cutoff)).returning({ id: reports.id });
    if (removed.length) console.log(`Auto-clear: deleted ${removed.length} report(s) older than ${RETENTION_DAYS} days.`);
  } catch (err) {
    console.warn('Auto-clear failed (will retry next hour):', err.cause?.message || err.message);
  }
}

// Set up tables, then start the hourly auto-clear. Retries while the database wakes up (Neon's free tier sleeps when idle).
async function prepareDatabase(attempt = 1) {
  try {
    await ensureSchema();
    console.log('Database ready.');
    await deleteExpiredReports();
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
    const allReports = await db.select({
      ...getTableColumns(reports),
      hasPhoto: sql`exists (select 1 from report_photos p where p.report_id = ${reports.id})`.mapWith(Boolean),
    }).from(reports).orderBy(desc(reports.time)).limit(500);
    res.json(allReports);
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
      .from(reportPhotos).where(eq(reportPhotos.reportId, id)).limit(1);
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
      return { ...row, hasPhoto: !!photo.value };
    });
    res.status(201).json(created);
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
    const [{ count, photos, size }] = await db.select({
      count: sql`count(*)::int`,
      photos: sql`(select count(*)::int from report_photos)`,
      size: sql`pg_database_size(current_database())::bigint`.mapWith(Number),
    }).from(reports);
    res.json({ db: { ok: true, ms: Date.now() - started, reports: count, photos, sizeMB: Math.round(size / 1048576 * 10) / 10, retentionDays: RETENTION_DAYS } });
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

// Any other page path falls back to the app.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
