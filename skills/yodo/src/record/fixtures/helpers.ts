/** 录制自检的公共辅助：加载真实 Chrome 抓到的 CDP 事件夹具，并把请求记录规范成可比较的形式。 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ActiveRecordStore, RecordWindowTracker, startCdpNetworkRecorder, startInjectEvents } from "../collect.ts";
import { DomRecordStore, simpleDomTimeline } from "../dom.ts";
import type { RawCdpConnection } from "../../browser/index.ts";
import { isRecordableUrl, RequestAssembler, writeResponseBody, type FeedAction, type LogEvent } from "../requests.ts";
import type { RawRequest } from "../types.ts";

type FixtureEvent = { method: string; params: Record<string, any> };
export type Fixture = {
  tabId: string;
  frameTree: unknown;
  snapshot: unknown;
  events: FixtureEvent[];
  bodies: Record<string, { body: string; base64Encoded: boolean } | { error: string }>;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture(name = "local-site"): Fixture {
  return JSON.parse(fs.readFileSync(path.join(HERE, `${name}.json`), "utf8")) as Fixture;
}

export function loadGolden(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(HERE, `${name}.golden.json`), "utf8"));
}

/** 模拟「attach 时页面已经加载完」：去掉第一个主文档请求的全部 Network 事件。 */
export function lateAttachVariant(fx: Fixture): Fixture {
  const first = fx.events.find(
    (e) => e.method === "Network.requestWillBeSent" && e.params.type === "Document" && String(e.params.request.url).endsWith(":18765/"),
  );
  const id = first?.params.requestId;
  return { ...fx, events: fx.events.filter((e) => !(e.method.startsWith("Network.") && e.params.requestId === id)) };
}

/** 去掉时间戳（endedAt、补抓行的 startedAt），把响应体文件换成大小和哈希，便于比较。 */
function normalizeRows(rows: RawRequest[], recordDir: string): unknown {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    delete copy.endedAt;
    if (row.late) delete copy.startedAt;
    if (row.responseBodyPath) {
      const bytes = fs.readFileSync(path.join(recordDir, row.responseBodyPath));
      copy.responseBodyPath = { name: row.responseBodyPath, size: bytes.length, sha1: crypto.createHash("sha1").update(bytes).digest("hex") };
    }
    return copy;
  });
}

