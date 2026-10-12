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
  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.rejectAll(new Error("holder 连接已关闭")));
    socket.on("error", (error) => this.rejectAll(error));
  }
  static open(sock = SESSION_SOCK): Promise<RpcPeer> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: sock });
      socket.once("connect", () => resolve(new RpcPeer(socket)));
      socket.once("error", reject);
    });
  }
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { this.close(new Error("holder 返回无效 JSON")); return; }
      if ("id" in message) {
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
      try { listener.fn(params); } catch (error) { queueMicrotask(() => { throw error; }); }
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
