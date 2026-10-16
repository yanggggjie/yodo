/**
 * native messaging host（由 Chrome 拉起）：把 stdio 逐字节转给 daemon 的扩展 socket，不解析、不持有状态。
 * 任一端断开就退出；Chrome 下次连接时重新拉起。daemon 不存在时由 relay 拉起。
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { SESSION_EXT_SOCK } from "../utils/constants.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("../holder.ts", import.meta.url));
const RETRY_MS = 200;
const DEADLINE_MS = 15_000;

function connectOnce(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SESSION_EXT_SOCK);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function connectDaemon(): Promise<net.Socket> {
  const deadline = Date.now() + DEADLINE_MS;
  let spawned = false;
  for (;;) {
    try {
      return await connectOnce();
    } catch (error) {
      if (!spawned) {
        spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: "ignore" }).unref();
        spawned = true;
      }
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

const sock = await connectDaemon().catch(() => process.exit(1));
const exit = (): void => process.exit(0);
process.stdin.pipe(sock);
sock.pipe(process.stdout);
process.stdin.on("end", exit);
sock.on("end", exit);
sock.on("close", exit);
sock.on("error", exit);
process.stdout.on("error", exit);
