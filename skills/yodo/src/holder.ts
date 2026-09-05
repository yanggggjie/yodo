/**
 * Detached session holder：进程内只持有 CDP 连接一次，听 unix socket / named pipe。
 * 先 listen，再连 Chrome（连接一直保持 = 续着 Chrome 远程调试授权）。
 * 对外暴露「高层 op」：run.begin/end、page.*、context.new-page、record.*、ping。
 * task 在 client 进程里跑；holder 只在自己那条连接上执行 CDP 并回传结果。
 */
import * as fs from "node:fs";
import * as net from "node:net";
import {
  connectChrome,
  disconnectChrome,
  setDiscoverTargets,
  setIgnoreCertificateErrors,
  setPageAutoAttach,
  type CdpBrowser,
  type CdpContext,
  type CdpPage,
} from "./browser/index.ts";
import { finishRecord, liveRecordName, startRecord } from "./record/index.ts";
import { sweepDeadActive } from "./store/repository.ts";
import { ensureHomeLayout } from "./store/layout.ts";
import {
  HANDSHAKE_GUIDES,
  HANDSHAKE_MARKS,
  handshakeStatusFromError,
  type SessionRequest,
  type SessionResponse,
} from "./protocol.ts";
import {
  CDP_COMMAND_TIMEOUT_MS,
  CDP_SHORT_TIMEOUT_MS,
  SESSION_DIR,
  SESSION_LOG,
  SESSION_PID_FILE,
  SESSION_SOCK,
  SESSION_SOCK_IS_FILE,
} from "./utils/constants.ts";
import { createLogger, setLogFile } from "./utils/logger.ts";

const logger = createLogger("holder");

let browser: CdpBrowser | undefined;
let context: CdpContext | undefined;
let chromeVersion = "";
let chromeReady: Promise<void> | null = null;
let recordBusy = false;
let shuttingDown = false;
let server: net.Server | undefined;

/** 每条连接的状态；run 绑在发起它的那条连接上。 */
type ConnState = { runActive: boolean };
/** 当前持有 run 的连接（同时只允许一个 run）。 */
let activeRunConn: ConnState | null = null;

function pagesOf(ctx: CdpContext): number {
  let n = 0;
  for (const p of ctx.pages()) if (!p.isClosed()) n++;
  return n;
}

function pingBody(): Pick<SessionResponse, "pid" | "chrome" | "pages" | "record"> {
  return {
    pid: process.pid,
    chrome: chromeVersion || "",
    pages: context ? pagesOf(context) : 0,
    record: liveRecordName(),
  };
}

function warnCatch(label: string): (err: unknown) => void {
  return (err) => {
    logger.warn(label, { err: err instanceof Error ? err.message : String(err) });
  };
}

async function tryConnectChrome(): Promise<void> {
  const connected = await connectChrome();
  browser = connected.browser;
  context = connected.context;
  chromeVersion = await browser.version().catch(() => "Google Chrome (CDP)");
  logger.info(`Chrome connected: version=${chromeVersion}`);
  browser.on("disconnected", () => void shutdown(1));
}

async function ensureChrome(req: SessionRequest): Promise<SessionResponse | null> {
  if (!chromeReady) chromeReady = tryConnectChrome();
  await chromeReady;
  if (!browser || !context) {
    return { id: req.id, ok: false, error: "holder 尚未连上 Chrome" };
  }
  return null;
}

async function settleIdle(): Promise<void> {
  if (!browser || !context) return;
  if (liveRecordName()) return;
  const prev = browser.raw.commandTimeoutMs;
  browser.raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
  try {
    await context.detachAllPages().catch(warnCatch("detachAllPages"));
    await setPageAutoAttach(browser.raw, false);
    await setDiscoverTargets(browser.raw, false);
    await setIgnoreCertificateErrors(browser.raw, false);
  } finally {
    browser.raw.commandTimeoutMs = prev;
  }
}

/** 结束当前 run：detach、恢复 idle。socket 断开中途崩溃也走这里。 */
async function runEnd(): Promise<void> {
  if (!activeRunConn) return;
  const conn = activeRunConn;
  activeRunConn = null;
  conn.runActive = false;
  if (browser) browser.raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
  await settleIdle().catch(warnCatch("run end settle"));
}

function pageById(id: string | undefined): CdpPage {
  if (!id) throw new Error("缺少 pageId");
  const p = context?.getPage(id);
  if (!p) throw new Error(`page 不存在或已关闭：${id}`);
  return p;
}

