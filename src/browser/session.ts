/**
 * Raw CDP attach + session / page。
 * 只给 holder 用 connectChrome；record / exec 只用已有句柄。
 */
import { NeedAllowError, resolveWsEndpoint } from "./connect.js";
import { timeoutReject } from "../utils/async.js";
import { CDP_COMMAND_TIMEOUT_MS, HARD_PROBE_MS } from "../utils/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("browser");

/** ponytail: flatten 下 envelope；升级 Playwright 不影响此路径 */
export function envelopeCdpCommand(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Record<string, unknown> {
  const msg: Record<string, unknown> = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return msg;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
};

export type RawCdpConnection = {
  browserSessionId: string;
  commandTimeoutMs: number;
  rpc?: { id: string; op: string };
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>;
  on: (
    method: string,
    handler: (params: unknown, sessionId?: string) => void,
  ) => () => void;
  onClose: (handler: () => void) => () => void;
  isClosed: () => boolean;
  close: () => Promise<void>;
};

let sharedRawConnection: RawCdpConnection | null = null;

async function getSharedRawCdp(wsUrl?: string): Promise<RawCdpConnection> {
  if (sharedRawConnection && !sharedRawConnection.isClosed()) {
    return sharedRawConnection;
  }
  const endpoint = wsUrl ?? (await resolveWsEndpoint());
  sharedRawConnection = await connectRawCdp(endpoint);
  return sharedRawConnection;
}

async function closeSharedRawCdp(): Promise<void> {
  if (sharedRawConnection) {
    const conn = sharedRawConnection;
    sharedRawConnection = null;
    await conn.close().catch(() => {});
  }
}

export async function connectRawCdp(wsUrl: string): Promise<RawCdpConnection> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    const fail = () => reject(new NeedAllowError());
    ws.addEventListener("error", fail, { once: true });
    ws.addEventListener("close", fail, { once: true });
  });

  let nextId = 1;
  let closed = false;
  let commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS;
  let rpc: { id: string; op: string } | undefined;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
  const closeHandlers = new Set<() => void>();

  const logSendFail = (method: string, ms: number, err: Error): void => {
    logger.warn(err.message, {
      method,
      ms,
      err: err.message,
      ...(rpc ?? {}),
    });
  };

  const rejectAll = (reason: string): void => {
    for (const [id, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  };

  ws.addEventListener("message", (event) => {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(String(event.data)) as typeof msg;
    } catch {
      return;
    }

    if (msg.id != null && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message ?? "raw CDP error");
        logSendFail(entry.method, 0, err);
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    const handlers = listeners.get(msg.method);
    if (!handlers?.size) return;
    for (const handler of handlers) {
      try {
        handler(msg.params, msg.sessionId);
      } catch (error) {
        logger.warn("raw CDP handler fail", {
          method: msg.method,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  ws.addEventListener("close", () => {
    closed = true;
    rejectAll("raw CDP WebSocket closed");
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        /* ignore */
      }
    }
  });

  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("raw CDP closed"));
    const ms = timeoutMs ?? commandTimeoutMs;
    const id = nextId++;
    const payload = JSON.stringify(envelopeCdpCommand(id, method, params, sessionId));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (ms > 0) {
        timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            const err = new Error(`CDP command timed out after ${ms}ms: ${method}`);
            logSendFail(method, ms, err);
            reject(err);
          }
        }, ms);
        timer.unref?.();
      }
      pending.set(id, { resolve, reject, timer, method });
      ws.send(payload);
    });
  };

  const on = (
    method: string,
    handler: (params: unknown, sessionId?: string) => void,
  ): (() => void) => {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) listeners.delete(method);
    };
  };

  const onClose = (handler: () => void): (() => void) => {
    closeHandlers.add(handler);
    return () => {
      closeHandlers.delete(handler);
    };
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    rejectAll("raw CDP closing");
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.addEventListener("close", () => resolve(), { once: true });
    });
  };

  logger.info("raw CDP connected");
  const attached = (await send("Target.attachToBrowserTarget")) as {
    sessionId: string;
  };
  const browserSessionId = attached.sessionId;

  const conn: RawCdpConnection = {
    browserSessionId,
    get commandTimeoutMs() {
      return commandTimeoutMs;
    },
    set commandTimeoutMs(v: number) {
      commandTimeoutMs = v;
    },
    get rpc() {
      return rpc;
    },
    set rpc(v: { id: string; op: string } | undefined) {
      rpc = v;
    },
    send,
    on,
    onClose,
    isClosed: () => closed,
    close,
  };
  return conn;
}

