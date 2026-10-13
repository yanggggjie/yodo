import * as fsSync from "node:fs";
import { MAX_BODY_BYTES } from "../utils/constants.ts";
import { createLogger } from "../utils/logger.ts";
import { closeTargetsKeepChrome, isChromeUiUrl, type RawCdpConnection } from "../browser/index.ts";
import { isRecordableUrl, RequestAssembler, writeResponseBody, type LogEvent } from "./requests.ts";
import type { DomTimelineItem, RawEvent, RawRequest } from "./types.ts";
import type { DomRecordStore } from "./dom.ts";

const logger = createLogger("record");

export function publicId(kind: string, n: number): string {
  return `${kind}_${String(n).padStart(3, "0")}`;
}

export class RecordWindowTracker {
  readonly activeWindowIds = new Set<number>();
  readonly activeTargets = new Set<string>();

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

  isTargetIncluded(
    targetId: string,
    openerId?: string,
    targetWindowId?: number,
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
    return false;
  }

  removeTarget(targetId: string): void {
    this.activeTargets.delete(targetId);
  }

  isKnownTarget(targetId: string): boolean {
    return this.activeTargets.has(targetId);
  }
}

/** 只关录制窗的 tab。扩展里 listOwned 给出每个 tab 所在的窗口，按 tracker 登记的窗口过滤。 */
export async function closeTrackedWindows(
  raw: RawCdpConnection,
  tracker: RecordWindowTracker,
): Promise<void> {
  const closing = new Set(tracker.activeTargets);
  try {
    const { tabs } = await raw.ops.listOwned();
    for (const t of tabs) {
      if (tracker.activeWindowIds.has(t.windowId)) closing.add(String(t.tabId));
    }
  } catch {
    /* 扩展不可用时只关已知 target */
  }
  if (closing.size === 0) return;
  await closeTargetsKeepChrome(raw, closing);
}

export class ActiveRecordStore {
  readonly events: RawEvent[] = [];
  readonly name: string;
  readonly startedAt: number;
  readonly recordDir: string;
  private nextRequest = 0;
  private active = true;

  constructor(name: string, startedAt: number, recordDir: string) {
    this.name = name;
    this.startedAt = startedAt;
    this.recordDir = recordDir;
  }

  isActive(): boolean {
    return this.active;
  }

  deactivate(): void {
    this.active = false;
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
      // 补抓的主文档（late）没有 HTTP 状态，但它是完整的，要保留。
      if (row.status === undefined && !row.errorText && !row.late) {
        this.events.splice(i, 1);
      }
    }
    return before - this.events.length;
  }
}

export type InjectRecorder = { stop: () => Promise<void> };

/** 注入页面的采集脚本，源码见 inject.js。 */
const INJECT_SOURCE = fsSync.readFileSync(new URL("./inject.js", import.meta.url), "utf8");
const INJECT_WORLD = "__yodo_isolated__";

export function startInjectEvents(
  raw: RawCdpConnection,
  store: ActiveRecordStore,
  tracker: RecordWindowTracker,
  domStore?: DomRecordStore,
): InjectRecorder {
  const offBinding = raw.on("Runtime.bindingCalled", (params, sessionId) => {
    if (!store.isActive()) return;
    const data = params as { name: string; payload: string };
    if (data.name !== "__yodoEvent") return;

    if (!sessionId) return;
    const targetId = sessionId;
    if (!tracker.isKnownTarget(targetId)) return;

    let row: {
      kind?: string;
      frameUrl?: string;
      mainFrame?: boolean;
      startedAt?: number;
      role?: string;
      name?: string;
      selector?: string;
      value?: string;
      valueRedacted?: true;
      checked?: boolean;
      selectedText?: string;
      scroll?: DomTimelineItem["scroll"];
    };
    try {
      row = JSON.parse(data.payload) as typeof row;
    } catch {
      return;
    }

    if (row.kind === "ready") {
      domStore?.markReady(targetId);
      return;
    }
    const type = row.kind === "click" || row.kind === "fill" || row.kind === "change" ? row.kind : row.kind === "scroll" && row.scroll ? "scroll" : undefined;
    if (!type) return;
    const frameUrl = row.frameUrl || "about:blank";
    domStore?.append(targetId, {
      t: row.startedAt ?? Date.now(),
      type,
      url: frameUrl,
      frameUrl,
      mainFrame: row.mainFrame !== false,
      role: row.role,
      name: row.name,
      selector: row.selector,
      value: row.value,
      valueRedacted: row.valueRedacted,
      checked: row.checked,
      selectedText: row.selectedText,
      scroll: row.scroll,
    });
  });
  const offNavigation = raw.on("Page.frameNavigated", (params, sessionId) => {
    if (!domStore || !sessionId) return;
    const targetId = sessionId;
    if (!tracker.isKnownTarget(targetId)) return;
    const data = params as { frame?: { url?: string; parentId?: string } };
    if (!data.frame?.url) return;
    domStore.append(targetId, {
      t: Date.now(),
      type: "navigation",
      url: data.frame.url,
      frameUrl: data.frame.url,
      mainFrame: !data.frame.parentId,
    });
  });

  // 单页应用的路由变化（pushState、hash 变化）不会触发 frameNavigated。
  const offSamePage = raw.on("Page.navigatedWithinDocument", (params, sessionId) => {
    if (!domStore || !sessionId || !tracker.isKnownTarget(sessionId)) return;
    const data = params as { url?: string };
    if (!data.url) return;
    domStore.append(sessionId, { t: Date.now(), type: "navigation", url: data.url, frameUrl: data.url, mainFrame: true });
  });

  return {
    stop: async () => {
      offBinding();
      offNavigation();
      offSamePage();
    },
  };
}

