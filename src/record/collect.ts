import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_BODY_BYTES, RESPONSE_SPLIT_BYTES } from "../utils/constants.js";
import { parseUrl } from "../utils/url.js";
import { createLogger } from "../utils/logger.js";
import { isChromeUiUrl, setDiscoverTargets, setPageAutoAttach, type RawCdpConnection } from "../browser/index.js";
import type { RawAction, RawEvent, RawRequest, RequestKind, TimelineActionType } from "./types.js";
import { isRawAction } from "./types.js";

const logger = createLogger("record");

export function isRecordableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function publicId(kind: string, n: number): string {
  return `${kind}_${String(n).padStart(3, "0")}`;
}

export const GESTURE_CORRELATION_WINDOW_MS = 2500;

export class RecordWindowTracker {
  readonly activeWindowIds = new Set<number>();
  readonly activeTargets = new Set<string>();
  lastGestureAt = 0;

  get activeWindowId(): number | undefined {
    return this.activeWindowIds.values().next().value;
  }

  set activeWindowId(id: number | undefined) {
    if (id !== undefined) this.activeWindowIds.add(id);
  }

  initWindow(targetId: string, windowId: number): void {
    this.activeWindowIds.add(windowId);
    this.activeTargets.add(targetId);
  }

  recordGesture(timestamp = Date.now()): void {
    this.lastGestureAt = timestamp;
  }

  isWithinGestureWindow(
    timestamp = Date.now(),
    windowMs = GESTURE_CORRELATION_WINDOW_MS,
  ): boolean {
    if (!this.lastGestureAt) return false;
    return (
      timestamp >= this.lastGestureAt &&
      timestamp - this.lastGestureAt <= windowMs
    );
  }

  isTargetIncluded(
    targetId: string,
    openerId?: string,
    targetWindowId?: number,
    attachedAt = Date.now(),
  ): boolean {
    if (this.activeTargets.has(targetId)) return true;
    if (
      targetWindowId !== undefined &&
      this.activeWindowIds.has(targetWindowId)
    ) {
      this.activeTargets.add(targetId);
      return true;
    }
    if (openerId && this.activeTargets.has(openerId)) {
      this.activeTargets.add(targetId);
      if (targetWindowId !== undefined) {
        this.activeWindowIds.add(targetWindowId);
      }
      return true;
    }
    if (targetWindowId !== undefined) return false;
    if (this.isWithinGestureWindow(attachedAt)) {
      this.activeTargets.add(targetId);
      return true;
    }
    return false;
  }

  removeTarget(targetId: string): void {
    this.activeTargets.delete(targetId);
  }

  isKnownTarget(targetId: string): boolean {
    return this.activeTargets.has(targetId);
  }
}

/** 只关录制窗的 page。若关完会变成最后一扇窗，先开一扇普通窗。不用 Browser.close。 */
export async function closeTrackedWindows(
  raw: Pick<RawCdpConnection, "send">,
  tracker: RecordWindowTracker,
): Promise<void> {
  const closing = new Set(tracker.activeTargets);
  let pages: { targetId: string; type?: string }[] = [];
  try {
    const res = (await raw.send("Target.getTargets")) as {
      targetInfos?: { targetId: string; type?: string }[];
    };
    pages = (res.targetInfos ?? []).filter((t) => t.type === "page");
  } catch {
    pages = [];
  }

  for (const t of pages) {
    try {
      const win = (await raw.send("Browser.getWindowForTarget", {
        targetId: t.targetId,
      })) as { windowId?: number };
      if (win?.windowId !== undefined && tracker.activeWindowIds.has(win.windowId)) {
        closing.add(t.targetId);
      }
    } catch {
      /* gone */
    }
  }

  if (closing.size === 0) return;

  const leftover = pages.filter((t) => !closing.has(t.targetId));
  if (leftover.length === 0) {
    await raw
      .send("Target.createTarget", { url: "about:blank", newWindow: true })
      .catch(() => {});
  }

  await Promise.all(
    [...closing].map((targetId) =>
      raw.send("Target.closeTarget", { targetId }).catch(() => {}),
    ),
  );
}

export class ActiveRecordStore {
  readonly events: RawEvent[] = [];
  readonly recordDir: string;
  private nextGesture = 0;
  private nextRequest = 0;
  private active = true;

  constructor(
    readonly name: string,
    readonly startedAt: number,
    recordDir: string,
  ) {
    this.recordDir = recordDir;
  }

  isActive(): boolean {
    return this.active;
  }

