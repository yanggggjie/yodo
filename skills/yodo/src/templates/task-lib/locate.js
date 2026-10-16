/**
 * 元素定位与自动等待。target 是 CSS 选择器字符串，或 { role, name }（无障碍角色和名称，与录制里的 role、name 同一套）。
 * - CSS：和以前一样取第一个匹配。
 * - role/name：按无障碍树查找，必须唯一；找到多个直接报错并列出数量，不静默选第一个。
 * 找到后等它可见且未禁用，最长 timeout 毫秒（默认 ACTION_TIMEOUT_MS）；超时报出具体在等什么。
 */
export const ACTION_TIMEOUT_MS = 10_000;
const POLL_MS = 200;

export const describeTarget = (target) => (typeof target === "string" ? target : `${target.role} "${target.name}"`);

/** 在页面里执行 fn(el, ...args)，el 是 objectId 对应的元素。返回 fn 的结果，异常直接抛出。 */
export async function callOn(page, objectId, fn, ...args) {
  const response = await page.cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function (...args) { return (${fn.toString()})(this, ...args); }`,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "DOM 操作失败");
  }
  return response.result.value;
}

/** 只找一次。找到返回 objectId；没有返回 null；role/name 有多个匹配直接抛错。 */
async function findOnce(page, target) {
  if (typeof target === "string") {
    const response = await page.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(target)})`,
      returnByValue: false,
    });
    return response.result.subtype === "null" ? null : response.result.objectId ?? null;
  }
  // queryAXTree 必须指定查询的根：这里用 document 对象，查整棵文档的无障碍树
  // 不把 name 交给 CDP 的 accessibleName 做精确匹配：有的站点无障碍名称带多余空白（如 "Following "），
  // CDP 按字节精确比较会找不到。改为自己按 role 取回全部节点，再规范化空白后比较。
  const document = await page.cdp.send("Runtime.evaluate", { expression: "document", returnByValue: false });
  const { nodes } = await page.cdp.send("Accessibility.queryAXTree", { objectId: document.result.objectId, role: target.role });
  const normalize = (name) => (name ?? "").replace(/\s+/g, " ").trim();
  const wanted = normalize(target.name);
  const matches = nodes.filter((node) => !node.ignored && node.backendDOMNodeId != null && normalize(node.name?.value) === wanted);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`${describeTarget(target)} 匹配到 ${matches.length} 个元素，无法唯一确定；请换一个更具体的 name，或改用 CSS 选择器`);
  }
  const { object } = await page.cdp.send("DOM.resolveNode", { backendNodeId: matches[0].backendDOMNodeId });
  return object.objectId;
}

/** 元素可见（有尺寸）且未禁用。 */
const isActionable = (el) => {
  if (!(el instanceof Element)) return false;
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return false;
  return !el.disabled;
};

/** 等到 target 存在且可操作，返回 objectId。 */
export async function locate(page, target, { timeout = ACTION_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let reason = "没有找到";
  for (;;) {
    const objectId = await findOnce(page, target);
    if (objectId) {
      if (await callOn(page, objectId, isActionable)) return objectId;
      reason = "找到了，但不可见或已禁用";
    }
    if (Date.now() - started >= timeout) {
      throw new Error(`${describeTarget(target)}：等了 ${timeout} 毫秒，${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** 定位 + 执行 + 释放。 */
export async function withElement(page, target, options, fn, ...args) {
  const objectId = await locate(page, target, options);
  try {
    return await callOn(page, objectId, fn, ...args);
  } finally {
    page.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}