export type CdpNetworkRecorder = {
  attachTarget: (targetId: string) => Promise<void>;
  stop: () => Promise<void>;
};

/** tab 在录制里的阶段：attaching 正在附加，active 已采集，ignored 不属于这次录制，detached 调试器已断开（不再重新附加）。 */
type TabPhase = "attaching" | "active" | "ignored" | "detached";

/**
 * 网络采集端：负责 attach 和所有 I/O（开启域、取响应体、读页面 HTML），
 * 把收到的事件交给 RequestAssembler 拼成请求记录；拼装逻辑本身见 requests.ts。
 * 设置 YODO_RECORD_LOG=<路径> 时，stop 时把喂给拼装器的全部事件写成 JSON，可直接作为测试夹具；
 * 日志含未脱敏的请求头和响应体，默认不记录。
 */
export async function startCdpNetworkRecorder(
  raw: RawCdpConnection,
  store: ActiveRecordStore,
  tracker: RecordWindowTracker,
): Promise<CdpNetworkRecorder> {
  const assembler = new RequestAssembler(store, writeResponseBody(store.recordDir));
  // sessionId 就是 tabId 的字符串形式，所以每个 tab 只需要一份状态。
  const tabs = new Map<string, TabPhase>();
  const logPath = process.env.YODO_RECORD_LOG;
  const log: LogEvent[] = [];
  let stopping = false;

  const networkEnableParams = {
    maxResourceBufferSize: MAX_BODY_BYTES,
    maxTotalBufferSize: MAX_BODY_BYTES * 4,
  };

  function feed(tabId: string, method: string, params: unknown): void {
    const ev: LogEvent = { t: Date.now(), tabId, method, params };
    if (logPath) log.push(ev);
    const action = assembler.feed(ev);
    if (!action) return;
    if ("fetchBody" in action) void fetchBody(tabId, action.fetchBody);
    else void maybeSnapshot(tabId);
  }

  /** 响应体只能在资源缓冲区还在的时候取，所以必须在 loadingFinished 之后立刻取。 */
  async function fetchBody(tabId: string, { requestId, kind }: { requestId: string; kind: "html" | "json" }): Promise<void> {
    try {
      const body = (await raw.send("Network.getResponseBody", { requestId }, tabId)) as { body: string; base64Encoded: boolean };
      feed(tabId, "yodo.body", { requestId, body: body.body, base64Encoded: body.base64Encoded });
    } catch (error) {
      const fallback = kind === "html" ? "document-response-failed" : "response-body-unavailable";
      feed(tabId, "yodo.body", { requestId, error: error instanceof Error ? error.message : fallback });
    }
  }

  /** 页面在开始采集之前就已经加载完：读当前页面的 HTML，交给拼装器补一条主文档。 */
  async function maybeSnapshot(tabId: string): Promise<void> {
    const url = assembler.pageUrl(tabId);
    if (stopping || !url || !isRecordableUrl(url) || assembler.hasMainDoc(tabId)) return;
    try {
      const response = (await raw.send(
        "Runtime.evaluate",
        {
          expression:
            "({ ready: document.readyState, html: document.documentElement ? document.documentElement.outerHTML : '', href: location.href })",
          returnByValue: true,
        },
        tabId,
      )) as { result?: { value?: unknown } };
      if (stopping) return;
      const value = response?.result?.value;
      if (value) feed(tabId, "yodo.snapshot", value);
    } catch {
      /* skip */
    }
  }

  function sendTargetPipeline(tabId: string): void {
    raw.send("Page.enable", {}, tabId).catch(() => {});
    raw.send("Runtime.enable", {}, tabId).catch(() => {});
    raw.send("Page.setBypassCSP", { enabled: true }, tabId).catch(() => {});
    raw.send("Runtime.addBinding", { name: "__yodoEvent" }, tabId).catch(() => {});
    raw.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: INJECT_SOURCE,
        worldName: INJECT_WORLD,
      },
      tabId,
    ).catch(() => {});
    raw.send("Network.enable", networkEnableParams, tabId).catch(() => {});
  }

  /**
   * addScriptToEvaluateOnNewDocument 只对之后新建的文档生效。开始采集时页面如果已经加载完
   * （弹窗、晚 attach），单页应用又不会再新建文档，整个页面的点击、输入、滚动就都录不到，
   * 所以对已经存在的 frame 也立刻执行一次。脚本自己能处理重复注入。
   */
  async function injectIntoLoadedFrames(tabId: string, tree: unknown): Promise<void> {
    const frameIds: string[] = [];
    const walk = (node: { frame?: { id?: string }; childFrames?: unknown[] } | undefined): void => {
      if (node?.frame?.id) frameIds.push(node.frame.id);
      for (const child of node?.childFrames ?? []) walk(child as typeof node);
    };
    walk((tree as { frameTree?: Parameters<typeof walk>[0] })?.frameTree);
    for (const frameId of frameIds) {
      try {
        const world = (await raw.send("Page.createIsolatedWorld", { frameId, worldName: INJECT_WORLD }, tabId)) as { executionContextId: number };
        await raw.send("Runtime.evaluate", { expression: INJECT_SOURCE, contextId: world.executionContextId }, tabId);
      } catch {
        /* frame 已经消失，或不在这个 tab 的会话里 */
      }
    }
  }

  function pipeline(tabId: string, url: string): void {
    sendTargetPipeline(tabId);
    feed(tabId, "yodo.tab", { url });
    raw
      .send("Page.getFrameTree", {}, tabId)
      .then(async (tree) => {
        feed(tabId, "yodo.frameTree", tree);
        await injectIntoLoadedFrames(tabId, tree);
        return maybeSnapshot(tabId);
      })
      .catch(() => {});
  }

  async function attachTarget(tabId: string, url = "about:blank"): Promise<void> {
    if (stopping || tabs.has(tabId)) return;
    if (isChromeUiUrl(url)) return;
    tabs.set(tabId, "attaching");
    try {
      await raw.ops.attach(Number(tabId));
    } catch {
      tabs.delete(tabId); // 附加失败，之后还有机会重试
      return;
    }
    if (stopping) {
      raw.ops.detach(Number(tabId)).catch(() => {});
      return;
    }
    pipeline(tabId, url);
    if (tabs.get(tabId) === "attaching") tabs.set(tabId, "active");
  }

  async function maybeAttachDiscovered(info: { tabId: string; url?: string; openerId?: string; windowId?: number }): Promise<void> {
    if (stopping || tabs.has(info.tabId)) return;
    const url = info.url || "";
    if (isChromeUiUrl(url)) return;
    if (!tracker.isTargetIncluded(info.tabId, info.openerId, info.windowId)) {
      if (info.windowId !== undefined) tabs.set(info.tabId, "ignored");
      return;
    }
    await attachTarget(info.tabId, url || "about:blank");
  }

  const forward = (method: string, gate?: (tabId: string) => boolean) =>
    raw.on(method, (params, sessionId) => {
      if (stopping || !sessionId || (gate && !gate(sessionId))) return;
      feed(sessionId, method, params);
    });

  const offEvents = [
    forward("Page.frameNavigated"),
    forward("Page.loadEventFired"),
    forward("Network.requestWillBeSent", (tabId) => tracker.isKnownTarget(tabId)),
    forward("Network.responseReceived"),
    forward("Network.loadingFinished"),
    forward("Network.loadingFailed"),

    raw.on("tab.created", (params) => {
      const t = params as { tabId: number; windowId: number; openerTabId?: number; url?: string };
      void maybeAttachDiscovered({
        tabId: String(t.tabId),
        url: t.url,
        openerId: t.openerTabId != null ? String(t.openerTabId) : undefined,
        windowId: t.windowId,
      });
    }),

    raw.on("tab.updated", (params) => {
      const t = params as { tabId: number; windowId: number; url?: string };
      void maybeAttachDiscovered({ tabId: String(t.tabId), url: t.url, windowId: t.windowId });
    }),

    raw.on("tab.detached", (params) => {
      const tabId = String((params as { tabId: number }).tabId);
      const phase = tabs.get(tabId);
      if (phase === "attaching" || phase === "active") {
        tabs.set(tabId, "detached");
        feed(tabId, "yodo.tabGone", {});
      }
    }),

    raw.on("tab.removed", (params) => {
      const tabId = String((params as { tabId: number }).tabId);
      tracker.removeTarget(tabId);
      tabs.delete(tabId);
    }),
  ];

  return {
    attachTarget: (targetId: string) => attachTarget(targetId),
    stop: async () => {
      stopping = true;
      const attached = [...tabs].filter(([, phase]) => phase === "attaching" || phase === "active").map(([tabId]) => tabId);
      await Promise.all(attached.map((tabId) => raw.ops.detach(Number(tabId)).catch(() => {})));
      for (const off of offEvents) off();
      const incomplete = store.dropIncompleteRequests();
      logger.info(`capture stopped: events=${store.events.length} dropped=${assembler.dropped} incomplete=${incomplete}`);
      if (logPath) fsSync.writeFileSync(logPath, JSON.stringify(log, null, 1));
    },
  };
}
