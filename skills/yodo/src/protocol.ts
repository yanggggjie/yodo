export type HandshakeStatus = "need-install" | "need-chrome" | "need-extension";
export type RpcMethod = "ping" | "run.begin" | "run.end" | "cdp.send" | "record.start" | "record.stop" | "record.abort" | "dev.pages" | "dev.cdp";
export type JsonRpcRequest = { jsonrpc: "2.0"; id: string; method: RpcMethod; params?: Record<string, unknown> };
/** 页面事件推送：sessionId 即 pageId（tab 的字符串形式）。 */
export type JsonRpcNotification = { jsonrpc: "2.0"; method: "cdp.event"; params: { sessionId: string; method: string; params: unknown } };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string; result: unknown } | { jsonrpc: "2.0"; id: string; error: JsonRpcError };
export type RpcMessage = JsonRpcResponse | JsonRpcNotification;

export const RPC_ERRORS = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, PAGE_NOT_FOUND: -32001, RUN_BUSY: -32002, HANDSHAKE: -32010 } as const;

export const HANDSHAKE_GUIDES: Record<HandshakeStatus, string> = {
  "need-install": "yodo 的 Chrome 扩展或 native messaging 注册还没装好。请告诉我，我会运行安装命令；装好后在 chrome://extensions 里加载 yodo 扩展，完成后告诉我「好了」。",
  "need-chrome": "没检测到正在运行的 Google Chrome。请启动 Chrome；好了告诉我。",
  "need-extension": "yodo 的 Chrome 扩展没有连上。请按顺序做：\n1. 在 Chrome 地址栏打开 chrome://extensions，确认 yodo 是开启状态。如果找不到 yodo，告诉我，我会先运行安装命令。\n2. 在 yodo 卡片上点「service worker」，或点一下浏览器工具栏里的 yodo 图标。\n3. 做完后告诉我「好了」，我会重新运行刚才的命令。\n如果还是失败，告诉我，我会运行 yodo doctor 查看具体原因。",
};

export function isHandshakeStatus(status: string): status is HandshakeStatus {
  return status in HANDSHAKE_GUIDES;
}
export function handshakeStatusFromError(error: unknown): HandshakeStatus | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "NeedInstallError") return "need-install";
  if (error.name === "NeedChromeError") return "need-chrome";
  if (error.name === "NeedExtensionError") return "need-extension";
  return null;
}
export function formatHandshakeStdout(status: HandshakeStatus): string {
  return JSON.stringify({ status, guide: HANDSHAKE_GUIDES[status] }, null, 2);
}
/** 所有命令的失败输出：总是带 status，握手类失败另用 formatHandshakeStdout。 */
export function formatErrorStdout(error: string): string {
  return JSON.stringify({ status: "failure", error }, null, 2);
}
