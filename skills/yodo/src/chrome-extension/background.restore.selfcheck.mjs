// 扩展刷新后 storage.session 被清空：只信任窗口里仍有 yodo 标题 tab 的 storage.local 登记。由 npm test 调用。
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const posted = [];
let portListeners = { message: null };
const localSaved = { windows: [10, 11, 12], tabs: [101, 102, 103, 104] };
const written = { local: null, session: null };
const onEvt = () => ({ addListener: () => {} });

// 浏览器里现存的窗口：10 是 yodo 的 run 窗（锚点 + 一个残留 tab）；
// 11 是用户窗口，tab id 恰好和旧登记冲突（浏览器重启后 id 被复用）；12 已不存在。
const windows = {
  10: { id: 10, tabs: [{ id: 101, windowId: 10, title: "yodo run", url: "about:blank" }, { id: 102, windowId: 10, title: "Some Site", url: "https://a.com" }] },
  11: { id: 11, tabs: [{ id: 103, windowId: 11, title: "我的邮箱", url: "https://mail.example" }] },
};
const allTabs = new Map(Object.values(windows).flatMap((w) => w.tabs).map((t) => [t.id, t]));

globalThis.chrome = {
  storage: {
    session: { get: async () => ({}), set: async (v) => { written.session = v; } },
    local: { get: async () => localSaved, set: async (v) => { written.local = v; } },
  },
  runtime: {
    connectNative: () => ({
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (fn) => (portListeners.message = fn) },
      onDisconnect: { addListener: () => {} },
    }),
    getManifest: () => ({ version: "0.1.0" }),
    onStartup: onEvt(),
    onInstalled: onEvt(),
  },
  alarms: { create: () => {}, onAlarm: onEvt() },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: onEvt(), onDetach: onEvt() },
  windows: {
    create: async () => { throw new Error("不应新建窗口"); },
    get: async (id) => { const w = windows[id]; if (!w) throw new Error("no window"); return w; },
    remove: async () => {},
    onRemoved: onEvt(),
  },
  tabs: {
    create: async () => { throw new Error("不应新建 tab"); },
    get: async (id) => { const t = allTabs.get(id); if (!t) throw new Error("no tab"); return t; },
    remove: async () => {},
    onCreated: onEvt(),
    onUpdated: onEvt(),
    onRemoved: onEvt(),
  },
};

await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "background.js") + "?restore=1");
await new Promise((r) => setTimeout(r, 20));

await portListeners.message({ id: 1, op: "tab", name: "listOwned", args: {} });
await new Promise((r) => setTimeout(r, 20));
const reply = posted.find((m) => m.id === 1);
const ids = reply.result.tabs.map((t) => t.tabId).sort();

assert.deepEqual(ids, [101, 102], "yodo 的 run 窗及其 tab 被恢复，窗口数量不增加");
assert.ok(!ids.includes(103), "id 冲突的用户 tab 不会被当成 yodo 的");
assert.deepEqual(written.local.windows, [10], "登记被校正：只保留校验通过的窗口");
assert.deepEqual(written.local.tabs.sort(), [101, 102]);
assert.deepEqual(reply.result.tabs.find((t) => t.tabId === 101).title, "yodo run");

// 没有登记的 tab 仍然被拒绝
await portListeners.message({ id: 2, op: "tab", name: "attach", args: { tabId: 103 } });
await new Promise((r) => setTimeout(r, 20));
assert.match(posted.find((m) => m.id === 2).error.message, /不属于 yodo/);

console.log("extension restore ok");
