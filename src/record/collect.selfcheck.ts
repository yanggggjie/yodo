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
} from "./collect.js";
import type { RawCdpConnection } from "../browser/index.js";
import { isRawAction, isRawRequest } from "./types.js";

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

const sent: { method: string; sessionId?: string; params?: Record<string, unknown> }[] = [];
const handlers = new Map<string, (params: unknown, sessionId?: string) => void>();
const raw: RawCdpConnection = {
  browserSessionId: "browser",
  commandTimeoutMs: 15_000,
  send: async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === "Browser.getWindowForTarget") {
      const id = (params as { targetId?: string })?.targetId;
      if (id === "fail") throw new Error("gone");
      if (id === "ours" || id === "ntp") return { windowId: 1 };
      return { windowId: 99 };
    }
    if (method === "Target.attachToTarget") {
      return { sessionId: `s-attach-${(params as { targetId?: string })?.targetId ?? "x"}` };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "f1", url: "https://z.com" } } };
    }
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: {
            ready: "complete",
            html: "<html><body>late</body></html>",
            href: "https://z.com/",
          },
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
const recTracker = new RecordWindowTracker();
recTracker.initWindow("born", 1);
const store = new ActiveRecordStore("selfcheck", undefined, Date.now(), "/tmp");
const rec = await startCdpNetworkRecorder(raw, store, recTracker);
assert.ok(sent.some((s) => s.method === "Target.setDiscoverTargets" && s.params?.discover === true));
assert.ok(!sent.some((s) => s.method === "Target.setAutoAttach" && s.params?.autoAttach === true));
const attach = handlers.get("Target.attachedToTarget");
assert.ok(attach);
const created = handlers.get("Target.targetCreated");
assert.ok(created);
const infoChanged = handlers.get("Target.targetInfoChanged");
assert.ok(infoChanged);

