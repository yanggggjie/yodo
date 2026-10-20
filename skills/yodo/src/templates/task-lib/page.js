/** 单个步骤（evaluate、goto、waitForSelector、expectRequest）的默认最长等待时间。 */
export const STEP_TIMEOUT_MS = 30_000;

function expressionOf(fnOrString, args) {
  if (typeof fnOrString === "string") return fnOrString;
  return `(async () => (${fnOrString.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")}))()`;
}

/**
 * 在页面内执行函数或表达式。不带 userGesture：yodo 无人值守，页面自己（或这里的脚本）调用 window.open 会被浏览器拦住，
 * 不会弹出新标签、更不会抢前台；需要新页面用 expectPopup 或 openPage。
 */
export async function evaluate(page, fnOrString, ...args) {
  const response = await page.cdp.send("Runtime.evaluate", { expression: expressionOf(fnOrString, args), returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluate failed");
  return response.result.value;
}

/**
 * 导航，并等到 options.until（默认 "domcontentloaded"）：
 * - "commit"：导航提交，新文档已经开始，可能还在解析；
 * - "domcontentloaded"、"load"：对应的页面事件。
 * 只认本次导航提交之后的事件：上一个页面还没发完的加载事件不算数。
 * 只改 hash、或者 pushState 这类同文档跳转不会提交新文档，收到 navigatedWithinDocument 就算完成。
 * 页面一直不触发 DOMContentLoaded 时（脚本卡住），用 until: "commit" 再自己等需要的元素。
 */
export async function goto(page, url, options = {}) {
  await page.cdp.send("Page.enable");
  const timeout = options.timeout ?? STEP_TIMEOUT_MS;
  const until = options.until ?? "domcontentloaded";
  let finish;
  const loaded = new Promise((resolve, reject) => { finish = (error) => error ? reject(error) : resolve(); });
  let committed = false;
  const offs = await Promise.all([
    page.cdp.on("Page.frameNavigated", ({ frame }) => {
      if (frame.parentId) return;
      committed = true;
      if (until === "commit") finish();
    }),
    page.cdp.on("Page.domContentEventFired", () => { if (committed && until === "domcontentloaded") finish(); }),
    page.cdp.on("Page.loadEventFired", () => { if (committed && until !== "commit") finish(); }),
    page.cdp.on("Page.navigatedWithinDocument", () => { if (!committed) finish(); }),
  ]);
  const timer = setTimeout(() => finish(new Error(`goto timeout after ${timeout}ms: ${url}`)), timeout);
  try {
    const result = await page.cdp.send("Page.navigate", { url });
    if (result.errorText) throw new Error(`net navigation error: ${result.errorText}`);
    await loaded;
  } finally {
    clearTimeout(timer);
    await Promise.all(offs.map((off) => off()));
  }
}

/**
 * 执行 action，并等待它触发的第一个匹配请求完成。
 * 返回 { status, body }：status 为 HTTP 状态码，body 为响应文本。
 * 没有发出匹配请求、或请求失败时抛出错误。
 */
export async function expectRequest(page, { method, path }, action, { timeout = STEP_TIMEOUT_MS } = {}) {
  await page.cdp.send("Network.enable");
  const statuses = new Map();
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const offs = [
    page.cdp.on("Network.requestWillBeSent", (e) => {
      if (e.request.method === method && new URL(e.request.url).pathname === path) statuses.set(e.requestId, undefined);
    }),
    page.cdp.on("Network.responseReceived", (e) => {
      if (statuses.has(e.requestId)) statuses.set(e.requestId, e.response.status);
    }),
    page.cdp.on("Network.loadingFinished", (e) => {
      if (statuses.has(e.requestId)) settle.resolve(e.requestId);
    }),
    page.cdp.on("Network.loadingFailed", (e) => {
      if (statuses.has(e.requestId)) settle.reject(new Error(e.errorText));
    }),
  ];
  let timer;
  try {
    await action();
    const requestId = await Promise.race([
      finished,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`未发出请求：${method} ${path}`)), timeout); }),
    ]);
    const { body } = await page.cdp.send("Network.getResponseBody", { requestId });
    return { status: statuses.get(requestId), body };
  } finally {
    clearTimeout(timer);
    for (const off of offs) off();
  }
}

/** 在 run 窗口里另开一个页面并导航到 url，返回新页面的句柄（run 结束时自动关闭）。 */
export async function openPage(page, url) {
  const next = await page.newPage();
  await goto(next, url);
  return next;
}

// 页面内的钩子：action 期间接管 window.open 和 <a target=_blank>，只记下目标网址，不让页面真的打开新标签。
function installPopupHook() {
  const state = { urls: [] };
  const originalOpen = window.open;
  window.open = (url) => { state.urls.push(url ? new URL(String(url), location.href).href : ""); return null; };
  const onClick = (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[target=_blank]") : null;
    if (!anchor || !anchor.href) return;
    event.preventDefault();
    state.urls.push(anchor.href);
  };
  document.addEventListener("click", onClick, true);
  window.__yodoPopup = { state, originalOpen, onClick };
}
const takePopupUrl = () => window.__yodoPopup?.state.urls[0] ?? null;
function removePopupHook() {
  const hook = window.__yodoPopup;
  if (!hook) return;
  window.open = hook.originalOpen;
  document.removeEventListener("click", hook.onClick, true);
  delete window.__yodoPopup;
}

/**
 * 执行 action（比如 click），其间页面想打开新窗口（window.open、<a target=_blank>）时，
 * 不让页面自己开（会抢前台），而是由 yodo 在 run 窗口里另开一个页面并导航过去，返回新页面的句柄。
 * 只接管 action 执行期间到 timeout 之内发生的；之后异步触发的拿不到。只支持 http(s) 地址。
 */
export async function expectPopup(page, action, { timeout = 10_000 } = {}) {
  await evaluate(page, installPopupHook);
  let url;
  try {
    await action();
    const deadline = Date.now() + timeout;
    for (;;) {
      url = await evaluate(page, takePopupUrl);
      if (url !== null) break;
      if (Date.now() >= deadline) throw new Error(`expectPopup：${timeout} 毫秒内页面没有要打开的新窗口`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await evaluate(page, removePopupHook).catch(() => {});
  }
  if (!/^https?:/i.test(url)) throw new Error(`expectPopup：新窗口的地址不是 http(s)，无法打开：${url || "（空）"}`);
  return openPage(page, url);
}
