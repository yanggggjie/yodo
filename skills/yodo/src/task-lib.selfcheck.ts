import assert from "node:assert/strict";
import { evaluate, goto } from "./templates/task-lib/page.js";
import type { PageHandle } from "./sdk.ts";

const calls: string[] = [];
const listeners = new Map<string, (value: unknown) => void>();
const page = { _targetId: "P1", cdp: {
  async send(method: string) { calls.push(method); if (method === "Runtime.evaluate") return { result: { value: 42 } }; if (method === "Page.navigate") { queueMicrotask(() => listeners.get("Page.loadEventFired")?.({})); return {}; } return {}; },
  async on(event: string, listener: (value: unknown) => void) { listeners.set(event, listener); return async () => { listeners.delete(event); }; },
  async once() { return {}; },
} } as unknown as PageHandle;

assert.equal(await evaluate(page, "21 * 2"), 42);
await goto(page, "https://example.com");
assert.deepEqual(calls, ["Runtime.enable", "Runtime.evaluate", "Page.enable", "Page.navigate"]);
assert.equal(listeners.size, 0);
console.log("task lib selfcheck ok");