  deactivate(): void {
    this.active = false;
  }

  appendAction(
    frameUrl: string,
    actionType: TimelineActionType,
    extra: {
      role?: string;
      name?: string;
      targetId?: string;
      startedAt?: number;
    } = {},
  ): RawAction | undefined {
    if (!this.active) return undefined;
    const action: RawAction = {
      id: publicId("action", ++this.nextGesture),
      actionType,
      startedAt: extra.startedAt ?? Date.now(),
      frameUrl: parseUrl(frameUrl),
      ...(extra.role ? { role: extra.role } : {}),
      ...(extra.name ? { name: extra.name } : {}),
      ...(extra.targetId ? { targetId: extra.targetId } : {}),
    };
    this.events.push(action);
    return action;
  }

  appendRequest(
    partial: Omit<RawRequest, "id" | "mainFrame">,
    mainFrame: boolean,
    targetId?: string,
  ): RawRequest {
    const request: RawRequest = {
      ...partial,
      id: publicId("request", ++this.nextRequest),
      mainFrame,
      ...(targetId ? { targetId } : {}),
    };
    this.events.push(request);
    return request;
  }

  dropIncompleteRequests(): number {
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const row = this.events[i]!;
      if (isRawAction(row)) continue;
      if (row.status === undefined && !row.errorText) {
        this.events.splice(i, 1);
      }
    }
    return before - this.events.length;
  }
}

const SCROLL_DEBOUNCE_MS = 200;

export type InjectRecorder = { stop: () => Promise<void> };

export const GESTURE_INJECT_SOURCE = `(() => {
  const gen = (window.__yodoGen = (window.__yodoGen || 0) + 1);
  const implicit = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.getAttribute("role")) return el.getAttribute("role");
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "";
  };
  const accessibleName = (el) => {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim().slice(0, 200);
    if (el.alt) return String(el.alt).trim().slice(0, 200);
    if (el.title) return String(el.title).trim().slice(0, 200);
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    return text.slice(0, 200);
  };
  const roleName = (el) => {
    let cur = el instanceof Element ? el : null;
    for (let i = 0; i < 6 && cur; i++) {
      const role = implicit(cur);
      const name = accessibleName(cur);
      if (role && name) return { role, name };
      cur = cur.parentElement;
    }
    const node = el instanceof Element ? el : null;
    return {
      role: node ? implicit(node) || "generic" : "generic",
      name: node ? accessibleName(node) : "",
    };
  };
  const send = (payload) => {
    if (window.__yodoGen !== gen) return;
    try { window.__yodoEvent(JSON.stringify(payload)); } catch { /* binding gone */ }
  };
  document.addEventListener("click", (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const { role, name } = roleName(e.target);
    send({ kind: "click", frameUrl: location.href, role, name, startedAt: Date.now() });
  }, true);
  document.addEventListener("submit", (e) => {
    if (!e.isTrusted) return;
    send({ kind: "submit", frameUrl: location.href, startedAt: Date.now() });
  }, true);
  let scrollTimer;
  document.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => send({ kind: "scroll", frameUrl: location.href, startedAt: Date.now() }), ${SCROLL_DEBOUNCE_MS});
  }, true);
})()`;

export function startInjectEvents(
  raw: RawCdpConnection,
  store: ActiveRecordStore,
  tracker: RecordWindowTracker,
  sessionToTarget: Map<string, string>,
): InjectRecorder {
  const offBinding = raw.on("Runtime.bindingCalled", (params, sessionId) => {
    if (!store.isActive()) return;
    const data = params as { name: string; payload: string };
    if (data.name !== "__yodoEvent") return;

    if (!sessionId) return;
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId || !tracker.isKnownTarget(targetId)) return;

    let row: {
      kind?: string;
      frameUrl?: string;
      role?: string;
      name?: string;
      startedAt?: number;
    };
    try {
      row = JSON.parse(data.payload) as typeof row;
    } catch {
      return;
    }

    const frameUrl = row.frameUrl || "about:blank";
    const startedAt = row.startedAt ?? Date.now();

    if (row.kind === "click") {
      tracker.recordGesture(startedAt);
      store.appendAction(frameUrl, "click", {
        role: row.role,
        name: row.name,
        targetId,
        startedAt,
      });
    } else if (row.kind === "submit") {
      tracker.recordGesture(startedAt);
      store.appendAction(frameUrl, "submit", { targetId, startedAt });
    } else if (row.kind === "scroll") {
      store.appendAction(frameUrl, "scroll", { targetId, startedAt });
    }
  });

  return {
    stop: async () => {
      offBinding();
    },
  };
}

