import * as fs from "node:fs";
import { sleep } from "../utils/async.ts";
import { HOLDER_READY_MS, SESSION_DIR, SESSION_PID_FILE, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "../utils/constants.ts";
import { HANDSHAKE_GUIDES, type HandshakeStatus, type JsonRpcError } from "../protocol.ts";
import { chromeRunning } from "../browser/connect.ts";
import { nativeHostInstalled } from "../native-messaging-host/install.ts";
import { sessionRpc, SessionUnavailableError } from "./rpc.ts";

// holder 由 Chrome 拉起（native messaging host），CLI 不再 spawn 它。

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

function clearStaleSession(): void {
  const pid = readSessionPid();
  if (pid && isPidAlive(pid)) return;
  if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true });
  fs.rmSync(SESSION_PID_FILE, { force: true });
}

type PingResult = { pid: number; chrome: string; pages: number; record: string | null };
type AttachResult = { ok: true; result: PingResult } | { ok: false; error: JsonRpcError };

async function tryPing(): Promise<PingResult | null> {
  const pid = readSessionPid();
  if (!pid || !isPidAlive(pid)) return null;
  try {
    return (await sessionRpc("ping", undefined, 2_000)) as PingResult;
  } catch {
    return null;
  }
}

/** holder 不在时，根据本机状态决定还缺什么：没装 → need-install；Chrome 没跑 → need-chrome；否则扩展没连 → need-extension。 */
export function missingStatus(): HandshakeStatus {
  if (!nativeHostInstalled()) return "need-install";
  if (!chromeRunning()) return "need-chrome";
  return "need-extension";
}

async function ensureAttached(): Promise<AttachResult> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const deadline = Date.now() + HOLDER_READY_MS;
  for (;;) {
    const existing = await tryPing();
    if (existing) return { ok: true, result: existing };
    if (Date.now() >= deadline) break;
    await sleep(200);
  }
  clearStaleSession();
  const status = missingStatus();
  return { ok: false, error: { code: -32010, message: HANDSHAKE_GUIDES[status], data: { status } } };
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

/** 确认 holder 可用。可用返回 null；不可用返回对应的握手状态。 */
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

/** SIGTERM 一个 pid 并等到它退出或超时。 */
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
