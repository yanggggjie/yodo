import { getDomain } from "tldts";

export type YodoUrl = {
  /** origin + pathname, no `?` or `#` */
  bareUrl: string;
  /** decoded query values */
  query: Record<string, string>;
};

/** Parse http(s) URL; query values stored decoded. */
export function parseUrl(raw: string): YodoUrl {
  try {
    const u = new URL(raw);
    const query: Record<string, string> = {};
    for (const [key, value] of u.searchParams) query[key] = value;
    return { bareUrl: `${u.origin}${u.pathname}`, query };
  } catch {
    return { bareUrl: raw, query: {} };
  }
}

/** Build full URL string; query values encoded via URLSearchParams. */
export function serializeUrl(u: YodoUrl): string {
  const keys = Object.keys(u.query);
  if (keys.length === 0) return u.bareUrl;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(u.query)) sp.set(key, value);
  return `${u.bareUrl}?${sp.toString()}`;
}

export function urlOrigin(u: YodoUrl): string {
  try {
    return new URL(u.bareUrl).origin;
  } catch {
    return "";
  }
}

/** Registrable domain (eTLD+1); falls back to hostname. */
export function registrableDomain(u: YodoUrl): string {
  try {
    const host = new URL(u.bareUrl).hostname;
    return getDomain(host) ?? host;
  } catch {
    return "";
  }
}

export function isSameSite(a: YodoUrl, b: YodoUrl): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return da !== "" && da === db;
}