export const PAGE_AUTO_ATTACH = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
  filter: [{ type: "page" }],
} as const;

export function isChromeUiUrl(url: string): boolean {
  return url.startsWith("chrome://") || url.startsWith("devtools://");
}

/** page session only when enabling. browser session may only turn it off. */
export function setPageAutoAttach(
  raw: Pick<RawCdpConnection, "send" | "browserSessionId">,
  enabled: boolean,
  sessionId?: string,
): Promise<unknown> {
  const sid = sessionId ?? raw.browserSessionId;
  if (enabled && sid === raw.browserSessionId) {
    return Promise.resolve();
  }
  return raw
    .send(
      "Target.setAutoAttach",
      {
        autoAttach: enabled,
        flatten: true,
        waitForDebuggerOnStart: false,
        filter: PAGE_AUTO_ATTACH.filter,
      },
      sid,
    )
    .catch((err) => {
      logger.warn("setPageAutoAttach failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

export function setDiscoverTargets(
  raw: Pick<RawCdpConnection, "send">,
  discover: boolean,
): Promise<unknown> {
  return raw.send("Target.setDiscoverTargets", { discover }).catch((err) => {
    logger.warn("setDiscoverTargets failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

export function setIgnoreCertificateErrors(
  raw: Pick<RawCdpConnection, "send">,
  ignore: boolean,
): Promise<unknown> {
  return raw.send("Security.setIgnoreCertificateErrors", { ignore }).catch((err) => {
    logger.warn("setIgnoreCertificateErrors failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

export type EvaluateFn<T = unknown> = (...args: any[]) => T | Promise<T>;

export class CdpPage {
  readonly targetId: string;
  readonly sessionId: string;
  private raw: RawCdpConnection;
  private currentUrl: string;
  private closed = false;
  private consoleListeners: Set<(msg: string) => void> = new Set();
  private inited = false;
  private offs: Array<() => void> = [];

  constructor(
    raw: RawCdpConnection,
    targetId: string,
    sessionId: string,
    initialUrl = "about:blank",
  ) {
    this.raw = raw;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.currentUrl = initialUrl;
    this.initListeners();
  }

  private initListeners(): void {
    this.offs.push(
      this.raw.on("Page.frameNavigated", (params, sessId) => {
        if (sessId !== this.sessionId) return;
        const data = params as { frame: { id: string; parentId?: string; url: string } };
        if (!data?.frame?.parentId && data.frame.url) {
          this.currentUrl = data.frame.url;
        }
      }),
    );

    this.offs.push(
      this.raw.on("Page.javascriptDialogOpening", async (_params, sessId) => {
        if (sessId !== this.sessionId) return;
        await this.raw
          .send("Page.handleJavaScriptDialog", { accept: true }, this.sessionId)
          .catch(() => {});
      }),
    );

    this.offs.push(
      this.raw.on("Runtime.consoleAPICalled", (params, sessId) => {
        if (sessId !== this.sessionId) return;
        const data = params as {
          type: string;
          args: { type: string; value?: unknown; description?: string }[];
        };
        const text = (data.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ""))
          .join(" ");
        for (const listener of this.consoleListeners) {
          try {
            listener(`[page:${data.type}] ${text}`);
          } catch {
            /* ignore */
          }
        }
      }),
    );
  }

  async initPage(): Promise<void> {
    if (this.inited || this.closed) return;
    this.inited = true;
    await Promise.all([
      this.raw.send("Page.enable", {}, this.sessionId).catch(() => {}),
      this.raw.send("Runtime.enable", {}, this.sessionId).catch(() => {}),
      this.raw.send("Page.setBypassCSP", { enabled: true }, this.sessionId).catch(() => {}),
    ]);
  }

  onConsole(listener: (msg: string) => void): () => void {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  markClosed(): void {
    this.closed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.consoleListeners.clear();
  }

  async title(): Promise<string> {
    if (this.closed) return "";
    try {
      return (await this.evaluate<string>("document.title")) || "";
    } catch {
      return "";
    }
  }

  async bringToFront(): Promise<void> {
    if (this.closed) return;
    await this.raw.send("Page.bringToFront", {}, this.sessionId).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    await this.raw.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }

  async goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number },
  ): Promise<void> {
    if (this.closed) throw new Error("Target is closed");
    const timeoutMs = options?.timeout ?? this.raw.commandTimeoutMs;

    await this.initPage();

    let cleanup: (() => void) | undefined;
    const waitPromise = new Promise<void>((resolve) => {
      const offDom = this.raw.on("Page.domContentEventFired", (_params, sessId) => {
        if (sessId === this.sessionId) resolve();
      });
      const offLoad = this.raw.on("Page.loadEventFired", (_params, sessId) => {
        if (sessId === this.sessionId) resolve();
      });
      const offNav = this.raw.on("Page.frameNavigated", (params, sessId) => {
        if (sessId === this.sessionId) {
          const data = params as { frame: { parentId?: string; url: string } };
          if (!data?.frame?.parentId) resolve();
        }
      });
      cleanup = () => {
        offDom();
        offLoad();
        offNav();
      };
    });

    try {
      const navPromise = this.raw.send(
        "Page.navigate",
        { url },
        this.sessionId,
      ) as Promise<{ frameId?: string; errorText?: string }>;

      const navResult = await Promise.race([
        navPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`goto timeout after ${timeoutMs}ms: ${url}`)), timeoutMs),
        ),
      ]);

      if (navResult?.errorText) {
        throw new Error(`net navigation error: ${navResult.errorText}`);
      }

      await Promise.race([
        waitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      this.currentUrl = url;
    } finally {
      cleanup?.();
    }
  }

  async evaluate<T = unknown>(
    fnOrString: string | EvaluateFn<T>,
    ...args: unknown[]
  ): Promise<T> {
    if (this.closed) throw new Error("Target is closed");
    await this.initPage();

    let expression: string;
    if (typeof fnOrString === "function") {
      const fnStr = fnOrString.toString();
      const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
      expression = `(async () => (${fnStr})(${serializedArgs}))()`;
    } else {
      expression = fnOrString;
    }

    let response: {
      result?: { type?: string; value?: unknown; description?: string };
      exceptionDetails?: {
        text: string;
        exception?: { description?: string; value?: unknown };
      };
    };
    try {
      response = (await this.raw.send(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        this.sessionId,
      )) as typeof response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(msg)) {
        logger.warn(`evaluate timeout ${this.currentUrl}`, {
          method: "Runtime.evaluate",
          err: msg,
        });
      }
      throw err;
    }

    if (response?.exceptionDetails) {
      const desc =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "evaluate failed";
      throw new Error(desc);
    }

    return response?.result?.value as T;
  }
}

export class CdpContext {
  private raw: RawCdpConnection;
  private pagesMap = new Map<string, CdpPage>();
  private sessionToTarget = new Map<string, string>();

  constructor(raw: RawCdpConnection) {
    this.raw = raw;
    this.initTargetListeners();
  }

  private initTargetListeners(): void {
    this.raw.on("Target.attachedToTarget", (params) => {
      const e = params as {
        sessionId: string;
        targetInfo: { targetId: string; type: string; url?: string };
      };
      const chromeUi =
        e.targetInfo.url?.startsWith("chrome://") ||
        e.targetInfo.url?.startsWith("devtools://");
      if (e.targetInfo.type !== "page" || chromeUi) {
        return;
      }
      if (this.pagesMap.has(e.targetInfo.targetId)) {
        this.sessionToTarget.set(e.sessionId, e.targetInfo.targetId);
      }
    });

    this.raw.on("Target.detachedFromTarget", (params) => {
      const e = params as { sessionId: string; targetId?: string };
      const targetId = e.targetId || this.sessionToTarget.get(e.sessionId);
      if (targetId) {
        this.sessionToTarget.delete(e.sessionId);
        const page = this.pagesMap.get(targetId);
        if (page) {
          page.markClosed();
          this.pagesMap.delete(targetId);
        }
      }
    });

    this.raw.on("Target.targetDestroyed", (params) => {
      const e = params as { targetId: string };
      const page = this.pagesMap.get(e.targetId);
      if (page) {
        page.markClosed();
        this.pagesMap.delete(e.targetId);
      }
    });
  }

  async init(): Promise<void> {
    await setPageAutoAttach(this.raw, false);
  }

  async pageForOrigin(origin: string): Promise<CdpPage> {
    const want = new URL(origin).origin;
    for (const p of this.pages()) {
      try {
        if (new URL(p.url()).origin === want) return p;
      } catch {
        /* about:blank / chrome:// */
      }
    }
    const targetsRes = (await this.raw.send("Target.getTargets")) as {
      targetInfos?: { targetId: string; type: string; url?: string }[];
    };
    for (const target of targetsRes?.targetInfos || []) {
      if (target.type !== "page") continue;
      const url = target.url || "";
      if (!url || url === "about:blank" || isChromeUiUrl(url)) continue;
      try {
        if (new URL(url).origin !== want) continue;
      } catch {
        continue;
      }
      if (this.pagesMap.has(target.targetId)) {
        return this.pagesMap.get(target.targetId)!;
      }
      try {
        return await this.attachExisting(target.targetId, url);
      } catch {
        /* target might have closed */
      }
    }
    const page = await this.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    return page;
  }

  async detachAllPages(): Promise<void> {
    const pages = [...this.pagesMap.values()];
    this.pagesMap.clear();
    this.sessionToTarget.clear();
    await Promise.all(
      pages.map(async (page) => {
        page.markClosed();
        await this.raw
          .send("Target.detachFromTarget", { sessionId: page.sessionId }, this.raw.browserSessionId)
          .catch((err) => {
            logger.warn("detachFromTarget failed", {
              err: err instanceof Error ? err.message : String(err),
            });
          });
      }),
    );
  }

  private async attachExisting(targetId: string, url: string): Promise<CdpPage> {
    const attachRes = (await this.raw.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const page = new CdpPage(this.raw, targetId, attachRes.sessionId, url);
    this.sessionToTarget.set(attachRes.sessionId, targetId);
    this.pagesMap.set(targetId, page);
    await page.initPage();
    return page;
  }

  pages(): CdpPage[] {
    return Array.from(this.pagesMap.values()).filter((p) => !p.isClosed());
  }

  getPage(targetId: string): CdpPage | undefined {
    return this.pagesMap.get(targetId);
  }

  async newPage(): Promise<CdpPage> {
    const createRes = (await this.raw.send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId: string };

    const targetId = createRes.targetId;
    const existing = this.pagesMap.get(targetId);
    if (existing) return existing;

    const attachRes = (await this.raw.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };

    const page = new CdpPage(this.raw, targetId, attachRes.sessionId, "about:blank");
    this.sessionToTarget.set(attachRes.sessionId, targetId);
    this.pagesMap.set(targetId, page);
    await page.initPage();
    return page;
  }
}

export class CdpBrowser {
  readonly raw: RawCdpConnection;
  private contextInstance: CdpContext;
  private disconnectListeners: Set<() => void> = new Set();

  constructor(raw: RawCdpConnection, context: CdpContext) {
    this.raw = raw;
    this.contextInstance = context;

    raw.onClose(() => {
      for (const listener of this.disconnectListeners) {
        try {
          listener();
        } catch {
          /* ignore */
        }
      }
    });
  }

  contexts(): CdpContext[] {
    return [this.contextInstance];
  }

  async version(): Promise<string> {
    try {
      const ver = (await this.raw.send("Browser.getVersion")) as { product?: string };
      return ver?.product || "Google Chrome (CDP)";
    } catch {
      return "Google Chrome (CDP)";
    }
  }

  isConnected(): boolean {
    return !this.raw.isClosed();
  }

  on(event: "disconnected", listener: () => void): void {
    if (event === "disconnected") {
      this.disconnectListeners.add(listener);
    }
  }

  async close(): Promise<void> {
    await this.raw.close();
  }
}

export async function connectChrome(): Promise<{
  browser: CdpBrowser;
  context: CdpContext;
}> {
  const ws = await resolveWsEndpoint();
  const raw = await getSharedRawCdp(ws);

  const context = new CdpContext(raw);
  await context.init();

  const browser = new CdpBrowser(raw, context);

  try {
    await timeoutReject(raw.send("Target.getTargets"), HARD_PROBE_MS, "hardProbe");
  } catch (e) {
    await disconnectChrome(browser);
    throw e;
  }

  logger.info("Chrome connected");
  return { browser, context };
}

export async function disconnectChrome(browser: CdpBrowser): Promise<void> {
  await closeSharedRawCdp().catch(() => {});
  await browser.close().catch(() => {});
  logger.info("Chrome disconnected");
}
