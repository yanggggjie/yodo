/** @param {string} raw */
export function parseUrl(raw) {
  try {
    const u = new URL(raw);
    const query = {};
    for (const [key, value] of u.searchParams) query[key] = value;
    return { bareUrl: `${u.origin}${u.pathname}`, query };
  } catch { return { bareUrl: raw, query: {} }; }
}

/** @param {{ bareUrl: string, query?: Record<string, string> }} u */
export function serializeUrl(u) {
  const entries = Object.entries(u.query ?? {});
  if (!entries.length) return u.bareUrl;
  const query = new URLSearchParams(entries);
  return `${u.bareUrl}?${query.toString()}`;
}
