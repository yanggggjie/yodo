import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { sessionRpc } from "./rpc.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-rpc-"));
const sock = path.join(dir, "sock");

const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl)) as { id: string; op: string };
    socket.end(
      `${JSON.stringify({ id: req.id, ok: true, text: "pong", pid: process.pid })}\n`,
    );
  });
});

await new Promise<void>((resolve, reject) => {
  server.listen(sock, () => resolve());
  server.on("error", reject);
});

try {
  const res = await sessionRpc({ op: "ping" }, 2_000, sock);
  assert.equal(res.ok, true);
  assert.equal(res.text, "pong");
  assert.equal(res.pid, process.pid);
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("cli rpc selfcheck ok");
