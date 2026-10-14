import assert from "node:assert/strict";
import { check, click, fill, press, scroll, select, toggle, waitForSelector } from "./templates/task-lib/dom.js";
import { evaluate, goto } from "./templates/task-lib/page.js";
import type { PageHandle } from "./sdk.ts";

const calls: string[] = [];
const expressions: string[] = [];
const listeners = new Map<string, (value: unknown) => void>();
// 假页面：CSS 选择器 "#missing" 找不到，其它都找得到；无障碍树里 button "保存" 唯一，"重复" 有两个，"隐藏" 不存在。
// visibleAfter 控制元素要过几次检查才可见，用来测自动等待。
const ax: Record<string, number> = { "button|保存": 1, "button|重复": 2 };
let visibleAfter = 0;
let checks = 0;
const page = { cdp: {
  async send(method: string, params?: any) {
    calls.push(method);
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.startsWith("document.querySelector(")) {
        const selector = JSON.parse(expression.match(/querySelector\((.*)\)/)![1]!);
        return selector === "#missing" ? { result: { subtype: "null", value: null } } : { result: { objectId: `obj:${selector}` } };
      }
      return { result: { value: 42 } }; // evaluate 的普通调用，比如 scroll
    }
    if (method === "Runtime.callFunctionOn") {
      const fn = String(params?.functionDeclaration ?? "");
      if (fn.includes("getBoundingClientRect")) {
        checks++;
        return { result: { value: checks > visibleAfter } };
      }
      expressions.push(`${params.objectId} ${fn}`);
      if (fn.includes("setter.call")) return { result: { value: params.arguments[0].value } };
      if (fn.includes("checked")) return { result: { value: false } };
      if (fn.includes("selectedOptions") || fn.includes("option.value")) return { result: { value: "hot" } };
      return { result: { value: undefined } };
    }
    if (method === "Accessibility.queryAXTree") {
      const key = `${params.role}|${params.accessibleName}`;
      const count = ax[key] ?? 0;
      return { nodes: Array.from({ length: count }, (_, i) => ({ ignored: false, backendDOMNodeId: 100 + i })) };
    }
    if (method === "DOM.resolveNode") return { object: { objectId: `ax:${params.backendNodeId}` } };
    if (method === "Page.navigate") {
      // 真实的顺序：先提交（frameNavigated），再 DOMContentLoaded、load
      queueMicrotask(() => {
        listeners.get("Page.frameNavigated")?.({ frame: { id: "main" } });
        listeners.get("Page.domContentEventFired")?.({});
        listeners.get("Page.loadEventFired")?.({});
      });
      return {};
    }
    return {};
  },
  async on(event: string, listener: (value: unknown) => void) { listeners.set(event, listener); return async () => { listeners.delete(event); }; },
  async once() { return {}; },
} } as unknown as PageHandle;

assert.equal(await evaluate(page, "21 * 2"), 42);
await goto(page, "https://example.com");
assert.deepEqual(calls, ["Runtime.evaluate", "Page.enable", "Page.navigate"], "evaluate 不需要 Runtime.enable");
assert.equal(listeners.size, 0);

const before = calls.length;
await click(page, "#go");
await fill(page, "#q", "hello");
await press(page, "#q", "Enter");
await scroll(page, undefined, { deltaY: 120 });
assert.equal(expressions.length, 3);
assert.ok(expressions[0]!.startsWith("obj:#go ") && /\.click\(\)/.test(expressions[0]!));
assert.ok(expressions[1]!.startsWith("obj:#q ") && /setter\.call/.test(expressions[1]!));
assert.ok(expressions[2]!.startsWith("obj:#q ") && /KeyboardEvent/.test(expressions[2]!));

// 角色 + 名称：按无障碍树唯一查找
checks = 0; visibleAfter = 0; expressions.length = 0;
await click(page, { role: "button", name: "保存" });
assert.equal(expressions[0]!.startsWith("ax:100 "), true, "按 role/name 找到的元素被点击");

// 多个匹配：报错，并说明数量，不静默选第一个
await assert.rejects(click(page, { role: "button", name: "重复" }, { timeout: 300 }), /匹配到 2 个元素，无法唯一确定/);

// 找不到：等满超时，报出在等什么
await assert.rejects(click(page, { role: "button", name: "不存在" }, { timeout: 300 }), /button "不存在"：等了 300 毫秒，没有找到/);
await assert.rejects(click(page, "#missing", { timeout: 300 }), /等了 300 毫秒，没有找到/);

