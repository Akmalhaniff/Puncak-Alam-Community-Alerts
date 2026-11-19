// Input rules for reports. Pure functions, so they can be unit-tested without a server or database.

export const TYPES = new Set(['flood', 'road', 'weather']);
export const STATUSES = new Set(['danger', 'uncertain', 'clear']);
export const WATER_LEVELS = new Set(['ankle', 'knee', 'waist', 'car']);
// Generous box around Puncak Alam / Kuala Selangor so pins can't be dropped on the other side of the world.
export const BOUNDS = { minLat: 2.9, maxLat: 3.6, minLng: 101.1, maxLng: 101.8 };

export const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const inBounds = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng;

export function validateReport(body) {
  const type = body?.type;
  const status = body?.status;
  const area = cleanText(body?.area, 70);
  const details = cleanText(body?.details, 240);
  const who = cleanText(body?.who, 40);
  if (!TYPES.has(type)) return { error: 'Invalid report type.' };
  if (!STATUSES.has(status)) return { error: 'Invalid status.' };
  if (!area) return { error: 'Area is required.' };
  if (!details) return { error: 'Details are required.' };
  const waterLevel = body?.waterLevel == null || body.waterLevel === '' ? null : body.waterLevel;
  if (waterLevel !== null && !WATER_LEVELS.has(waterLevel)) return { error: 'Invalid water level.' };

  let lat = null;
  let lng = null;
  if (body.lat != null && body.lng != null) {
    lat = Number(body.lat);
    lng = Number(body.lng);
    if (!inBounds(lat, lng)) return { error: 'Map point must be in the Puncak Alam area.' };
  }
  return { value: { type, status, area, details, who, lat, lng, approximate: lat == null, waterLevel: type === 'flood' ? waterLevel : null } };
}

// Hotspots edited by the admin.
export function validateHotspot(body) {
  const nameMs = cleanText(body?.nameMs, 60);
  const nameEn = cleanText(body?.nameEn, 60) || nameMs;
  const noteMs = cleanText(body?.noteMs, 200);
  const noteEn = cleanText(body?.noteEn, 200) || noteMs;
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  const days = Number(body?.days);
  if (!nameMs) return { error: 'Name (BM) is required.' };
  if (!inBounds(lat, lng)) return { error: 'Map point must be in the Puncak Alam area.' };
  if (!Number.isInteger(days) || days < 0 || days > 3650) return { error: 'Flood days must be a whole number from 0 to 3650.' };
  return { value: { nameMs, nameEn, noteMs, noteEn, lat, lng, days } };
}