async function handleOp(req: SessionRequest, conn: ConnState): Promise<SessionResponse> {
  const id = req.id;

  if (req.op === "ping") {
    if (chromeReady) await chromeReady;
    return { id, ok: true, ...pingBody() };
  }

  const blocked = await ensureChrome(req);
  if (blocked) return blocked;
  browser!.raw.rpc = { id, op: req.op };

  try {
    switch (req.op) {
      case "run.begin": {
        if (activeRunConn) return { id, ok: false, error: "run 进行中" };
        const rec = liveRecordName();
        if (rec) {
          return { id, ok: false, error: `record ${rec} 仍在进行；请先 record stop/abort` };
        }
        if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
        activeRunConn = conn;
        conn.runActive = true;
        browser!.raw.commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS;
        await setIgnoreCertificateErrors(browser!.raw, true);
        return { id, ok: true };
      }
      case "run.end": {
        await runEnd();
        return { id, ok: true };
      }
      case "page.for-origin": {
        if (!req.origin) return { id, ok: false, error: "page.for-origin 需要 origin" };
        const p = await context!.pageForOrigin(req.origin);
        return { id, ok: true, pageId: p.targetId, url: p.url() };
      }
      case "context.new-page": {
        const p = await context!.newPage();
        return { id, ok: true, pageId: p.targetId, url: p.url() };
      }
      case "page.goto": {
        await pageById(req.pageId).goto(
          req.url ?? "",
          req.timeoutMs ? { timeout: req.timeoutMs } : undefined,
        );
        return { id, ok: true };
      }
      case "page.evaluate": {
        const value = await pageById(req.pageId).evaluate(req.expr ?? "undefined");
        return { id, ok: true, value };
      }
      case "page.url":
        return { id, ok: true, url: pageById(req.pageId).url() };
      case "page.title":
        return { id, ok: true, title: await pageById(req.pageId).title() };
      case "page.close":
        await pageById(req.pageId).close();
        return { id, ok: true };
      case "page.bring-to-front":
        await pageById(req.pageId).bringToFront();
        return { id, ok: true };

      case "record.start": {
        if (activeRunConn) return { id, ok: false, error: "run 进行中；请等结束再 record start" };
        if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
        recordBusy = true;
        try {
          await setIgnoreCertificateErrors(browser!.raw, true);
          const text = await startRecord(browser!, context!, { name: req.name });
          return { id, ok: true, text };
        } catch (error) {
          await finishRecord("abort").catch(warnCatch("record start abort"));
          throw error;
        } finally {
          recordBusy = false;
          if (!liveRecordName()) await settleIdle();
        }
      }
      case "record.stop": {
        if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
        recordBusy = true;
        try {
          const text = await finishRecord("stop");
          return { id, ok: true, text };
        } finally {
          recordBusy = false;
          await settleIdle();
        }
      }
      case "record.abort": {
        if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
        recordBusy = true;
        try {
          const text = await finishRecord("abort");
          return { id, ok: true, text };
        } finally {
          recordBusy = false;
          await settleIdle();
        }
      }
      default:
        return { id, ok: false, error: `未知 op：${(req as SessionRequest).op}` };
    }
  } finally {
    if (browser) browser.raw.rpc = undefined;
  }
}

async function handle(req: SessionRequest, conn: ConnState): Promise<SessionResponse> {
  const t0 = Date.now();
  try {
    const res = await handleOp(req, conn);
    logger.info(res.ok ? "op ok" : "op error", {
      op: req.op,
      id: req.id,
      ms: Date.now() - t0,
      err: res.error ?? res.status,
    });
    return res;
  } catch (err) {
    logger.warn("op throw", {
      op: req.op,
      id: req.id,
      ms: Date.now() - t0,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`exit ${code}`);
  if (liveRecordName()) {
    await finishRecord("disconnect").catch(warnCatch("disconnect flush"));
  }
  await settleIdle().catch(warnCatch("settleIdle"));
  server?.close();
  if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true });
  fs.rmSync(SESSION_PID_FILE, { force: true });
  if (browser) await disconnectChrome(browser).catch(warnCatch("disconnectChrome"));
  process.exit(code);
}

function onConnection(socket: net.Socket): void {
  const conn: ConnState = { runActive: false };
  let buf = "";
  let chain: Promise<void> = Promise.resolve();
  const write = (res: SessionResponse): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
  };
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req: SessionRequest;
      try {
        req = JSON.parse(line) as SessionRequest;
      } catch {
        write({ id: "", ok: false, error: "bad json" });
        continue;
      }
      // 每条连接内串行执行，避免并发改 context
      chain = chain.then(() =>
        handle(req, conn)
          .then(write)
          .catch((err) => {
            const status = handshakeStatusFromError(err);
            if (status) {
              write({ id: req.id, ok: false, status, guide: HANDSHAKE_GUIDES[status] });
            } else {
              write({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          }),
      );
    }
  });
  socket.on("close", () => {
    if (conn.runActive) void runEnd().catch(warnCatch("run cleanup on close"));
  });
  socket.on("error", () => {
    /* client 断开，close 会兜底清理 */
  });
}

export async function runHolder(): Promise<void> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  setLogFile(SESSION_LOG);
  fs.writeFileSync(SESSION_PID_FILE, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  ensureHomeLayout();
  await sweepDeadActive().catch(warnCatch("sweepDeadActive"));

  logger.info(`starting pid=${process.pid}`);

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", err);
    void shutdown(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error("unhandledRejection", err);
    void shutdown(1);
  });

  if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true });
  server = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server!.listen(SESSION_SOCK, () => resolve());
    server!.on("error", reject);
  });
  if (SESSION_SOCK_IS_FILE) fs.chmodSync(SESSION_SOCK, 0o600);
  logger.info(`listen ${SESSION_SOCK}`);

  chromeReady = tryConnectChrome();
  try {
    await chromeReady;
  } catch (err) {
    const status = handshakeStatusFromError(err);
    if (status) logger.warn(HANDSHAKE_MARKS[status]);
    else logger.error("connect failed", err);
    await shutdown(1);
    return;
  }

  await new Promise(() => {
    /* keep alive：CDP 连接 + socket */
  });
}

runHolder().catch((err) => {
  const status = handshakeStatusFromError(err);
  if (status) logger.warn(HANDSHAKE_MARKS[status]);
  else logger.error("holder start failed", err);
  void shutdown(1);
});
