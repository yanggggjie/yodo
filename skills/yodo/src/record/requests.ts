/**
 * 录制的请求拼装：把 CDP 事件（以及采集端补充的 yodo.* 事件）按顺序喂进来，得到请求记录。
 * 这里不做网络或 CDP 调用；响应体写文件由注入的 writer 完成。
 * 所以真实录制得到的事件日志可以原样回放，用来做测试。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BODY_BYTES, RESPONSE_SPLIT_BYTES } from "../utils/constants.ts";
import { parseUrl } from "../utils/url.ts";
import type { ActiveRecordStore } from "./collect.ts";
import type { RawRequest, RequestKind } from "./types.ts";

/**
 * 一条被记录的事件。除 CDP 事件外还有采集端补充的：
 * yodo.tab（开始采集某个 tab）、yodo.tabGone、yodo.frameTree（Page.getFrameTree 的结果）、
 * yodo.body（取回的响应体或失败原因）、yodo.snapshot（补抓主文档读到的页面）。
 */
export type LogEvent = { t: number; tabId: string; method: string; params: any };

/** feed 之后采集端要做的事：取响应体，或尝试补抓主文档。 */
export type FeedAction = { fetchBody: { requestId: string; kind: "html" | "json" } } | { snapshot: true } | null;

export type BodyWriter = (row: RawRequest, bytes: Buffer, kind: "html" | "json") => void;

