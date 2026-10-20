/** 单个步骤（evaluate、goto、waitForSelector、expectRequest）的默认最长等待时间。 */
export const STEP_TIMEOUT_MS = 30_000;

function expressionOf(fnOrString, args) {
  if (typeof fnOrString === "string") return fnOrString;
  return `(async () => (${fnOrString.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")}))()`;
}

async function run(page, fnOrString, args, userGesture) {
  const response = await page.cdp.send("Runtime.evaluate", { expression: expressionOf(fnOrString, args), returnByValue: true, awaitPromise: true, userGesture });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluate failed");
  return response.result.value;
}

/** task 里用的 evaluate：可能包含点击等操作，所以算作用户操作（userGesture），target=_blank 才打得开。 */
export async function evaluate(page, fnOrString, ...args) {
  return run(page, fnOrString, args, true);
}

/** 库内部的只读查询（轮询等）：不带 userGesture，否则轮询会让页面一直处于被用户激活的状态，页面自己发起的弹窗也被放行。 */
export async function query(page, fnOrString, ...args) {
  return run(page, fnOrString, args, false);
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
