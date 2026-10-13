import assert from "node:assert/strict";
import {
  ActiveRecordStore,
  closeTrackedWindows,
  isRecordableUrl,
  kindOfCdpResourceType,
  publicId,
  RecordWindowTracker,
  startCdpNetworkRecorder,
  startInjectEvents,
} from "./collect.ts";
import { DomRecordStore } from "./dom.ts";
import type { RawCdpConnection, TabOps } from "../browser/index.ts";

assert.ok(isRecordableUrl("https://example.com/a"));
assert.ok(!isRecordableUrl("chrome://version"));
assert.equal(publicId("event", 7), "event_007");
assert.equal(kindOfCdpResourceType("Document"), "document");
assert.equal(kindOfCdpResourceType("XHR"), "xhr");
assert.equal(kindOfCdpResourceType("Script"), undefined);

const tracker = new RecordWindowTracker();
tracker.initWindow("target_born", 100);
assert.equal(tracker.isKnownTarget("target_born"), true);
assert.equal(tracker.isTargetIncluded("target_tab2", undefined, 100), true);
assert.equal(tracker.isTargetIncluded("target_other", undefined, 999), false);
assert.equal(tracker.isTargetIncluded("target_popup", "target_tab2", 200), true);
assert.equal(tracker.isTargetIncluded("target_unrelated", "target_other", 201, 1000), false);
tracker.recordGesture(10_000);
assert.equal(tracker.isTargetIncluded("target_noopener_popup", undefined, undefined, 11_000), true);
assert.equal(tracker.isTargetIncluded("target_other_window", undefined, 999, 11_000), false);
assert.equal(tracker.isTargetIncluded("target_late", undefined, undefined, 15_000), false);

type Sent = { method: string; sessionId?: string; params?: Record<string, unknown> };

/** 内存版扩展：tab 操作记录到 calls；页面级命令记录到 sent；事件用 emit 模拟。 */
function fakeExtension(tabsOwned: { tabId: number; windowId: number; url: string }[]) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const tabs = [...tabsOwned];
  const ops: TabOps = {
    openWindow: async ({ focused }) => {
      calls.push({ method: "openWindow", params: { focused } });
      return { windowId: 500, tabId: 600 };
    },
    openTab: async () => ({ tabId: 601 }),
    closeTab: async (tabId) => {
      calls.push({ method: "closeTab", params: { tabId } });
    },
    closeWindow: async () => {},
    listOwned: async () => ({ tabs: tabs.map((t) => ({ ...t, title: "" })) }),
    windowOf: async (tabId) => {
      const t = tabs.find((x) => x.tabId === tabId);
      if (!t) throw new Error("gone");
      return { windowId: t.windowId, state: "normal" };
    },
    attach: async (tabId) => {
      calls.push({ method: "attach", params: { tabId } });
    },
    detach: async (tabId) => {
      calls.push({ method: "detach", params: { tabId } });
    },
  };
  return { ops, calls, tabs };
}

function fakeRaw(ops: TabOps, sent: Sent[]) {
  const handlers = new Map<string, (params: unknown, sessionId?: string) => void>();
  const emit = (method: string, params: unknown, sessionId?: string) => handlers.get(method)?.(params, sessionId);
  const raw: RawCdpConnection = {
    ops,
    chromeVersion: "test",
    commandTimeoutMs: 15_000,
    send: async (method, params, sessionId) => {
      if (!sessionId) throw new Error(`browser 级 CDP 不可用：${method}`);
      sent.push({ method, params, sessionId });
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "f1", url: "https://z.com" } } };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { ready: "complete", html: "<html><body>late</body></html>", href: "https://z.com/" },
          },
        };
      }
      return {};
    },
    on: (method, handler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
    onClose: () => () => {},
    isClosed: () => false,
    close: async () => {},
  };
  return { raw, emit };
}

const pause = () => new Promise((r) => setTimeout(r, 20));

// 1. 发现与附加：录制窗内的新 tab 附加；无关窗口的 tab 不附加；chrome:// 不附加
{
  const ext = fakeExtension([{ tabId: 102, windowId: 1, url: "https://z.com" }]);
  const sent: Sent[] = [];
  const { raw, emit } = fakeRaw(ext.ops, sent);
  const recTracker = new RecordWindowTracker();
  recTracker.initWindow("101", 1);
  const store = new ActiveRecordStore("selfcheck", Date.now(), "/tmp");
  const rec = await startCdpNetworkRecorder(raw, store, recTracker);

  emit("tab.created", { tabId: 103, windowId: 99, url: "https://x.com" });
  await pause();
  assert.ok(!ext.calls.some((c) => c.method === "attach" && c.params?.tabId === 103), "无关窗口的 tab 不附加");
  assert.ok(!sent.some((s) => s.method === "Network.enable"));

  emit("tab.created", { tabId: 104, windowId: 1, url: "chrome://new-tab-page" });
  await pause();
  assert.ok(!ext.calls.some((c) => c.method === "attach" && c.params?.tabId === 104), "chrome:// 不附加");

  emit("tab.updated", { tabId: 104, windowId: 1, url: "https://z.com/" });
  await pause();
  assert.ok(ext.calls.some((c) => c.method === "attach" && c.params?.tabId === 104), "导航到真实页面后附加");
  assert.ok(sent.some((s) => s.method === "Network.enable" && s.sessionId === "104"));
  assert.ok(sent.some((s) => s.method === "Page.addScriptToEvaluateOnNewDocument" && s.sessionId === "104"));

  // 同一个 tab 再次上报不重复附加
  const attachesBefore = ext.calls.filter((c) => c.method === "attach").length;
  emit("tab.updated", { tabId: 104, windowId: 1, url: "https://z.com/next" });
  await pause();
  assert.equal(ext.calls.filter((c) => c.method === "attach").length, attachesBefore);

  // 录制结束：分离已附加的 tab
  await rec.stop();
  assert.ok(ext.calls.some((c) => c.method === "detach" && c.params?.tabId === 104));
  emit("tab.created", { tabId: 105, windowId: 1, url: "https://z.com" });
  await pause();
  assert.ok(!ext.calls.some((c) => c.method === "attach" && c.params?.tabId === 105), "停止后不再附加");
}

