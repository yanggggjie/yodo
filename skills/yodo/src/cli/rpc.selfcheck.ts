import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { RpcError, RpcPeer, sessionRpc, SessionUnavailableError } from "./rpc.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-rpc-"));
const sock = path.join(dir, "sock");

type Request = { id: string; method: string };

// 假 holder：ping 回 pong；boom 回错误（带 data.status）；push 先推一条页面事件再回包。
const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl)) as Request;
    buf = buf.slice(nl + 1);
    if (req.method === "utf8") {
      // 一个汉字的三个字节被拆在两个数据块里：按块 toString() 会把它变成替换字符
      const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { text: "中文".repeat(10) } })}\n`);
      const cut = bytes.indexOf(Buffer.from("中")) + 1;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.write(bytes.subarray(cut)), 20);
    } else if (req.method === "overflow") {
      // daemon 在断开连接前先写一行没有 id 的错误，说明原因
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "", error: { code: -32603, message: "队列超限，已结束这次 run" } })}\n`, () => socket.destroy());
    } else if (req.method === "drop") {
      socket.destroy();
    } else if (req.method === "record.start") {
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32010, message: "guide", data: { status: "need-extension" } } })}\n`);
    } else if (req.method === "cdp.send") {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cdp.event", params: { sessionId: "P1", method: "Page.loadEventFired", params: { t: 1 } } })}\n`);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } })}\n`);
    } else {
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { text: "pong", pid: process.pid } })}\n`);
    }
  });
});

await new Promise<void>((resolve, reject) => {
  server.listen(sock, () => resolve());
  server.on("error", reject);
});

try {
  // 一次性请求
  const res = await sessionRpc("ping", undefined, 2_000, sock) as { text: string; pid: number };
  assert.equal(res.text, "pong");
  assert.equal(res.pid, process.pid);

  // 错误回包：保留 code 与 data.status，握手判断依赖它
  await assert.rejects(sessionRpc("record.start", undefined, 2_000, sock), (error) =>
    error instanceof RpcError && error.code === -32010 && (error.data as { status: string }).status === "need-extension");

  // 长连接：页面事件按 sessionId 与 method 分发给监听者
  const peer = await RpcPeer.open(sock);
  const events: unknown[] = [];
  const off = peer.addListener({ event: "Page.loadEventFired", pageId: "P1", fn: (params) => events.push(params) });
  const other: unknown[] = [];
  peer.addListener({ event: "Page.loadEventFired", pageId: "P2", fn: (params) => other.push(params) });
  assert.deepEqual(await peer.request("cdp.send", { pageId: "P1" }), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, [{ t: 1 }]);
  assert.deepEqual(other, [], "别的页面的监听者不应收到事件");
  off();
  peer.close();

  // 汉字被拆在两个数据块里，内容不变
  assert.deepEqual(await sessionRpc("utf8" as never, undefined, 2_000, sock), { text: "中文".repeat(10) });

  // 监听函数抛错：peer.failure reject 带着这个错误，不是未捕获异常
  const listening = await RpcPeer.open(sock);
  listening.addListener({ event: "Page.loadEventFired", pageId: "P1", fn: () => { throw new Error("listener boom"); } });
  void listening.request("cdp.send", { pageId: "P1" });
  await assert.rejects(listening.failure, /listener boom/);
  listening.close();

  // daemon 说明了原因再断开：等待中的请求和 failure 都带这个原因，而不是笼统的"连接已关闭"
  const overflowed = await RpcPeer.open(sock);
  const waiting = overflowed.request("overflow" as never);
  await assert.rejects(waiting, /队列超限/);
  await assert.rejects(overflowed.failure, /队列超限/);

  // 连接意外断开（没有说明）：failure reject，等事件的 task 不会一直挂着；我们自己 close 不算失败
  const dropped = await RpcPeer.open(sock);
  void dropped.request("drop" as never).catch(() => {});
  await assert.rejects(dropped.failure, /holder 连接已关闭/);
  const closedByUs = await RpcPeer.open(sock);
  closedByUs.close();
  const settled = await Promise.race([closedByUs.failure.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 100))]);
  assert.equal(settled, "pending", "自己关闭连接不应让 failure reject");
} finally {
  server.close();
}

// 连不上 holder：统一成 SessionUnavailableError
await assert.rejects(sessionRpc("ping", undefined, 2_000, path.join(dir, "missing.sock")), SessionUnavailableError);

fs.rmSync(dir, { recursive: true, force: true });
console.log("cli rpc selfcheck ok");
