// API tests: the real server against an in-memory Postgres. No network or accounts needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as webpush from 'web-push';
import { startApp, spawnServer } from './helpers.js';

const vapid = webpush.generateVAPIDKeys();
let app;
before(async () => { app = await startApp({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }); });
after(async () => { await app?.stop(); });

const flood = (extra = {}) => ({ type: 'flood', status: 'danger', area: 'TEST Depan Proton', details: 'Air naik', lat: 3.2409, lng: 101.4414, ...extra });
const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0c, ...Buffer.from('Exif\0\0GPS!'), 0xff, 0xda, 0x00, 0x04, 1, 2, 3, 0xff, 0xd9]).toString('base64');
let ipCounter = 1;
const freshIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

test('serves only the public files, never the code', async () => {
  for (const p of ['/', '/admin', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/og-image.png']) {
    assert.equal((await app.api('GET', p)).status, 200, p);
  }
  for (const p of ['/server.js', '/package.json', '/src/db/schema.ts', '/.env.local']) {
    const r = await app.api('GET', p);
    assert.ok(typeof r.data === 'string' && r.data.includes('<!doctype html>'), `${p} should fall back to the page`);
    assert.ok(!r.data.includes('import express'), `${p} must not leak code`);
  }
});

test('home page has link-preview tags', async () => {
  const { data } = await app.api('GET', '/');
  assert.match(data, /<meta property="og:title" content="Amaran Banjir Puncak Alam" \/>/);
  assert.match(data, /og-image\.png/);
  assert.ok(!data.includes('<!--OG-->'));
});

test('starting hotspots are added once', async () => {
  const { status, data } = await app.api('GET', '/api/hotspots');
  assert.equal(status, 200);
  assert.ok(data.length >= 17);
  assert.ok(data.some(h => h.name.ms === 'Depan Zombie Seafood'));
});

test('creates a report with water level and a photo (EXIF removed)', async () => {
  const ip = freshIp();
  const { status, data } = await app.api('POST', '/api/reports', { ip, body: flood({ waterLevel: 'knee', photo: { thumb: tinyJpeg, full: tinyJpeg } }) });
  assert.equal(status, 201);
  assert.equal(data.waterLevel, 'knee');
  assert.equal(data.hasPhoto, true);
  const photo = await fetch(`${app.base}/api/reports/${data.id}/photo?size=full`);
  assert.equal(photo.status, 200);
  const bytes = Buffer.from(await photo.arrayBuffer());
  assert.ok(!bytes.includes(Buffer.from('GPS!')), 'GPS data must be stripped');
});

test('rejects bad reports with clear messages', async () => {
  const ip = freshIp();
  assert.equal((await app.api('POST', '/api/reports', { ip, body: flood({ waterLevel: 'ocean' }) })).data.error, 'Invalid water level.');
  assert.equal((await app.api('POST', '/api/reports', { ip, body: flood({ lat: 1, lng: 1 }) })).data.error, 'Map point must be in the Puncak Alam area.');
  assert.equal((await app.api('POST', '/api/reports', { ip, body: flood({ photo: { thumb: 'data:image/png;base64,AA', full: tinyJpeg } }) })).status, 400);
});

test('limits each connection to 5 posts per 10 minutes', async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) assert.equal((await app.api('POST', '/api/reports', { ip, body: flood() })).status, 201);
  assert.equal((await app.api('POST', '/api/reports', { ip, body: flood() })).status, 429);
});

test('"I see it too" counts one vote per person', async () => {
  const { data: r } = await app.api('POST', '/api/reports', { ip: freshIp(), body: flood() });
  const a = freshIp(), b = freshIp();
  assert.equal((await app.api('POST', `/api/reports/${r.id}/confirm`, { ip: a })).data.confirmCount, 1);
  assert.equal((await app.api('POST', `/api/reports/${r.id}/confirm`, { ip: a })).data.confirmCount, 1);
  assert.equal((await app.api('POST', `/api/reports/${r.id}/confirm`, { ip: b })).data.confirmCount, 2);
});

test('three different people flagging hides a report and its photo; one person cannot do it alone', async () => {
  const { data: r } = await app.api('POST', '/api/reports', { ip: freshIp(), body: flood({ area: 'TEST flag me', photo: { thumb: tinyJpeg, full: tinyJpeg } }) });
  const visible = async () => (await app.api('GET', '/api/reports')).data.some(x => x.id === r.id);
  const solo = freshIp();
  for (let i = 0; i < 3; i++) await app.api('POST', `/api/reports/${r.id}/flag`, { ip: solo });
  assert.ok(await visible(), 'one person flagging repeatedly must not hide it');
  await app.api('POST', `/api/reports/${r.id}/flag`, { ip: freshIp() });
  await app.api('POST', `/api/reports/${r.id}/flag`, { ip: freshIp() });
  assert.ok(!(await visible()), 'hidden after 3 different people flag it');
  assert.equal((await fetch(`${app.base}/api/reports/${r.id}/photo`)).status, 404);
  // The admin "keeps" it: flags cleared, visible again (done directly here; the admin API needs a Google sign-in).
  await app.sql('update reports set reviewed = true where id = $1', [r.id]);
  await app.sql('delete from report_flags where report_id = $1', [r.id]);
  await app.api('POST', `/api/reports/${r.id}/confirm`, { ip: freshIp() }); // any write refreshes the cache
  assert.ok(await visible());
});

