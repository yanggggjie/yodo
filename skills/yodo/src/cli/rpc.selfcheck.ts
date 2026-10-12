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
    if (req.method === "record.start") {
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
} finally {
  server.close();
}

// 连不上 holder：统一成 SessionUnavailableError
await assert.rejects(sessionRpc("ping", undefined, 2_000, path.join(dir, "missing.sock")), SessionUnavailableError);

fs.rmSync(dir, { recursive: true, force: true });
console.log("cli rpc selfcheck ok");
