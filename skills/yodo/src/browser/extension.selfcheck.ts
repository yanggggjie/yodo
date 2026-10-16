import assert from "node:assert/strict";
import { ExtensionLink, frame, parseFrames, PROTOCOL_VERSION } from "./extension.ts";

// 分帧：往返一致；半包不吐消息，拼完整后再吐
{
  const out: Record<string, unknown>[] = [];
  const a = frame({ id: 1, op: "tab", name: "listOwned", args: {} });
  const b = frame({ type: "event", tabId: 7, method: "Page.loadEventFired", params: { 中文: "ok" } });
  const all = Buffer.concat([a, b]);
  const rest = parseFrames(all.subarray(0, 5), (m) => out.push(m));
  assert.equal(out.length, 0, "半包不应吐消息");
  const rest2 = parseFrames(Buffer.concat([rest, all.subarray(5)]), (m) => out.push(m));
  assert.equal(rest2.length, 0);
  assert.equal(out.length, 2);
  assert.equal(out[1]?.method, "Page.loadEventFired");
  assert.deepEqual((out[1]?.params as { 中文: string }).中文, "ok");
}

// 链路：写出的请求带 id；应答按 id 匹配；事件带 tabId 作为 sessionId
{
  const written: Record<string, unknown>[] = [];
  const link = new ExtensionLink();
  link.write = (m) => written.push(m);
  link.hello({ type: "hello", protocolVersion: PROTOCOL_VERSION, chromeVersion: "Chrome/x" });
  assert.equal(link.raw.chromeVersion, "Chrome/x");

  const seen: { params: unknown; sessionId?: string }[] = [];
  link.raw.on("Page.frameNavigated", (params, sessionId) => seen.push({ params, sessionId }));
  link.receive({ type: "event", tabId: 7, method: "Page.frameNavigated", params: { frame: { url: "https://a" } } });
  assert.equal(seen[0]?.sessionId, "7");

  const removed: unknown[] = [];
  link.raw.on("tab.removed", (params) => removed.push(params));
  link.receive({ type: "tab", kind: "removed", tabId: 7, windowId: 1 });
  assert.equal((removed[0] as { tabId: number }).tabId, 7);

  const listed = link.ops.listOwned();
  const req = written[written.length - 1]!;
  assert.equal(req.op, "tab");
  assert.equal(req.name, "listOwned");
  link.receive({ id: req.id, result: { tabs: [{ tabId: 7, windowId: 1, url: "https://a" }] } });
  assert.equal((await listed).tabs[0]?.tabId, 7);

  const sent = link.raw.send("Runtime.evaluate", { expression: "1" }, "7");
  const cdp = written[written.length - 1]!;
  assert.equal(cdp.op, "cdp");
  assert.equal(cdp.tabId, 7);
  assert.equal(cdp.method, "Runtime.evaluate");
  link.receive({ id: cdp.id, error: { message: "boom" } });
  await assert.rejects(sent, /boom/);

  // browser 级命令（无 sessionId）不发出去
  await assert.rejects(link.raw.send("Target.getTargets"), /browser 级 CDP 不可用/);
  assert.equal(written.filter((m) => m.method === "Target.getTargets").length, 0);
}

// 版本不一致直接报错
{
  const link = new ExtensionLink();
  assert.throws(() => link.hello({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1 }), /协议版本/);
}

// 连接关闭：未完成的请求被拒绝，close 处理函数被调用
{
  const link = new ExtensionLink();
  link.write = () => {};
  let closed = 0;
  link.onClose(() => closed++);
  const pending = link.ops.closeTab(1);
  link.close();
  await assert.rejects(pending, /扩展通道已关闭/);
  assert.equal(closed, 1);
  assert.equal(link.raw.isClosed(), true);
}

console.log("browser extension selfcheck ok");
