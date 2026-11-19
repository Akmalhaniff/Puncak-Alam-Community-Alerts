// Photo checks for uploads. The page compresses photos to JPEG before upload; the server only
// accepts JPEG within size limits and removes metadata (EXIF incl. GPS location, XMP, IPTC, comments).

export const PHOTO_LIMITS = { thumb: 80 * 1024, full: 500 * 1024 };

// Returns the JPEG without metadata segments, or null if the bytes aren't a well-formed JPEG.
export function stripJpegMetadata(buf) {
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

export function decodeJpegDataUrl(value, maxBytes) {
  if (typeof value !== 'string') return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64');
  if (!raw.length || raw.length > maxBytes) return null;
  return stripJpegMetadata(raw);
}

// photo: { thumb, full } as JPEG data URLs.
export function parsePhoto(photo) {
  if (photo == null) return { value: null };
  const thumb = decodeJpegDataUrl(photo.thumb, PHOTO_LIMITS.thumb);
  const full = decodeJpegDataUrl(photo.full, PHOTO_LIMITS.full);
  if (!thumb || !full) return { error: 'Photo must be a JPEG under 500 KB. Please try another photo.' };
  return { value: { thumb, full } };
}
