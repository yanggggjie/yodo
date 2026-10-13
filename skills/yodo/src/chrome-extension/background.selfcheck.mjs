// 用桩对象模拟 chrome.* 运行 background.js，验证扩展侧的消息与所有权逻辑。由 npm test 调用。
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const posted = [];
let portListeners = { message: null, disconnect: null };
const storage = {};
const calls = [];
const listeners = {};
const onEvt = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
let nextWin = 1000;
let nextTab = 2000;
const tabs = new Map();

globalThis.chrome = {
  storage: {
    session: {
      get: async (keys) => Object.fromEntries(keys.map((k) => [k, storage[k]])),
      set: async (obj) => Object.assign(storage, obj),
    },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: {
    connectNative: (name) => {
      calls.push(["connectNative", name]);
      return {
        postMessage: (m) => posted.push(m),
        onMessage: { addListener: (fn) => (portListeners.message = fn) },
        onDisconnect: { addListener: (fn) => (portListeners.disconnect = fn) },
      };
    },
    getManifest: () => ({ version: "0.1.0" }),
    onStartup: onEvt("startup"),
    onInstalled: onEvt("installed"),
  },
  alarms: { create: (n, o) => calls.push(["alarm", n, o.periodInMinutes]), onAlarm: onEvt("alarm") },
  debugger: {
    attach: async (t, v) => { calls.push(["attach", t.tabId, v]); },
    detach: async (t) => { calls.push(["detach", t.tabId]); },
    sendCommand: async (t, m, p) => { calls.push(["cdp", t.tabId, m]); return { echoed: m, params: p }; },
    onEvent: onEvt("debuggerEvent"),
    onDetach: onEvt("debuggerDetach"),
  },
  windows: {
    create: async ({ focused }) => {
      const id = nextWin++; const tab = { id: nextTab++, windowId: id, url: "about:blank" };
      tabs.set(tab.id, tab); calls.push(["windows.create", focused]);
      return { id, tabs: [tab], state: "normal" };
    },
    get: async (id) => ({ id, state: "normal" }),
    remove: async (id) => { calls.push(["windows.remove", id]); },
    onRemoved: onEvt("windowRemoved"),
  },
  tabs: {
    create: async ({ windowId, url, active }) => { const tab = { id: nextTab++, windowId, url }; tabs.set(tab.id, tab); calls.push(["tabs.create", windowId, active]); return tab; },
    get: async (id) => { const t = tabs.get(id); if (!t) throw new Error("no tab"); return t; },
    remove: async (id) => { tabs.delete(id); calls.push(["tabs.remove", id]); },
    onCreated: onEvt("tabCreated"),
    onUpdated: onEvt("tabUpdated"),
    onRemoved: onEvt("tabRemoved"),
  },
};

await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "background.js") + "?t=1");
await new Promise((r) => setTimeout(r, 10));

// 1. 启动即连接，并先发 hello
assert.deepEqual(calls.find((c) => c[0] === "connectNative"), ["connectNative", "com.yodo.connect"]);
assert.equal(posted[0].type, "hello");
assert.equal(posted[0].protocolVersion, 1);
assert.deepEqual(calls.find((c) => c[0] === "alarm"), ["alarm", "yodo-keepalive", 0.5]);

const host = (msg) => portListeners.message(msg);
const replies = () => posted.filter((m) => "id" in m);
const last = () => replies()[replies().length - 1];
const settle = () => new Promise((r) => setTimeout(r, 20));

// 2. 开窗：focused 原样传递；返回 windowId / tabId；记入 owned
await host({ id: 1, op: "tab", name: "openWindow", args: { focused: true } });
await settle();
assert.equal(last().id, 1);
const win = last().result;
assert.ok(win.windowId && win.tabId);
assert.ok(calls.some((c) => c[0] === "windows.create" && c[1] === true));

// 3. 未 attach 的 cdp 被拒绝；attach 后可发送
await host({ id: 2, op: "cdp", tabId: win.tabId, method: "Runtime.evaluate", params: { expression: "1" } });
await settle();
assert.match(last().error.message, /未 attach/);
await host({ id: 3, op: "tab", name: "attach", args: { tabId: win.tabId } });
await settle();
assert.ok(calls.some((c) => c[0] === "attach" && c[1] === win.tabId && c[2] === "1.3"));
await host({ id: 4, op: "cdp", tabId: win.tabId, method: "Runtime.evaluate", params: { expression: "1" } });
await settle();
assert.equal(last().result.echoed, "Runtime.evaluate");

