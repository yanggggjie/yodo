export type SessionOp =
  | "ping"
  | "run"
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
  file?: string;
  argsText?: string;
  name?: string;
  /** run only；毫秒。CLI 已校验 15～60 秒。 */
  timeoutMs?: number;
};

export type SessionResponse = {
  id: string;
  ok: boolean;
  error?: string;
  text?: string;
  status?: StdoutStatus;
  guide?: string;
  pid?: number;
  chrome?: string;
  pages?: number;
  record?: string | null;
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