sent.length = 0;
attach({
  sessionId: "s-other",
  targetInfo: { targetId: "other", type: "page", url: "https://x.com" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(!sent.some((s) => s.method === "Runtime.runIfWaitingForDebugger"));
assert.ok(sent.some((s) => s.method === "Target.detachFromTarget"));
assert.ok(!sent.some((s) => s.method === "Network.enable"));

sent.length = 0;
attach({
  sessionId: "s-fail",
  targetInfo: { targetId: "fail", type: "page", url: "https://y.com" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(!sent.some((s) => s.method === "Runtime.runIfWaitingForDebugger"));
assert.ok(!sent.some((s) => s.method === "Network.enable"));

sent.length = 0;
attach({
  sessionId: "s-ours",
  targetInfo: { targetId: "ours", type: "page", url: "https://z.com" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(sent.some((s) => s.method === "Network.enable"));
assert.ok(!sent.some((s) => s.method === "Runtime.runIfWaitingForDebugger"));
assert.ok(
  sent.some(
    (s) =>
      s.method === "Target.setAutoAttach" &&
      s.params?.autoAttach === true &&
      s.params?.waitForDebuggerOnStart === false &&
      s.sessionId === "s-ours",
  ),
);
assert.ok(
  !sent.some(
    (s) =>
      s.method === "Target.setAutoAttach" &&
      s.params?.autoAttach === true &&
      (s.sessionId === undefined || s.sessionId === "browser"),
  ),
);
const late = store.events.find((e) => isRawRequest(e) && e.late === true);
assert.ok(late && isRawRequest(late));
assert.equal(late.url.bareUrl, "https://z.com/");

sent.length = 0;
created({
  targetInfo: { targetId: "other-created", type: "page", url: "https://x.com" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(!sent.some((s) => s.method === "Target.attachToTarget"));
assert.ok(!sent.some((s) => s.method === "Network.enable"));
assert.ok(!sent.some((s) => s.method === "Target.detachFromTarget"));

recTracker.recordGesture(Date.now());
sent.length = 0;
created({
  targetInfo: { targetId: "gest-other", type: "page", url: "https://x.com" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(!sent.some((s) => s.method === "Target.attachToTarget"));
assert.ok(!sent.some((s) => s.method === "Network.enable"));

sent.length = 0;
created({
  targetInfo: { targetId: "ntp", type: "page", url: "chrome://new-tab-page" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(!sent.some((s) => s.method === "Target.attachToTarget"));
assert.ok(!sent.some((s) => s.method === "Network.enable"));

sent.length = 0;
infoChanged({
  targetInfo: { targetId: "ntp", type: "page", url: "https://z.com/" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(
  sent.some((s) => s.method === "Target.attachToTarget" && s.params?.targetId === "ntp"),
);
assert.ok(sent.some((s) => s.method === "Network.enable"));

await rec.stop();
assert.ok(sent.some((s) => s.method === "Target.setDiscoverTargets" && s.params?.discover === false));
sent.length = 0;
attach({
  sessionId: "s-after-stop",
  targetInfo: { targetId: "ours", type: "page", url: "https://z.com" },
});
await new Promise((r) => setTimeout(r, 20));
assert.ok(!sent.some((s) => s.method === "Network.enable"));

{
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const lastOnly = new RecordWindowTracker();
  lastOnly.initWindow("born", 1);
  await closeTrackedWindows(
    {
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Target.getTargets") {
          return { targetInfos: [{ targetId: "born", type: "page" }] };
        }
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        return {};
      },
    },
    lastOnly,
  );
  assert.ok(calls.some((c) => c.method === "Target.createTarget" && c.params?.newWindow === true));
  assert.ok(calls.some((c) => c.method === "Target.closeTarget" && c.params?.targetId === "born"));
  assert.ok(!calls.some((c) => c.method === "Browser.close"));
}

{
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const withOther = new RecordWindowTracker();
  withOther.initWindow("born", 1);
  await closeTrackedWindows(
    {
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Target.getTargets") {
          return {
            targetInfos: [
              { targetId: "born", type: "page" },
              { targetId: "user", type: "page" },
            ],
          };
        }
        if (method === "Browser.getWindowForTarget") {
          const id = (params as { targetId?: string })?.targetId;
          return { windowId: id === "user" ? 2 : 1 };
        }
        return {};
      },
    },
    withOther,
  );
  assert.ok(!calls.some((c) => c.method === "Target.createTarget"));
  assert.ok(calls.some((c) => c.method === "Target.closeTarget" && c.params?.targetId === "born"));
  assert.ok(!calls.some((c) => c.method === "Target.closeTarget" && c.params?.targetId === "user"));
}

{
  const sentOnce: { method: string; sessionId?: string; params?: Record<string, unknown> }[] = [];
  const handlersOnce = new Map<string, (params: unknown, sessionId?: string) => void>();
  const rawOnce: RawCdpConnection = {
    browserSessionId: "browser",
    commandTimeoutMs: 15_000,
    send: async (method, params, sessionId) => {
      sentOnce.push({ method, params, sessionId });
      if (method === "Browser.getWindowForTarget") return { windowId: 1 };
      if (method === "Target.attachToTarget") return { sessionId: "s-manual" };
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "f1", url: "https://z.com" } } };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { ready: "complete", html: "<html></html>", href: "https://z.com/" },
          },
        };
      }
      return {};
    },
    on: (method, handler) => {
      handlersOnce.set(method, handler);
      return () => handlersOnce.delete(method);
    },
    onClose: () => () => {},
    isClosed: () => false,
    close: async () => {},
  };
  const trackerOnce = new RecordWindowTracker();
  trackerOnce.initWindow("ours", 1);
  const storeOnce = new ActiveRecordStore("once", undefined, Date.now(), "/tmp");
  const recOnce = await startCdpNetworkRecorder(rawOnce, storeOnce, trackerOnce);
  const attachOnce = handlersOnce.get("Target.attachedToTarget");
  assert.ok(attachOnce);

  sentOnce.length = 0;
  attachOnce({
    sessionId: "s-first",
    targetInfo: { targetId: "ours", type: "page", url: "https://z.com" },
  });
  await new Promise((r) => setTimeout(r, 20));
  await recOnce.attachTarget("ours");
  attachOnce({
    sessionId: "s-second",
    targetInfo: { targetId: "ours", type: "page", url: "https://z.com" },
  });
  await new Promise((r) => setTimeout(r, 20));

  const enables = sentOnce.filter((s) => s.method === "Network.enable");
  const scripts = sentOnce.filter((s) => s.method === "Page.addScriptToEvaluateOnNewDocument");
  const bindings = sentOnce.filter((s) => s.method === "Runtime.addBinding");
  assert.equal(enables.length, 1);
  assert.equal(scripts.length, 1);
  assert.equal(bindings.length, 1);
  assert.ok(
    sentOnce.some(
      (s) => s.method === "Target.detachFromTarget" && s.params?.sessionId === "s-second",
    ),
  );
  await recOnce.stop();
}

{
  const handlersBind = new Map<string, (params: unknown, sessionId?: string) => void>();
  const rawBind: RawCdpConnection = {
    browserSessionId: "browser",
    commandTimeoutMs: 15_000,
    send: async () => ({}),
    on: (method, handler) => {
      handlersBind.set(method, handler);
      return () => handlersBind.delete(method);
    },
    onClose: () => () => {},
    isClosed: () => false,
    close: async () => {},
  };
  const trackerBind = new RecordWindowTracker();
  trackerBind.initWindow("ours", 1);
  const storeBind = new ActiveRecordStore("bind", undefined, Date.now(), "/tmp");
  const inject = startInjectEvents(
    rawBind,
    storeBind,
    trackerBind,
    new Map([["s-known", "ours"]]),
  );
  const onBinding = handlersBind.get("Runtime.bindingCalled");
  assert.ok(onBinding);
  const payload = JSON.stringify({
    kind: "click",
    frameUrl: "https://z.com",
    role: "button",
    name: "ok",
    startedAt: 1000,
  });
  onBinding({ name: "__yodoEvent", payload }, "s-known");
  onBinding({ name: "__yodoEvent", payload }, "s-unknown");
  onBinding({ name: "__yodoEvent", payload });
  const clicks = storeBind.events.filter((e) => isRawAction(e) && e.actionType === "click");
  assert.equal(clicks.length, 1);
  await inject.stop();
}

console.log("record collect selfcheck ok");
