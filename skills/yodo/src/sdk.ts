import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { ensureHolder } from "./cli/session.ts";
import { RpcError, RpcPeer } from "./cli/rpc.ts";
import { assertNode24 } from "./utils/node.ts";
import { sleep } from "./utils/async.ts";
import { CDP_COMMAND_TIMEOUT_MS, RUN_BUSY_WAIT_MS } from "./utils/constants.ts";
import { RPC_ERRORS, formatHandshakeStdout, isHandshakeStatus } from "./protocol.ts";
import { consoleToStderr, runFailureJson, runSuccessJson } from "./run-report.ts";

type Listener<E extends keyof ProtocolMapping.Events> = (...params: ProtocolMapping.Events[E]) => void;

export interface CdpSession {
  send<M extends keyof ProtocolMapping.Commands>(method: M, ...params: ProtocolMapping.Commands[M]["paramsType"]): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  on<E extends keyof ProtocolMapping.Events>(event: E, listener: Listener<E>): () => void;
  once<E extends keyof ProtocolMapping.Events>(event: E, options?: { timeout?: number }): Promise<ProtocolMapping.Events[E][0]>;
}

function cdpSession(peer: RpcPeer, pageId: string): CdpSession {
  return {
    async send(method, ...params) {
      return await peer.request("cdp.send", { pageId, method, params: params[0] ?? {} }) as never;
    },
    on(event, listener) {
      return peer.addListener({ event: String(event), pageId, fn: (params) => (listener as (...args: unknown[]) => void)(params) });
    },
    once(event, options) {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const off = peer.addListener({
          event: String(event),
          pageId,
          fn: (params) => { off(); if (timer) clearTimeout(timer); resolve(params as never); },
        });
        // 没有指定就用单条命令的上限，事件不来也不会一直挂着
        const ms = options?.timeout ?? CDP_COMMAND_TIMEOUT_MS;
        timer = setTimeout(() => { off(); reject(new Error(`${String(event)} timeout ${ms}ms`)); }, ms);
      });
    },
  };
}

/** 一个页面（标签页）。newPage() 在 run 窗口里另开一个空白页面并返回它的句柄，run 结束时自动关闭。 */
export type PageHandle = { readonly cdp: CdpSession; newPage(): Promise<PageHandle> };
function pageHandle(peer: RpcPeer, pageId: string): PageHandle {
  return {
    cdp: cdpSession(peer, pageId),
    async newPage() {
      const opened = await peer.request("run.openPage") as { pageId: string };
      return pageHandle(peer, opened.pageId);
    },
  };
}

export type TaskFn = (api: { page: PageHandle }) => Promise<unknown> | unknown;


/**
 * 开始一次 run。另一个 task 正在运行（或录制操作进行中）时每 500ms 重试，最多等 waitMs；
 * 录制进行中不会很快结束，直接报错，由调用方先 record stop。
 */
export async function beginRun(peer: RpcPeer, waitMs = RUN_BUSY_WAIT_MS): Promise<{ pageId: string }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await peer.request("run.begin") as { pageId: string };
    } catch (error) {
      const reason = error instanceof RpcError && error.code === RPC_ERRORS.RUN_BUSY ? (error.data as { reason?: string } | undefined)?.reason : undefined;
      const waitable = reason === "run" || reason === "record-op";
      if (!waitable || Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

/** 命令行 `--名字 值` 传进来的参数，由 `yodo run` 通过环境变量交给 task；没传的参数不存在。 */
function readParams(): Record<string, string> {
  try { return JSON.parse(process.env.YODO_PARAMS ?? "{}") as Record<string, string>; } catch { return {}; }
}

export const yodo = {
  params: readParams(),
  async run(fn: TaskFn): Promise<void> {
    const scriptAbs = process.argv[1] ?? "task";
    let restore: (() => void) | undefined;
    let peer: RpcPeer | undefined;
    try {
      assertNode24();
      const blocked = await ensureHolder();
      if (blocked) { const status = (blocked.data as { status?: string } | undefined)?.status; console.log(status && isHandshakeStatus(status) ? formatHandshakeStdout(status) : runFailureJson(new Error(blocked.message), scriptAbs)); process.exitCode = 1; return; }
      peer = await RpcPeer.open();
      const begun = await beginRun(peer);
      const page = pageHandle(peer, begun.pageId);
      restore = consoleToStderr();
      // 监听函数抛错、连接意外断开，都会让 peer.failure 先 reject，成为这次 run 的失败
      const result = await Promise.race([fn({ page }), peer.failure]);
      restore(); restore = undefined;
      console.log(runSuccessJson(result));
    } catch (error) {
      restore?.(); restore = undefined;
      const status = error instanceof RpcError ? (error.data as { status?: string } | undefined)?.status : undefined;
      if (status && isHandshakeStatus(status)) { console.log(formatHandshakeStdout(status)); process.exitCode = 1; }
      else { console.log(runFailureJson(error, scriptAbs)); process.exitCode = 1; }
    } finally {
      restore?.();
      if (peer) { await peer.request("run.end").catch(() => {}); peer.close(); }
    }
  },
};
