import assert from "node:assert/strict";
import {
  ActiveRecordStore,
  closeTrackedWindows,
  publicId,
  RecordWindowTracker,
  startCdpNetworkRecorder,
  startInjectEvents,
} from "./collect.ts";
import { DomRecordStore } from "./dom.ts";
import { isRecordableUrl, kindOfCdpResourceType } from "./requests.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drive, lateAttachVariant, loadDomFixture, loadFixture, loadGolden, replayDom, replayLog } from "./fixtures/helpers.ts";
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
assert.equal(tracker.isTargetIncluded("target_unrelated", "target_other", 201), false);
// 没有 opener、也不在录制窗口里的 tab 不归属（扩展只上报 opener 属于 yodo 的新 tab）。
assert.equal(tracker.isTargetIncluded("target_no_opener", undefined, undefined), false);
assert.equal(tracker.isTargetIncluded("target_other_window", undefined, 999), false);

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
        return { frameTree: { frame: { id: "f1", url: "https://z.com" }, childFrames: [{ frame: { id: "f2", parentId: "f1", url: "https://z.com/frame" } }] } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 77 };
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
  const inject = startInjectEvents(raw, storeBind, trackerBind, domStore);
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

// 6. 真实 Chrome 抓到的事件经采集端回放，输出与旧实现一致
{
  const fx = loadFixture();
  assert.deepEqual(await drive(fx), loadGolden("local-site"));
  assert.deepEqual(await drive(lateAttachVariant(fx)), loadGolden("local-site-late"));
}

// 7. YODO_RECORD_LOG：导出的日志可以被拼装器原样回放，得到同样的结果
{
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "record-log-")), "log.json");
  const rows = await drive(loadFixture(), logPath);
  const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
  assert.ok(log.some((e: { method: string }) => e.method === "yodo.body"), "日志里带着取回的响应体");
  assert.deepEqual(replayLog(log), rows);
  fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
}

// 8. 开始采集时页面已经加载完：对已有的 frame（含 iframe）立刻补注入，因为新文档脚本只对之后新建的文档生效
{
  const ext = fakeExtension([{ tabId: 801, windowId: 1, url: "https://z.com" }]);
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ext.ops, sent);
  const t = new RecordWindowTracker();
  t.initWindow("801", 1);
  const rec = await startCdpNetworkRecorder(raw, new ActiveRecordStore("inject", Date.now(), "/tmp"), t);
  await rec.attachTarget("801");
  await pause();
  assert.deepEqual(sent.filter((s) => s.method === "Page.createIsolatedWorld").map((s) => s.params?.frameId), ["f1", "f2"]);
  const injected = sent.filter((s) => s.method === "Runtime.evaluate" && s.params?.contextId === 77);
  assert.equal(injected.length, 2);
  assert.ok(String(injected[0]!.params?.expression).includes("__yodoGen"), "补注入执行的是采集脚本");
  assert.ok(sent.some((s) => s.method === "Page.addScriptToEvaluateOnNewDocument"), "之后新建的文档仍由新文档脚本注入");
  await rec.stop();
}

// 9. 真实 Chrome 里用可信鼠标、键盘输入抓到的页面脚本事件，经 startInjectEvents 和时间线规则整理
{
  const fx = loadDomFixture();
  const route = fx.navigatedWithinDocument[1]!.url;
  const { rows, ready } = replayDom(fx, [
    { method: "Page.frameNavigated", params: { frame: { id: "m", url: "http://127.0.0.1:18766/controls" } } },
    { method: "Page.frameNavigated", params: { frame: { id: "s", parentId: "m", url: "about:blank" } } },
    { method: "Page.navigatedWithinDocument", params: { url: route } },
  ]);
  assert.ok(ready.has(fx.tabId), "收到页面脚本的 ready 信号");

  // role 与 name 和 Chrome 自己的无障碍树一致（夹具里的 ax 是当时用 Accessibility.getPartialAXTree 读到的）
  const pairs: Array<[string, string]> = [["#save", "#save"], ["#more", "#more"], ["#q", "#q"], ['input[name="city"]', "[name=city]"], ['input[name="pwd"]', "[name=pwd]"], ["#agree", "#agree"], ["#close", "#close"]];
  for (const [selector, axKey] of pairs) {
    const row = rows.find((r) => r.selector === selector);
    assert.ok(row, `有 ${selector} 的操作`);
    assert.equal(row.name, fx.ax[axKey]!.name, `${selector} 的 name`);
    assert.equal(row.role, fx.ax[axKey]!.role, `${selector} 的 role`);
  }

  // 点击按钮里的图标，算作点了按钮；点击 label，算作点了它控制的复选框，且只留下 checked
  assert.ok(rows.some((r) => r.actionType === "click" && r.selector === "#save"));
  assert.deepEqual(rows.filter((r) => r.selector === "#agree").map((r) => [r.actionType, r.checked]), [["checked", true]]);
  // 文本框先 fill、失焦又 change，只留一条；密码只有 valueRedacted
  assert.deepEqual(rows.filter((r) => r.selector === "#q").map((r) => [r.actionType, r.value]), [["value", "hello"]]);
  const password = rows.find((r) => r.selector === 'input[name="pwd"]')!;
  assert.equal(password.valueRedacted, true);
  assert.equal("value" in password, false);
  // 没有可交互元素的点击只取元素自己的文字，不取整个容器的文字
  assert.equal(rows.find((r) => r.selector === "p.desc")?.name, "卡片说明文字");
  // iframe 里的点击带 frame；shadow DOM 里的点击用宿主的选择器
  assert.match(rows.find((r) => r.selector === "#fb")?.frame ?? "", /frame-btn/);
  assert.equal(rows.find((r) => r.name === "影子按钮")?.selector, "#host");
  // 滚动：容器滚动带 selector，整页滚动没有 selector 和 name；都带位移
  assert.equal(rows.find((r) => r.actionType === "scroll" && r.selector === "#list")?.deltaY, 90);
  const pageScroll = rows.find((r) => r.actionType === "scroll" && !r.selector && r.deltaY === 400);
  assert.ok(pageScroll && !("name" in pageScroll));
  // 导航：主框架、页面内路由变化记录；iframe 里的 about:blank 不记录
  const urls = rows.filter((r) => r.actionType === "navigation").map((r) => r.url);
  assert.ok(urls.includes("http://127.0.0.1:18766/controls") && urls.includes(route));
  assert.ok(!urls.includes("about:blank"));
}

console.log("record collect selfcheck ok");
