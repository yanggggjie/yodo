import * as fs from "node:fs";
import * as net from "node:net";
import { connectChrome, disconnectChrome, setDiscoverTargets, setIgnoreCertificateErrors, setPageAutoAttach, type CdpBrowser, type CdpContext, type CdpPage } from "./browser/index.ts";
import { finishRecord, liveRecordName, startRecord } from "./record/index.ts";
import { sweepDeadActive } from "./store/repository.ts";
import { ensureHomeLayout } from "./store/layout.ts";
import { HANDSHAKE_GUIDES, HANDSHAKE_MARKS, RPC_ERRORS, handshakeStatusFromError, type CdpScope, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.ts";
import { CDP_COMMAND_TIMEOUT_MS, CDP_SHORT_TIMEOUT_MS, SESSION_DIR, SESSION_LOG, SESSION_PID_FILE, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "./utils/constants.ts";
import { createLogger, setLogFile } from "./utils/logger.ts";

const logger = createLogger("holder");
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_ADVANCED = new Set([
  "Browser.close",
  "Browser.setDownloadBehavior",
  "Security.setIgnoreCertificateErrors",
  "Target.closeTarget",
  "Target.createBrowserContext",
  "Target.createTarget",
  "Target.detachFromTarget",
  "Target.disposeBrowserContext",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
]);

let browser: CdpBrowser | undefined;
let context: CdpContext | undefined;
let chromeVersion = "";
let chromeReady: Promise<void> | null = null;
let recordBusy = false;
let shuttingDown = false;
let server: net.Server | undefined;

type Subscription = { scope: CdpScope; event: string; off: () => void };
type ConnState = { runActive: boolean; subscriptions: Map<string, Subscription>; write: (message: JsonRpcResponse | JsonRpcNotification, priority?: boolean) => void };
let activeRunConn: ConnState | null = null;

function pagesOf(ctx: CdpContext): number { return ctx.pages().filter((page) => !page.isClosed()).length; }
function pingBody() { return { pid: process.pid, chrome: chromeVersion, pages: context ? pagesOf(context) : 0, record: liveRecordName() }; }
function warnCatch(label: string): (error: unknown) => void { return (error) => logger.warn(label, { err: error instanceof Error ? error.message : String(error) }); }
async function tryConnectChrome(): Promise<void> { const connected = await connectChrome(); browser = connected.browser; context = connected.context; chromeVersion = await browser.version().catch(() => "Google Chrome (CDP)"); browser.on("disconnected", () => void shutdown(1)); }
async function ensureChrome(): Promise<void> { if (!chromeReady) chromeReady = tryConnectChrome(); await chromeReady; if (!browser || !context) throw new Error("holder 尚未连上 Chrome"); }

async function settleIdle(): Promise<void> {
  if (!browser || !context || liveRecordName()) return;
  const previous = browser.raw.commandTimeoutMs; browser.raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
  try { await context.detachAllPages(context.runKeepIds()).catch(warnCatch("detachAllPages")); await setPageAutoAttach(browser.raw, false); await setDiscoverTargets(browser.raw, false); await setIgnoreCertificateErrors(browser.raw, false); }
  finally { browser.raw.commandTimeoutMs = previous; }
}

function clearSubscriptions(conn: ConnState): void { for (const subscription of conn.subscriptions.values()) subscription.off(); conn.subscriptions.clear(); }
async function runEnd(conn = activeRunConn): Promise<void> {
  if (!conn || activeRunConn !== conn) return;
  clearSubscriptions(conn);
  if (activeRunConn === conn) activeRunConn = null;
  conn.runActive = false;
  if (browser) browser.raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
  await context?.endRunTabs().catch(warnCatch("endRunTabs"));
  await settleIdle().catch(warnCatch("run end settle"));
}

function pageById(id: unknown): CdpPage { if (typeof id !== "string") throw Object.assign(new Error("缺少 pageId"), { code: RPC_ERRORS.INVALID_PARAMS }); const page = context?.getPage(id); if (!page) throw Object.assign(new Error(`page 不存在或已关闭：${id}`), { code: RPC_ERRORS.PAGE_NOT_FOUND }); return page; }
function paramsOf(req: JsonRpcRequest): Record<string, unknown> { return req.params ?? {}; }
function scopeOf(value: unknown): CdpScope { if (!value || typeof value !== "object") throw Object.assign(new Error("无效 CDP scope"), { code: RPC_ERRORS.INVALID_PARAMS }); const scope = value as CdpScope; if (scope.type === "connection" || scope.type === "browser") return scope; if (scope.type === "page" && typeof scope.pageId === "string") return scope; throw Object.assign(new Error("无效 CDP scope"), { code: RPC_ERRORS.INVALID_PARAMS }); }
function sessionIdOf(scope: CdpScope): string | undefined { if (scope.type === "connection") return undefined; if (scope.type === "browser") return browser!.raw.browserSessionId; return pageById(scope.pageId).sessionId; }
function sameScope(scope: CdpScope, sessionId?: string): boolean { return sessionIdOf(scope) === sessionId; }
function assertCdpAllowed(method: string): void { if (FORBIDDEN_ADVANCED.has(method)) throw Object.assign(new Error(`禁止 task 调用 ${method}`), { code: RPC_ERRORS.FORBIDDEN_CDP }); }

async function dispatch(req: JsonRpcRequest, conn: ConnState): Promise<unknown> {
  if (req.method === "ping") { if (chromeReady) await chromeReady; return pingBody(); }
  await ensureChrome();
  browser!.raw.rpc = { id: req.id, op: req.method };
  try {
    const params = paramsOf(req);
    switch (req.method) {
      case "run.begin": {
        if (activeRunConn) throw Object.assign(new Error("run 进行中"), { code: RPC_ERRORS.RUN_BUSY });
        const record = liveRecordName(); if (record) throw Object.assign(new Error(`record ${record} 仍在进行；请先 record stop/abort`), { code: RPC_ERRORS.RUN_BUSY });
        if (recordBusy) throw Object.assign(new Error("record 操作进行中"), { code: RPC_ERRORS.RUN_BUSY });
        activeRunConn = conn; conn.runActive = true;
        try {
          browser!.raw.commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS; await setIgnoreCertificateErrors(browser!.raw, true);
          const page = await context!.newPage(); return { pageId: page.targetId };
        } catch (error) {
          await runEnd(conn);
          throw error;
        }
      }
      case "run.end": await runEnd(conn); return {};
      case "cdp.send": {
        if (!conn.runActive) throw new Error("cdp.send 只能在 run 中使用");
        const scope = scopeOf(params.scope); const method = String(params.method ?? ""); if (!method) throw Object.assign(new Error("缺少 CDP method"), { code: RPC_ERRORS.INVALID_PARAMS });
        assertCdpAllowed(method);
        return await browser!.raw.send(method, (params.params as Record<string, unknown> | undefined) ?? {}, sessionIdOf(scope), typeof params.timeoutMs === "number" ? params.timeoutMs : undefined);
      }
      case "cdp.subscribe": {
        if (!conn.runActive) throw new Error("cdp.subscribe 只能在 run 中使用");
        const subscriptionId = String(params.subscriptionId ?? ""); const event = String(params.event ?? ""); const scope = scopeOf(params.scope);
        if (!subscriptionId || !event || conn.subscriptions.has(subscriptionId)) throw Object.assign(new Error("无效 subscription"), { code: RPC_ERRORS.INVALID_PARAMS });
        const off = browser!.raw.on(event, (value, sessionId) => { if (sameScope(scope, sessionId)) conn.write({ jsonrpc: "2.0", method: "cdp.event", params: { subscriptionId, event, value } }); });
        conn.subscriptions.set(subscriptionId, { scope, event, off }); return {};
      }
      case "cdp.unsubscribe": { const subscriptionId = String(params.subscriptionId ?? ""); const subscription = conn.subscriptions.get(subscriptionId); if (!subscription) return {}; subscription.off(); conn.subscriptions.delete(subscriptionId); return {}; }
      case "record.start": {
        if (activeRunConn) throw Object.assign(new Error("run 进行中；请等结束再 record start"), { code: RPC_ERRORS.RUN_BUSY });
        if (recordBusy) throw Object.assign(new Error("record 操作进行中"), { code: RPC_ERRORS.RUN_BUSY }); recordBusy = true;
        try { await setIgnoreCertificateErrors(browser!.raw, true); return await startRecord(browser!, context!, { name: typeof params.name === "string" ? params.name : undefined }); }
        catch (error) { await finishRecord("abort").catch(warnCatch("record start abort")); throw error; }
        finally { recordBusy = false; if (!liveRecordName()) await settleIdle(); }
      }
      case "record.stop": { if (recordBusy) throw new Error("record 操作进行中"); recordBusy = true; try { return await finishRecord("stop"); } finally { recordBusy = false; await settleIdle(); } }
      case "record.abort": { if (recordBusy) throw new Error("record 操作进行中"); recordBusy = true; try { return await finishRecord("abort"); } finally { recordBusy = false; await settleIdle(); } }
      default: throw Object.assign(new Error(`未知 method：${String(req.method)}`), { code: RPC_ERRORS.METHOD_NOT_FOUND });
    }
  } finally { if (browser) browser.raw.rpc = undefined; }
}

function responseError(id: string, error: unknown): JsonRpcResponse { const status = handshakeStatusFromError(error); if (status) return { jsonrpc: "2.0", id, error: { code: RPC_ERRORS.HANDSHAKE, message: HANDSHAKE_GUIDES[status], data: { status } } }; const value = error as { code?: number; data?: unknown }; return { jsonrpc: "2.0", id, error: { code: typeof value?.code === "number" ? value.code : RPC_ERRORS.INTERNAL, message: error instanceof Error ? error.message : String(error), ...(value?.data === undefined ? {} : { data: value.data }) } }; }

function onConnection(socket: net.Socket): void {
  let buffer = ""; let writing = false; let queuedBytes = 0; const responses: string[] = []; const notifications: string[] = [];
  const flush = (): void => { if (writing || socket.destroyed) return; const message = responses.shift() ?? notifications.shift(); if (!message) return; queuedBytes -= Buffer.byteLength(message); writing = true; socket.write(message, () => { writing = false; flush(); }); };
  const write = (message: JsonRpcResponse | JsonRpcNotification, priority = false): void => { const line = `${JSON.stringify(message)}\n`; const bytes = Buffer.byteLength(line); if (bytes > MAX_MESSAGE_BYTES || queuedBytes + bytes > MAX_QUEUE_BYTES) { void runEnd(conn).finally(() => socket.destroy()); return; } (priority ? responses : notifications).push(line); queuedBytes += bytes; flush(); };
  const conn: ConnState = { runActive: false, subscriptions: new Map(), write };
  socket.on("data", (chunk) => {
    buffer += chunk.toString(); if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) { write({ jsonrpc: "2.0", id: "", error: { code: RPC_ERRORS.INVALID_REQUEST, message: "RPC message too large" } }, true); socket.end(); return; }
    let nl: number; while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!line.trim()) continue; let req: JsonRpcRequest; try { req = JSON.parse(line) as JsonRpcRequest; } catch { write({ jsonrpc: "2.0", id: "", error: { code: RPC_ERRORS.PARSE, message: "Parse error" } }, true); continue; }
      if (req.jsonrpc !== "2.0" || typeof req.id !== "string" || typeof req.method !== "string") { write({ jsonrpc: "2.0", id: typeof req.id === "string" ? req.id : "", error: { code: RPC_ERRORS.INVALID_REQUEST, message: "Invalid Request" } }, true); continue; }
      void dispatch(req, conn).then((result) => write({ jsonrpc: "2.0", id: req.id, result }, true), (error) => write(responseError(req.id, error), true));
    }
  });
  socket.on("close", () => { clearSubscriptions(conn); if (conn.runActive) void runEnd(conn).catch(warnCatch("run cleanup on close")); });
  socket.on("error", () => {});
}

