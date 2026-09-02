/**
 * Detached session holder：进程内只持有 CDP 连接一次，听 unix socket。
 * 先 listen，再连 Chrome。logger 写 session/log.jsonl；stdio 丢弃。
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
} from "./browser/index.js";
import { finishRecord, liveRecordName, startRecord } from "./record/index.js";
import { runTask } from "./exec/index.js";
import { sweepDeadActive } from "./store/repository.js";
import { ensureHomeLayout } from "./store/layout.js";
import {
  HANDSHAKE_GUIDES,
  HANDSHAKE_MARKS,
  handshakeStatusFromError,
  type SessionRequest,
  type SessionResponse,
} from "./protocol.js";
import {
  CDP_COMMAND_TIMEOUT_MS,
  CDP_SHORT_TIMEOUT_MS,
  SESSION_DIR,
  SESSION_LOG,
  SESSION_PID_FILE,
  SESSION_SOCK,
} from "./utils/constants.js";
import { createLogger, setLogFile } from "./utils/logger.js";

const logger = createLogger("holder");

let browser: CdpBrowser | undefined;
let context: CdpContext | undefined;
let chromeVersion = "";
let chromeReady: Promise<void> | null = null;
let runBusy = false;
let recordBusy = false;
let shuttingDown = false;
let server: net.Server | undefined;

function pagesOf(ctx: CdpContext): number {
  let n = 0;
  for (const p of ctx.pages()) {
    if (!p.isClosed()) n++;
  }
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

async function handleOp(req: SessionRequest): Promise<SessionResponse> {
  const id = req.id;

  if (req.op === "ping") {
    if (chromeReady) await chromeReady;
    return { id, ok: true, ...pingBody() };
  }

  const blocked = await ensureChrome(req);
  if (blocked) return blocked;
  browser!.raw.rpc = { id, op: req.op };

  try {
    if (req.op === "run") {
      if (runBusy || recordBusy) {
        return {
          id,
          ok: false,
          error: runBusy ? "run 进行中" : "record 操作进行中",
        };
      }
      const rec = liveRecordName();
      if (rec) {
        return {
          id,
          ok: false,
          error: `record ${rec} 仍在进行；请先 record stop 或 abort，再 run`,
        };
      }
      if (!req.file) return { id, ok: false, error: "run 需要 file" };
      runBusy = true;
      try {
        logger.info(`run ${req.file}`, { op: "run", id });
        await setIgnoreCertificateErrors(browser!.raw, true);
        const text = await runTask(
          browser!,
          context!,
          req.file,
          req.argsText,
          req.timeoutMs ?? CDP_COMMAND_TIMEOUT_MS,
        );
        return { id, ok: true, text };
      } finally {
        runBusy = false;
        await settleIdle();
      }
    }

    if (req.op === "record.start") {
      if (runBusy) return { id, ok: false, error: "run 进行中；请等结束再 record start" };
      if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
      recordBusy = true;
      try {
        logger.info(`record start name=${req.name ?? "auto"}`, { op: req.op, id });
        await setIgnoreCertificateErrors(browser!.raw, true);
        const text = await startRecord(browser!, context!, {
          name: req.name,
        });
        return { id, ok: true, text };
      } catch (error) {
        await finishRecord("abort").catch(warnCatch("record start abort"));
        throw error;
      } finally {
        recordBusy = false;
        if (!liveRecordName()) await settleIdle();
      }
    }
    if (req.op === "record.stop") {
      if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
      recordBusy = true;
      try {
        logger.info("record stop", { op: req.op, id });
        const text = await finishRecord("stop");
        return { id, ok: true, text };
      } finally {
        recordBusy = false;
        await settleIdle();
      }
    }
    if (req.op === "record.abort") {
      if (recordBusy) return { id, ok: false, error: "record 操作进行中" };
      recordBusy = true;
      try {
        logger.info("record abort", { op: req.op, id });
        const text = await finishRecord("abort");
        return { id, ok: true, text };
      } finally {
        recordBusy = false;
        await settleIdle();
      }
    }
    return { id, ok: false, error: `未知 op：${req.op}` };
  } finally {
    if (browser) browser.raw.rpc = undefined;
  }
}

async function handle(req: SessionRequest): Promise<SessionResponse> {
  const t0 = Date.now();
  logger.info("op start", { op: req.op, id: req.id });
  try {
    const res = await handleOp(req);
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
  fs.rmSync(SESSION_SOCK, { force: true });
  fs.rmSync(SESSION_PID_FILE, { force: true });
  if (browser) await disconnectChrome(browser).catch(warnCatch("disconnectChrome"));
  process.exit(code);
}

export async function runHolder(): Promise<void> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  setLogFile(SESSION_LOG);
  fs.writeFileSync(SESSION_PID_FILE, `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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

  fs.rmSync(SESSION_SOCK, { force: true });
  server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req: SessionRequest;
      try {
        req = JSON.parse(line) as SessionRequest;
      } catch {
        socket.end(`${JSON.stringify({ id: "", ok: false, error: "bad json" })}\n`);
        return;
      }
      void handle(req)
        .then((res) => {
          socket.end(`${JSON.stringify(res)}\n`);
        })
        .catch((err) => {
          const status = handshakeStatusFromError(err);
          if (status) {
            socket.end(
              `${JSON.stringify({
                id: req.id,
                ok: false,
                status,
                guide: HANDSHAKE_GUIDES[status],
              })}\n`,
            );
            return;
          }
          const error = err instanceof Error ? err.message : String(err);
          socket.end(`${JSON.stringify({ id: req.id, ok: false, error })}\n`);
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.listen(SESSION_SOCK, () => resolve());
    server!.on("error", reject);
  });
  fs.chmodSync(SESSION_SOCK, 0o600);
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
    /* CDP + socket */
  });
}

runHolder().catch((err) => {
  const status = handshakeStatusFromError(err);
  if (status) logger.warn(HANDSHAKE_MARKS[status]);
  else logger.error("holder start failed", err);
  void shutdown(1);
});
