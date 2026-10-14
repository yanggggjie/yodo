import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// constants 在加载时按 HOME 计算 ~/.yodo 路径，先把 HOME 指到临时目录再动态 import，避免碰真实数据。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-session-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { ensureHolder, isPidAlive, restartStaleDaemon, tryPing } = await import("./session.ts");
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
  // 假 holder 的 ping 应答里的 extension 可调
  let extension = true;
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { id: string };
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pid: process.pid, chrome: "x", extension, pages: 0, record: null } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.listen(SESSION_SOCK, () => resolve()); server.on("error", reject); });
  try {
    assert.equal((await tryPing())?.pid, process.pid);
    assert.equal(await ensureHolder({ missingStatus: () => "need-install" }), null, "holder 在时不应判断缺什么");

    // holder 在，但 relay 已断开（extension: false）
    extension = false;
    //   Chrome 已退出：判成 need-chrome，立即返回，而不是 need-extension
    let started2 = Date.now();
    const chromeGone = await ensureHolder({ missingStatus: () => "need-chrome", readyMs: 5_000 });
    assert.equal((chromeGone?.data as { status: string }).status, "need-chrome");
    assert.ok(Date.now() - started2 < 1_000, "Chrome 已退出时不用等");
    //   Chrome 在运行：等扩展重连，超时后才是 need-extension
    started2 = Date.now();
    const waitingExt = await ensureHolder({ missingStatus: () => "need-extension", readyMs: 600 });
    assert.equal((waitingExt?.data as { status: string }).status, "need-extension");
    assert.ok(Date.now() - started2 >= 500, "应等待扩展重连");
    //   等待期间扩展连上：返回可用
    setTimeout(() => { extension = true; }, 300);
    assert.equal(await ensureHolder({ missingStatus: () => "need-extension", readyMs: 3_000 }), null, "扩展重连后可用");
  } finally {
    server.close();
  }

  // 过期的 daemon：build 和部署目录里的不同。空闲就请它退出并等新的接上；忙或者是旧版本就不动。
  {
    const state: { pid: number; mode?: string; build: string; extension: boolean; dead: boolean; revive: boolean } = { pid: process.pid, mode: "idle", build: "old", extension: true, dead: false, revive: true };
    const calls: string[] = [];
    const server2 = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as { id: string; method: string };
        calls.push(req.method);
        if (state.dead) { socket.destroy(); return; }
        if (req.method === "daemon.exit") {
          socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} })}\n`);
          // 旧 daemon 退出；新 daemon 在扩展重连后出现（pid 不同、build 是新的）
          if (state.revive) { state.pid += 1; state.build = "new"; } else state.dead = true;
          return;
        }
        socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pid: state.pid, chrome: "x", extension: state.extension, pages: 0, record: null, ...(state.mode ? { mode: state.mode } : {}), build: state.build, extensionBuild: "" } })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server2.listen(SESSION_SOCK, () => resolve()); server2.on("error", reject); });
    const reset = (patch: Partial<typeof state>): void => { Object.assign(state, { pid: process.pid, mode: "idle", build: "old", extension: true, dead: false, revive: true }, patch); calls.length = 0; };
    const newer = () => ({ build: "new", extension: "e" });
    try {
      // 空闲且 build 不同：请它退出，等到新 daemon
      reset({});
      const restarted = await restartStaleDaemon({ version: newer, waitMs: 3_000 });
      assert.equal(restarted.action, "restarted");
      assert.equal(calls.filter((c) => c === "daemon.exit").length, 1);
      assert.equal(restarted.action === "restarted" && restarted.ping.build, "new");

      // build 相同：不动
      reset({ build: "new" });
      assert.equal((await restartStaleDaemon({ version: newer })).action, "none");
      assert.ok(!calls.includes("daemon.exit"));

      // 正在 run / 录制：不动，留给下一次空闲
      for (const mode of ["run", "record", "record-op"]) {
        reset({ mode });
        assert.equal((await restartStaleDaemon({ version: newer })).action, "busy", mode);
        assert.ok(!calls.includes("daemon.exit"), `${mode} 时不能让 daemon 退出`);
      }

      // 旧 daemon（ping 里没有 mode）和开发时没有 .version：不动
      reset({ mode: undefined });
      assert.equal((await restartStaleDaemon({ version: newer })).action, "none");
      reset({});
      assert.equal((await restartStaleDaemon({ version: () => null })).action, "none");
      assert.ok(!calls.includes("daemon.exit"));

      // 扩展没连着：退出即可，新 daemon 要等扩展下次连接才出现，不等
      reset({ extension: false });
      const started3 = Date.now();
      assert.equal((await restartStaleDaemon({ version: newer, waitMs: 3_000 })).action, "exited");
      assert.ok(Date.now() - started3 < 1_000, "扩展没连着时不用等新 daemon");

      // 退出了但新 daemon 一直没出现：超时返回 failed
      reset({ revive: false });
      assert.equal((await restartStaleDaemon({ version: newer, waitMs: 600 })).action, "failed");

      // ensureHolder：过期且空闲的 daemon 会被换掉，之后可用
      reset({});
      assert.equal(await ensureHolder({ version: newer, missingStatus: () => "need-install" }), null);
      assert.equal(calls.filter((c) => c === "daemon.exit").length, 1, "每次调用最多重启一次");
      // 已经是最新的：不会再请它退出
      calls.length = 0;
      assert.equal(await ensureHolder({ version: newer, missingStatus: () => "need-install" }), null);
      assert.ok(!calls.includes("daemon.exit"));
    } finally {
      server2.close();
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("cli session selfcheck ok");
