// yodo Chrome 扩展：薄层 CDP 代理。
// 协议与 holder 端的实现见 src/browser/extension.ts。
// 只操作 yodo 自己创建（或由它打开）的窗口与 tab；其余 id 一律拒绝。

const HOST = "com.yodo.connect";
const PROTOCOL_VERSION = 1;
const RETRY_MAX_MS = 30_000;
const KEEPALIVE_MINUTES = 0.5;

let port = null;
let retryCount = 0;
let retryTimer = null;

// 由 yodo 拥有的窗口与 tab。
// storage.session：同一浏览器会话内 service worker 重启后 id 可信，但扩展刷新会清空它。
// storage.local：扩展刷新后仍在，但 id 在浏览器重启后会被复用，所以只在窗口里仍有标题为 yodo 的 tab 时才信任。
const YODO_TITLES = new Set(["yodo run", "yodo record"]);
// recordWindows：录制窗口。用户在里面自己开的新 tab（没有 opener）也要纳入，run 窗口不放宽。
const owned = { windows: new Set(), tabs: new Set(), recordWindows: new Set() };
const attached = new Set();

const ready = restoreOwned();

async function restoreOwned() {
  const saved = await chrome.storage.session.get(["windows", "tabs", "recordWindows"]);
  for (const id of saved.windows ?? []) owned.windows.add(id);
  for (const id of saved.tabs ?? []) owned.tabs.add(id);
  for (const id of saved.recordWindows ?? []) owned.recordWindows.add(id);

  const persisted = await chrome.storage.local.get(["windows", "tabs", "recordWindows"]);
  const persistedTabs = new Set(persisted.tabs ?? []);
  for (const windowId of persisted.windows ?? []) {
    if (owned.windows.has(windowId)) continue;
    const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
    if (!win?.tabs?.some((tab) => YODO_TITLES.has(tab.title))) continue;
    owned.windows.add(windowId);
    if ((persisted.recordWindows ?? []).includes(windowId)) owned.recordWindows.add(windowId);
    for (const tab of win.tabs) if (persistedTabs.has(tab.id)) owned.tabs.add(tab.id);
  }
  await saveOwned();
}

async function saveOwned() {
  const value = { windows: [...owned.windows], tabs: [...owned.tabs], recordWindows: [...owned.recordWindows] };
  await Promise.all([chrome.storage.session.set(value), chrome.storage.local.set(value)]);
}

function postToHost(message) {
  if (port) port.postMessage(message);
}

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    scheduleRetry();
    return;
  }
  port.onMessage.addListener((msg) => {
    void handleHostMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleRetry();
  });
  retryCount = 0;
  port.postMessage({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    chromeVersion: navigator.userAgent,
    extensionVersion: chrome.runtime.getManifest().version,
  });
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay = Math.min(1000 * 2 ** retryCount, RETRY_MAX_MS);
  retryCount++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

async function handleHostMessage(msg) {
  try {
    await ready;
    const result = msg.op === "cdp" ? await runCdp(msg) : await runTab(msg.name, msg.args ?? {});
    postToHost({ id: msg.id, result: result ?? {} });
  } catch (error) {
    postToHost({ id: msg.id, error: { message: error instanceof Error ? error.message : String(error) } });
  }
}

function requireTab(tabId) {
  if (!owned.tabs.has(tabId)) throw new Error(`tab ${tabId} 不属于 yodo`);
}

function requireWindow(windowId) {
  if (!owned.windows.has(windowId)) throw new Error(`window ${windowId} 不属于 yodo`);
}

async function runCdp({ tabId, method, params }) {
  requireTab(tabId);
  if (!attached.has(tabId)) throw new Error(`tab ${tabId} 未 attach`);
  return await chrome.debugger.sendCommand({ tabId }, method, params ?? {});
}