// 2. 录制窗 tab 关闭：从 tracker 移除
{
  const ext = fakeExtension([]);
  const sent: Sent[] = [];
  const { raw, emit } = fakeRaw(ext.ops, sent);
  const t = new RecordWindowTracker();
  t.initWindow("201", 3);
  t.initWindow("202", 3);
  const store = new ActiveRecordStore("removed", Date.now(), "/tmp");
  const rec = await startCdpNetworkRecorder(raw, store, t);
  emit("tab.removed", { tabId: 201, windowId: 3 });
  assert.equal(t.isKnownTarget("201"), false);
  assert.equal(t.isKnownTarget("202"), true);
  await rec.stop();
}

// 3. closeTrackedWindows：只关 tracker 登记的窗口；用户窗口不动
{
  // listOwned 只含 yodo 的 tab；用户的 tab（302）不在其中
  const ext = fakeExtension([{ tabId: 301, windowId: 10, url: "https://z.com" }]);
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ext.ops, sent);
  const t = new RecordWindowTracker();
  t.initWindow("301", 10);
  await closeTrackedWindows(raw, t);
  assert.ok(ext.calls.some((c) => c.method === "closeTab" && c.params?.tabId === 301));
  assert.ok(!ext.calls.some((c) => c.method === "closeTab" && c.params?.tabId === 302), "用户窗口的 tab 不关");
  assert.ok(ext.calls.some((c) => c.method === "openWindow"), "没有其它窗口时开一扇后台窗");
}

// 4. 同一 tab 重复附加只会 pipeline 一次
{
  const ext = fakeExtension([{ tabId: 401, windowId: 1, url: "https://z.com" }]);
  const sent: Sent[] = [];
  const { raw, emit } = fakeRaw(ext.ops, sent);
  const t = new RecordWindowTracker();
  t.initWindow("400", 1);
  const store = new ActiveRecordStore("once", Date.now(), "/tmp");
  const rec = await startCdpNetworkRecorder(raw, store, t);
  emit("tab.created", { tabId: 401, windowId: 1, url: "https://z.com" });
  await pause();
  await rec.attachTarget("401");
  emit("tab.updated", { tabId: 401, windowId: 1, url: "https://z.com/2" });
  await pause();
  assert.equal(sent.filter((s) => s.method === "Network.enable").length, 1);
  assert.equal(sent.filter((s) => s.method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
  assert.equal(sent.filter((s) => s.method === "Runtime.addBinding").length, 1);
  await rec.stop();
}

// 5. 页面事件注入：binding 事件按 sessionId 归属；未知 session 忽略
{
  const handlers = new Map<string, (params: unknown, sessionId?: string) => void>();
  const sent: Sent[] = [];
  const raw: RawCdpConnection = {
    ops: fakeExtension([]).ops,
    chromeVersion: "test",
    commandTimeoutMs: 15_000,
    send: async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      return {};
    },
    on: (method, handler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
    onClose: () => () => {},
    isClosed: () => false,
    close: async () => {},
  };
  const trackerBind = new RecordWindowTracker();
  trackerBind.initWindow("501", 1);
  const storeBind = new ActiveRecordStore("bind", Date.now(), "/tmp");
  const domStore = new DomRecordStore();
  const inject = startInjectEvents(raw, storeBind, trackerBind, new Map([["501", "501"]]), domStore);
  const onBinding = handlers.get("Runtime.bindingCalled");
  assert.ok(onBinding);
  const payload = JSON.stringify({ kind: "click", frameUrl: "https://z.com", role: "button", name: "ok", startedAt: 1000 });
  onBinding({ name: "__yodoEvent", payload }, "501");
  onBinding({ name: "__yodoEvent", payload }, "999");
  onBinding({ name: "__yodoEvent", payload });
  const clicks = domStore.events.filter((e) => e.type === "click");
  assert.equal(clicks.length, 1);
  await inject.stop();
}

console.log("record collect selfcheck ok");
