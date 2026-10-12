import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { RpcError, RpcPeer } from "./cli/rpc.ts";
import { beginRun } from "./sdk.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-busy-"));
const sock = path.join(dir, "sock");

// 假 holder：按脚本依次回应 run.begin
let script: Array<{ reason: string } | "ok"> = [];
let calls = 0;
const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, nl)) as { id: string };
      buf = buf.slice(nl + 1);
      calls++;
      const step = script.shift() ?? "ok";
      const reply = step === "ok"
        ? { jsonrpc: "2.0", id: req.id, result: { pageId: "P1" } }
        : { jsonrpc: "2.0", id: req.id, error: { code: -32002, message: "busy", data: { reason: step.reason } } };
      socket.write(`${JSON.stringify(reply)}\n`);
    }
  });
});
await new Promise<void>((resolve) => server.listen(sock, resolve));

try {
  const peer = await RpcPeer.open(sock);

  // 另一个 task 在运行：等待后重试成功
  script = [{ reason: "run" }, { reason: "run" }, "ok"];
  calls = 0;
  assert.deepEqual(await beginRun(peer, 5_000), { pageId: "P1" });
  assert.equal(calls, 3, "前两次忙碌，第三次成功");

  // 一直忙：等到上限后抛出带原因的 RpcError
  script = Array.from({ length: 50 }, () => ({ reason: "run" }));
  await assert.rejects(beginRun(peer, 700), (error) => error instanceof RpcError && error.code === -32002);

  // 录制进行中不会很快结束：不等待，立即报错
  script = [{ reason: "record" }];
  calls = 0;
  await assert.rejects(beginRun(peer, 5_000), (error) => error instanceof RpcError && (error.data as { reason: string }).reason === "record");
  assert.equal(calls, 1);

  peer.close();
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("sdk busy selfcheck ok");
