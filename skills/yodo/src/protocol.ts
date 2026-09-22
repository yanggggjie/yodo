export type HandshakeStatus = "need-install" | "need-chrome" | "need-cdp-port" | "need-allow";
export type StdoutStatus = HandshakeStatus | "recording" | "stopped" | "aborted" | "idle" | "success" | "failure";
export type CdpScope = { type: "connection" } | { type: "browser" } | { type: "page"; pageId: string };
export type RpcMethod = "ping" | "run.begin" | "run.end" | "cdp.send" | "cdp.subscribe" | "cdp.unsubscribe" | "record.start" | "record.stop" | "record.abort";
export type JsonRpcRequest = { jsonrpc: "2.0"; id: string; method: RpcMethod; params?: Record<string, unknown> };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: "cdp.event"; params: { subscriptionId: string; event: string; value: unknown } };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string; result: unknown } | { jsonrpc: "2.0"; id: string; error: JsonRpcError };
export type RpcMessage = JsonRpcResponse | JsonRpcNotification;

export const RPC_ERRORS = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, PAGE_NOT_FOUND: -32001, RUN_BUSY: -32002, FORBIDDEN_CDP: -32003, QUEUE_OVERFLOW: -32004, HANDSHAKE: -32010 } as const;

export const HANDSHAKE_GUIDES: Record<HandshakeStatus, string> = {
  "need-install": "没检测到 Google Chrome，装一下：https://www.google.com/chrome/ 。装好告诉我。",
  "need-chrome": "我已帮你启动 Chrome；没弹出来就手动打开它。好了告诉我。",
  "need-cdp-port": "我没有在当前配置的 port 找到 Chrome remote debugging endpoint。我已打开 chrome://inspect/#remote-debugging（没跳转就手动贴这地址），确认「Allow remote debugging for this browser instance」已勾选，然后把页面显示的 port 数字告诉我。",
  "need-allow": "Chrome 弹出「Allow remote debugging?」时点「Allow」。点了告诉我。",
};
export const HANDSHAKE_MARKS: Record<HandshakeStatus, string> = { "need-install": "yodo:need-install", "need-chrome": "yodo:need-chrome", "need-cdp-port": "yodo:need-cdp-port", "need-allow": "yodo:need-allow" };
const STATUSES = Object.keys(HANDSHAKE_MARKS) as HandshakeStatus[];
export function isHandshakeStatus(status: string): status is HandshakeStatus { return status in HANDSHAKE_GUIDES; }
export function handshakeStatusFromMark(text: string): HandshakeStatus | null { for (const status of STATUSES) if (text.includes(HANDSHAKE_MARKS[status])) return status; return null; }
export function handshakeStatusFromError(error: unknown): HandshakeStatus | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "NeedInstallError") return "need-install";
  if (error.name === "NeedChromeError") return "need-chrome";
  if (error.name === "NeedCdpPortError") return "need-cdp-port";
  if (error.name === "NeedAllowError") return "need-allow";
  const code = (error as { code?: string }).code;
  if (code === "permission-blocked") return "need-allow";
  return null;
}
export function formatHandshakeStdout(status: HandshakeStatus): string { return JSON.stringify({ status, guide: HANDSHAKE_GUIDES[status] }, null, 2); }
export function formatErrorStdout(error: string): string { return JSON.stringify({ error }); }
