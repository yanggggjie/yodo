/**
 * yodo SDK —— 对外唯一的面。bin/*.js 和 task 都是它的薄组合。
 * 没有 CLI / verb dispatcher。task 在 client 进程里跑，浏览器操作经 holder 代理。
 */
import * as net from "node:net";
import { SESSION_SOCK } from "./utils/constants.ts";
import type { SessionRequest, SessionResponse } from "./protocol.ts";
import { ensureHolder, ensureSessionAndRpc, stopCurrentHolder } from "./cli/spawn.ts";
import { ensureHomeLayout } from "./store/layout.ts";
import { captureConsole, runFailureJson, runSuccessJson } from "./run-report.ts";
import { handleDoctor } from "./cli/doctor.ts";
import { CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "./utils/constants.ts";

// ───────── Node 版本门 ─────────
function assertNode24(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) {
    console.error(`yodo 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`);
    process.exit(1);
  }
}

class HandshakeError extends Error {
  readonly status: string;
  readonly guide: string;
  constructor(status: string, guide: string) {
    super(guide);
    this.name = "HandshakeError";
    this.status = status;
    this.guide = guide;
  }
}

function printHandshake(status: string, guide?: string): void {
  console.log(JSON.stringify({ status, guide }, null, 2));
}

// ───────── 持久连接（一条连接跑完一个 run 的多个 op）─────────
class HolderConn {
  private socket: net.Socket;
  private buf = "";
  private pending = new Map<string, { resolve: (r: SessionResponse) => void; reject: (e: Error) => void }>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.rejectAll(new Error("holder 连接已关闭")));
    socket.on("error", (e) => this.rejectAll(e));
  }

  static open(): Promise<HolderConn> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: SESSION_SOCK });
      socket.once("connect", () => resolve(new HolderConn(socket)));
      socket.once("error", reject);
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let res: SessionResponse;
      try {
        res = JSON.parse(line) as SessionResponse;
      } catch {
        continue;
      }
      const p = this.pending.get(res.id);
      if (p) {
        this.pending.delete(res.id);
        p.resolve(res);
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  send(op: SessionRequest["op"], params: Omit<SessionRequest, "id" | "op"> = {}): Promise<SessionResponse> {
    const id = crypto.randomUUID();
    return new Promise<SessionResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, op, ...params })}\n`);
    }).then((res) => {
      if (res.ok) return res;
      if (res.status) throw new HandshakeError(res.status, res.guide ?? "");
      throw new Error(res.error ?? `${op} 失败`);
    });
  }

  close(): void {
    this.socket.end();
  }
}

// ───────── client 侧代理对象 ─────────
type EvaluateArg = string | ((...args: any[]) => unknown);

function buildExpr(fnOrStr: EvaluateArg, args: unknown[]): string {
  if (typeof fnOrStr === "function") {
    const serialized = args.map((a) => JSON.stringify(a)).join(", ");
    return `(async () => (${fnOrStr.toString()})(${serialized}))()`;
  }
  return fnOrStr;
}

export class ProxyPage {
  private conn: HolderConn;
  readonly targetId: string;
  private currentUrl: string;
  constructor(conn: HolderConn, targetId: string, currentUrl: string) {
    this.conn = conn;
    this.targetId = targetId;
    this.currentUrl = currentUrl;
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string, options?: { timeout?: number }): Promise<void> {
    await this.conn.send("page.goto", { pageId: this.targetId, url, timeoutMs: options?.timeout });
    this.currentUrl = url;
  }

  async evaluate<T = unknown>(fnOrStr: EvaluateArg, ...args: unknown[]): Promise<T> {
    const res = await this.conn.send("page.evaluate", {
      pageId: this.targetId,
      expr: buildExpr(fnOrStr, args),
    });
    return res.value as T;
  }

  async title(): Promise<string> {
    return (await this.conn.send("page.title", { pageId: this.targetId })).title ?? "";
  }

  async close(): Promise<void> {
    await this.conn.send("page.close", { pageId: this.targetId });
  }

  async bringToFront(): Promise<void> {
    await this.conn.send("page.bring-to-front", { pageId: this.targetId });
  }
}

export class ProxyContext {
  private conn: HolderConn;
  constructor(conn: HolderConn) {
    this.conn = conn;
  }

  async pageForOrigin(origin: string): Promise<ProxyPage> {
    const r = await this.conn.send("page.for-origin", { origin });
    return new ProxyPage(this.conn, r.pageId!, r.url ?? origin);
  }

  async newPage(): Promise<ProxyPage> {
    const r = await this.conn.send("context.new-page", {});
    return new ProxyPage(this.conn, r.pageId!, r.url ?? "about:blank");
  }
}

export type TaskFn = (api: { browserContext: ProxyContext; args?: unknown }) => Promise<unknown> | unknown;

// ───────── 公开 SDK ─────────
async function ensureOrHandshake(): Promise<boolean> {
  const blocked = await ensureHolder();
  if (blocked?.status) {
    printHandshake(blocked.status, blocked.guide);
    return false;
  }
  return true;
}

export const yodo = {
  /** 确保 holder 起来并连上 Chrome（点一次授权后保持）。 */
  async start(): Promise<void> {
    assertNode24();
    if (await ensureOrHandshake()) console.log(JSON.stringify({ status: "ok" }));
  },

  /** 停 holder（连接断 → 授权失效）。 */
  async stop(): Promise<void> {
    assertNode24();
    await stopCurrentHolder();
    console.log(JSON.stringify({ status: "ok" }));
  },

  /** 建 ~/.yodo 数据目录。 */
  async init(): Promise<void> {
    assertNode24();
    ensureHomeLayout();
    console.log("yodo init ok");
  },

  /** 排障。 */
  async doctor(): Promise<void> {
    assertNode24();
    handleDoctor();
  },

  /** 跑一个任务闭包：task 在本进程执行，浏览器操作经 holder。结果直出 stdout。 */
  async run(fn: TaskFn, opts: { args?: unknown } = {}): Promise<void> {
    assertNode24();
    const scriptAbs = process.argv[1] ?? "task";
    if (!(await ensureOrHandshake())) return;

    const conn = await HolderConn.open();
    const logs: string[] = [];
    const restore = captureConsole(logs);
    try {
      await conn.send("run.begin");
      const browserContext = new ProxyContext(conn);
      const result = await fn({ browserContext, args: opts.args });
      restore();
      console.log(runSuccessJson(scriptAbs, result));
    } catch (err) {
      restore();
      if (err instanceof HandshakeError) {
        printHandshake(err.status, err.guide);
      } else {
        console.log(runFailureJson(err, scriptAbs));
        process.exitCode = 1;
      }
    } finally {
      await conn.send("run.end").catch(() => {});
      conn.close();
    }
  },

  record: {
    async start(name?: string): Promise<void> {
      assertNode24();
      const res = await ensureSessionAndRpc(
        { op: "record.start", ...(name ? { name } : {}) },
        15_000,
      );
      printRecordResponse(res);
    },
    async stop(): Promise<void> {
      assertNode24();
      const res = await ensureSessionAndRpc({ op: "record.stop" }, RECORD_STOP_RPC_MS + CLI_RPC_BUFFER_MS);
      printRecordResponse(res);
    },
    async abort(): Promise<void> {
      assertNode24();
      const res = await ensureSessionAndRpc({ op: "record.abort" }, 15_000);
      printRecordResponse(res);
    },
  },
};

function printRecordResponse(res: SessionResponse): void {
  if (res.ok) {
    if (res.text) console.log(res.text);
    return;
  }
  if (res.status) {
    printHandshake(res.status, res.guide);
    return;
  }
  console.log(JSON.stringify({ error: res.error ?? "record 失败" }));
  process.exitCode = 1;
}
