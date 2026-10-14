import * as net from "node:net";
import { timeoutReject } from "../utils/async.ts";
import { SESSION_SOCK } from "../utils/constants.ts";
import type { JsonRpcNotification, JsonRpcRequest, RpcMessage, RpcMethod } from "../protocol.ts";

export class SessionUnavailableError extends Error {
  constructor(message = "没有可用 session") { super(message); this.name = "SessionUnavailableError"; }
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) { super(message); this.name = "RpcError"; this.code = code; this.data = data; }
}

export type PageListener = { event: string; pageId: string; fn: (params: unknown) => void };

/**
 * 到 holder 的一条 socket 连接，按行分隔 JSON-RPC。
 * 一问一答用 sessionRpc（用完即关）；整个 run 期间保持连接并接收页面事件用 RpcPeer.open（sdk.ts）。
 */
export class RpcPeer {
  private buffer = "";
  private closed = false;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<PageListener>();
  private socket: net.Socket;
  /** daemon 在断开连接前说明原因的那一行（没有 id 的错误应答）。 */
  private closeReason: Error | null = null;
  /**
   * 连接意外断开，或监听函数抛错时 reject。yodo.run 把它和 task 函数赛跑，
   * 这样等事件的 task 不会一直挂着，监听函数里的错误也成为这次 run 的失败，而不是进程的未捕获异常。
   */
  readonly failure: Promise<never>;
  private reportFailure!: (error: unknown) => void;
  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.failure = new Promise<never>((_, reject) => { this.reportFailure = reject; });
    this.failure.catch(() => {}); // 没人赛跑时不算未处理的 rejection
    // 按 UTF-8 解码：一个汉字的三个字节可能被拆在两个数据块里，直接 chunk.toString() 会把它变成替换字符。
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(String(chunk)));
    socket.on("close", () => {
      const reason = this.closeReason ?? new Error("holder 连接已关闭");
      if (!this.closed) this.reportFailure(reason);
      this.rejectAll(reason);
    });
    socket.on("error", (error) => this.rejectAll(error));
  }
  static open(sock = SESSION_SOCK): Promise<RpcPeer> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: sock });
      socket.once("connect", () => resolve(new RpcPeer(socket)));
      socket.once("error", reject);
    });
  }
  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { this.close(new Error("holder 返回无效 JSON")); return; }
      if ("id" in message) {
        // 没有 id 的错误：daemon 在断开连接前说明原因（例如队列超限）
        if (message.id === "" && "error" in message) { this.closeReason = new RpcError(message.error.code, message.error.message, message.error.data); continue; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if ("error" in message) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
        else pending.resolve(message.result);
        continue;
      }
      this.dispatch(message as JsonRpcNotification);
    }
  }
  private dispatch(notification: JsonRpcNotification): void {
    const { sessionId, method, params } = notification.params;
    for (const listener of [...this.listeners]) {
      if (listener.pageId !== sessionId || listener.event !== method) continue;
      try { listener.fn(params); } catch (error) { this.reportFailure(error); }
    }
  }
  request(method: RpcMethod, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("holder 连接已关闭"));
    const id = crypto.randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }
  addListener(listener: PageListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.listeners.clear(); }
  close(error = new Error("holder 连接已关闭")): void { if (this.closed) return; this.closed = true; this.rejectAll(error); this.socket.end(); }
}

/** 一次请求：连接、发送、等回包、关闭。连不上 holder 时抛 SessionUnavailableError。 */
export async function sessionRpc(method: RpcMethod, params: Record<string, unknown> | undefined, ms: number, sock = SESSION_SOCK): Promise<unknown> {
  let peer: RpcPeer | undefined;
  try {
    return await timeoutReject((async () => {
      peer = await RpcPeer.open(sock);
      return peer.request(method, params);
    })(), ms, method);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|ECONNREFUSED|EPIPE|not a socket/i.test(msg)) throw new SessionUnavailableError();
    throw err;
  } finally {
    peer?.close();
  }
}
