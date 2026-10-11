import assert from "node:assert/strict";
import {
  CdpContext,
  CdpPage,
  RECORD_WINDOW_TITLE,
  RUN_WINDOW_TITLE,
  envelopeCdpCommand,
  isChromeUiUrl,
  type RawCdpConnection,
} from "./session.ts";
import type { TabOps } from "./extension.ts";

const flat = envelopeCdpCommand(1, "Network.enable", { a: 1 }, "101");
assert.equal(flat.sessionId, "101");
assert.equal(envelopeCdpCommand(2, "Page.enable").sessionId, undefined);
assert.equal(isChromeUiUrl("chrome://new-tab-page"), true);
assert.equal(isChromeUiUrl("https://a.com"), false);

/** 内存版扩展：记录每次 tab / window 操作，tab 归 yodo 所有。 */
function fakeTabs() {
  const tabs = new Map<number, { windowId: number; url: string }>();
  const calls: string[] = [];
  let next = 100;
  const ops: TabOps = {
    openWindow: async ({ focused }) => {
      const windowId = next++;
      const tabId = next++;
      tabs.set(tabId, { windowId, url: "about:blank" });
      calls.push(`openWindow:focused=${focused}`);
      return { windowId, tabId };
    },
    openTab: async ({ windowId, url }) => {
      const tabId = next++;
      tabs.set(tabId, { windowId, url });
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
      tabs: [...tabs].map(([tabId, v]) => ({ tabId, windowId: v.windowId, url: v.url })),
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

function fakeRaw(ops: TabOps, sent: Sent[]) {
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
      if (method === "Runtime.evaluate") return { result: { type: "string", value: "ok" } };
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
  const page = new CdpPage(raw, "100", "100", "https://example.com");
  assert.equal(page.targetId, "100");
  await page.close();
  assert.equal(page.isClosed(), true);
  assert.ok(calls.includes("closeTab:100"));
}

// 2. run 窗：只开一扇窗，同一个 anchor tab 被复用；endRunTabs 不关窗；closeRunWindow 关 anchor
{
  const { ops, tabs, calls } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const runPage = await ctx.openRunWindow();
  assert.ok(calls.includes("openWindow:focused=false"));
  assert.ok(sent.some((s) => s.method === "Runtime.evaluate" && String(s.params?.expression ?? "").includes(RUN_WINDOW_TITLE)));
  const work = await ctx.newPage();
  assert.equal(work.targetId, runPage.targetId);
  await ctx.openRunWindow();
  assert.equal(calls.filter((c) => c.startsWith("openWindow")).length, 1);
  await ctx.endRunTabs();
  assert.equal(tabs.size, 1, "endRunTabs 不关 anchor tab");
  await ctx.closeRunWindow();
  assert.ok(calls.includes(`closeTab:${runPage.targetId}`), "closeRunWindow 关掉 anchor tab");
  assert.equal(tabs.size, 1, "没有其它窗口时保留一扇后台空白窗，避免 Chrome 退出");
}

// 3. 录制窗：focused=true，窗口 id 直接来自 openWindow
{
  const { ops, calls } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const rec = await ctx.openRecordWindow();
  assert.ok(calls.includes("openWindow:focused=true"));
  assert.equal(typeof rec.windowId, "number");
  assert.ok(sent.some((s) => s.method === "Runtime.evaluate" && String(s.params?.expression ?? "").includes(RECORD_WINDOW_TITLE)));
  assert.ok(!sent.some((s) => s.method === "Page.bringToFront"));
}

// 4. 证书忽略：对已附加 tab 生效，之后新附加的 tab 也生效
{
  const { ops } = fakeTabs();
  const sent: Sent[] = [];
  const { raw } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const page = await ctx.openRunWindow();
  await ctx.setIgnoreCertErrors(true);
  assert.ok(sent.some((s) => s.method === "Security.setIgnoreCertificateErrors" && s.sessionId === page.sessionId && s.params?.ignore === true));
  const rec = await ctx.openRecordWindow();
  assert.ok(sent.some((s) => s.method === "Security.setIgnoreCertificateErrors" && s.sessionId === rec.page.sessionId));
}

// 5. tab.removed 事件：页面被标记关闭，不再出现在 pages() 里
{
  const { ops } = fakeTabs();
  const sent: Sent[] = [];
  const { raw, emit } = fakeRaw(ops, sent);
  const ctx = new CdpContext(raw);
  const page = await ctx.openRunWindow();
  assert.equal(ctx.pages().length, 1);
  emit("tab.removed", { tabId: Number(page.targetId) });
  assert.equal(page.isClosed(), true);
  assert.equal(ctx.pages().length, 0);
}

console.log("browser session selfcheck ok");