/** 把夹具里的事件按顺序喂给 RequestAssembler，模拟采集端的行为（取响应体、补抓主文档），返回原始的请求记录；用完要调用 cleanup。 */
export function replayStore(fx: Fixture): { rows: RawRequest[]; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
  const store = new ActiveRecordStore("replay", 0, dir);
  const assembler = new RequestAssembler(store, writeResponseBody(dir));
  let t = 0;
  const feed = (method: string, params: unknown): FeedAction => assembler.feed({ t: ++t, tabId: fx.tabId, method, params });
  const snapshotIfNeeded = (): void => {
    if (!assembler.hasMainDoc(fx.tabId) && isRecordableUrl(assembler.pageUrl(fx.tabId) ?? "")) feed("yodo.snapshot", fx.snapshot);
  };

  feed("yodo.tab", { url: "about:blank" });
  feed("yodo.frameTree", fx.frameTree);
  snapshotIfNeeded();
  for (const e of fx.events) {
    const action = feed(e.method, e.params);
    if (action && "fetchBody" in action) {
      const requestId = action.fetchBody.requestId;
      const body = fx.bodies[requestId];
      feed("yodo.body", body && !("error" in body) ? { requestId, ...body } : { requestId, error: body && "error" in body ? body.error : "no body" });
    } else if (action && "snapshot" in action) {
      snapshotIfNeeded();
    }
  }
  store.dropIncompleteRequests();
  return { rows: store.events, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** replayStore 的结果，规范化后便于比较。 */
export function replay(fx: Fixture): unknown {
  const { rows, dir, cleanup } = replayStore(fx);
  try {
    return normalizeRows(rows, dir);
  } finally {
    cleanup();
  }
}

/** 直接回放事件日志（日志里已经带着 yodo.body、yodo.snapshot，不需要采集端的 I/O）。 */
export function replayLog(log: LogEvent[]): unknown {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-log-"));
  try {
    const store = new ActiveRecordStore("replay-log", 0, dir);
    const assembler = new RequestAssembler(store, writeResponseBody(dir));
    for (const ev of log) assembler.feed(ev);
    store.dropIncompleteRequests();
    return normalizeRows(store.events, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 用内存版的 raw 连接驱动真正的网络采集端：事件按顺序发出，响应体、frameTree、页面 HTML 从夹具里取。 */
export async function drive(fx: Fixture, logPath?: string): Promise<unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  const previous = process.env.YODO_RECORD_LOG;
  if (logPath) process.env.YODO_RECORD_LOG = logPath;
  else delete process.env.YODO_RECORD_LOG;
  try {
    const handlers = new Map<string, (params: unknown, sessionId?: string) => void>();
    const ops = { attach: async () => {}, detach: async () => {} };
    const raw = {
      ops,
      chromeVersion: "test",
      commandTimeoutMs: 1000,
      onClose: () => () => {},
      isClosed: () => false,
      close: async () => {},
      on: (method: string, handler: (params: unknown, sessionId?: string) => void) => {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
      send: async (method: string, params: { requestId?: string }) => {
        if (method === "Page.getFrameTree") return fx.frameTree;
        if (method === "Runtime.evaluate") return { result: { value: fx.snapshot } };
        if (method === "Network.getResponseBody") {
          const body = fx.bodies[params.requestId ?? ""];
          if (!body || "error" in body) throw new Error(body && "error" in body ? body.error : "no body");
          return body;
        }
        return {};
      },
    } as unknown as RawCdpConnection;
    const tracker = new RecordWindowTracker();
    tracker.initWindow(fx.tabId, 1);
    const store = new ActiveRecordStore("drive", Date.now(), dir);
    const recorder = await startCdpNetworkRecorder(raw, store, tracker);
    await recorder.attachTarget(fx.tabId);
    const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
    await tick();
    for (const e of fx.events) {
      handlers.get(e.method)?.(e.params, fx.tabId);
      await tick();
    }
    await tick(100);
    await recorder.stop();
    return normalizeRows(store.events, dir);
  } finally {
    if (previous === undefined) delete process.env.YODO_RECORD_LOG;
    else process.env.YODO_RECORD_LOG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export type DomFixture = {
  tabId: string;
  payloads: Array<Record<string, unknown>>;
  navigatedWithinDocument: Array<{ url: string }>;
  ax: Record<string, { role: string; name: string }>;
};

export function loadDomFixture(): DomFixture {
  return JSON.parse(fs.readFileSync(path.join(HERE, "dom-events.json"), "utf8")) as DomFixture;
}

/** 把页面脚本回传的载荷按顺序交给真正的 startInjectEvents，再整理成 timeline 里的操作行。 */
export function replayDom(fx: DomFixture, extra: Array<{ method: string; params: unknown }> = []): { rows: ReturnType<typeof simpleDomTimeline>; ready: Set<string> } {
  const handlers = new Map<string, (params: unknown, sessionId?: string) => void>();
  const raw = {
    on: (method: string, handler: (params: unknown, sessionId?: string) => void) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
  } as unknown as RawCdpConnection;
  const tracker = new RecordWindowTracker();
  tracker.initWindow(fx.tabId, 1);
  const store = new ActiveRecordStore("dom", 0, os.tmpdir());
  const domStore = new DomRecordStore();
  const recorder = startInjectEvents(raw, store, tracker, domStore);
  for (const payload of fx.payloads) handlers.get("Runtime.bindingCalled")?.({ name: "__yodoEvent", payload: JSON.stringify(payload) }, fx.tabId);
  for (const e of extra) handlers.get(e.method)?.(e.params, fx.tabId);
  void recorder.stop();
  return { rows: simpleDomTimeline(domStore.events), ready: domStore.ready };
}
