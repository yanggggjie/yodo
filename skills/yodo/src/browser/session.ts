/**
 * Raw CDP attach + session / page。
 * 只给 holder 用 connectChrome；record / exec 只用已有句柄。
 */
import { requireActiveLink, type TabOps } from "./extension.ts";
import { timeoutReject } from "../utils/async.ts";
import { CDP_COMMAND_TIMEOUT_MS, CDP_SHORT_TIMEOUT_MS } from "../utils/constants.ts";
import { createLogger } from "../utils/logger.ts";

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

/**
 * 页面级 CDP 通道（扩展里是 chrome.debugger 按 tab 附加）。
 * sessionId 即 tabId 的字符串形式；不再有 browser 级会话（browser 级操作走 ops）。
 */
export type RawCdpConnection = {
  ops: TabOps;
  chromeVersion: string;
  commandTimeoutMs: number;
  rpc?: { id: string; op: string };
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<unknown>;
  /** 页面事件：method 为 CDP 事件名，handler 第二参数是 sessionId；tab.* 为扩展事件。 */
  on: (
    method: string,
    handler: (params: unknown, sessionId?: string) => void,
  ) => () => void;
  onClose: (handler: () => void) => () => void;
  isClosed: () => boolean;
  close: () => Promise<void>;
};

/** 录制空白 tab 的 document.title，给人在后台找到这扇窗。 */
export const RECORD_WINDOW_TITLE = "yodo record";
/** run 窗里那一个 tab 的 document.title（idle 时）。 */
export const RUN_WINDOW_TITLE = "yodo run";

