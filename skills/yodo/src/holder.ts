import * as fs from "node:fs";
import * as net from "node:net";
import { connectChrome, disconnectChrome, ExtensionLink, frame, parseFrames, setActiveLink, type CdpBrowser, type CdpContext, type CdpPage } from "./browser/index.ts";
import { finishRecord, liveRecordName, startRecord } from "./record/index.ts";
import { ensureHomeLayout } from "./store/layout.ts";
import { HANDSHAKE_GUIDES, RPC_ERRORS, handshakeStatusFromError, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.ts";
import { CDP_COMMAND_TIMEOUT_MS, CDP_SHORT_TIMEOUT_MS, RECORDING_DIR, SESSION_DIR, SESSION_EXT_SOCK, SESSION_LOG, SESSION_PID_FILE, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "./utils/constants.ts";
import { createLogger, setLogFile } from "./utils/logger.ts";

const logger = createLogger("holder");
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;

let browser: CdpBrowser | undefined;
let context: CdpContext | undefined;
let chromeVersion = "";
let chromeReady: Promise<void> | null = null;
/** 扩展每次 hello 之后的对账；除 ping 外的请求都要等它完成。 */
let reconciled: Promise<void> = Promise.resolve();
let recordBusy = false;
let shuttingDown = false;
let server: net.Server | null = null;
let extServer: net.Server | null = null;
let extSocket: net.Socket | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** 扩展链路对象在 daemon 生命周期内只有一个；relay 断开只 detach，不 close。 */
const link = new ExtensionLink();
setActiveLink(link);
// 页面事件按 sessionId（pageId）推给当前 run 的 client；client 自己按 method 过滤。
link.onAny((method, params, sessionId) => {
  if (!activeRunConn || !sessionId) return;
  activeRunConn.write({ jsonrpc: "2.0", method: "cdp.event", params: { sessionId, method, params } });
});
/** ponytail: 没有 relay 且没有 run/record 超过 10 分钟才退出；忙时不重试，下次 relay 断开再判断。 */
const IDLE_EXIT_MS = 10 * 60_000;

type ConnState = { runActive: boolean; write: (message: JsonRpcResponse | JsonRpcNotification, priority?: boolean) => void };
let activeRunConn: ConnState | null = null;

function pagesOf(ctx: CdpContext): number { return ctx.pages().filter((page) => !page.isClosed()).length; }
/** `extension`：扩展链路当前是否接着。holder 在 relay 断开后还会存活一段时间，ping 通不代表扩展在线。 */
function pingBody() { return { pid: process.pid, chrome: chromeVersion, extension: extSocket !== null, pages: context ? pagesOf(context) : 0, record: liveRecordName() }; }
function warnCatch(label: string): (error: unknown) => void { return (error) => logger.warn(label, { err: error instanceof Error ? error.message : String(error) }); }
async function tryConnectChrome(): Promise<void> { const connected = await connectChrome(); browser = connected.browser; context = connected.context; chromeVersion = await browser.version().catch(() => "Google Chrome (CDP)"); browser.on("disconnected", () => void shutdown(1)); }
async function ensureChrome(): Promise<void> {
  if (!browser) { chromeReady ??= tryConnectChrome().catch((error) => { chromeReady = null; throw error; }); await chromeReady; }
  if (!browser || !context) throw new Error("holder 尚未连上 Chrome");
}

async function settleIdle(): Promise<void> {
  if (!browser || !context || liveRecordName()) return;
  const previous = browser.raw.commandTimeoutMs; browser.raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
  try { await context.detachAllPages(context.runKeepIds()).catch(warnCatch("detachAllPages")); }
  finally { browser.raw.commandTimeoutMs = previous; }
}

async function runEnd(conn = activeRunConn): Promise<void> {
  if (!conn || activeRunConn !== conn) return;
  if (activeRunConn === conn) activeRunConn = null;
  conn.runActive = false;
  if (browser) browser.raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
  await context?.endRunTab().catch(warnCatch("endRunTab"));
  await settleIdle().catch(warnCatch("run end settle"));
}

function pageById(id: unknown): CdpPage { if (typeof id !== "string") throw Object.assign(new Error("缺少 pageId"), { code: RPC_ERRORS.INVALID_PARAMS }); const page = context?.getPage(id); if (!page) throw Object.assign(new Error(`page 不存在或已关闭：${id}`), { code: RPC_ERRORS.PAGE_NOT_FOUND }); return page; }
function paramsOf(req: JsonRpcRequest): Record<string, unknown> { return req.params ?? {}; }
/** 扩展里没有 browser 级会话：connection / browser scope 发出的命令没有 tab，会被 raw.send 拒绝。 */

async function dispatch(req: JsonRpcRequest, conn: ConnState): Promise<unknown> {
  if (req.method === "ping") { if (chromeReady) await chromeReady.catch(() => {}); return pingBody(); }
  await ensureChrome();
  await reconciled;
  const params = paramsOf(req);
  switch (req.method) {
    case "run.begin": {
      if (activeRunConn) throw Object.assign(new Error("已有 task 正在运行，请等它结束后重试"), { code: RPC_ERRORS.RUN_BUSY, data: { reason: "run" } });
      const record = liveRecordName(); if (record) throw Object.assign(new Error(`录制 ${record} 正在进行，请先 record stop 或 record abort`), { code: RPC_ERRORS.RUN_BUSY, data: { reason: "record" } });
      if (recordBusy) throw Object.assign(new Error("录制操作正在进行，请稍后重试"), { code: RPC_ERRORS.RUN_BUSY, data: { reason: "record-op" } });
      activeRunConn = conn; conn.runActive = true;
      try {
        browser!.raw.commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS;
        const page = await context!.newPage(); return { pageId: page.targetId };
      } catch (error) {
        await runEnd(conn);
        throw error;
      }
    }
    case "run.end": await runEnd(conn); return {};
    case "cdp.send": {
      if (!conn.runActive) throw new Error("cdp.send 只能在 run 中使用");
      const method = String(params.method ?? "");
      if (!method) throw Object.assign(new Error("缺少 CDP method"), { code: RPC_ERRORS.INVALID_PARAMS });
      const page = pageById(params.pageId);
      return await browser!.raw.send(method, (params.params as Record<string, unknown> | undefined) ?? {}, page.sessionId, typeof params.timeoutMs === "number" ? params.timeoutMs : undefined);
    }
    case "record.start": {
      if (activeRunConn) throw Object.assign(new Error("已有 task 正在运行，请等它结束后再 record start"), { code: RPC_ERRORS.RUN_BUSY, data: { reason: "run" } });
      if (recordBusy) throw Object.assign(new Error("录制操作正在进行，请稍后重试"), { code: RPC_ERRORS.RUN_BUSY, data: { reason: "record-op" } }); recordBusy = true;
      try { return await startRecord(browser!, context!, { name: typeof params.name === "string" ? params.name : undefined }); }
      catch (error) { await finishRecord("abort").catch(warnCatch("record start abort")); throw error; }
      finally { recordBusy = false; if (!liveRecordName()) await settleIdle(); }
    }
    case "record.stop": { if (recordBusy) throw new Error("record 操作进行中"); recordBusy = true; try { return await finishRecord("stop"); } finally { recordBusy = false; await settleIdle(); } }
    case "record.abort": { if (recordBusy) throw new Error("record 操作进行中"); recordBusy = true; try { return await finishRecord("abort"); } finally { recordBusy = false; await settleIdle(); } }
    default: throw Object.assign(new Error(`未知 method：${String(req.method)}`), { code: RPC_ERRORS.METHOD_NOT_FOUND });
  }
}

function responseError(id: string, error: unknown): JsonRpcResponse { const status = handshakeStatusFromError(error); if (status) return { jsonrpc: "2.0", id, error: { code: RPC_ERRORS.HANDSHAKE, message: HANDSHAKE_GUIDES[status], data: { status } } }; const value = error as { code?: number; data?: unknown }; return { jsonrpc: "2.0", id, error: { code: typeof value?.code === "number" ? value.code : RPC_ERRORS.INTERNAL, message: error instanceof Error ? error.message : String(error), ...(value?.data === undefined ? {} : { data: value.data }) } }; }

function onConnection(socket: net.Socket): void {
  let buffer = ""; let writing = false; let queuedBytes = 0; const responses: string[] = []; const notifications: string[] = [];
  const flush = (): void => { if (writing || socket.destroyed) return; const message = responses.shift() ?? notifications.shift(); if (!message) return; queuedBytes -= Buffer.byteLength(message); writing = true; socket.write(message, () => { writing = false; flush(); }); };
  const write = (message: JsonRpcResponse | JsonRpcNotification, priority = false): void => { const line = `${JSON.stringify(message)}\n`; const bytes = Buffer.byteLength(line); if (bytes > MAX_MESSAGE_BYTES || queuedBytes + bytes > MAX_QUEUE_BYTES) { void runEnd(conn).finally(() => socket.destroy()); return; } (priority ? responses : notifications).push(line); queuedBytes += bytes; flush(); };
  const conn: ConnState = { runActive: false, write };
  socket.on("data", (chunk) => {
    buffer += chunk.toString(); if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) { write({ jsonrpc: "2.0", id: "", error: { code: RPC_ERRORS.INVALID_REQUEST, message: "RPC message too large" } }, true); socket.end(); return; }
    let nl: number; while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!line.trim()) continue; let req: JsonRpcRequest; try { req = JSON.parse(line) as JsonRpcRequest; } catch { write({ jsonrpc: "2.0", id: "", error: { code: RPC_ERRORS.PARSE, message: "Parse error" } }, true); continue; }
      if (req.jsonrpc !== "2.0" || typeof req.id !== "string" || typeof req.method !== "string") { write({ jsonrpc: "2.0", id: typeof req.id === "string" ? req.id : "", error: { code: RPC_ERRORS.INVALID_REQUEST, message: "Invalid Request" } }, true); continue; }
      void dispatch(req, conn).then((result) => write({ jsonrpc: "2.0", id: req.id, result }, true), (error) => write(responseError(req.id, error), true));
    }
  });
  socket.on("close", () => { if (conn.runActive) void runEnd(conn).catch(warnCatch("run cleanup on close")); });
  socket.on("error", () => {});
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("holder exit", { code });
  if (liveRecordName()) await finishRecord("disconnect").catch(warnCatch("disconnect flush"));
  await context?.closeRunWindow().catch(warnCatch("closeRunWindow"));
  await settleIdle().catch(warnCatch("settleIdle"));
  server?.close();
  extServer?.close();
  extSocket?.destroy();
  if (SESSION_SOCK_IS_FILE) { fs.rmSync(SESSION_SOCK, { force: true }); fs.rmSync(SESSION_EXT_SOCK, { force: true }); }
  fs.rmSync(SESSION_PID_FILE, { force: true });
  if (browser) await disconnectChrome(browser).catch(warnCatch("disconnectChrome"));
  process.exit(code);
}