async function runTab(name, args) {
  switch (name) {
    case "openWindow": {
      const win = await chrome.windows.create({ url: "about:blank", focused: !!args.focused, type: "normal" });
      const tab = win.tabs[0];
      owned.windows.add(win.id);
      if (args.kind === "record") owned.recordWindows.add(win.id);
      owned.tabs.add(tab.id);
      await saveOwned();
      return { windowId: win.id, tabId: tab.id };
    }
    case "openTab": {
      requireWindow(args.windowId);
      const tab = await chrome.tabs.create({ windowId: args.windowId, url: args.url || "about:blank", active: !!args.active });
      owned.tabs.add(tab.id);
      await saveOwned();
      return { tabId: tab.id };
    }
    case "closeTab": {
      requireTab(args.tabId);
      await chrome.tabs.remove(args.tabId).catch(() => {});
      owned.tabs.delete(args.tabId);
      await saveOwned();
      return {};
    }
    case "closeWindow": {
      requireWindow(args.windowId);
      await chrome.windows.remove(args.windowId).catch(() => {});
      owned.windows.delete(args.windowId);
      owned.recordWindows.delete(args.windowId);
      await saveOwned();
      return {};
    }
    case "listOwned": {
      const tabs = [];
      for (const tabId of [...owned.tabs]) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          owned.tabs.delete(tabId);
          continue;
        }
        tabs.push({ tabId, windowId: tab.windowId, url: tab.url || tab.pendingUrl || "", title: tab.title || "" });
      }
      await saveOwned();
      return { tabs };
    }
    case "windowOf": {
      requireTab(args.tabId);
      const tab = await chrome.tabs.get(args.tabId);
      const win = await chrome.windows.get(tab.windowId);
      return { windowId: win.id, state: win.state };
    }
    case "attach": {
      requireTab(args.tabId);
      if (attached.has(args.tabId)) return {};
      try {
        await chrome.debugger.attach({ tabId: args.tabId }, "1.3");
      } catch (error) {
        // service worker 重启后内存里的 attached 丢了，但 debugger 仍附着：视为已附加。
        if (!String(error?.message ?? error).includes("already attached")) throw error;
      }
      attached.add(args.tabId);
      return {};
    }
    case "detach": {
      requireTab(args.tabId);
      if (attached.has(args.tabId)) {
        await chrome.debugger.detach({ tabId: args.tabId }).catch(() => {});
        attached.delete(args.tabId);
      }
      return {};
    }
    default:
      throw new Error(`未知操作 ${name}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || !owned.tabs.has(source.tabId)) return;
  postToHost({ type: "event", tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  postToHost({ type: "tab", kind: "detached", tabId: source.tabId, reason });
});

// 自动纳入新 tab：opener 属于 yodo，或者它开在录制窗口里（用户自己按 Cmd+T 开的 tab 没有 opener）。窗口同样纳入。
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  const byOpener = tab.openerTabId != null && owned.tabs.has(tab.openerTabId);
  if (!byOpener && !owned.recordWindows.has(tab.windowId)) return;
  owned.tabs.add(tab.id);
  owned.windows.add(tab.windowId);
  await saveOwned();
  postToHost({
    type: "tab",
    kind: "created",
    tabId: tab.id,
    windowId: tab.windowId,
    openerTabId: tab.openerTabId,
    url: tab.pendingUrl || tab.url || "",
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;
  if (!owned.tabs.has(tabId) || changeInfo.url == null) return;
  postToHost({ type: "tab", kind: "updated", tabId, windowId: tab.windowId, url: changeInfo.url });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  if (!owned.tabs.has(tabId)) return;
  attached.delete(tabId);
  owned.tabs.delete(tabId);
  await saveOwned();
  postToHost({ type: "tab", kind: "removed", tabId, windowId: removeInfo.windowId });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  if (!owned.windows.has(windowId)) return;
  owned.windows.delete(windowId);
  owned.recordWindows.delete(windowId);
  await saveOwned();
});

// service worker 每次启动都尝试连接；onStartup / onInstalled 显式触发，alarm 兜底。
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "yodo-keepalive" && !port) connect();
});
chrome.alarms.create("yodo-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
connect();