export type CdpNetworkRecorder = {
  sessionToTarget: Map<string, string>;
  attachTarget: (targetId: string) => Promise<void>;
  stop: () => Promise<void>;
};

type TargetNetworkSession = {
  sessionId: string;
  targetId: string;
  mainFrameId: string;
  pageUrl: string;
  attachedAt: number;
  byRequestId: Map<string, RawRequest>;
  send: RawCdpConnection["send"];
};

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

async function attachResponseBody(
  row: RawRequest,
  recordDir: string,
  bytes: Buffer,
  kind: "html" | "json",
): Promise<void> {
  if (bytes.byteLength > MAX_BODY_BYTES) {
    row.responseBodyUnavailableReason = "response-body-too-large";
    return;
  }
  if (bytes.byteLength > RESPONSE_SPLIT_BYTES) {
    const rel = `${row.id}.response.${kind === "html" ? "html" : "json"}`;
    await fs.writeFile(path.join(recordDir, rel), bytes);
    row.responseBodyPath = rel;
    return;
  }
  const raw = bytes.toString("utf8");
  row.responseBody = kind === "html" ? raw : parseText(raw);
}

export async function startCdpNetworkRecorder(
  raw: RawCdpConnection,
  store: ActiveRecordStore,
  tracker: RecordWindowTracker,
): Promise<CdpNetworkRecorder> {
  const sessionsBySessionId = new Map<string, TargetNetworkSession>();
  const sessionsByTarget = new Map<string, TargetNetworkSession>();
  const sessionToTarget = new Map<string, string>();
  const frameUrlMap = new Map<string, string>();
  let stopping = false;
  let dropped = 0;

  const networkEnableParams = {
    maxResourceBufferSize: MAX_BODY_BYTES,
    maxTotalBufferSize: MAX_BODY_BYTES * 4,
  };

  const onRequestWillBeSent = (
    ps: TargetNetworkSession,
    params: {
      requestId: string;
      request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        postData?: string;
      };
      type: string;
      frameId: string;
      wallTime: number;
    },
  ): void => {
    if (!tracker.isKnownTarget(ps.targetId)) return;

    const requestUrl = params.request.url;
    const kind = kindOfCdpResourceType(params.type);
    const mainFrame = ps.mainFrameId
      ? params.frameId === ps.mainFrameId
      : (params.type || "").toLowerCase() === "document";

    if (!kind || !isRecordableUrl(requestUrl)) {
      if (kind) dropped++;
      return;
    }

    const currentFrameUrl =
      frameUrlMap.get(params.frameId) || ps.pageUrl || requestUrl;

    const rawPost = params.request.postData ?? "";
    const rawBytes = Buffer.byteLength(rawPost);
    let requestBody: unknown | null = rawPost ? parseText(rawPost) : null;
    let requestBodyUnavailableReason: string | undefined;
    if (kind === "document") {
      requestBody = null;
    } else if (rawBytes > MAX_BODY_BYTES) {
      requestBody = null;
      requestBodyUnavailableReason = "request-body-too-large";
    }

    const row = store.appendRequest(
      {
        requestType: kind === "document" ? (mainFrame ? "mainDoc" : "doc") : (kind as "xhr" | "fetch"),
        method: params.request.method,
        url: parseUrl(requestUrl),
        frameUrl: parseUrl(currentFrameUrl),
        headers: params.request.headers,
        requestBody,
        ...(requestBodyUnavailableReason ? { requestBodyUnavailableReason } : {}),
        responseBody: null,
        startedAt: wallMs(params.wallTime),
      },
      mainFrame,
      ps.targetId,
    );
    ps.byRequestId.set(params.requestId, row);

    if (kind === "document" && mainFrame) {
      ps.pageUrl = requestUrl;
      frameUrlMap.set(params.frameId, requestUrl);
    }
  };

  const onLoadingFinished = async (
    ps: TargetNetworkSession,
    params: { requestId: string },
  ): Promise<void> => {
    const row = ps.byRequestId.get(params.requestId);
    if (!row || row.endedAt != null) return;
    row.endedAt = Date.now();

    const ct = contentTypeOf(row.responseHeaders);
    const documentHtml = (row.requestType === "mainDoc" || row.requestType === "doc") && row.mainFrame;

    if (documentHtml) {
      if (!/html/i.test(ct)) {
        row.responseBodyUnavailableReason = "document-not-html";
        return;
      }
      try {
        const body = (await ps.send(
          "Network.getResponseBody",
          { requestId: params.requestId },
          ps.sessionId,
        )) as { body: string; base64Encoded: boolean };
        const bytes = body.base64Encoded
          ? Buffer.from(body.body, "base64")
          : Buffer.from(body.body, "utf8");
        await attachResponseBody(row, store.recordDir, bytes, "html");
      } catch (error) {
        row.responseBodyUnavailableReason =
          error instanceof Error ? error.message : "document-response-failed";
      }
      return;
    }

    const announced = Number(
      row.responseHeaders?.["content-length"] ??
        row.responseHeaders?.["Content-Length"] ??
        "",
    );
    if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
      row.responseBodyUnavailableReason = "content-length-exceeds-limit";
      return;
    }

    if (!/json|text|xml|javascript|x-www-form-urlencoded/i.test(ct)) return;

    try {
      const body = (await ps.send(
        "Network.getResponseBody",
        { requestId: params.requestId },
        ps.sessionId,
      )) as { body: string; base64Encoded: boolean };
      const bytes = body.base64Encoded
        ? Buffer.from(body.body, "base64")
        : Buffer.from(body.body, "utf8");
      await attachResponseBody(row, store.recordDir, bytes, "json");
    } catch (error) {
      row.responseBodyUnavailableReason =
        error instanceof Error ? error.message : "response-body-unavailable";
    }
  };

  const pendingSessions = new Set<string>();
  const pipelinedTargets = new Set<string>();
  const ignoredTargets = new Set<string>();

  type DiscoveredTarget = {
    targetId: string;
    type: string;
    url?: string;
    openerId?: string;
  };

  function detachSession(sessionId: string): void {
    raw
      .send("Target.detachFromTarget", { sessionId }, raw.browserSessionId)
      .catch(() => {});
    pendingSessions.delete(sessionId);
  }

  async function attachTarget(targetId: string, url = "about:blank"): Promise<void> {
    if (stopping || sessionsByTarget.has(targetId) || pipelinedTargets.has(targetId)) return;
    if (isChromeUiUrl(url)) return;
    try {
      const attachRes = (await raw.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      if (!attachRes?.sessionId) return;
      pendingSessions.add(attachRes.sessionId);
      if (stopping) {
        detachSession(attachRes.sessionId);
        return;
      }
      pipelineTarget(attachRes.sessionId, targetId, url);
    } catch {
      /* target may have attached via page autoAttach */
    }
  }

  async function maybeAttachDiscovered(info: DiscoveredTarget): Promise<void> {
    if (stopping || info.type !== "page") return;
    if (ignoredTargets.has(info.targetId)) return;
    if (sessionsByTarget.has(info.targetId) || pipelinedTargets.has(info.targetId)) return;
    const url = info.url || "";
    if (isChromeUiUrl(url)) return;
    let windowId: number | undefined;
    try {
      const win = (await raw.send(
        "Browser.getWindowForTarget",
        { targetId: info.targetId },
        raw.browserSessionId,
      )) as { windowId?: number };
      windowId = win?.windowId;
    } catch {
      return;
    }
    if (stopping) return;
    const included = tracker.isTargetIncluded(
      info.targetId,
      info.openerId,
      windowId,
      Date.now(),
    );
    if (!included) {
      if (windowId !== undefined) ignoredTargets.add(info.targetId);
      return;
    }
    await attachTarget(info.targetId, url || "about:blank");
  }

  /** attachTarget 与 page 级 autoAttach 都会碰到同一 page；inject 只能灌一次。 */
  function pipelineTarget(sessionId: string, targetId: string, url: string): boolean {
    if (stopping || pipelinedTargets.has(targetId)) return false;
    pipelinedTargets.add(targetId);
    sendTargetPipeline(sessionId);
    bindSession(sessionId, targetId, url);
    return true;
  }

  function sendTargetPipeline(sessionId: string): void {
    raw.send("Page.enable", {}, sessionId).catch(() => {});
    raw.send("Runtime.enable", {}, sessionId).catch(() => {});
    raw.send("Page.setBypassCSP", { enabled: true }, sessionId).catch(() => {});
    raw.send("Runtime.addBinding", { name: "__yodoEvent" }, sessionId).catch(() => {});
    raw.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: GESTURE_INJECT_SOURCE,
        worldName: "__yodo_isolated__",
      },
      sessionId,
    ).catch(() => {});
    raw.send("Network.enable", networkEnableParams, sessionId).catch(() => {});
    setPageAutoAttach(raw, true, sessionId);
  }

  function hasMainDoc(targetId: string): boolean {
    return store.events.some(
      (e) => !isRawAction(e) && e.targetId === targetId && e.requestType === "mainDoc",
    );
  }

  async function maybeLateDocument(ps: TargetNetworkSession): Promise<void> {
    if (stopping || hasMainDoc(ps.targetId)) return;
    if (!isRecordableUrl(ps.pageUrl)) return;
    try {
      const response = (await raw.send(
        "Runtime.evaluate",
        {
          expression:
            "({ ready: document.readyState, html: document.documentElement ? document.documentElement.outerHTML : '', href: location.href })",
          returnByValue: true,
        },
        ps.sessionId,
      )) as {
        result?: { value?: { ready?: string; html?: string; href?: string } };
      };
      if (stopping || hasMainDoc(ps.targetId)) return;
      const v = response?.result?.value;
      if (!v || (v.ready !== "interactive" && v.ready !== "complete")) return;
      const href = v.href && isRecordableUrl(v.href) ? v.href : ps.pageUrl;
      if (!isRecordableUrl(href)) return;
      const html = typeof v.html === "string" ? v.html : "";
      if (!html.includes("<")) return;
      const row = store.appendRequest(
        {
          requestType: "mainDoc",
          url: parseUrl(href),
          frameUrl: parseUrl(href),
          headers: {},
          requestBody: null,
          responseBody: null,
          late: true,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
        true,
        ps.targetId,
      );
      await attachResponseBody(row, store.recordDir, Buffer.from(html, "utf8"), "html");
    } catch {
      /* skip */
    }
  }

  function bindSession(sessionId: string, targetId: string, url: string): void {
    if (stopping || sessionsByTarget.has(targetId)) return;

    const t0 = Date.now();
    const ps: TargetNetworkSession = {
      sessionId,
      targetId,
      mainFrameId: "",
      pageUrl: url,
      attachedAt: t0,
      byRequestId: new Map(),
      send: raw.send,
    };
    sessionsBySessionId.set(sessionId, ps);
    sessionsByTarget.set(targetId, ps);
    sessionToTarget.set(sessionId, targetId);

    void raw
      .send("Page.getFrameTree", {}, sessionId)
      .then((tree) => {
        const t = tree as {
          frameTree: {
            frame: { id: string; url?: string };
            childFrames?: { frame: { id: string; url?: string } }[];
          };
        };
        if (t?.frameTree?.frame) {
          ps.mainFrameId = t.frameTree.frame.id;
          ps.pageUrl = t.frameTree.frame.url || ps.pageUrl;
          frameUrlMap.set(t.frameTree.frame.id, ps.pageUrl);
          if (t.frameTree.childFrames) {
            for (const child of t.frameTree.childFrames) {
              if (child.frame?.id && child.frame?.url) {
                frameUrlMap.set(child.frame.id, child.frame.url);
              }
            }
          }
        }
        return maybeLateDocument(ps);
      })
      .catch(() => {});
  }

  const offEvents = [
    raw.on("Page.javascriptDialogOpening", (_params, sessId) => {
      if (sessId) {
        raw.send("Page.handleJavaScriptDialog", { accept: true }, sessId).catch(() => {});
      }
    }),

    raw.on("Page.frameNavigated", (params, sessId) => {
      const data = params as {
        frame: { id: string; url: string; parentId?: string };
      };
      if (data?.frame) {
        frameUrlMap.set(data.frame.id, data.frame.url);
        if (sessId && !data.frame.parentId) {
          const ps = sessionsBySessionId.get(sessId);
          if (ps) {
            ps.pageUrl = data.frame.url;
            void maybeLateDocument(ps);
          }
        }
      }
    }),

    raw.on("Page.loadEventFired", (_params, sessId) => {
      if (!sessId) return;
      const ps = sessionsBySessionId.get(sessId);
      if (ps) void maybeLateDocument(ps);
    }),

    raw.on("Network.requestWillBeSent", (params, sessionId) => {
      if (stopping || !sessionId) return;
      const ps = sessionsBySessionId.get(sessionId);
      if (!ps) return;
      onRequestWillBeSent(ps, params as Parameters<typeof onRequestWillBeSent>[1]);
    }),

    raw.on("Network.responseReceived", (params, sessionId) => {
      if (stopping || !sessionId) return;
      const ps = sessionsBySessionId.get(sessionId);
      if (!ps) return;
      const p = params as {
        requestId: string;
        response: { status: number; headers: Record<string, string> };
      };
      const row = ps.byRequestId.get(p.requestId);
      if (!row) return;
      row.status = p.response.status;
      row.responseHeaders = p.response.headers;
    }),

    raw.on("Network.loadingFinished", (params, sessionId) => {
      if (stopping || !sessionId) return;
      const ps = sessionsBySessionId.get(sessionId);
      if (!ps) return;
      void onLoadingFinished(ps, params as { requestId: string }).catch(() => {});
    }),

    raw.on("Network.loadingFailed", (params, sessionId) => {
      if (stopping || !sessionId) return;
      const ps = sessionsBySessionId.get(sessionId);
      if (!ps) return;
      const p = params as { requestId: string; errorText: string };
      const row = ps.byRequestId.get(p.requestId);
      if (row) {
        row.errorText = p.errorText;
        row.endedAt = Date.now();
      }
    }),

    raw.on("Target.attachedToTarget", (params) => {
      const e = params as {
        sessionId: string;
        targetInfo: {
          targetId: string;
          type: string;
          url?: string;
          openerId?: string;
        };
      };

      const { sessionId, targetInfo } = e;
      const targetId = targetInfo.targetId;
      pendingSessions.add(sessionId);

      if (stopping) {
        detachSession(sessionId);
        return;
      }

      if (targetInfo.type !== "page" || isChromeUiUrl(targetInfo.url || "")) {
        detachSession(sessionId);
        return;
      }

      void (async () => {
        try {
          if (stopping) {
            detachSession(sessionId);
            return;
          }
          let windowId: number | undefined;
          try {
            const win = (await raw.send(
              "Browser.getWindowForTarget",
              { targetId },
              raw.browserSessionId,
            )) as { windowId?: number };
            windowId = win?.windowId;
          } catch {
            /* gone */
          }
          if (stopping) {
            detachSession(sessionId);
            return;
          }
          const included = tracker.isTargetIncluded(
            targetId,
            targetInfo.openerId,
            windowId,
            Date.now(),
          );
          if (!included) {
            detachSession(sessionId);
            return;
          }
          if (!pipelineTarget(sessionId, targetId, targetInfo.url || "about:blank")) {
            const existing = sessionsByTarget.get(targetId);
            if (!existing || existing.sessionId !== sessionId) {
              detachSession(sessionId);
            }
          }
        } catch {
          detachSession(sessionId);
        }
      })();
    }),

    raw.on("Target.targetCreated", (params) => {
      const created = params as { targetInfo: DiscoveredTarget };
      if (!created?.targetInfo) return;
      void maybeAttachDiscovered(created.targetInfo);
    }),

    raw.on("Target.targetInfoChanged", (params) => {
      const changed = params as { targetInfo: DiscoveredTarget };
      if (!changed?.targetInfo) return;
      void maybeAttachDiscovered(changed.targetInfo);
    }),

    raw.on("Target.detachedFromTarget", (params) => {
      const e = params as { sessionId: string; targetId?: string };
      const ps = sessionsBySessionId.get(e.sessionId);
      if (ps) {
        sessionsBySessionId.delete(e.sessionId);
        sessionsByTarget.delete(ps.targetId);
        sessionToTarget.delete(e.sessionId);
      }
    }),

    raw.on("Target.targetDestroyed", (params) => {
      const e = params as { targetId: string };
      tracker.removeTarget(e.targetId);
      ignoredTargets.delete(e.targetId);
    }),
  ];

  await setDiscoverTargets(raw, true);

  return {
    sessionToTarget,
    attachTarget: (targetId: string) => attachTarget(targetId),
    stop: async () => {
      stopping = true;
      await setDiscoverTargets(raw, false);
      await setPageAutoAttach(raw, false);
      const sessionIds = new Set([
        ...pendingSessions,
        ...[...sessionsBySessionId.values()].map((ps) => ps.sessionId),
      ]);
      await Promise.all(
        [...sessionIds].map((sessionId) => setPageAutoAttach(raw, false, sessionId)),
      );
      await Promise.all(
        [...sessionIds].map((sessionId) =>
          raw
            .send("Target.detachFromTarget", { sessionId }, raw.browserSessionId)
            .catch(() => {}),
        ),
      );
      for (const off of offEvents) off();
      const incomplete = store.dropIncompleteRequests();
      logger.info(`capture stopped: events=${store.events.length} dropped=${dropped} incomplete=${incomplete}`);
    },
  };
}
