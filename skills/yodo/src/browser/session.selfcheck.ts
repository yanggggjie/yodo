import assert from "node:assert/strict";
import {
  CdpContext,
  CdpPage,
  RECORD_WINDOW_TITLE,
  RUN_WINDOW_TITLE,
  closeTargetsKeepChrome,
  isChromeUiUrl,
  type RawCdpConnection,
} from "./session.ts";
import type { TabOps } from "./extension.ts";

assert.equal(isChromeUiUrl("chrome://new-tab-page"), true);
assert.equal(isChromeUiUrl("https://a.com"), false);

/** 内存版扩展：记录每次 tab / window 操作，tab 归 yodo 所有。 */
function fakeTabs() {
  const tabs = new Map<number, { windowId: number; url: string; title: string }>();
  const calls: string[] = [];
  let next = 100;
  const ops: TabOps = {
    openWindow: async ({ focused }) => {
      const windowId = next++;
      const tabId = next++;
      tabs.set(tabId, { windowId, url: "about:blank", title: "" });
      calls.push(`openWindow:focused=${focused}`);
      return { windowId, tabId };
    },
    openTab: async ({ windowId, url }) => {
      const tabId = next++;
      tabs.set(tabId, { windowId, url, title: "" });
      calls.push("openTab");
      return { tabId };
    },
    closeTab: async (tabId) => {
      tabs.delete(tabId);
      calls.push(`closeTab:${tabId}`);
    },
    closeWindow: async (windowId) => {
      for (const [tabId, v] of tabs) if (v.windowId === windowId) tabs.delete(tabId);
      calls.push(`closeWindow:${windowId}`);
    },
    listOwned: async () => ({
      tabs: [...tabs].map(([tabId, v]) => ({ tabId, windowId: v.windowId, url: v.url, title: v.title })),
    }),
    windowOf: async (tabId) => {
      const v = tabs.get(tabId);
      if (!v) throw new Error("tab 不属于 yodo");
      return { windowId: v.windowId, state: "normal" };
    },
    attach: async (tabId) => {
      calls.push(`attach:${tabId}`);
    },
    detach: async (tabId) => {
      calls.push(`detach:${tabId}`);
    },
  };
  return { ops, tabs, calls };
}

type Sent = { method: string; params?: Record<string, unknown>; sessionId?: string };

function fakeRaw(ops: TabOps, sent: Sent[], tabs?: Map<number, { title: string }>) {
  const handlers = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
  const emit = (method: string, params: unknown, sessionId?: string) => {
    for (const h of handlers.get(method) ?? []) h(params, sessionId);
  };
  const raw: RawCdpConnection = {
    ops,
    chromeVersion: "Chrome/test",
    commandTimeoutMs: 15_000,
    send: async (method, params = {}, sessionId) => {
      if (!sessionId) throw new Error(`browser 级 CDP 不可用：${method}`);
      sent.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        const title = /document\.title = ("(?:[^"\\]|\\.)*")/.exec(String(params.expression ?? ""));
        const tab = tabs?.get(Number(sessionId));
        if (title && tab) tab.title = JSON.parse(title[1]!) as string;
        return { result: { type: "string", value: "ok" } };
      }
      if (method === "Page.navigate") {
        queueMicrotask(() => emit("Page.loadEventFired", {}, sessionId));
        return { frameId: "f1" };
      }
      return {};
    },
    on: (method, handler) => {
      let set = handlers.get(method);
      if (!set) handlers.set(method, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    },
    onClose: () => () => {},
    isClosed: () => false,
    close: async () => {},
  };
  return { raw, emit };
}

// 1. CdpPage 直接用 sessionId 发页面级命令；close 走 closeTab
{
  const { ops, calls } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const page = new CdpPage(raw, "100", "100");
  assert.equal(page.targetId, "100");
  await page.close();
  assert.equal(page.isClosed(), true);
  assert.ok(calls.includes("closeTab:100"));
}

