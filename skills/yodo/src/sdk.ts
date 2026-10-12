import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { ensureHolder } from "./cli/session.ts";
import { RpcError, RpcPeer } from "./cli/rpc.ts";
import { assertNode24 } from "./utils/node.ts";
import { sleep } from "./utils/async.ts";
import { RUN_BUSY_WAIT_MS } from "./utils/constants.ts";
import { RPC_ERRORS } from "./protocol.ts";
import { captureConsole, runFailureJson, runSuccessJson } from "./run-report.ts";

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
        if (options?.timeout != null) {
          timer = setTimeout(() => { off(); reject(new Error(`${String(event)} timeout ${options.timeout}ms`)); }, options.timeout);
        }
      });
    },
  };
}

export type PageHandle = { readonly _targetId: string; readonly cdp: CdpSession };
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

export const yodo = {
  async run(fn: TaskFn): Promise<void> {
    const scriptAbs = process.argv[1] ?? "task";
    let restore: (() => void) | undefined;
    let peer: RpcPeer | undefined;
    try {
      assertNode24();
      const blocked = await ensureHolder();
      if (blocked) { const status = (blocked.data as { status?: string } | undefined)?.status; console.log(JSON.stringify({ status, guide: blocked.message }, null, 2)); process.exitCode = 1; return; }
      peer = await RpcPeer.open();
      const begun = await beginRun(peer);
      const page: PageHandle = { _targetId: begun.pageId, cdp: cdpSession(peer, begun.pageId) };
      const logs: string[] = []; restore = captureConsole(logs);
      const result = await fn({ page });
      restore(); restore = undefined;
      console.log(runSuccessJson(result));
    } catch (error) {
      restore?.(); restore = undefined;
      const status = error instanceof RpcError ? (error.data as { status?: string } | undefined)?.status : undefined;
      if (status) { console.log(JSON.stringify({ status, guide: error instanceof Error ? error.message : String(error) }, null, 2)); process.exitCode = 1; }
      else { console.log(runFailureJson(error, scriptAbs)); process.exitCode = 1; }
    } finally {
      restore?.();
      if (peer) { await peer.request("run.end").catch(() => {}); peer.close(); }
    }
  },
};
