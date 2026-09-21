import * as net from "node:net";
import { timeoutReject } from "../utils/async.ts";
import { SESSION_SOCK } from "../utils/constants.ts";
import type { JsonRpcRequest, JsonRpcResponse, RpcMethod } from "../protocol.ts";

export class SessionUnavailableError extends Error {
  constructor(message = "没有可用 session") { super(message); this.name = "SessionUnavailableError"; }
}

export async function sessionRpc(method: RpcMethod, params: Record<string, unknown> | undefined, ms: number, sock = SESSION_SOCK): Promise<unknown> {
  const request: JsonRpcRequest = { jsonrpc: "2.0", id: crypto.randomUUID(), method, ...(params ? { params } : {}) };
  try {
    const response = await timeoutReject(once(sock, request), ms, method);
    if ("error" in response) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|ECONNREFUSED|EPIPE|not a socket/i.test(msg)) throw new SessionUnavailableError();
    throw err;
  }
}

function once(sock: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: sock });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      socket.end();
      try { resolve(JSON.parse(buf.slice(0, nl)) as JsonRpcResponse); } catch (err) { reject(err); }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}
