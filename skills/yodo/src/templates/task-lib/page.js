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
  const timeout = options.timeout ?? 30_000;
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
