// Small geography helpers.

export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Pulls coordinates out of a full Google Maps URL. Prefers the place pin (!3d<lat>!4d<lng>) over the
// map view (@lat,lng). Returns [lat, lng] or null.
export function coordsFromGoogleMapsUrl(url) {
  if (typeof url !== 'string') return null;
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url);
  if (pin) return [Number(pin[1]), Number(pin[2])];
  const view = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url);
  if (view) return [Number(view[1]), Number(view[2])];
  const q = /[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(url);
  if (q) return [Number(q[1]), Number(q[2])];
  return null;
}

// Only these hosts may be fetched when resolving a pasted Google Maps link (prevents fetching arbitrary URLs).
export const MAPS_LINK_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'www.google.com', 'google.com', 'maps.google.com', 'www.google.com.my', 'google.com.my']);
export function isAllowedMapsLink(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && MAPS_LINK_HOSTS.has(u.hostname) && (u.hostname.includes('goo.gl') || u.pathname.startsWith('/maps'));
  } catch {
    return false;
  }
}
