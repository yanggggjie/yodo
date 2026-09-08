import assert from "node:assert/strict";
import {
  CdpContext,
  CdpPage,
  PAGE_AUTO_ATTACH,
  envelopeCdpCommand,
  isChromeUiUrl,
  setDiscoverTargets,
  setPageAutoAttach,
  type RawCdpConnection,
} from "./session.ts";

const flat = envelopeCdpCommand(1, "Network.enable", { a: 1 }, "child-session");
assert.equal(flat.id, 1);
assert.equal(flat.method, "Network.enable");
assert.equal(flat.sessionId, "child-session");
const root = envelopeCdpCommand(2, "Target.getTargets");
assert.equal(root.sessionId, undefined);
assert.equal(PAGE_AUTO_ATTACH.autoAttach, true);
assert.equal(PAGE_AUTO_ATTACH.waitForDebuggerOnStart, false);
assert.equal(PAGE_AUTO_ATTACH.filter[0]?.type, "page");
assert.equal(isChromeUiUrl("chrome://new-tab-page"), true);
assert.equal(isChromeUiUrl("devtools://devtools"), true);
assert.equal(isChromeUiUrl("https://a.com"), false);

const mockRaw: RawCdpConnection = {
  browserSessionId: "sess_browser",
  commandTimeoutMs: 15_000,
  send: async (method: string, params?: Record<string, unknown>) => {
    if (method === "Runtime.evaluate") {
      const expr = (params?.expression as string) || "";
      if (expr === "document.title") {
        return { result: { type: "string", value: "Test Page" } };
      }
      return { result: { type: "string", value: "ok" } };
    }
    if (method === "Page.navigate") return { frameId: "frame_001" };
    return {};
  },
  on: () => () => {},
  onClose: () => () => {},
  isClosed: () => false,
  close: async () => {},
};

const page = new CdpPage(mockRaw, "target_1", "sess_1", "https://example.com");
assert.equal(page.targetId, "target_1");
assert.equal(page.url(), "https://example.com");
assert.equal(await page.title(), "Test Page");
await page.close();
assert.equal(page.isClosed(), true);

const messagesSent: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];
await setPageAutoAttach(
  {
    browserSessionId: "browser",
    send: async (method, params, sessionId) => {
      messagesSent.push({ method, params, sessionId });
      return {};
    },
  },
  false,
);
assert.equal(messagesSent[0]?.method, "Target.setAutoAttach");
assert.equal(messagesSent[0]?.params?.autoAttach, false);
assert.equal(messagesSent[0]?.params?.waitForDebuggerOnStart, false);
assert.equal(messagesSent[0]?.sessionId, "browser");

messagesSent.length = 0;
await setPageAutoAttach(
  {
    browserSessionId: "browser",
    send: async (method, params, sessionId) => {
      messagesSent.push({ method, params, sessionId });
      return {};
    },
  },
  true,
);
assert.equal(messagesSent.length, 0);

messagesSent.length = 0;
await setPageAutoAttach(
  {
    browserSessionId: "browser",
    send: async (method, params, sessionId) => {
      messagesSent.push({ method, params, sessionId });
      assert.equal(params?.waitForDebuggerOnStart, false);
      assert.equal(params?.autoAttach, true);
      return {};
    },
  },
  true,
  "page-sess",
);
assert.equal(messagesSent[0]?.method, "Target.setAutoAttach");
assert.equal(messagesSent[0]?.sessionId, "page-sess");

messagesSent.length = 0;
await setDiscoverTargets(
  {
    send: async (method, params) => {
      messagesSent.push({ method, params });
      return {};
    },
  },
  true,
);
assert.equal(messagesSent[0]?.method, "Target.setDiscoverTargets");
assert.equal(messagesSent[0]?.params?.discover, true);

const initSent: string[] = [];
const initRaw: RawCdpConnection = {
  browserSessionId: "browser",
  commandTimeoutMs: 15_000,
  send: async (method) => {
    initSent.push(method);
    if (method === "Target.getTargets") {
      return { targetInfos: [{ targetId: "p1", type: "page", url: "https://a.com" }] };
    }
    return {};
  },
  on: () => () => {},
  onClose: () => () => {},
  isClosed: () => false,
  close: async () => {},
};
const ctx = new CdpContext(initRaw);
await ctx.init();
assert.ok(!initSent.includes("Target.attachToTarget"));
assert.ok(!initSent.includes("Runtime.runIfWaitingForDebugger"));
assert.equal(ctx.pages().length, 0);

const originSent: { method: string; params?: Record<string, unknown> }[] = [];
const originRaw: RawCdpConnection = {
  browserSessionId: "browser",
  commandTimeoutMs: 15_000,
  send: async (method, params) => {
    originSent.push({ method, params });
    if (method === "Target.createTarget") {
      assert.equal(params?.newWindow, true);
      assert.equal(params?.background, true);
      assert.equal(params?.focus, false);
      return { targetId: "run-tab" };
    }
    if (method === "Browser.getWindowForTarget") return { windowId: 42 };
    if (method === "Target.attachToTarget") {
      return { sessionId: `s-${(params as { targetId?: string })?.targetId}` };
    }
    if (method === "Runtime.evaluate") {
      return { result: { type: "string", value: "ok" } };
    }
    if (method === "Page.navigate") return { frameId: "f1" };
    return {};
  },
  on: () => () => {},
  onClose: () => () => {},
  isClosed: () => false,
  close: async () => {},
};
const originCtx = new CdpContext(originRaw);
await originCtx.init();
const runPage = await originCtx.openRunWindow();
assert.equal(runPage.targetId, "run-tab");
const originPage = await originCtx.pageForOrigin("https://a.com");
assert.equal(originPage.targetId, "run-tab");
assert.equal((await originCtx.newPage()).targetId, "run-tab");
assert.equal(originSent.filter((s) => s.method === "Target.createTarget").length, 1);
assert.ok(!originSent.some((s) => s.method === "Target.getTargets"));
assert.ok(originSent.some((s) => s.method === "Page.navigate"));
await originCtx.closeRunWindow();
assert.ok(originSent.some((s) => s.method === "Target.closeTarget"));

const recSent: { method: string; params?: Record<string, unknown> }[] = [];
const recRaw: RawCdpConnection = {
  browserSessionId: "browser",
  commandTimeoutMs: 15_000,
  send: async (method, params) => {
    recSent.push({ method, params });
    if (method === "Target.createTarget") {
      assert.equal(params?.newWindow, true);
      assert.equal(params?.background, undefined);
      return { targetId: "rec-tab" };
    }
    if (method === "Browser.getWindowForTarget") return { windowId: 7 };
    if (method === "Target.attachToTarget") {
      return { sessionId: `s-${(params as { targetId?: string })?.targetId}` };
    }
    return {};
  },
  on: () => () => {},
  onClose: () => () => {},
  isClosed: () => false,
  close: async () => {},
};
const recCtx = new CdpContext(recRaw);
const rec = await recCtx.openRecordWindow();
assert.equal(rec.page.targetId, "rec-tab");
assert.equal(rec.windowId, 7);
assert.ok(recSent.some((s) => s.method === "Page.bringToFront"));

console.log("browser session selfcheck ok");
