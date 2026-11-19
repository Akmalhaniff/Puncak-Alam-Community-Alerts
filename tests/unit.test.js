// Unit tests for the pure helpers: input rules, photo cleaning, geography, link previews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, validateHotspot, inBounds } from '../src/lib/validation.js';
import { stripJpegMetadata, parsePhoto } from '../src/lib/photos.js';
import { distanceKm, coordsFromGoogleMapsUrl, isAllowedMapsLink } from '../src/lib/geo.js';
import { previewFor, metaTags } from '../src/lib/og.js';

// A tiny well-formed JPEG: SOI, APP0 (JFIF), SOS + data, EOI.
const APP0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]);
const exifSegment = text => { const body = Buffer.from(text); const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(body.length + 2, 2); return Buffer.concat([seg, body]); };
const jpeg = (...segments) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, SCAN]);
const dataUrl = buf => `data:image/jpeg;base64,${buf.toString('base64')}`;

test('validateReport accepts a normal flood report', () => {
  const { value, error } = validateReport({ type: 'flood', status: 'danger', area: ' Depan Proton ', details: 'Air naik', lat: 3.24, lng: 101.44, waterLevel: 'knee' });
  assert.equal(error, undefined);
  assert.equal(value.area, 'Depan Proton');
  assert.equal(value.waterLevel, 'knee');
  assert.equal(value.approximate, false);
});

test('validateReport rejects bad input', () => {
  assert.equal(validateReport({ type: 'tsunami', status: 'danger', area: 'x', details: 'y' }).error, 'Invalid report type.');
  assert.equal(validateReport({ type: 'flood', status: 'gone', area: 'x', details: 'y' }).error, 'Invalid status.');
  assert.equal(validateReport({ type: 'flood', status: 'danger', area: '  ', details: 'y' }).error, 'Area is required.');
  assert.equal(validateReport({ type: 'flood', status: 'danger', area: 'x', details: 'y', waterLevel: 'ocean' }).error, 'Invalid water level.');
  assert.equal(validateReport({ type: 'flood', status: 'danger', area: 'x', details: 'y', lat: 51.5, lng: -0.1 }).error, 'Map point must be in the Puncak Alam area.');
});

test('validateReport drops water level for non-flood reports and trims long text', () => {
  const { value } = validateReport({ type: 'road', status: 'uncertain', area: 'A'.repeat(200), details: 'x', waterLevel: 'knee' });
  assert.equal(value.waterLevel, null);
  assert.equal(value.area.length, 70);
});

test('validateHotspot needs a BM name, a point in the area and whole days', () => {
  assert.equal(validateHotspot({ nameMs: '', lat: 3.2, lng: 101.4, days: 1 }).error, 'Name (BM) is required.');
  assert.match(validateHotspot({ nameMs: 'X', lat: 0, lng: 0, days: 1 }).error, /Puncak Alam/);
  assert.match(validateHotspot({ nameMs: 'X', lat: 3.2, lng: 101.4, days: 1.5 }).error, /whole number/);
  const { value } = validateHotspot({ nameMs: 'Depan Zombie', lat: 3.1955, lng: 101.4331, days: 26 });
  assert.equal(value.nameEn, 'Depan Zombie'); // English falls back to BM
});

test('inBounds covers Puncak Alam but not KL city centre far east', () => {
  assert.ok(inBounds(3.2409, 101.4414));
  assert.ok(!inBounds(3.15, 101.9));
});

test('stripJpegMetadata removes EXIF (GPS) but keeps the image', () => {
  const withGps = jpeg(APP0, exifSegment('Exif\0\0GPSLatitude=3.24;HOME'));
  const cleaned = stripJpegMetadata(withGps);
  assert.ok(cleaned);
  assert.ok(!cleaned.includes(Buffer.from('GPSLatitude')));
  assert.ok(cleaned.includes(APP0));
  assert.ok(cleaned.subarray(-SCAN.length).equals(SCAN));
});

test('stripJpegMetadata rejects non-JPEG and broken files', () => {
  assert.equal(stripJpegMetadata(Buffer.from('\x89PNG\r\n\x1a\n')), null);
  assert.equal(stripJpegMetadata(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00])), null);
  assert.equal(stripJpegMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x99])), null); // length runs past the end
});

test('parsePhoto: optional, JPEG only, size limited', () => {
  assert.deepEqual(parsePhoto(null), { value: null });
  const ok = parsePhoto({ thumb: dataUrl(jpeg(APP0)), full: dataUrl(jpeg(APP0)) });
  assert.ok(ok.value.thumb && ok.value.full);
  assert.ok(parsePhoto({ thumb: 'data:image/png;base64,AAAA', full: dataUrl(jpeg(APP0)) }).error);
  const huge = Buffer.concat([jpeg(APP0), Buffer.alloc(600 * 1024)]);
  assert.ok(parsePhoto({ thumb: dataUrl(jpeg(APP0)), full: dataUrl(huge) }).error);
});

test('distanceKm is about right', () => {
  const d = distanceKm(3.2409, 101.4414, 3.1955, 101.4331); // Proton -> Zombie Seafood
  assert.ok(d > 4.9 && d < 5.3, `got ${d}`);
  assert.equal(distanceKm(3.2, 101.4, 3.2, 101.4), 0);
});

test('coordsFromGoogleMapsUrl prefers the place pin over the map view', () => {
  const url = 'https://www.google.com/maps/place/ZOMBIE+Seafood/@3.1955303,101.4305736,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d3.1955249!4d101.4331485!16s';
  assert.deepEqual(coordsFromGoogleMapsUrl(url), [3.1955249, 101.4331485]);
  assert.deepEqual(coordsFromGoogleMapsUrl('https://www.google.com/maps/@3.2,101.44,15z'), [3.2, 101.44]);
  assert.deepEqual(coordsFromGoogleMapsUrl('https://maps.google.com/maps?q=3.21,101.45'), [3.21, 101.45]);
  assert.equal(coordsFromGoogleMapsUrl('https://maps.app.goo.gl/abc'), null);
});

test('isAllowedMapsLink only allows Google Maps links over https', () => {
  assert.ok(isAllowedMapsLink('https://maps.app.goo.gl/nixrSqQErsuHFm3Y7'));
  assert.ok(isAllowedMapsLink('https://www.google.com/maps/place/X/@3.2,101.4,17z'));
  assert.ok(!isAllowedMapsLink('http://maps.app.goo.gl/x'));
  assert.ok(!isAllowedMapsLink('https://evil.example/maps'));
  assert.ok(!isAllowedMapsLink('https://www.google.com/search?q=x'));
  assert.ok(!isAllowedMapsLink('not a url'));
});

test('link preview for a report uses its photo and escapes HTML', () => {
  const p = previewFor({ id: 7, status: 'danger', area: 'Depan "Proton" <b>', details: 'Air naik', time: '2026-11-19T07:00:00Z', waterLevel: 'knee', hasPhoto: true }, 'https://x.test');
  assert.equal(p.title, '⚠️ Banjir: Depan "Proton" <b> · paras lutut');
  assert.equal(p.image, 'https://x.test/api/reports/7/photo?size=full');
  assert.equal(p.url, 'https://x.test/?r=7');
  const html = metaTags(p);
  assert.ok(html.includes('Depan &quot;Proton&quot; &lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
});

test('link preview for the home page uses the wide card image', () => {
  const p = previewFor(null, 'https://x.test');
  assert.equal(p.image, 'https://x.test/icons/og-image.png');
  assert.ok(metaTags(p).includes('og:image:width'));
});