// 2. run 窗：每次 run 新开 tab，结束关闭；锚点保留；窗口被关后静默重建
{
  const { ops, tabs, calls } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const first = await ctx.newPage();
  assert.ok(calls.includes("openWindow:focused=false"));
  assert.ok(sent.some((s) => s.method === "Runtime.evaluate" && String(s.params?.expression ?? "").includes(RUN_WINDOW_TITLE)));
  await ctx.endRunTab();
  assert.ok(calls.includes(`closeTab:${first.targetId}`), "run 结束关闭本次 tab");
  assert.equal(tabs.size, 1, "只剩锚点 tab");
  const second = await ctx.newPage();
  assert.notEqual(second.targetId, first.targetId, "每次 run 都是新 tab");
  assert.equal(calls.filter((c) => c.startsWith("openWindow")).length, 1, "run 窗只创建一次");
  await ctx.endRunTab();
  await ctx.closeRunWindow();
  assert.equal(tabs.size, 0, "holder 退出时关掉整扇 run 窗");
  const third = await ctx.newPage();
  assert.ok(third.targetId, "窗口被关后静默重建");
  assert.equal(calls.filter((c) => c.startsWith("openWindow")).length, 2);
}

// 2b. run 期间另开的页面（openRunPage）：开在 run 窗口里，和本次 run 的 tab 一起在 run 结束时关闭，锚点保留
{
  const { ops, tabs, calls } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const main = await ctx.newPage();
  const extra = await ctx.openRunPage();
  assert.notEqual(extra.targetId, main.targetId);
  assert.equal(calls.filter((c) => c.startsWith("openWindow")).length, 1, "额外页面开在同一个 run 窗里");
  assert.equal(tabs.size, 3, "锚点 + 本次 run 的 tab + 额外页面");
  await ctx.endRunTab();
  assert.equal(tabs.size, 1, "run 结束后只剩锚点");
  assert.ok(calls.includes(`closeTab:${extra.targetId}`), "额外页面也被关掉");
}

// 3. 录制窗：focused=false（不抢用户焦点），窗口 id 直接来自 openWindow
{
  const { ops, calls } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const rec = await ctx.openRecordWindow();
  assert.ok(calls.includes("openWindow:focused=false"));
  assert.equal(typeof rec.windowId, "number");
  assert.ok(sent.some((s) => s.method === "Runtime.evaluate" && String(s.params?.expression ?? "").includes(RECORD_WINDOW_TITLE)));
  assert.ok(!sent.some((s) => s.method === "Page.bringToFront"));
}

// 5. tab.removed 事件：页面被标记关闭，不再出现在 pages() 里
{
  const { ops } = fakeTabs();
  const sent: Sent[] = [];
  const { raw, emit } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const page = await ctx.newPage();
  assert.equal(ctx.pages().length, 2, "锚点 tab 与本次 tab");
  emit("tab.removed", { tabId: Number(page.targetId) });
  assert.equal(page.isClosed(), true);
  assert.equal(ctx.pages().length, 1, "只剩锚点");
}

// 6. 对账：扩展刷新或 holder 重启后，run 窗数量不增加
{
  // a) 扩展刷新，holder 还记得 run 窗：保留窗口，关掉残留 tab 和孤儿 run 窗，丢弃附加状态未知的页面记录
  const { ops, tabs, calls } = fakeTabs();
  const { raw } = fakeRaw(ops, [], tabs);
  const ctx = new CdpContext(raw);
  const interrupted = await ctx.newPage(); // run 被打断，tab 没来得及关
  const strayWindow = 900;
  tabs.set(901, { windowId: strayWindow, url: "about:blank", title: RUN_WINDOW_TITLE }); // 更早的 holder 留下的孤儿
  tabs.set(902, { windowId: 800, url: "https://popup.example", title: "popup" }); // yodo 的 tab 打开的普通弹窗，没有 yodo 标题
  await ctx.reconcile({ recordLive: false, runActive: false });
  assert.ok(calls.includes(`closeTab:${interrupted.targetId}`), "残留的 run tab 被关掉");
  assert.ok(calls.includes(`closeWindow:${strayWindow}`), "孤儿 run 窗被关闭");
  assert.ok(!calls.includes("closeWindow:800"), "没有 yodo 标题的窗口绝不会被关闭");
  assert.equal(ctx.pages().length, 0, "页面记录已丢弃");
  const next = await ctx.newPage();
  assert.ok(next.targetId);
  assert.equal(calls.filter((c) => c.startsWith("openWindow")).length, 1, "沿用原 run 窗，没有新开");
}

{
  // b) holder 重启：新的 context 什么都不记得，收养已有的 run 窗并关掉多余的
  const { ops, tabs, calls } = fakeTabs();
  const { raw } = fakeRaw(ops, [], tabs);
  tabs.set(300, { windowId: 30, url: "about:blank", title: RUN_WINDOW_TITLE });
  tabs.set(301, { windowId: 31, url: "about:blank", title: RUN_WINDOW_TITLE });
  const ctx = new CdpContext(raw);
  await ctx.reconcile({ recordLive: false, runActive: false });
  assert.ok(calls.includes("closeWindow:31"), "多出来的 run 窗被关闭");
  assert.ok(!calls.includes("closeWindow:30"), "最早的 run 窗被收养");
  await ctx.newPage();
  assert.equal(calls.filter((c) => c.startsWith("openWindow")).length, 0, "沿用被收养的 run 窗，没有新开窗口");
}