/** 已有活的 daemon 在监听时返回 true：新 daemon 不应覆盖它。 */
function socketAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (SESSION_SOCK_IS_FILE && !fs.existsSync(sock)) { resolve(false); return; }
    const probe = net.connect(sock);
    const done = (ok: boolean): void => { probe.destroy(); resolve(ok); };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(500, () => done(false));
  });
}

/** 抢占 socket：EADDRINUSE 且对方还活着时返回 null，本进程应退出；残留文件则删掉后重试。 */
async function listenUnique(sock: string, onConn: (socket: net.Socket) => void): Promise<net.Server | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const srv = net.createServer(onConn);
    try {
      await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(sock, () => { srv.off("error", reject); resolve(); }); });
      if (SESSION_SOCK_IS_FILE) fs.chmodSync(sock, 0o600);
      return srv;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || (await socketAlive(sock))) return null;
      if (SESSION_SOCK_IS_FILE) fs.rmSync(sock, { force: true });
    }
  }
  return null;
}

/** relay 连上来：同一时间只保留一个扩展链路，新连接替换旧连接。 */
function onRelay(sock: net.Socket): void {
  let buffer: Buffer = Buffer.alloc(0);
  let helloDone = false;
  sock.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      buffer = parseFrames(buffer, (msg) => {
        if (!helloDone) {
          if (msg.type !== "hello") return;
          // 只有合法 hello 才替换旧连接：单例探测等无效连接不能把正在用的扩展踢掉。
          const previous = extSocket;
          extSocket = sock;
          clearTimeout(idleTimer);
          previous?.destroy();
          link.hello(msg);
          chromeVersion = link.chromeVersion;
          link.attach((out) => sock.write(frame(out)));
          helloDone = true;
          logger.info("extension connected");
          reconciled = ensureChrome()
            .then(() => context!.reconcile({ recordLive: liveRecordName() !== null, runActive: activeRunConn !== null }))
            .catch(warnCatch("reconcile on hello"));
          return;
        }
        link.receive(msg);
      });
    } catch (error) {
      logger.error("扩展消息处理失败", error);
      sock.destroy();
    }
  });
  sock.on("close", () => {
    if (extSocket !== sock) return;
    extSocket = null;
    link.detach();
    logger.info("extension link closed");
    if (activeRunConn) void runEnd().catch(warnCatch("run cleanup on relay close"));
    idleTimer = setTimeout(() => { if (!extSocket && !activeRunConn && !liveRecordName()) void shutdown(0); }, IDLE_EXIT_MS);
    idleTimer.unref();
  });
  sock.on("error", () => {});
}

export async function runHolder(): Promise<void> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  setLogFile(SESSION_LOG);
  ensureHomeLayout();
  extServer = await listenUnique(SESSION_EXT_SOCK, onRelay);
  if (!extServer) { logger.warn("已有 holder 在运行，本进程退出"); process.exit(0); }
  server = await listenUnique(SESSION_SOCK, onConnection);
  if (!server) { logger.warn("CLI socket 被占用，本进程退出"); extServer.close(); if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_EXT_SOCK, { force: true }); process.exit(0); }
  fs.rmSync(RECORDING_DIR, { recursive: true, force: true });
  fs.writeFileSync(SESSION_PID_FILE, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => { logger.error("uncaughtException", error); void shutdown(1); });
  process.on("unhandledRejection", (error) => { logger.error("unhandledRejection", error); void shutdown(1); });
  logger.info("daemon start", { pid: process.pid });
  await new Promise(() => {});
}

runHolder().catch((error) => { logger.error("holder start failed", error); process.exit(1); });