export function isRecordableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function kindOfCdpResourceType(type: string): RequestKind | undefined {
  const t = (type || "").toLowerCase();
  if (t === "document") return "document";
  if (t === "xhr") return "xhr";
  if (t === "fetch") return "fetch";
  return undefined;
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function wallMs(wallTime: number): number {
  return Math.round(wallTime * 1000);
}

function contentTypeOf(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return headers["content-type"] ?? headers["Content-Type"] ?? "";
}

/** 超过 RESPONSE_SPLIT_BYTES 的响应体写成单独文件，较小的内联；超过 MAX_BODY_BYTES 标记为不可用。 */
export function writeResponseBody(recordDir: string): BodyWriter {
  return (row, bytes, kind) => {
    if (bytes.byteLength > MAX_BODY_BYTES) {
      row.responseBodyUnavailableReason = "response-body-too-large";
      return;
    }
    if (bytes.byteLength > RESPONSE_SPLIT_BYTES) {
      const rel = `${row.id}.response.${kind === "html" ? "html" : "json"}`;
      fs.writeFileSync(path.join(recordDir, rel), bytes);
      row.responseBodyPath = rel;
      return;
    }
    const text = bytes.toString("utf8");
    row.responseBody = kind === "html" ? text : parseText(text);
  };
}

type TabState = { mainFrameId: string; pageUrl: string; requests: Map<string, RawRequest> };

export class RequestAssembler {
  /** 类型属于 document、xhr、fetch，但 URL 不是 http(s) 而被丢弃的请求数，只用于日志。 */
  dropped = 0;
  private readonly tabs = new Map<string, TabState>();
  private readonly frameUrls = new Map<string, string>();

  private readonly store: ActiveRecordStore;
  private readonly writeBody: BodyWriter;

  constructor(store: ActiveRecordStore, writeBody: BodyWriter) {
    this.store = store;
    this.writeBody = writeBody;
  }

  hasMainDoc(tabId: string): boolean {
    return this.store.events.some((e) => e.targetId === tabId && e.requestType === "mainDoc");
  }

  pageUrl(tabId: string): string | undefined {
    return this.tabs.get(tabId)?.pageUrl;
  }

  feed(ev: LogEvent): FeedAction {
    const { tabId, method, params: p } = ev;
    switch (method) {
      case "yodo.tab":
        if (!this.tabs.has(tabId)) this.tabs.set(tabId, { mainFrameId: "", pageUrl: p.url, requests: new Map() });
        return null;
      case "yodo.tabGone":
        this.tabs.delete(tabId);
        return null;
      case "yodo.frameTree":
        this.onFrameTree(tabId, p);
        return null;
      case "Page.frameNavigated":
        return this.onFrameNavigated(tabId, p);
      case "Page.loadEventFired":
        return this.tabs.has(tabId) ? { snapshot: true } : null;
      case "Network.requestWillBeSent":
        this.onRequestWillBeSent(tabId, p);
        return null;
      case "Network.responseReceived": {
        const row = this.tabs.get(tabId)?.requests.get(p.requestId);
        if (row) {
          row.status = p.response.status;
          row.responseHeaders = p.response.headers;
        }
        return null;
      }
      case "Network.loadingFinished":
        return this.onLoadingFinished(tabId, p.requestId, ev.t);
      case "Network.loadingFailed": {
        const row = this.tabs.get(tabId)?.requests.get(p.requestId);
        if (row) {
          row.errorText = p.errorText;
          row.endedAt = ev.t;
        }
        return null;
      }
      case "yodo.body":
        this.onBody(tabId, p);
        return null;
      case "yodo.snapshot":
        this.onSnapshot(tabId, p, ev.t);
        return null;
      default:
        return null;
    }
  }

  private onFrameTree(tabId: string, tree: any): void {
    const ps = this.tabs.get(tabId);
    const frame = tree?.frameTree?.frame;
    if (!ps || !frame) return;
    ps.mainFrameId = frame.id;
    ps.pageUrl = frame.url || ps.pageUrl;
    this.frameUrls.set(frame.id, ps.pageUrl);
    for (const child of tree.frameTree.childFrames ?? []) {
      if (child.frame?.id && child.frame?.url) this.frameUrls.set(child.frame.id, child.frame.url);
    }
  }

  private onFrameNavigated(tabId: string, p: any): FeedAction {
    const frame = p?.frame;
    if (!frame) return null;
    this.frameUrls.set(frame.id, frame.url);
    if (frame.parentId) return null;
    const ps = this.tabs.get(tabId);
    if (!ps) return null;
    ps.pageUrl = frame.url;
    return { snapshot: true };
  }

  private onRequestWillBeSent(tabId: string, p: any): void {
    const ps = this.tabs.get(tabId);
    if (!ps) return;
    const requestUrl: string = p.request.url;
    const kind = kindOfCdpResourceType(p.type);
    const mainFrame = ps.mainFrameId ? p.frameId === ps.mainFrameId : (p.type || "").toLowerCase() === "document";

    if (!kind || !isRecordableUrl(requestUrl)) {
      if (kind) this.dropped++;
      return;
    }

    const currentFrameUrl = this.frameUrls.get(p.frameId) || ps.pageUrl || requestUrl;
    const rawPost: string = p.request.postData ?? "";
    let requestBody: unknown | null = rawPost ? parseText(rawPost) : null;
    let requestBodyUnavailableReason: string | undefined;
    if (kind === "document") {
      requestBody = null;
    } else if (Buffer.byteLength(rawPost) > MAX_BODY_BYTES) {
      requestBody = null;
      requestBodyUnavailableReason = "request-body-too-large";
    }

    const row = this.store.appendRequest(
      {
        requestType: kind === "document" ? (mainFrame ? "mainDoc" : "doc") : (kind as "xhr" | "fetch"),
        method: p.request.method,
        url: parseUrl(requestUrl),
        frameUrl: parseUrl(currentFrameUrl),
        headers: p.request.headers,
        requestBody,
        ...(requestBodyUnavailableReason ? { requestBodyUnavailableReason } : {}),
        responseBody: null,
        startedAt: wallMs(p.wallTime),
      },
      mainFrame,
      tabId,
    );
    ps.requests.set(p.requestId, row);

    if (kind === "document" && mainFrame) {
      ps.pageUrl = requestUrl;
      this.frameUrls.set(p.frameId, requestUrl);
    }
  }

  /** 请求结束：标记结束时间，并决定要不要取响应体（取回后以 yodo.body 事件喂回来）。 */
  private onLoadingFinished(tabId: string, requestId: string, t: number): FeedAction {
    const row = this.tabs.get(tabId)?.requests.get(requestId);
    if (!row || row.endedAt != null) return null;
    row.endedAt = t;

    const ct = contentTypeOf(row.responseHeaders);
    const documentHtml = (row.requestType === "mainDoc" || row.requestType === "doc") && row.mainFrame;
    if (documentHtml) {
      if (!/html/i.test(ct)) {
        row.responseBodyUnavailableReason = "document-not-html";
        return null;
      }
      return { fetchBody: { requestId, kind: "html" } };
    }

    const announced = Number(row.responseHeaders?.["content-length"] ?? row.responseHeaders?.["Content-Length"] ?? "");
    if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
      row.responseBodyUnavailableReason = "content-length-exceeds-limit";
      return null;
    }
    if (!/json|text|xml|javascript|x-www-form-urlencoded/i.test(ct)) return null;
    return { fetchBody: { requestId, kind: "json" } };
  }

  private onBody(tabId: string, p: any): void {
    const row = this.tabs.get(tabId)?.requests.get(p.requestId);
    if (!row) return;
    if (p.error !== undefined) {
      row.responseBodyUnavailableReason = p.error;
      return;
    }
    const kind = (row.requestType === "mainDoc" || row.requestType === "doc") && row.mainFrame ? "html" : "json";
    try {
      const bytes = p.base64Encoded ? Buffer.from(p.body, "base64") : Buffer.from(p.body, "utf8");
      this.writeBody(row, bytes, kind);
    } catch (error) {
      row.responseBodyUnavailableReason = error instanceof Error ? error.message : kind === "html" ? "document-response-failed" : "response-body-unavailable";
    }
  }

  /** 页面在开始采集之前就已经加载完：用页面当前的 HTML 补一条主文档。 */
  private onSnapshot(tabId: string, v: any, t: number): void {
    const ps = this.tabs.get(tabId);
    if (!ps || this.hasMainDoc(tabId)) return;
    if (!v || (v.ready !== "interactive" && v.ready !== "complete")) return;
    const href: string = v.href && isRecordableUrl(v.href) ? v.href : ps.pageUrl;
    if (!isRecordableUrl(href)) return;
    const html: string = typeof v.html === "string" ? v.html : "";
    if (!html.includes("<")) return;
    const row = this.store.appendRequest(
      { requestType: "mainDoc", url: parseUrl(href), frameUrl: parseUrl(href), headers: {}, requestBody: null, responseBody: null, late: true, startedAt: t, endedAt: t },
      true,
      tabId,
    );
    try {
      this.writeBody(row, Buffer.from(html, "utf8"), "html");
    } catch {
      /* 没有响应体也保留这一行 */
    }
  }
}
