/**
 * YodoUrl helpers for scripts (mirror src/utils/url.ts).
 *
 *   import { parseUrl, serializeUrl } from "./_common/url.js";
 */

/** @param {string} raw */
export function parseUrl(raw) {
  try {
    const u = new URL(raw);
    /** @type {Record<string, string>} */
    const query = {};
    for (const [key, value] of u.searchParams) query[key] = value;
    return { bareUrl: `${u.origin}${u.pathname}`, query };
  } catch {
    return { bareUrl: raw, query: {} };
  }
}

/** @param {{ bareUrl: string, query?: Record<string, string> }} u */
export function serializeUrl(u) {
  const query = u.query ?? {};
  const keys = Object.keys(query);
  if (keys.length === 0) return u.bareUrl;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) sp.set(key, value);
  return `${u.bareUrl}?${sp.toString()}`;
}