{
  // c) 录制窗：录制进行中不碰，没有录制时才是孤儿
  const { ops, tabs, calls } = fakeTabs();
  const { raw } = fakeRaw(ops, [], tabs);
  tabs.set(500, { windowId: 50, url: "about:blank", title: RECORD_WINDOW_TITLE });
  const ctx = new CdpContext(raw);
  await ctx.reconcile({ recordLive: true, runActive: false });
  assert.ok(!calls.includes("closeWindow:50"), "录制进行中不关录制窗");
  await ctx.reconcile({ recordLive: false, runActive: false });
  assert.ok(calls.includes("closeWindow:50"), "没有录制时录制窗是孤儿");
}

{
  // d) 有 run 正在进行：不关它的 tab，也不丢它的页面记录
  const { ops, calls } = fakeTabs();
  const { raw } = fakeRaw(ops, []);
  const ctx = new CdpContext(raw);
  const running = await ctx.newPage();
  await ctx.reconcile({ recordLive: false, runActive: true });
  assert.ok(!calls.includes(`closeTab:${running.targetId}`), "进行中的 run 的 tab 不被关闭");
  assert.equal(ctx.pages().some((p) => p.targetId === running.targetId), true, "进行中的 run 的页面记录保留");
}

// 7. JS 对话框：run 页面无人值守自动点"确定"；录制页面由用户自己选，holder 不处理
{
  const { ops, tabs } = fakeTabs();
  const sent: Sent[] = [];
  const { raw, emit } = fakeRaw(ops, sent, tabs);
  const ctx = new CdpContext(raw);
  const run = await ctx.newPage();
  emit("Page.javascriptDialogOpening", {}, run.sessionId);
  const rec = await ctx.openRecordWindow();
  emit("Page.javascriptDialogOpening", {}, rec.page.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const handled = (sessionId: string) => sent.some((s) => s.method === "Page.handleJavaScriptDialog" && s.sessionId === sessionId);
  assert.equal(handled(run.sessionId), true, "run 页面的对话框自动处理");
  assert.equal(handled(rec.page.sessionId), false, "录制页面的对话框交给用户，不自动点确定");
}

// 8. 关掉最后一个 yodo tab 时开的保活窗：标题与 run 窗锚点一致，之后对账和 run 会接管它，而不是永远留着空白窗
{
  const { ops, tabs } = fakeTabs();
  const { raw } = fakeRaw(ops, [], tabs);
  const only = await ops.openWindow({ focused: false });
  await closeTargetsKeepChrome(raw, [String(only.tabId)]);
  assert.deepEqual([...tabs.values()].map((t) => t.title), [RUN_WINDOW_TITLE]);
}

// 9. run 结束：关掉本次 run 的 tab，以及 run 期间在 run 窗口里新开的 tab（点 target=_blank 链接等）；锚点和别的窗口不动
{
  const { ops, tabs, calls } = fakeTabs();
  const { raw } = fakeRaw(ops, [], tabs);
  const ctx = new CdpContext(raw);
  const page = await ctx.newPage();
  const runWindow = tabs.get(Number(page.targetId))!.windowId;
  const anchorId = [...tabs].find(([id, v]) => v.windowId === runWindow && String(id) !== page.targetId)![0];
  tabs.set(950, { windowId: runWindow, url: "https://opened.example", title: "opened by the task" }); // 扩展按 opener 纳入的新 tab
  tabs.set(951, { windowId: 777, url: "https://other.example", title: "" }); // 别的窗口里的 yodo tab：这里不处理
  await ctx.endRunTab();
  assert.ok(calls.includes(`closeTab:${page.targetId}`), "本次 run 的 tab 被关闭");
  assert.ok(calls.includes("closeTab:950"), "run 期间新开的 tab 被关闭");
  assert.ok(!calls.includes(`closeTab:${anchorId}`), "锚点不关");
  assert.ok(!calls.includes("closeTab:951"), "别的窗口里的 tab 不关");
  assert.equal(tabs.has(anchorId), true);
}

console.log("browser session selfcheck ok");