export function isChromeUiUrl(url: string): boolean {
  return url.startsWith("chrome://") || url.startsWith("devtools://");
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
    await this.raw.ops.closeTab(Number(this.targetId)).catch(() => {});
  }

  async goto(
    url: string,
    options?: { timeout?: number },
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

/** 扩展里 yodo 自己拥有的 tab（只含 yodo 创建或由其打开的）。 */
async function ownedPages(
  raw: RawCdpConnection,
): Promise<{ targetId: string; windowId: number; url: string }[]> {
  const { tabs } = await raw.ops.listOwned();
  return tabs.map((t) => ({ targetId: String(t.tabId), windowId: t.windowId, url: t.url }));
}

/** 关掉一批 tab。若会关到 yodo 的 tab 只剩这些，先开一扇后台空白窗，避免窗口全没。 */
export async function closeTargetsKeepChrome(
  raw: RawCdpConnection,
  targetIds: Iterable<string>,
): Promise<void> {
  const closing = new Set(targetIds);
  if (closing.size === 0) return;
  let pages: { targetId: string }[] = [];
  try {
    pages = await ownedPages(raw);
  } catch {
    pages = [];
  }
  const leftover = pages.filter((t) => !closing.has(t.targetId));
  if (leftover.length === 0) {
    await raw.ops.openWindow({ focused: false }).catch(() => {});
  }
  await Promise.all(
    [...closing].map((targetId) => raw.ops.closeTab(Number(targetId)).catch(() => {})),
  );
}

export class CdpContext {
  private raw: RawCdpConnection;
  private pagesMap = new Map<string, CdpPage>();
  private runWindowId: number | null = null;
  private runAnchorId: string | null = null;
  private ignoreCertErrors = false;

  constructor(raw: RawCdpConnection) {
    this.raw = raw;
    // 扩展上报：tab 被用户或 Chrome 关掉 / 调试器被分离（如用户点了提示条的 Cancel）。
    // ponytail: 分离后不自动重新附加，之后对该页的命令会报 PAGE_NOT_FOUND。
    this.raw.on("tab.removed", (params) => {
      const { tabId } = params as { tabId: number };
      this.forgetPage(String(tabId));
    });
    this.raw.on("tab.detached", (params) => {
      const { tabId } = params as { tabId: number };
      this.forgetPage(String(tabId));
    });
  }

  runKeepIds(): Set<string> {
    return this.runAnchorId ? new Set([this.runAnchorId]) : new Set();
  }

  async openRunWindow(): Promise<CdpPage> {
    if (!(await this.runWindowAlive())) {
      this.forgetRunMeta();
      return await this.createRunWindow();
    }
    return await this.ensureAnchor();
  }

  async openRecordWindow(): Promise<{ page: CdpPage; windowId: number }> {
    const { windowId, tabId } = await this.raw.ops.openWindow({ focused: true });
    try {
      const page = await this.attachTarget(String(tabId));
      await page.evaluate(`document.title = ${JSON.stringify(RECORD_WINDOW_TITLE)}`);
      return { page, windowId };
    } catch (err) {
      await this.raw.ops.closeWindow(windowId).catch(() => {});
      this.forgetPage(String(tabId));
      throw err;
    }
  }

  /** 这一次 run 结束：tab 回到 about:blank，标题改回 `yodo run`。不关窗。 */
  async endRunTabs(): Promise<void> {
    if (this.runWindowId == null) return;
    if (!(await this.runWindowAlive())) {
      this.forgetRunMeta();
      return;
    }
    const inWin = await this.targetsInRunWindow();
    for (const id of inWin) {
      if (id === this.runAnchorId) continue;
      await this.raw.ops.closeTab(Number(id)).catch(() => {});
      this.forgetPage(id);
    }
    try {
      const page = await this.ensureAnchor();
      await page.goto("about:blank");
      await this.setTabTitle(page, RUN_WINDOW_TITLE);
    } catch {
      this.forgetRunMeta();
    }
  }

  /** holder 停：整扇 run 窗关掉。 */
  async closeRunWindow(): Promise<void> {
    const ids = new Set(await this.targetsInRunWindow());
    if (this.runAnchorId) ids.add(this.runAnchorId);
    this.forgetRunMeta();
    await closeTargetsKeepChrome(this.raw, ids);
    await this.detachAllPages();
  }

  async detachAllPages(keep: ReadonlySet<string> = new Set()): Promise<void> {
    const pages = [...this.pagesMap.values()].filter((p) => !keep.has(p.targetId));
    for (const page of pages) {
      this.pagesMap.delete(page.targetId);
      page.markClosed();
    }
    await Promise.all(
      pages.map((page) =>
        this.raw.ops.detach(Number(page.targetId)).catch((err) => {
          logger.warn("detach failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  }

  /** 证书错误忽略：对所有已附加的 tab 生效，之后新附加的 tab 也生效。 */
  async setIgnoreCertErrors(ignore: boolean): Promise<void> {
    this.ignoreCertErrors = ignore;
    await Promise.all(
      this.pages().map((page) =>
        this.raw.send("Security.setIgnoreCertificateErrors", { ignore }, page.sessionId).catch((err) => {
          logger.warn("setIgnoreCertificateErrors failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  }

  private forgetPage(targetId: string): void {
    const page = this.pagesMap.get(targetId);
    if (page) {
      page.markClosed();
      this.pagesMap.delete(targetId);
    }
    if (targetId === this.runAnchorId) this.runAnchorId = null;
  }

  private forgetRunMeta(): void {
    this.runWindowId = null;
    this.runAnchorId = null;
  }

  private async windowIdOf(targetId: string): Promise<number | undefined> {
    try {
      return (await this.raw.ops.windowOf(Number(targetId))).windowId;
    } catch {
      return undefined;
    }
  }

  private async targetsInRunWindow(): Promise<string[]> {
    if (this.runWindowId == null) return [];
    try {
      return (await ownedPages(this.raw))
        .filter((t) => t.windowId === this.runWindowId)
        .map((t) => t.targetId);
    } catch {
      return [];
    }
  }

  private async runWindowAlive(): Promise<boolean> {
    if (this.runWindowId == null) return false;
    if (this.runAnchorId != null) {
      if ((await this.windowIdOf(this.runAnchorId)) === this.runWindowId) return true;
    }
    return (await this.targetsInRunWindow()).length > 0;
  }

  private async setTabTitle(page: CdpPage, title: string): Promise<void> {
    await page.evaluate(`document.title = ${JSON.stringify(title)}`);
  }

  private async createRunWindow(): Promise<CdpPage> {
    const { windowId, tabId } = await this.raw.ops.openWindow({ focused: false });
    const page = await this.attachTarget(String(tabId));
    this.runWindowId = windowId;
    this.runAnchorId = page.targetId;
    await this.setTabTitle(page, RUN_WINDOW_TITLE);
    return page;
  }

  private async ensureAnchor(): Promise<CdpPage> {
    if (this.runWindowId == null) return await this.createRunWindow();
    if (this.runAnchorId) {
      const existing = this.pagesMap.get(this.runAnchorId);
      if (existing && !existing.isClosed()) {
        if ((await this.windowIdOf(existing.targetId)) === this.runWindowId) {
          await this.setTabTitle(existing, RUN_WINDOW_TITLE).catch(() => {});
          return existing;
        }
      }
    }
    if (this.runAnchorId) {
      const w = await this.windowIdOf(this.runAnchorId);
      if (w === this.runWindowId) {
        const page = await this.attachTarget(this.runAnchorId);
        await this.setTabTitle(page, RUN_WINDOW_TITLE).catch(() => {});
        return page;
      }
    }
    const inWin = await this.targetsInRunWindow();
    const reuse = inWin[0];
    if (reuse) {
      const page = await this.attachTarget(reuse);
      this.runAnchorId = page.targetId;
      await page.goto("about:blank").catch(() => {});
      await this.setTabTitle(page, RUN_WINDOW_TITLE).catch(() => {});
      return page;
    }
    this.forgetRunMeta();
    return await this.createRunWindow();
  }

  private async attachTarget(targetId: string, url = "about:blank"): Promise<CdpPage> {
    const existing = this.pagesMap.get(targetId);
    if (existing && !existing.isClosed()) return existing;
    await this.raw.ops.attach(Number(targetId));
    const page = new CdpPage(this.raw, targetId, targetId, url);
    this.pagesMap.set(targetId, page);
    if (this.ignoreCertErrors) {
      await this.raw
        .send("Security.setIgnoreCertificateErrors", { ignore: true }, targetId)
        .catch(() => {});
    }
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
    const page = await this.openRunWindow();
    await page.goto("about:blank");
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
    return this.raw.chromeVersion || "Google Chrome (extension)";
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

/** 扩展已经由 native host 建立好连接；这里只是把它包成 browser / context。 */
export async function connectChrome(): Promise<{
  browser: CdpBrowser;
  context: CdpContext;
}> {
  const raw = requireActiveLink().raw;
  await timeoutReject(raw.ops.listOwned(), CDP_SHORT_TIMEOUT_MS, "extension ping");
  const context = new CdpContext(raw);
  const browser = new CdpBrowser(raw, context);
  logger.info("extension connected");
  return { browser, context };
}

export async function disconnectChrome(browser: CdpBrowser): Promise<void> {
  await browser.close().catch(() => {});
  logger.info("extension link closed");
}