async function shutdown(code: number): Promise<void> { if (shuttingDown) return; shuttingDown = true; if (liveRecordName()) await finishRecord("disconnect").catch(warnCatch("disconnect flush")); await context?.closeRunWindow().catch(warnCatch("closeRunWindow")); await settleIdle().catch(warnCatch("settleIdle")); server?.close(); if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true }); fs.rmSync(SESSION_PID_FILE, { force: true }); if (browser) await disconnectChrome(browser).catch(warnCatch("disconnectChrome")); process.exit(code); }

export async function runHolder(): Promise<void> {
  fs.mkdirSync(SESSION_DIR, { recursive: true }); setLogFile(SESSION_LOG); fs.writeFileSync(SESSION_PID_FILE, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 }); ensureHomeLayout(); await sweepDeadActive().catch(warnCatch("sweepDeadActive"));
  process.on("SIGINT", () => void shutdown(0)); process.on("SIGTERM", () => void shutdown(0)); process.on("uncaughtException", (error) => { logger.error("uncaughtException", error); void shutdown(1); }); process.on("unhandledRejection", (error) => { logger.error("unhandledRejection", error); void shutdown(1); });
  if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_SOCK, { force: true }); server = net.createServer(onConnection); await new Promise<void>((resolve, reject) => { server!.listen(SESSION_SOCK, resolve); server!.on("error", reject); }); if (SESSION_SOCK_IS_FILE) fs.chmodSync(SESSION_SOCK, 0o600);
  chromeReady = tryConnectChrome(); try { await chromeReady; } catch (error) { const status = handshakeStatusFromError(error); if (status) logger.warn(HANDSHAKE_MARKS[status]); else logger.error("connect failed", error); await shutdown(1); return; }
  await new Promise(() => {});
}

runHolder().catch((error) => { const status = handshakeStatusFromError(error); if (status) logger.warn(HANDSHAKE_MARKS[status]); else logger.error("holder start failed", error); void shutdown(1); });
