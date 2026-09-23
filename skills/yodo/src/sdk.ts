import * as net from "node:net";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { SESSION_SOCK } from "./utils/constants.ts";
import type { CdpScope, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, RpcMessage, RpcMethod } from "./protocol.ts";
import { ensureHolder } from "./cli/spawn.ts";
import { captureConsole, runFailureJson, runSuccessJson } from "./run-report.ts";

type Listener<E extends keyof ProtocolMapping.Events> = (...params: ProtocolMapping.Events[E]) => void;
type Subscription = { listener: (...params: never[]) => void; scope: CdpScope; event: string };

class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) { super(message); this.name = "RpcError"; this.code = code; this.data = data; }
}

class RpcPeer {
  private buffer = "";
  private closed = false;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private subscriptions = new Map<string, Subscription>();
  private socket: net.Socket;
  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.rejectAll(new Error("holder 连接已关闭")));
    socket.on("error", (error) => this.rejectAll(error));
  }
  static open(): Promise<RpcPeer> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: SESSION_SOCK });
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
      const notification = message as JsonRpcNotification;
      const sub = this.subscriptions.get(notification.params.subscriptionId);
      if (!sub) continue;
      try { sub.listener(notification.params.value as never); } catch (error) { queueMicrotask(() => { throw error; }); }
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
  addSubscription(id: string, subscription: Subscription): void { this.subscriptions.set(id, subscription); }
  deleteSubscription(id: string): void { this.subscriptions.delete(id); }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.subscriptions.clear(); }
  close(error = new Error("holder 连接已关闭")): void { if (this.closed) return; this.closed = true; this.rejectAll(error); this.socket.end(); }
}

export interface CdpSession {
  send<M extends keyof ProtocolMapping.Commands>(method: M, ...params: ProtocolMapping.Commands[M]["paramsType"]): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  on<E extends keyof ProtocolMapping.Events>(event: E, listener: Listener<E>): Promise<() => Promise<void>>;
  once<E extends keyof ProtocolMapping.Events>(event: E, options?: { timeout?: number }): Promise<ProtocolMapping.Events[E][0]>;
}

function cdpSession(peer: RpcPeer, scope: CdpScope): CdpSession {
  return {
    async send(method, ...params) { return await peer.request("cdp.send", { scope, method, params: params[0] ?? {} }) as never; },
    async on(event, listener) {
      const subscriptionId = crypto.randomUUID();
      peer.addSubscription(subscriptionId, { scope, event, listener: listener as (...params: never[]) => void });
      try { await peer.request("cdp.subscribe", { subscriptionId, scope, event }); }
      catch (error) { peer.deleteSubscription(subscriptionId); throw error; }
      let active = true;
      return async () => { if (!active) return; active = false; peer.deleteSubscription(subscriptionId); await peer.request("cdp.unsubscribe", { subscriptionId }); };
    },
    async once(event, options) {
      return await new Promise(async (resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const subscriptionId = crypto.randomUUID();
        let settled = false;
        const unsubscribe = async (): Promise<void> => { peer.deleteSubscription(subscriptionId); await peer.request("cdp.unsubscribe", { subscriptionId }); };
        peer.addSubscription(subscriptionId, { scope, event, listener: ((value: ProtocolMapping.Events[typeof event][0]) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); void unsubscribe().then(() => resolve(value), reject); }) as (...params: never[]) => void });
        try { await peer.request("cdp.subscribe", { subscriptionId, scope, event }); }
        catch (error) { peer.deleteSubscription(subscriptionId); reject(error); return; }
        if (options?.timeout != null) timer = setTimeout(() => { if (settled) return; settled = true; void unsubscribe().then(() => reject(new Error(`${String(event)} timeout ${options.timeout}ms`)), reject); }, options.timeout);
      });
    },
  };
}

export type PageHandle = { readonly _targetId: string; readonly cdp: CdpSession };
export type TaskFn = (api: { page: PageHandle; _cdp: { connection: CdpSession; browser: CdpSession } }) => Promise<unknown> | unknown;

function assertNode24(): void { const major = Number(process.versions.node.split(".")[0]); if (!Number.isFinite(major) || major < 24) throw new Error(`yodo 需要 Node >=24，当前 ${process.version}`); }

export const yodo = {
  async run(fn: TaskFn): Promise<void> {
    const scriptAbs = process.argv[1] ?? "task";
    let restore: (() => void) | undefined;
    let peer: RpcPeer | undefined;
    try {
      assertNode24();
      const blocked = await ensureHolder();
      if (blocked) { const status = (blocked.data as { status?: string } | undefined)?.status; console.log(JSON.stringify({ status, guide: blocked.message }, null, 2)); return; }
      peer = await RpcPeer.open();
      const begun = await peer.request("run.begin") as { pageId: string };
      const page: PageHandle = { _targetId: begun.pageId, cdp: cdpSession(peer, { type: "page", pageId: begun.pageId }) };
      const logs: string[] = []; restore = captureConsole(logs);
      const result = await fn({ page, _cdp: { connection: cdpSession(peer, { type: "connection" }), browser: cdpSession(peer, { type: "browser" }) } });
      restore(); restore = undefined;
      console.log(runSuccessJson(scriptAbs, result));
    } catch (error) {
      restore?.(); restore = undefined;
      const status = error instanceof RpcError ? (error.data as { status?: string } | undefined)?.status : undefined;
      if (status) console.log(JSON.stringify({ status, guide: error instanceof Error ? error.message : String(error) }, null, 2));
      else { console.log(runFailureJson(error, scriptAbs)); process.exitCode = 1; }
    } finally {
      restore?.();
      if (peer) { await peer.request("run.end").catch(() => {}); peer.close(); }
    }
  },
};
