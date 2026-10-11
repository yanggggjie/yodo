/**
 * 扩展通道：holder 作为 native messaging host，与 yodo Chrome 扩展说话。
 * 帧：4 字节小端长度前缀 + UTF-8 JSON。
 *
 * holder → 扩展：{ id, op: "cdp", tabId, method, params } | { id, op: "tab", name, args }
 * 扩展 → holder：{ id, result|error }（应答）| { type: "event" | "tab" | "hello" | "detach", ... }（推送）
 *
 * ponytail: 只支持一个扩展连接、一个 holder；无 per-session 隔离、无分片（host→扩展只发小命令）。
 */
import { CDP_COMMAND_TIMEOUT_MS } from "../utils/constants.ts";
import { NeedExtensionError } from "./connect.ts";
import type { RawCdpConnection } from "./session.ts";

export const PROTOCOL_VERSION = 1;

export type TabOps = {
  openWindow(opts: { focused: boolean }): Promise<{ windowId: number; tabId: number }>;
  openTab(opts: { windowId: number; url: string; active: boolean }): Promise<{ tabId: number }>;
  closeTab(tabId: number): Promise<void>;
  closeWindow(windowId: number): Promise<void>;
  listOwned(): Promise<{ tabs: { tabId: number; windowId: number; url: string }[] }>;
  windowOf(tabId: number): Promise<{ windowId: number; state: string }>;
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
};

type Handler = (params: unknown, sessionId?: string) => void;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class ExtensionLink {
  /** 由 holder 注入：把一条消息写到 native host stdout。 */
  write: (message: Record<string, unknown>) => void = () => {};
  readonly raw: RawCdpConnection;
  readonly ops: TabOps;
  chromeVersion = "";
  private nextId = 1;
  private closed = false;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Handler>>();
  private closeHandlers = new Set<() => void>();
  private commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS;
  private rpc: { id: string; op: string } | undefined;

  constructor() {
    const self = this;
    const call = (msg: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => {
      if (this.closed) return Promise.reject(new Error("扩展通道已关闭"));
      const id = this.nextId++;
      const ms = timeoutMs ?? this.commandTimeoutMs;
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (ms > 0) {
          timer = setTimeout(() => {
            if (this.pending.delete(id)) reject(new Error(`扩展命令超时 ${ms}ms：${String(msg.method ?? msg.name)}`));
          }, ms);
          timer.unref?.();
        }
        this.pending.set(id, { resolve, reject, timer });
        this.write({ id, ...msg });
      });
    };

    this.ops = {
      openWindow: (args) => call({ op: "tab", name: "openWindow", args }) as Promise<{ windowId: number; tabId: number }>,
      openTab: (args) => call({ op: "tab", name: "openTab", args }) as Promise<{ tabId: number }>,
      closeTab: (tabId) => call({ op: "tab", name: "closeTab", args: { tabId } }).then(() => undefined),
      closeWindow: (windowId) => call({ op: "tab", name: "closeWindow", args: { windowId } }).then(() => undefined),
      listOwned: () => call({ op: "tab", name: "listOwned", args: {} }) as Promise<{ tabs: { tabId: number; windowId: number; url: string }[] }>,
      windowOf: (tabId) => call({ op: "tab", name: "windowOf", args: { tabId } }) as Promise<{ windowId: number; state: string }>,
      attach: (tabId) => call({ op: "tab", name: "attach", args: { tabId } }).then(() => undefined),
      detach: (tabId) => call({ op: "tab", name: "detach", args: { tabId } }).then(() => undefined),
    };

    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<unknown> => {
      // 页面级 CDP 只能发给某个 tab（sessionId = tabId）；browser 级命令已由 ops 取代。
      if (!sessionId) return Promise.reject(new Error(`browser 级 CDP 不可用：${method}`));
      return call({ op: "cdp", tabId: Number(sessionId), method, params }, timeoutMs);
    };

    const on = (method: string, handler: Handler): (() => void) => {
      let set = this.listeners.get(method);
      if (!set) this.listeners.set(method, (set = new Set()));
      set.add(handler);
      return () => {
        set!.delete(handler);
        if (set!.size === 0) this.listeners.delete(method);
      };
    };

    this.raw = {
      get commandTimeoutMs() { return self.commandTimeoutMs; },
      set commandTimeoutMs(v: number) { self.commandTimeoutMs = v; },
      get rpc() { return self.rpc; },
      set rpc(v: { id: string; op: string } | undefined) { self.rpc = v; },
      get chromeVersion() { return self.chromeVersion; },
      ops: this.ops,
      send,
      on,
      onClose: (handler) => {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
      },
      isClosed: () => this.closed,
      close: async () => this.close(),
    };
  }

  /** 收到扩展消息：应答匹配 pending，推送转为事件。 */
  receive(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(String((msg.error as { message?: string }).message ?? msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.type === "event") {
      this.emit(String(msg.method), msg.params, String(msg.tabId));
    } else if (msg.type === "tab") {
      // 页面外的 tab 事件：created / updated / removed / detached
      this.emit(`tab.${String(msg.kind)}`, msg, undefined);
    }
  }

  /** 扩展握手；缺版本或版本不符直接报错。 */
  hello(msg: Record<string, unknown>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`扩展协议版本 ${String(msg.protocolVersion)} 与 holder ${PROTOCOL_VERSION} 不一致`);
    }
    this.chromeVersion = String(msg.chromeVersion ?? "");
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error("扩展通道已关闭"));
    }
    for (const handler of this.closeHandlers) {
      try { handler(); } catch { /* ignore */ }
    }
  }

  private emit(method: string, params: unknown, sessionId?: string): void {
    const handlers = this.listeners.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(params, sessionId); } catch { /* 单个订阅者出错不影响其它 */ }
    }
  }
}

let active: ExtensionLink | null = null;

export function setActiveLink(link: ExtensionLink | null): void {
  active = link;
}

export function requireActiveLink(): ExtensionLink {
  if (!active || active.raw.isClosed()) throw new NeedExtensionError();
  return active;
}

export function frame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 增量解析 native messaging 帧，返回剩余未完成的 buffer。 */
export function parseFrames(buffer: Buffer, onMessage: (msg: Record<string, unknown>) => void): Buffer {
  let rest = buffer;
  while (rest.length >= 4) {
    const len = rest.readUInt32LE(0);
    if (rest.length < 4 + len) break;
    const body = rest.subarray(4, 4 + len).toString("utf8");
    rest = rest.subarray(4 + len);
    onMessage(JSON.parse(body) as Record<string, unknown>);
  }
  return rest;
}

