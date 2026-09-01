import { FiltersEngine, Request as FilterRequest, type RequestType } from "@ghostery/adblocker";
import { isSameSite, parseUrl, type YodoUrl } from "../utils/url.js";
import type {
  RawAction,
  RawEvent,
  RawRequest,
  Redaction,
  RequestKind,
} from "./types.js";
import { isRawAction } from "./types.js";

export type AdblockEngine = FiltersEngine;

let engine: FiltersEngine | undefined;
let enginePromise: Promise<FiltersEngine> | undefined;

function filterType(kind: RequestKind): RequestType {
  if (kind === "document") return "main_frame";
  if (kind === "xhr") return "xmlhttprequest";
  if (kind === "fetch") return "fetch";
  return "other";
}

export async function loadAdblockEngine(): Promise<FiltersEngine> {
  if (engine) return engine;
  if (!enginePromise) {
    enginePromise = FiltersEngine.fromPrebuiltAdsAndTracking(fetch).then((eng) => {
      engine = eng;
      return eng;
    });
  }
  return enginePromise;
}

export function shouldSkipRecordUrl(
  url: string,
  kind: RequestKind,
  sourceUrl: string,
  loaded: FiltersEngine | undefined = engine,
): boolean {
  if (kind === "document" || !loaded) return false;
  try {
    return loaded.match(
      FilterRequest.fromRawDetails({
        url,
        type: filterType(kind),
        sourceUrl,
      }),
    ).match;
  } catch {
    return false;
  }
}

const SENSITIVE_NAME =
  /password|passwd|auth|authorization|token|ticket|csrf|xsrf|jwt|session|sign|signature|secret|api[-_]?key|access[-_]?token|verify|fingerprint|(^|[_-])fp($|[_-])|bogus|nonce/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

type Location = Redaction["location"];
type Result<T> = { value: T; redactions: Redaction[] };

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function shape(value: string): Redaction["shape"] {
  if (JWT.test(value)) return "jwt";
  if (UUID.test(value)) return "uuid";
  if (value.length >= 8 && HEX.test(value)) return "hex";
  if (/^\d+$/.test(value)) return "numeric";
  if (value.length >= 16 && BASE64URL.test(value)) return "base64url";
  if (/^[\p{L}\p{N}\s._:/-]+$/u.test(value)) return "text";
  return "opaque";
}

export class RecordSanitizer {
  private readonly aliases = new Map<string, string>();
  private nextAlias = 1;

  private redact(
    raw: string,
    location: Location,
    path: string,
    out: Redaction[],
  ): string {
    let alias = this.aliases.get(raw);
    if (!alias) {
      alias = `secret_${String(this.nextAlias++).padStart(3, "0")}`;
      this.aliases.set(raw, alias);
    }
    const kind = shape(raw);
    out.push({ location, path, alias, shape: kind, bytes: bytes(raw) });
    return `⟨${alias}:${kind}:bytes=${bytes(raw)}⟩`;
  }

  sanitizeUrl(urlText: string): Result<YodoUrl> {
    const redactions: Redaction[] = [];
    const parsed = parseUrl(urlText);
    for (const [name, value] of Object.entries(parsed.query)) {
      if (SENSITIVE_NAME.test(name) || JWT.test(value)) {
        parsed.query[name] = this.redact(value, "query", name, redactions);
      }
    }
    return { value: parsed, redactions };
  }

  sanitizeHeaders(headers: Record<string, string>): Result<Record<string, string>> {
    const redactions: Redaction[] = [];
    const value: Record<string, string> = {};
    for (const [name, raw] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower === "authorization") {
        const match = raw.match(/^(\S+)\s+(.+)$/);
        value[name] = match
          ? `${match[1]} ${this.redact(match[2]!, "header", lower, redactions)}`
          : this.redact(raw, "header", lower, redactions);
      } else if (lower === "cookie") {
        value[name] = raw
          .split(";")
          .map((part) => {
            const index = part.indexOf("=");
            if (index < 0) return part;
            const cookieName = part.slice(0, index).trim();
            const cookieValue = part.slice(index + 1);
            return `${cookieName}=${this.redact(
              cookieValue,
              "header",
              `cookie.${cookieName}`,
              redactions,
            )}`;
          })
          .join("; ");
      } else if (lower === "set-cookie") {
        const match = raw.match(/^([^=;]+)=([^;]*)(.*)$/);
        value[name] = match
          ? `${match[1]}=${this.redact(
              match[2]!,
              "header",
              `set-cookie.${match[1]!.trim()}`,
              redactions,
            )}${match[3]}`
          : this.redact(raw, "header", "set-cookie", redactions);
      } else if (SENSITIVE_NAME.test(lower) || JWT.test(raw)) {
        value[name] = this.redact(raw, "header", lower, redactions);
      } else {
        value[name] = raw;
      }
    }
    return { value, redactions };
  }

  sanitizeBody(
    input: unknown,
    location: "request-body" | "response-body",
    parseForm = false,
  ): Result<unknown> {
    const redactions: Redaction[] = [];
    const walk = (value: unknown, path: string, key = "", depth = 0): unknown => {
      if (depth > 20 || value == null) return value;
      if (typeof value === "string") {
        if (SENSITIVE_NAME.test(key) || JWT.test(value)) {
          return this.redact(value, location, path, redactions);
        }
        if (depth === 0 && parseForm && value.includes("=")) {
          try {
            const params = new URLSearchParams(value);
            const obj: { [name: string]: string } = {};
            let count = 0;
            for (const [name, child] of [...params]) {
              count++;
              obj[name] =
                SENSITIVE_NAME.test(name) || JWT.test(child)
                  ? this.redact(child, location, `$.${name}`, redactions)
                  : child;
            }
            if (count > 0) return obj;
          } catch {
            /* keep unstructured */
          }
        }
        return this.sanitizeText(value, location, path, redactions);
      }
      if (Array.isArray(value)) {
        return value.map((child, index) =>
          walk(child, `${path}[${index}]`, "", depth + 1),
        );
      }
      if (typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(
            ([name, child]) => [
              name,
              walk(child, `${path}.${name}`, name, depth + 1),
            ],
          ),
        );
      }
      if (SENSITIVE_NAME.test(key)) {
        return this.redact(String(value), location, path, redactions);
      }
      return value;
    };
    return { value: walk(input, "$"), redactions };
  }

  private sanitizeText(
    value: string,
    location: "request-body" | "response-body",
    path: string,
    redactions: Redaction[],
  ): string {
    const sensitivePair =
      /(password|passwd|auth|authorization|token|ticket|csrf|xsrf|jwt|session|sign|signature|secret|api[-_]?key|access[-_]?token|verify|fingerprint|fp|bogus|nonce)(\s*[:=]\s*["']?)([^&\s"'<>]+)/gi;
    let result = value.replace(
      sensitivePair,
      (_whole, key: string, separator: string, raw: string) =>
        `${key}${separator}${this.redact(raw, location, path, redactions)}`,
    );
    const jwt = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
    result = result.replace(jwt, (raw) =>
      this.redact(raw, location, path, redactions),
    );
    return result;
  }
}

function serializeUrlText(url: YodoUrl): string {
  const keys = Object.keys(url.query);
  if (keys.length === 0) return url.bareUrl;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(url.query)) sp.set(key, value);
  return `${url.bareUrl}?${sp.toString()}`;
}

