import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sleep } from "../utils/async.ts";
import {
  HOLDER_READY_MS,
  SESSION_DIR,
  SESSION_LOG,
  SESSION_PID_FILE,
  SESSION_SOCK,
  SESSION_SOCK_IS_FILE,
} from "../utils/constants.ts";
import { SRC_ROOT } from "../utils/pkg-root.ts";
import {
  HANDSHAKE_GUIDES,
  handshakeStatusFromMark,
  type HandshakeStatus,
  type JsonRpcError,
} from "../protocol.ts";
import { sessionRpc, SessionUnavailableError } from "./rpc.ts";

const LOG_TAIL_BYTES = 64 * 1024;

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readSessionPid(): number | null {
  try {
    const n = Number(fs.readFileSync(SESSION_PID_FILE, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function cleanNpmEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD" || key === "PROJECT_CWD") {
      delete env[key];
    }
  }
  return env;
}

function clearStaleSession(): void {
  const pid = readSessionPid();
  if (pid && isPidAlive(pid)) return;
  if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true });
  fs.rmSync(SESSION_PID_FILE, { force: true });
}

/** ping 只有 ok 才是可复用 session。带 handshake status 的活进程当 stale。 */
type PingResult = { pid: number; chrome: string; pages: number; record: string | null };
type AttachResult = { ok: true; result: PingResult } | { ok: false; error: JsonRpcError };

async function tryPing(): Promise<PingResult | null> {
  const pid = readSessionPid();
  if (!pid || !isPidAlive(pid)) return null;
  try {
    return await sessionRpc("ping", undefined, 2_000) as PingResult;
  } catch {
    return null;
  }
}

function spawnHolder(): number {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const holderJs = path.join(SRC_ROOT, "holder.ts");
  const child = child_process.spawn(process.execPath, [holderJs], {
    detached: true,
    stdio: "ignore",
    env: cleanNpmEnv(),
  });
  if (child.pid == null) throw new Error("spawn holder 没有 pid");
  child.unref();
  fs.writeFileSync(SESSION_PID_FILE, `${child.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return child.pid;
}

export function readHandshakeFromLogFile(file = SESSION_LOG): HandshakeStatus | null {
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, LOG_TAIL_BYTES);
    if (n <= 0) return null;
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, n, st.size - n);
    } finally {
      fs.closeSync(fd);
    }
    return handshakeStatusFromMark(buf.toString("utf8"));
  } catch {
    return null;
  }
}

async function waitReady(pid: number, ms: number): Promise<AttachResult> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      const status = readHandshakeFromLogFile();
      if (status) {
        return { ok: false, error: { code: -32010, message: HANDSHAKE_GUIDES[status], data: { status } } };
      }
      throw new Error(`holder 启动失败，详见 ${SESSION_LOG}`);
    }
    try {
      const result = await sessionRpc("ping", undefined, 500) as PingResult;
      return { ok: true, result };
    } catch {
      /* still booting */
    }
    await sleep(100);
  }
  const status = readHandshakeFromLogFile();
  if (status) {
    return { ok: false, error: { code: -32010, message: HANDSHAKE_GUIDES[status], data: { status } } };
  }
  throw new Error(`holder 未就绪，详见 ${SESSION_LOG}`);
}

async function ensureAttached(): Promise<AttachResult> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const existing = await tryPing();
  if (existing) return { ok: true, result: existing };
  const pid = readSessionPid();
  if (pid && isPidAlive(pid)) return waitReady(pid, HOLDER_READY_MS);
  clearStaleSession();
  return waitReady(spawnHolder(), HOLDER_READY_MS);
}

export async function ensureSessionAndRpc(
  method: Parameters<typeof sessionRpc>[0],
  params: Parameters<typeof sessionRpc>[1],
  ms: number,
): Promise<unknown> {
  const attached = await ensureAttached();
  if (!attached.ok) throw Object.assign(new Error(attached.error.message), attached.error);
  return sessionRpc(method, params, ms);
}

/** 确保 holder 起来并就绪。就绪返回 null；被 handshake 挡住返回那条响应。 */
export async function ensureHolder(): Promise<JsonRpcError | null> {
  const attached = await ensureAttached();
  return attached.ok ? null : attached.error;
}

export async function rpcExistingSession(
  method: Parameters<typeof sessionRpc>[0],
  params: Parameters<typeof sessionRpc>[1],
  ms: number,
): Promise<unknown | null> {
  const pid = readSessionPid();
  if (!pid || !isPidAlive(pid)) {
    clearStaleSession();
    return null;
  }
  try {
    return await sessionRpc(method, params, ms);
  } catch (error) {
    if (error instanceof SessionUnavailableError) {
      clearStaleSession();
      return null;
    }
    throw error;
  }
}

/** SIGTERM 一个 pid 并等到它退出或超时。setup 停旧 holder 也走这条。 */
export async function stopPid(pid: number, ms = 5_000): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(50);
}

export async function stopCurrentHolder(ms = 5_000): Promise<void> {
  const pid = readSessionPid();
  if (!pid || !isPidAlive(pid)) {
    clearStaleSession();
    return;
  }
  await stopPid(pid, ms);
  clearStaleSession();
}
