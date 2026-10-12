import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/** 本机数据根目录（写死，无 env 覆盖）。 */
export const YODO_HOME = path.join(os.homedir(), ".yodo");
export const TASK_DIR = path.join(YODO_HOME, "task");
export const RECORD_DIR = path.join(YODO_HOME, "record");
export const SESSION_DIR = path.join(YODO_HOME, "session");
/** 运行历史：run/<task>/<时间戳>.json，组合运行记为 run/compose/。 */
export const RUN_DIR = path.join(YODO_HOME, "run");
/** 每个 task（含 compose）保留的最近运行历史份数。 */
export const RUN_HISTORY_KEEP = 20;
/** `yodo eval` 生成的临时组合脚本目录，运行后删除。 */
export const COMPOSE_DIR = path.join(SESSION_DIR, "compose");
/** 进行中的录制目录；stop 时移入 RECORD_DIR，holder 启动时清理残留。 */
export const RECORDING_DIR = path.join(SESSION_DIR, "recording");
/** posix 用文件 socket；win32 用 named pipe（不是 fs 文件）。 */
export const SESSION_SOCK_IS_FILE = process.platform !== "win32";
export const SESSION_SOCK = SESSION_SOCK_IS_FILE
  ? path.join(SESSION_DIR, "sock")
  : `\\\\.\\pipe\\yodo-${createHash("sha256").update(os.homedir()).digest("hex").slice(0, 12)}`;
/** relay 与 daemon 之间的扩展通道；win32 用独立 named pipe。 */
export const SESSION_EXT_SOCK = SESSION_SOCK_IS_FILE ? path.join(SESSION_DIR, "ext.sock") : `${SESSION_SOCK}-ext`;
export const SESSION_PID_FILE = path.join(SESSION_DIR, "pid");
export const SESSION_LOG = path.join(SESSION_DIR, "log.jsonl");

/** attach / idle 时的短 CDP 超时。与「最多 5 次」无关。 */
export const CDP_SHORT_TIMEOUT_MS = 2_000;
/** holder 起来并连上已开 CDP 的 Chrome。不等 Allow。 */
export const HOLDER_READY_MS = 8_000;
export const CDP_COMMAND_TIMEOUT_MS = 30_000;
/** CLI 等 holder 回包比脚本 watchdog 多这点，给 failure JSON + settleIdle。 */
export const CLI_RPC_BUFFER_MS = 5_000;
export const RECORD_STOP_RPC_MS = 60_000;
/** 录制最长 5 分钟，到点按 stop 归档。 */
export const RECORD_MAX_MS = 5 * 60 * 1000;
export const SESSION_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
/** 响应体超过此值拆到 *.response.json / *.response.html */
export const RESPONSE_SPLIT_BYTES = 1024;