function isFormUrlEncoded(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const ct = headers["content-type"] ?? headers["Content-Type"] ?? "";
  return /x-www-form-urlencoded/i.test(ct);
}

export function sanitizeEvent(entry: RawEvent, sanitizer: RecordSanitizer): RawEvent {
  if (isRawAction(entry)) {
    const action: RawAction = {
      ...entry,
      frameUrl: sanitizer.sanitizeUrl(serializeUrlText(entry.frameUrl)).value,
    };
    return action;
  }
  const req = entry;
  return {
    ...req,
    url: sanitizer.sanitizeUrl(serializeUrlText(req.url)).value,
    frameUrl: sanitizer.sanitizeUrl(serializeUrlText(req.frameUrl)).value,
    headers: sanitizer.sanitizeHeaders(req.headers).value,
    ...(req.responseHeaders
      ? { responseHeaders: sanitizer.sanitizeHeaders(req.responseHeaders).value }
      : {}),
    requestBody:
      req.requestBody !== null && req.requestBody !== undefined
        ? sanitizer.sanitizeBody(
            req.requestBody,
            "request-body",
            isFormUrlEncoded(req.headers),
          ).value
        : req.requestBody,
    responseBody:
      req.responseBody !== null && req.responseBody !== undefined
        ? sanitizer.sanitizeBody(
            req.responseBody,
            "response-body",
            isFormUrlEncoded(req.responseHeaders),
          ).value
        : req.responseBody,
  };
}

export function filterSuccessOnly(timeline: RawEvent[]): RawEvent[] {
  return timeline.filter((entry) => {
    if (isRawAction(entry)) return true;
    return typeof entry.status === "number" && entry.status >= 200 && entry.status < 300;
  });
}

export function filterAdblock(
  timeline: RawEvent[],
  loaded: FiltersEngine | undefined = engine,
): RawEvent[] {
  return timeline.filter((entry) => {
    if (isRawAction(entry)) return true;
    if (entry.requestType === "mainDoc" || entry.requestType === "doc") return true;
    const kind = entry.requestType === "xhr" ? "xhr" : entry.requestType === "fetch" ? "fetch" : "other";
    return !shouldSkipRecordUrl(
      entry.url.bareUrl,
      kind as RequestKind,
      entry.frameUrl.bareUrl,
      loaded,
    );
  });
}

function thirdPartyKey(row: RawRequest): string {
  return `${row.method}\0${row.url.bareUrl}`;
}

export function dedupeTimeline(timeline: RawEvent[]): number {
  timeline.sort((a, b) => a.startedAt - b.startedAt);
  const out: RawEvent[] = [];
  const thirdPartyIdx = new Map<string, number>();
  let removed = 0;

  for (const entry of timeline) {
    if (isRawAction(entry)) {
      out.push(entry);
      continue;
    }
    if (entry.requestType === "mainDoc" || entry.requestType === "doc") {
      out.push(entry);
      continue;
    }
    if (isSameSite(entry.url, entry.frameUrl)) {
      out.push(entry);
      continue;
    }
    const key = thirdPartyKey(entry);
    const prior = thirdPartyIdx.get(key);
    if (prior !== undefined) {
      removed++;
      out[prior] = entry;
    } else {
      thirdPartyIdx.set(key, out.length);
      out.push(entry);
    }
  }

  out.sort((a, b) => a.startedAt - b.startedAt);
  timeline.length = 0;
  timeline.push(...out);
  return removed;
}

/** 纯：2xx → adblock → 脱敏 → 去重。零 fs、零 CDP。 */
export function processTimelinePipeline(
  rawTimeline: RawEvent[],
  loaded?: FiltersEngine,
): RawEvent[] {
  const sanitizer = new RecordSanitizer();
  const step1 = filterSuccessOnly(rawTimeline);
  const step2 = filterAdblock(step1, loaded);
  const step3 = step2.map((e) => sanitizeEvent(e, sanitizer));
  const step4 = [...step3];
  dedupeTimeline(step4);
  return step4;
}
