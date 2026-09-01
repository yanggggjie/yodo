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
} from "./session.js";

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
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "other", type: "page", url: "https://b.com/" },
          { targetId: "hit", type: "page", url: "https://a.com/x" },
          { targetId: "ntp", type: "page", url: "chrome://new-tab-page" },
        ],
      };
    }
    if (method === "Target.attachToTarget") {
      return { sessionId: `s-${(params as { targetId?: string })?.targetId}` };
    }
    if (method === "Runtime.evaluate") {
      return { result: { type: "string", value: "ok" } };
    }
    return {};
  },
  on: () => () => {},
  onClose: () => () => {},
  isClosed: () => false,
  close: async () => {},
};
const originCtx = new CdpContext(originRaw);
await originCtx.init();
const originPage = await originCtx.pageForOrigin("https://a.com");
assert.equal(originPage.targetId, "hit");
const attaches = originSent.filter((s) => s.method === "Target.attachToTarget");
assert.equal(attaches.length, 1);
assert.equal(attaches[0]?.params?.targetId, "hit");

console.log("browser session selfcheck ok");
