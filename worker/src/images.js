/**
 * images.js — guest photo pipeline (step 5, first slice).
 *
 * Workers have no native image processing, so v1 resizes through the
 * images.weserv.nl proxy (free, battle-tested, cacheable). Swap for
 * Cloudflare Images or WASM later without touching callers.
 *
 * Apple (generic pass): square thumbnail (90pt / 180px@2x), PNG.
 * Google: wide hero image URL (1032x336 recommended).
 */

function weserv(photoUrl, params) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(photoUrl)}&${params}`;
}

/** Wide hero URL for the Google object (Google fetches it itself). */
export function googleHeroUrl(photoUrl) {
  return weserv(photoUrl, 'w=1032&h=336&fit=cover&output=jpg&q=80');
}

/**
 * Fetch Apple thumbnail images for a photo.
 * @returns {Promise<Record<string, Uint8Array>>} {} on any failure — card ships without photo.
 */
export async function appleThumbnails(photoUrl) {
  try {
    const [x1, x2] = await Promise.all([
      fetchPng(weserv(photoUrl, 'w=90&h=90&fit=cover&output=png')),
      fetchPng(weserv(photoUrl, 'w=180&h=180&fit=cover&output=png')),
    ]);
    if (!x1 || !x2) return {};
    return { 'thumbnail.png': x1, 'thumbnail@2x.png': x2 };
  } catch {
    return {};
  }
}

async function fetchPng(url) {
  const res = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  // sanity: PNG magic + size cap (pass bundle must stay small)
  if (buf.length < 8 || buf.length > 400_000) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return buf;
}
