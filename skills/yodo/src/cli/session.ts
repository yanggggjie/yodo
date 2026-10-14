import * as fs from "node:fs";
import { sleep } from "../utils/async.ts";
import { HOLDER_READY_MS, SESSION_DIR, SESSION_PID_FILE, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "../utils/constants.ts";
import { HANDSHAKE_GUIDES, type HandshakeStatus, type JsonRpcError } from "../protocol.ts";
import { chromeRunning } from "../browser/connect.ts";
import { nativeHostInstalled } from "../native-messaging-host/install.ts";
import { readVersion, type Version } from "../store/version.ts";
import { sessionRpc } from "./rpc.ts";

// holder 是 relay 拉起的常驻 daemon（relay 才是 Chrome 拉起的 native host），CLI 不启动它，只确认它在不在、不在时说清楚缺什么。

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

/**
 * extension：扩展链路是否接着。
 * mode / build / extensionBuild 是后加的字段，旧 daemon 的应答里没有。
 */
export type PingResult = {
  pid: number;
  chrome: string;
  extension: boolean;
  pages: number;
  record: string | null;
  mode?: "idle" | "run" | "record-op" | "record";
  /** daemon 启动时部署目录的 build。 */
  build?: string;
  /** 当前连着的扩展报告的 build；扩展没报告时为空串。 */
  extensionBuild?: string;
};
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

/** daemon 重启后等新 daemon 连上的最长时间：扩展按 1 秒起的指数退避重连，再加 relay 拉起 daemon 的时间。 */
const RESTART_WAIT_MS = 15_000;

export type StaleResult =
  | { action: "none" }
  | { action: "busy" }
  | { action: "restarted"; ping: PingResult }
  | { action: "exited" }
  | { action: "failed" };

/**
 * daemon 的 build 和部署目录里的不同、且空闲时，请它退出，并等新 daemon 连上。
 * 扩展没连着时，新 daemon 要等扩展下次连接才会出现，不等。
 * 忙（run、录制）时不动它，下次空闲时的第一条命令会再来一遍。旧 daemon（ping 里没有 mode）也不动。
 */
export async function restartStaleDaemon(options: { version?: () => Version | null; waitMs?: number; ping?: PingResult | null } = {}): Promise<StaleResult> {
  const installed = (options.version ?? readVersion)();
  if (!installed) return { action: "none" };
  const existing = options.ping === undefined ? await tryPing() : options.ping;
  if (!existing || existing.mode === undefined || existing.build === installed.build) return { action: "none" };
  if (existing.mode !== "idle") return { action: "busy" };
  try {
    await sessionRpc("daemon.exit", undefined, 2_000);
  } catch {
    return { action: "busy" }; // 刚好有人开始 run，或 daemon 已经在退出
  }
  if (!existing.extension) return { action: "exited" };
  const deadline = Date.now() + (options.waitMs ?? RESTART_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await tryPing();
    if (found && found.pid !== existing.pid && found.extension) return { action: "restarted", ping: found };
  }
  return { action: "failed" };
}

export interface AttachOptions {
  /** 部署目录的版本，默认读 .version；自检里注入。 */
  version?: () => Version | null;
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

  // holder 在，且扩展链路接着：可用。holder 在 relay 断开后会存活一段时间，所以 ping 通还不够。
  const existing = await tryPing();
  if (existing?.extension) {
    const stale = await restartStaleDaemon({ version: options.version, ping: existing });
    if (stale.action === "restarted") return { ok: true, result: stale.ping };
    // 重启没等到新 daemon：往下走，按"扩展没连上"处理，等它重连或返回握手状态。
    if (stale.action !== "failed") return { ok: true, result: existing };
  } else if (existing) {
    // daemon 在但扩展没连着：也让过期的 daemon 换掉，换完后新 daemon 会在扩展重连时出现。
    await restartStaleDaemon({ version: options.version, ping: existing });
  }

  // 没装 host 或 Chrome 没运行时扩展不可能连上，不用等；
  // holder 还在但 Chrome 已退出，也在这里被判成 need-chrome，而不是 need-extension。
  const early = status();
  if (early !== "need-extension") {
    clearStaleSession();
    return handshakeFailure(early);
  }

  // Chrome 在运行且 host 已注册：扩展可能正在（重新）连接，等一会。
  const deadline = Date.now() + (options.readyMs ?? HOLDER_READY_MS);
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await tryPing();
    if (found?.extension) return { ok: true, result: found };
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