// 自动等待：元素过两次检查才可见，动作会等到它可见再执行，而不是立即失败
checks = 0; visibleAfter = 2; expressions.length = 0;
await click(page, "#late");
assert.equal(checks, 3, "前两次不可见，第三次才点击");
assert.equal(expressions.length, 1);

// 找到但禁用/不可见，超时后报出原因
checks = 0; visibleAfter = 1e9;
await assert.rejects(click(page, "#hidden", { timeout: 300 }), /找到了，但不可见或已禁用/);
visibleAfter = 0;

// check / select / toggle 走同一套定位
assert.equal(await check(page, "#agree", true), "done");
await select(page, "#sort", "热度");
assert.equal(await toggle(page, { role: "button", name: "保存" }, { target: true }), "done");

// waitForSelector 在 Node 侧轮询：每次只做一次快速 evaluate，出现后立即返回
let polls = 0;
const waiting = { cdp: {
  async send(method: string) {
    if (method === "Runtime.evaluate") { polls++; return { result: { value: polls >= 3 } }; }
    return {};
  },
  on() { return () => {}; },
  async once() { return {}; },
} } as unknown as PageHandle;
await waitForSelector(waiting, "#late");
assert.equal(polls, 3, "前两次没找到，第三次出现");

// goto 等什么：只认本次导航提交之后的事件；until 控制等到哪一步；同文档跳转等 navigatedWithinDocument
{
  type Handler = (value: unknown) => void;
  const make = () => {
    const handlers = new Map<string, Handler>();
    const fire = (event: string, value: unknown = {}) => handlers.get(event)?.(value);
    const fake = { cdp: {
      async send() { return {}; },
      on(event: string, handler: Handler) { handlers.set(event, handler); return () => { handlers.delete(event); }; },
      async once() { return {}; },
    } } as unknown as PageHandle;
    return { fake, fire, handlers };
  };
  const state = async (promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> =>
    Promise.race([promise.then(() => "resolved" as const, () => "rejected" as const), new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 30))]);
  const commit = { frame: { id: "main" } };

  // 默认 domcontentloaded：上一个页面的加载事件（提交之前）不算；提交了但还没解析完也不算
  {
    const { fake, fire, handlers } = make();
    const done = goto(fake, "https://a.test/");
    await new Promise((resolve) => setTimeout(resolve, 5));
    fire("Page.loadEventFired"); fire("Page.domContentEventFired"); // 上一个页面的
    assert.equal(await state(done), "pending", "提交之前的事件不算");
    fire("Page.frameNavigated", { frame: { id: "sub", parentId: "main" } });
    fire("Page.domContentEventFired");
    assert.equal(await state(done), "pending", "子框架的提交不算");
    fire("Page.frameNavigated", commit);
    assert.equal(await state(done), "pending", "提交了但页面还在解析，不能返回");
    fire("Page.domContentEventFired");
    assert.equal(await state(done), "resolved");
    assert.equal(handlers.size, 0, "监听函数都取消了");
  }
  // until: commit 提交就返回；until: load 要等 load
  {
    const { fake, fire } = make();
    const done = goto(fake, "https://a.test/", { until: "commit" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fire("Page.frameNavigated", commit);
    assert.equal(await state(done), "resolved");
  }
  {
    const { fake, fire } = make();
    const done = goto(fake, "https://a.test/", { until: "load" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fire("Page.frameNavigated", commit); fire("Page.domContentEventFired");
    assert.equal(await state(done), "pending", "load 之前不返回");
    fire("Page.loadEventFired");
    assert.equal(await state(done), "resolved");
  }
  // 同文档跳转（hash、pushState）不提交新文档：收到 navigatedWithinDocument 就完成；提交之后出现的不算（新页面启动时的 replaceState）
  {
    const { fake, fire } = make();
    const done = goto(fake, "https://a.test/#x");
    await new Promise((resolve) => setTimeout(resolve, 5));
    fire("Page.navigatedWithinDocument");
    assert.equal(await state(done), "resolved");
    const second = make();
    const next = goto(second.fake, "https://a.test/next");
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.fire("Page.frameNavigated", commit);
    second.fire("Page.navigatedWithinDocument");
    assert.equal(await state(next), "pending", "新页面提交之后的 replaceState 不算导航完成");
  }
  // 超时
  {
    const { fake } = make();
    await assert.rejects(goto(fake, "https://a.test/", { timeout: 40 }), /goto timeout after 40ms/);
  }
}

console.log("task lib selfcheck ok");
