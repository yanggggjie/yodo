import * as net from "node:net";
import { timeoutReject } from "../utils/async.js";
import { SESSION_SOCK } from "../utils/constants.js";
import type { SessionRequest, SessionResponse } from "../protocol.js";

export class SessionUnavailableError extends Error {
  constructor(message = "没有可用 session") {
    super(message);
    this.name = "SessionUnavailableError";
  }
}

export async function sessionRpc(
  req: Omit<SessionRequest, "id">,
  ms: number,
  sock = SESSION_SOCK,
): Promise<SessionResponse> {
  const id = crypto.randomUUID();
  const payload = { id, ...req };
  try {
    return await timeoutReject(once(sock, payload), ms, req.op);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|ECONNREFUSED|EPIPE|not a socket/i.test(msg)) {
      throw new SessionUnavailableError();
    }
    throw err;
  }
}

function once(sock: string, req: SessionRequest): Promise<SessionResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: sock });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as SessionResponse);
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(req)}\n`);
  });
}