test('a shared report link has its own preview', async () => {
  const { data: r } = await app.api('POST', '/api/reports', { ip: freshIp(), body: flood({ area: 'TEST preview spot', waterLevel: 'waist' }) });
  const { data } = await app.api('GET', `/?r=${r.id}`);
  assert.match(data, /og:title" content="⚠️ Banjir: TEST preview spot · paras pinggang"/);
  assert.match(data, new RegExp(`og:url" content="http://127.0.0.1:\\d+/\\?r=${r.id}"`));
});

test('link previews use the public address, never an internal one', async () => {
  // Behind a proxy that forwards the public host.
  const fwd = await app.api('GET', '/', { headers: { 'x-forwarded-host': 'banjir.example', 'x-forwarded-proto': 'https' } });
  assert.match(fwd.data, /og:image" content="https:\/\/banjir\.example\/icons\/og-image\.png"/);
  // Behind a proxy that hides it (like AI Studio): falls back to PUBLIC_URL.
  const hidden = await spawnServer(app.dbUrl, { PUBLIC_URL: 'https://public.example/' });
  try {
    const html = await (await fetch(hidden.base + '/')).text();
    assert.match(html, /og:image" content="https:\/\/public\.example\/icons\/og-image\.png"/);
    assert.ok(!html.includes('127.0.0.1'));
  } finally {
    hidden.stop();
  }
});

test('report list is cached for 30 seconds and refreshed after changes', async () => {
  const before = (await app.api('GET', '/api/reports')).data.length;
  await app.sql("insert into reports(type,status,area,details,who) values('flood','danger','TEST direct','x','x')");
  assert.equal((await app.api('GET', '/api/reports')).data.length, before, 'served from cache');
  await app.api('POST', '/api/reports', { ip: freshIp(), body: flood() }); // a write clears the cache
  assert.equal((await app.api('GET', '/api/reports')).data.length, before + 2);
});

test('admin endpoints need the admin sign-in', async () => {
  for (const [m, p] of [['GET', '/api/admin/health'], ['GET', '/api/admin/reports'], ['GET', '/api/admin/hotspots'], ['POST', '/api/admin/hotspots'], ['POST', '/api/admin/reports/1/keep']]) {
    assert.equal((await app.api(m, p, { body: m === 'POST' ? {} : undefined })).status, 401, `${m} ${p}`);
  }
  assert.equal((await app.api('GET', '/api/admin/health', { headers: { authorization: 'Bearer fake' } })).status, 401);
});

test('flood alert sign-up checks its input', async () => {
  assert.equal((await app.api('GET', '/api/push/key')).data.publicKey, vapid.publicKey);
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) } };
  assert.equal((await app.api('POST', '/api/push/subscribe', { ip: freshIp(), body: { subscription: sub, lat: 3.2, lng: 101.43, radiusKm: 5 } })).status, 201);
  assert.equal((await app.api('POST', '/api/push/subscribe', { ip: freshIp(), body: { subscription: sub, lat: 3.2, lng: 101.43, radiusKm: 7 } })).status, 400);
  assert.equal((await app.api('POST', '/api/push/subscribe', { ip: freshIp(), body: { subscription: { endpoint: 'http://insecure' }, lat: 3.2, lng: 101.43, radiusKm: 5 } })).status, 400);
  assert.equal((await app.api('POST', '/api/push/unsubscribe', { body: { endpoint: sub.endpoint } })).status, 200);
});

test('reports (and their photos) older than 7 days are deleted automatically', async () => {
  const old = await app.sql("insert into reports(type,status,area,details,who,time) values('flood','danger','TEST 8 days','x','x', now() - interval '8 days') returning id");
  await app.sql("insert into report_photos(report_id,mime,thumb,full_image,bytes) values($1,'image/jpeg',$2,$2,2)", [old.rows[0].id, Buffer.from([0xff, 0xd8])]);
  await app.sql("insert into reports(type,status,area,details,who,time) values('flood','danger','TEST 6 days','x','x', now() - interval '6 days')");
  // The clean-up runs when a server starts (and hourly after that): start a second server on the same database.
  const second = await spawnServer(app.dbUrl);
  try {
    const areas = (await app.sql("select area from reports where area like 'TEST % days'")).rows.map(r => r.area);
    assert.deepEqual(areas, ['TEST 6 days']);
    assert.equal((await app.sql('select count(*)::int n from report_photos where report_id = $1', [old.rows[0].id])).rows[0].n, 0);
    assert.match(second.log(), /Auto-clear: deleted 1 report/);
  } finally {
    second.stop();
  }
});
