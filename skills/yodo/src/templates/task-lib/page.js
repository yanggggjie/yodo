/** 单个步骤（evaluate、goto、waitForSelector、expectRequest）的默认最长等待时间。 */
export const STEP_TIMEOUT_MS = 30_000;

function expressionOf(fnOrString, args) {
  if (typeof fnOrString === "string") return fnOrString;
  return `(async () => (${fnOrString.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")}))()`;
}

export async function evaluate(page, fnOrString, ...args) {
  await page.cdp.send("Runtime.enable");
  const response = await page.cdp.send("Runtime.evaluate", { expression: expressionOf(fnOrString, args), returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluate failed");
  return response.result.value;
}

export async function goto(page, url, options = {}) {
  await page.cdp.send("Page.enable");
  const timeout = options.timeout ?? STEP_TIMEOUT_MS;
  let finish;
  const loaded = new Promise((resolve, reject) => { finish = (error) => error ? reject(error) : resolve(); });
  const offs = await Promise.all([
    page.cdp.on("Page.domContentEventFired", () => finish()),
    page.cdp.on("Page.loadEventFired", () => finish()),
    page.cdp.on("Page.frameNavigated", ({ frame }) => { if (!frame.parentId) finish(); }),
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
