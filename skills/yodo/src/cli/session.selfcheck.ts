import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// constants 在加载时按 HOME 计算 ~/.yodo 路径，先把 HOME 指到临时目录再动态 import，避免碰真实数据。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-session-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { ensureHolder, restartDaemon, tryPing } = await import("./session.ts");
const { SESSION_DIR, SESSION_SOCK } = await import("../utils/constants.ts");

try {
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

  // holder 在：只看 socket 能不能回 ping。这里**故意不写 pid 文件**，
  // 因为 pid 文件不是判据——它丢了（被测试写坏、被清理工具删掉）不能影响判定。
  fs.mkdirSync(SESSION_DIR, { recursive: true });
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

  // restartDaemon：按 ping 里的 pid 发 SIGTERM。忙时不杀；旧 daemon（ping 里没有 mode）直接杀。
  // 注意 pid 必须是一个真实的、可丢弃的子进程，不能是本进程：信号是真的会发出去的。
  {
    const state: { pid: number; mode?: string; extension: boolean } = { pid: 0, mode: "idle", extension: true };
    const spawned: ChildProcess[] = [];
    const spawnVictim = (): ChildProcess => { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); spawned.push(child); return child; };
    const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const server2 = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as { id: string };
        socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pid: state.pid, chrome: "x", extension: state.extension, pages: 0, record: null, ...(state.mode ? { mode: state.mode } : {}), build: "old", extensionBuild: "" } })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server2.listen(SESSION_SOCK, () => resolve()); server2.on("error", reject); });
    const waitDead = async (child: ChildProcess): Promise<boolean> => { for (let i = 0; i < 40; i++) { if (child.exitCode !== null || child.signalCode !== null) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    try {
      // 空闲：杀掉目标进程；扩展没连着就不等新 daemon
      for (const extension of [false]) {
        const child = spawnVictim(); state.pid = child.pid!; state.mode = "idle"; state.extension = extension;
        const started = Date.now();
        assert.equal((await restartDaemon({ waitMs: 3_000 })).action, "killed");
        assert.ok(await waitDead(child), "空闲时目标进程应被 SIGTERM 杀掉");
        assert.ok(Date.now() - started < 1_000, "扩展没连着时不用等新 daemon");
      }

      // 空闲且扩展连着：杀掉后，等 ping 里出现不同的 pid（新 daemon），返回 restarted
      {
        const old = spawnVictim(); const fresh = spawnVictim();
        state.pid = old.pid!; state.mode = "idle"; state.extension = true;
        setTimeout(() => { state.pid = fresh.pid!; }, 300); // 旧的退出后，新 daemon 在扩展重连后出现
        const result = await restartDaemon({ waitMs: 3_000 });
        assert.equal(result.action, "restarted");
        assert.equal(result.action === "restarted" && result.ping.pid, fresh.pid);
        assert.ok(await waitDead(old), "旧进程应被杀掉");
        assert.ok(isAlive(fresh.pid!), "新进程不能被误杀");
        fresh.kill();
      }

      // 正在 run / 录制：拒绝，目标进程必须还活着
      for (const mode of ["run", "record", "record-op"]) {
        const child = spawnVictim(); state.pid = child.pid!; state.mode = mode; state.extension = true;
        const result = await restartDaemon({ waitMs: 300 });
        assert.deepEqual(result, { action: "busy", mode }, mode);
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(isAlive(child.pid!), `${mode} 时不能杀 daemon`);
        child.kill();
      }

      // 旧 daemon（ping 里没有 mode，无从判断忙闲）：直接杀
      {
        const child = spawnVictim(); state.pid = child.pid!; state.mode = undefined; state.extension = false;
        assert.equal((await restartDaemon({ waitMs: 300 })).action, "killed");
        assert.ok(await waitDead(child), "旧 daemon 应被直接杀掉");
      }

      // 退出了但新 daemon 一直没出现：超时返回 failed
      {
        const child = spawnVictim(); state.pid = child.pid!; state.mode = "idle"; state.extension = true;
        // 假 holder 一直报告同一个 pid，相当于新 daemon 没起来
        assert.equal((await restartDaemon({ waitMs: 600 })).action, "failed");
        await waitDead(child);
      }

      // ensureHolder 不碰版本判断，也不会杀 daemon：目标进程必须还活着
      {
        const child = spawnVictim(); state.pid = child.pid!; state.mode = "idle"; state.extension = true;
        assert.equal(await ensureHolder({ missingStatus: () => "need-install" }), null, "daemon 在时直接可用");
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(isAlive(child.pid!), "ensureHolder 不应杀 daemon");
        child.kill();
      }
    } finally {
      for (const child of spawned) child.kill(); // 兜底：任何用例中途失败也不留下孤儿进程
      server2.close();
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("cli session selfcheck ok");
