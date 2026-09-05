export type SessionOp =
  | "ping"
  | "run.begin"
  | "run.end"
  | "page.for-origin"
  | "page.goto"
  | "page.evaluate"
  | "page.url"
  | "page.title"
  | "page.close"
  | "page.bring-to-front"
  | "context.new-page"
  | "record.start"
  | "record.stop"
  | "record.abort";

export type HandshakeStatus =
  | "need-install"
  | "need-chrome"
  | "need-remote-debugging"
  | "need-allow";

export type StdoutStatus =
  | HandshakeStatus
  | "recording"
  | "stopped"
  | "aborted"
  | "idle"
  | "success"
  | "failure";

export type SessionRequest = {
  id: string;
  op: SessionOp;
  /** page.* 目标页句柄（= CDP targetId） */
  pageId?: string;
  /** page.for-origin */
  origin?: string;
  /** page.goto */
  url?: string;
  /** page.evaluate：已拼好的表达式（client 侧把 fn+args 序列化） */
  expr?: string;
  /** record.start */
  name?: string;
  /** page.goto 毫秒超时 */
  timeoutMs?: number;
};

export type SessionResponse = {
  id: string;
  ok: boolean;
  error?: string;
  /** record.* 的 stdout 文本 */
  text?: string;
  status?: StdoutStatus;
  guide?: string;
  /** ping */
  pid?: number;
  chrome?: string;
  pages?: number;
  record?: string | null;
  /** page.for-origin / context.new-page */
  pageId?: string;
  /** page.for-origin / page.url / context.new-page */
  url?: string;
  /** page.title */
  title?: string;
  /** page.evaluate 结果（任意 JSON） */
  value?: unknown;
};

export const HANDSHAKE_GUIDES: Record<HandshakeStatus, string> = {
  "need-install": "请安装 Google Chrome。好了告诉我。",
  "need-chrome": "请打开 Google Chrome。好了告诉我。",
  "need-remote-debugging":
    "请打开这个 Chrome 实例的 remote-debugging 开关。好了告诉我。",
  "need-allow": "请点允许本次会话的 remote-debugging 弹窗。好了告诉我。",
};

export const HANDSHAKE_MARKS: Record<HandshakeStatus, string> = {
  "need-install": "yodo:need-install",
  "need-chrome": "yodo:need-chrome",
  "need-remote-debugging": "yodo:need-remote-debugging",
  "need-allow": "yodo:need-allow",
};

const STATUSES = Object.keys(HANDSHAKE_MARKS) as HandshakeStatus[];

export function isHandshakeStatus(status: string): status is HandshakeStatus {
  return status in HANDSHAKE_GUIDES;
}

export function handshakeStatusFromMark(text: string): HandshakeStatus | null {
  for (const status of STATUSES) {
    if (text.includes(HANDSHAKE_MARKS[status])) return status;
  }
  return null;
}

export function handshakeStatusFromError(
  error: unknown,
): HandshakeStatus | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "NeedInstallError") return "need-install";
  if (error.name === "NeedChromeError") return "need-chrome";
  if (error.name === "NeedRemoteDebuggingError") return "need-remote-debugging";
  if (error.name === "NeedAllowError") return "need-allow";
  const code = (error as { code?: string }).code;
  if (code === "chrome-not-running") return "need-chrome";
  if (code === "cdp-toggle-off" || code === "cdp-port-missing") {
    return "need-remote-debugging";
  }
  if (code === "permission-blocked") return "need-allow";
  return null;
}

export function formatHandshakeStdout(
  status: HandshakeStatus,
  guide = HANDSHAKE_GUIDES[status],
): string {
  return JSON.stringify({ status, guide }, null, 2);
}

export function formatErrorStdout(error: string): string {
  return JSON.stringify({ error });
}
