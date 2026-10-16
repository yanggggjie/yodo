import * as fs from "node:fs";
import { sleep } from "../utils/async.ts";
import { HOLDER_READY_MS, SESSION_DIR, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "../utils/constants.ts";
import { HANDSHAKE_GUIDES, type HandshakeStatus, type JsonRpcError } from "../protocol.ts";
import { chromeRunning } from "../browser/connect.ts";
import { nativeHostInstalled } from "../native-messaging-host/install.ts";
import { sessionRpc } from "./rpc.ts";

// holder 是 relay 拉起的常驻 daemon（relay 才是 Chrome 拉起的 native host），CLI 不启动它，只确认它在不在、不在时说清楚缺什么。
// 存活判据只有一条：socket 能不能回 ping。pid 文件只是 holder 自己留下的展示信息，不参与判断。

/**
 * 清掉残留的 socket 文件。判据也是 ping：能应答（哪怕扩展没连上）说明 holder 活着，socket 留着；
 * 完全没应答才当成残留。原来这里读 pid 文件判断，pid 文件丢了就会误删活着的 holder 的 socket。
 */
function clearStaleSession(ping: PingResult | null): void {
  if (ping) return;
  if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true });
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

/** 发一次 ping。连不上就返回 null——判据是 socket 本身，pid 文件丢了不影响。 */
export async function tryPing(): Promise<PingResult | null> {
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

export type RestartResult =
  | { action: "busy"; mode: string }
  | { action: "none" }
  | { action: "killed" }
  | { action: "restarted"; ping: PingResult }
  | { action: "failed" };

/**
 * 重启 holder：按 ping 里的 pid 发 SIGTERM（holder 收到后走 shutdown：收尾录制、关 run 窗、再退出），不请求它自己退出。
 * 这样新旧 daemon 走同一条路，不依赖对方实现了哪个 RPC。
 * - 忙（run、录制）时拒绝，不杀：会打断正在进行的操作。
 * - 旧 daemon（ping 里没有 mode，无从判断忙闲）直接杀：它本来就没法保证"忙时不杀"，让它活着的代价更大。
 * - 没有 holder：返回 none。
 * - 扩展没连着时新 daemon 要等扩展下次连接才会出现，只返回 killed，不等。
 */
export async function restartDaemon(options: { waitMs?: number } = {}): Promise<RestartResult> {
  const existing = await tryPing();
  if (!existing) return { action: "none" };
  if (existing.mode !== undefined && existing.mode !== "idle") return { action: "busy", mode: existing.mode };
  try {
    process.kill(existing.pid, "SIGTERM");
  } catch {
    return { action: "none" }; // 刚好已经退出
  }
  if (!existing.extension) return { action: "killed" };
  const deadline = Date.now() + (options.waitMs ?? RESTART_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await tryPing();
    if (found && found.pid !== existing.pid && found.extension) return { action: "restarted", ping: found };
  }
  return { action: "failed" };
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

  // holder 在，且扩展链路接着：可用。holder 在 relay 断开后会存活一段时间，所以 ping 通还不够。
  // 版本是不是最新的不在这里判断：换代码只在 setup.js 或 `yodo daemon restart` 时发生（见 restartDaemon），
  // 不在每条命令里偷偷检查、重启——那样一条不相关的命令会隐式触发进程重启和几秒等待。
  const existing = await tryPing();
  if (existing?.extension) return { ok: true, result: existing };

  // 没装 host 或 Chrome 没运行时扩展不可能连上，不用等；
  // holder 还在但 Chrome 已退出，也在这里被判成 need-chrome，而不是 need-extension。
  const early = status();
  if (early !== "need-extension") {
    clearStaleSession(existing);
    return handshakeFailure(early);
  }

  // Chrome 在运行且 host 已注册：扩展可能正在（重新）连接，等一会。
  const deadline = Date.now() + (options.readyMs ?? HOLDER_READY_MS);
  let last = existing;
  while (Date.now() < deadline) {
    await sleep(200);
    last = await tryPing();
    if (last?.extension) return { ok: true, result: last };
  }
  clearStaleSession(last);
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