// 4. 非 yodo 的 tab 一律拒绝（用户自己的 tab）
await host({ id: 5, op: "tab", name: "attach", args: { tabId: 999999 } });
await settle();
assert.match(last().error.message, /不属于 yodo/);
await host({ id: 6, op: "cdp", tabId: 999999, method: "Page.enable", params: {} });
await settle();
assert.match(last().error.message, /不属于 yodo/);

// 5. 由 yodo tab 打开的新 tab 自动纳入，并通知 holder
tabs.set(7001, { id: 7001, windowId: 7000, url: "https://a.com" });
await listeners.tabCreated({ id: 7001, windowId: 7000, openerTabId: win.tabId, pendingUrl: "https://a.com" });
await settle();
const created = posted.find((m) => m.type === "tab" && m.kind === "created");
assert.equal(created.tabId, 7001);
assert.equal(created.openerTabId, win.tabId);
// 无 opener 的用户 tab 不纳入
tabs.set(8001, { id: 8001, windowId: 8000, url: "https://user.com" });
await listeners.tabCreated({ id: 8001, windowId: 8000, openerTabId: undefined });
await settle();
assert.equal(posted.filter((m) => m.type === "tab" && m.kind === "created").length, 1);
await host({ id: 9, op: "tab", name: "listOwned", args: {} });
await settle();
const ids = last().result.tabs.map((t) => t.tabId);
assert.equal(typeof last().result.tabs[0].title, "string", "listOwned 带 title，holder 靠它识别 yodo 的窗口");
assert.ok(ids.includes(win.tabId) && ids.includes(7001) && !ids.includes(8001));

// 6. 录制窗口（kind: record）里用户自己开的新 tab（没有 opener）也纳入；run 窗口不放宽
await host({ id: 20, op: "tab", name: "openWindow", args: { focused: false, kind: "record" } });
await settle();
const rec = last().result;
const createdCount = () => posted.filter((m) => m.type === "tab" && m.kind === "created").length;
const before = createdCount();
tabs.set(9001, { id: 9001, windowId: rec.windowId, url: "chrome://newtab" });
await listeners.tabCreated({ id: 9001, windowId: rec.windowId, openerTabId: undefined });
await settle();
assert.equal(createdCount(), before + 1, "录制窗口里没有 opener 的 tab 应被纳入并通知 holder");
assert.equal(posted.filter((m) => m.type === "tab" && m.kind === "created").at(-1).tabId, 9001);
tabs.set(9002, { id: 9002, windowId: win.windowId, url: "https://user.com" });
await listeners.tabCreated({ id: 9002, windowId: win.windowId, openerTabId: undefined });
await settle();
assert.equal(createdCount(), before + 1, "run 窗口里没有 opener 的 tab 不纳入");
// 录制窗口关闭后不再放宽
await host({ id: 21, op: "tab", name: "closeWindow", args: { windowId: rec.windowId } });
await settle();
tabs.set(9003, { id: 9003, windowId: rec.windowId, url: "https://late.com" });
await listeners.tabCreated({ id: 9003, windowId: rec.windowId, openerTabId: undefined });
await settle();
assert.equal(createdCount(), before + 1, "窗口关闭后不再纳入"); 

// 6. 调试器事件带 tabId 转发；分离通知
listeners.debuggerEvent({ tabId: win.tabId }, "Page.loadEventFired", { timestamp: 1 });
const ev = posted.find((m) => m.type === "event");
assert.equal(ev.tabId, win.tabId);
assert.equal(ev.method, "Page.loadEventFired");
listeners.debuggerDetach({ tabId: win.tabId }, "canceled_by_user");
const det = posted.find((m) => m.type === "tab" && m.kind === "detached");
assert.equal(det.reason, "canceled_by_user");

// 7. 关闭 tab：owned 移除并通知
listeners.tabRemoved(7001, { windowId: 7000 });
await settle();
assert.ok(posted.some((m) => m.type === "tab" && m.kind === "removed" && m.tabId === 7001));

// 8. 断开后退避重连
portListeners.disconnect();
await new Promise((r) => setTimeout(r, 1100));
assert.equal(calls.filter((c) => c[0] === "connectNative").length >= 2, true, "断开后应重连");

console.log("extension smoke ok");
