import assert from "node:assert/strict";
import { click, fill, press, scroll } from "./templates/task-lib/dom.js";
import { evaluate, goto } from "./templates/task-lib/page.js";
import type { PageHandle } from "./sdk.ts";

const calls: string[] = [];
const expressions: string[] = [];
const listeners = new Map<string, (value: unknown) => void>();
const page = { _targetId: "P1", cdp: {
  async send(method: string, params?: { expression?: string }) {
    calls.push(method);
    if (method === "Runtime.evaluate") {
      const expression = params?.expression ?? "";
      if (expression.includes(".click()") || expression.includes("setter.call") || expression.includes("new KeyboardEvent") || expression.includes("scrollBy")) {
        expressions.push(expression);
        return { result: { value: expression.includes("setter.call") ? "hello" : undefined } };
      }
      return { result: { value: 42 } };
    }
    if (method === "Page.navigate") { queueMicrotask(() => listeners.get("Page.loadEventFired")?.({})); return {}; }
    return {};
  },
  async on(event: string, listener: (value: unknown) => void) { listeners.set(event, listener); return async () => { listeners.delete(event); }; },
  async once() { return {}; },
} } as unknown as PageHandle;

assert.equal(await evaluate(page, "21 * 2"), 42);
await goto(page, "https://example.com");
assert.deepEqual(calls, ["Runtime.enable", "Runtime.evaluate", "Page.enable", "Page.navigate"]);
assert.equal(listeners.size, 0);

const before = calls.length;
await click(page, "#go");
await fill(page, "#q", "hello");
await press(page, "#q", "Enter");
await scroll(page, undefined, { deltaY: 120 });
assert.ok(calls.slice(before).every((method) => method === "Runtime.enable" || method === "Runtime.evaluate"));
assert.equal(expressions.length, 4);
assert.ok(expressions.every((expression) => !expression.includes("Input.")));
assert.match(expressions[0], /\.click\(\)/);
assert.match(expressions[1], /setter\.call/);
assert.match(expressions[2], /new KeyboardEvent/);
assert.match(expressions[3], /scrollBy/);
console.log("task lib selfcheck ok");
