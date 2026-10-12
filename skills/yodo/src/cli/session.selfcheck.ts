import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// constants 在加载时按 HOME 计算 ~/.yodo 路径，先把 HOME 指到临时目录再动态 import，避免碰真实数据。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-session-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { ensureHolder, isPidAlive, tryPing } = await import("./session.ts");
const { SESSION_DIR, SESSION_PID_FILE, SESSION_SOCK } = await import("../utils/constants.ts");

try {
  assert.ok(isPidAlive(process.pid), "当前进程应活着");
  assert.equal(isPidAlive(0), false);

  // 没装 host / Chrome 没运行：立即返回，不等 readyMs
  for (const status of ["need-install", "need-chrome"] as const) {
    const started = Date.now();
    const blocked = await ensureHolder({ missingStatus: () => status, readyMs: 5_000 });
    assert.equal((blocked?.data as { status: string }).status, status);
    assert.ok(Date.now() - started < 1_000, `${status} 应立即返回`);
  }

  // Chrome 在运行但扩展没连：等满 readyMs 后返回 need-extension
  const started = Date.now();
  const waiting = await ensureHolder({ missingStatus: () => "need-extension", readyMs: 600 });
  assert.equal((waiting?.data as { status: string }).status, "need-extension");
  assert.ok(Date.now() - started >= 500, "need-extension 应等待扩展连接");

  // holder 在：pid 文件 + 能应答 ping
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_PID_FILE, String(process.pid));
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { id: string };
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pid: process.pid, chrome: "x", pages: 0, record: null } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.listen(SESSION_SOCK, () => resolve()); server.on("error", reject); });
  try {
    assert.equal((await tryPing())?.pid, process.pid);
    assert.equal(await ensureHolder({ missingStatus: () => "need-install" }), null, "holder 在时不应判断缺什么");
  } finally {
    server.close();
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("cli session selfcheck ok");
