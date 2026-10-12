import * as fs from "node:fs";
import { sleep } from "../utils/async.ts";
import { HOLDER_READY_MS, SESSION_DIR, SESSION_PID_FILE, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "../utils/constants.ts";
import { HANDSHAKE_GUIDES, type HandshakeStatus, type JsonRpcError } from "../protocol.ts";
import { chromeRunning } from "../browser/connect.ts";
import { nativeHostInstalled } from "../native-messaging-host/install.ts";
import { sessionRpc } from "./rpc.ts";

// holder 由 Chrome 拉起（native messaging host），CLI 不启动它，只确认它在不在、不在时说清楚缺什么。

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

export type PingResult = { pid: number; chrome: string; pages: number; record: string | null };
type AttachResult = { ok: true; result: PingResult } | { ok: false; error: JsonRpcError };

/** pid 文件存在且进程活着时发一次 ping；任何一步失败返回 null。 */
export async function tryPing(): Promise<PingResult | null> {
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

export interface AttachOptions {
  /** 判断缺什么，默认读本机状态；自检里注入。 */
  missingStatus?: () => HandshakeStatus;
  /** need-extension 时等待扩展连上的时间，默认 HOLDER_READY_MS。 */
  readyMs?: number;
}

function handshakeFailure(status: HandshakeStatus): AttachResult {
  return { ok: false, error: { code: -32010, message: HANDSHAKE_GUIDES[status], data: { status } } };
}

async function ensureAttached(options: AttachOptions = {}): Promise<AttachResult> {
  const status = options.missingStatus ?? missingStatus;
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const existing = await tryPing();
  if (existing) return { ok: true, result: existing };

  // 没装 host 或 Chrome 没运行时 holder 不可能出现，不用等。
  const early = status();
  if (early !== "need-extension") {
    clearStaleSession();
    return handshakeFailure(early);
  }

  // Chrome 在运行且 host 已注册：扩展可能正在连接，等一会。
  const deadline = Date.now() + (options.readyMs ?? HOLDER_READY_MS);
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await tryPing();
    if (found) return { ok: true, result: found };
  }
  clearStaleSession();
  return handshakeFailure(status());
}

export async function ensureSessionAndRpc(
  method: Parameters<typeof sessionRpc>[0],
  params: Parameters<typeof sessionRpc>[1],
  ms: number,
  options?: AttachOptions,
): Promise<unknown> {
  const attached = await ensureAttached(options);
  if (!attached.ok) throw Object.assign(new Error(attached.error.message), attached.error);
  return sessionRpc(method, params, ms);
}

/** 确认 holder 可用。可用返回 null；不可用返回对应的握手状态。 */
export async function ensureHolder(options?: AttachOptions): Promise<JsonRpcError | null> {
  const attached = await ensureAttached(options);
  return attached.ok ? null : attached.error;
}
