/**
 * Raw CDP attach + session / page。
 * 只给 holder 用 connectChrome；record / exec 只用已有句柄。
 */
import { requireActiveLink, type TabOps } from "./extension.ts";
import { timeoutReject } from "../utils/async.ts";
import { CDP_SHORT_TIMEOUT_MS } from "../utils/constants.ts";
import { createLogger } from "../utils/logger.ts";

const logger = createLogger("browser");

/**
 * 页面级 CDP 通道（扩展里是 chrome.debugger 按 tab 附加）。
 * sessionId 即 tabId 的字符串形式；不再有 browser 级会话（browser 级操作走 ops）。
 */
export type RawCdpConnection = {
  ops: TabOps;
  chromeVersion: string;
  commandTimeoutMs: number;
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
  private closed = false;
  private inited = false;
  private offs: Array<() => void> = [];

  constructor(
    raw: RawCdpConnection,
    targetId: string,
    sessionId: string,
  ) {
    this.raw = raw;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.initListeners();
  }

  private initListeners(): void {
    this.offs.push(
      this.raw.on("Page.javascriptDialogOpening", async (_params, sessId) => {
        if (sessId !== this.sessionId) return;
        await this.raw
          .send("Page.handleJavaScriptDialog", { accept: true }, this.sessionId)
          .catch(() => {});
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

  isClosed(): boolean {
    return this.closed;
  }

  markClosed(): void {
    this.closed = true;
    for (const off of this.offs) off();
    this.offs = [];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    await this.raw.ops.closeTab(Number(this.targetId)).catch(() => {});
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
        logger.warn(`evaluate timeout tab ${this.targetId}`, {
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
  private runTabId: string | null = null;

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

  /** 锚点 tab 保留，不参与 detach；它保证 run 窗存活。 */
  runKeepIds(): Set<string> {
    return this.runAnchorId ? new Set([this.runAnchorId]) : new Set();
  }

  async openRecordWindow(): Promise<{ page: CdpPage; windowId: number }> {
    const { windowId, tabId } = await this.raw.ops.openWindow({ focused: false, kind: "record" });
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

  /** run 窗：不存在或已被用户关闭时静默重建，锚点 tab 标题为 yodo run。 */
  private async ensureRunWindow(): Promise<number> {
    if (this.runWindowId != null && this.runAnchorId != null) {
      if ((await this.windowIdOf(this.runAnchorId)) === this.runWindowId) return this.runWindowId;
    }
    this.forgetRunMeta();
    const { windowId, tabId } = await this.raw.ops.openWindow({ focused: false });
    const anchor = await this.attachTarget(String(tabId));
    await anchor.evaluate(`document.title = ${JSON.stringify(RUN_WINDOW_TITLE)}`);
    this.runWindowId = windowId;
    this.runAnchorId = anchor.targetId;
    return windowId;
  }

  /**
   * 扩展（重新）连上后对账：刷新扩展会让 debugger 附加状态和窗口登记与 holder 的记录脱节。
   * - 没有进行中的 run 时丢弃全部页面记录（附加状态未知，之后按需重新 attach）。
   * - 按标题识别 yodo 的窗口：当前 run 窗保留；记录失效时收养一扇已有的 run 窗，窗口数量不增加。
   * - run 窗里除锚点外的残留 tab 关掉；其它 `yodo run` 窗口是孤儿，整扇关闭；录制进行中不碰 `yodo record` 窗口。
   * 只关被标题确认的 yodo 窗口，从不按 id 关用户的窗口。
   */
  async reconcile(options: { recordLive: boolean; runActive: boolean }): Promise<void> {
    const { tabs } = await this.raw.ops.listOwned();
    const alive = new Set(tabs.map((t) => String(t.tabId)));
    for (const [id, page] of [...this.pagesMap]) {
      if (options.runActive && alive.has(id)) continue;
      page.markClosed();
      this.pagesMap.delete(id);
    }
    if (!options.runActive) this.runTabId = null;

    const windows = new Map<number, typeof tabs>();
    for (const tab of tabs) {
      const group = windows.get(tab.windowId) ?? [];
      group.push(tab);
      windows.set(tab.windowId, group);
    }
    const anchorOf = (windowId: number): (typeof tabs)[number] | undefined =>
      windows.get(windowId)?.find((t) => t.title === RUN_WINDOW_TITLE);

    const current = this.runWindowId != null ? anchorOf(this.runWindowId) : undefined;
    if (!current || String(current.tabId) !== this.runAnchorId) {
      if (!options.runActive) this.forgetRunMeta();
      const adopt = [...windows.keys()].sort((a, b) => a - b).find((id) => anchorOf(id));
      if (adopt != null && !options.runActive) {
        this.runWindowId = adopt;
        this.runAnchorId = String(anchorOf(adopt)!.tabId);
      }
    }

    for (const [windowId, group] of windows) {
      if (windowId === this.runWindowId) {
        for (const tab of group) {
          const id = String(tab.tabId);
          if (id === this.runAnchorId || id === this.runTabId) continue;
          await this.raw.ops.closeTab(tab.tabId).catch(() => {});
        }
        continue;
      }
      const isRun = group.some((t) => t.title === RUN_WINDOW_TITLE);
      const isRecord = group.some((t) => t.title === RECORD_WINDOW_TITLE);
      if (isRun || (isRecord && !options.recordLive)) {
        logger.info("reconcile: 关闭孤儿窗口", { windowId, kind: isRun ? "run" : "record" });
        await this.raw.ops.closeWindow(windowId).catch(() => {});
      }
    }
  }

  /** 每次 run 都新开一个 tab，不复用。 */
  async newPage(): Promise<CdpPage> {
    const windowId = await this.ensureRunWindow();
    const { tabId } = await this.raw.ops.openTab({ windowId, url: "about:blank", active: true });
    this.runTabId = String(tabId);
    return await this.attachTarget(String(tabId));
  }

  /** run 结束：关闭本次 run 的 tab；锚点保留。 */
  async endRunTab(): Promise<void> {
    const id = this.runTabId;
    if (id == null) return;
    this.runTabId = null;
    this.forgetPage(id);
    await this.raw.ops.detach(Number(id)).catch(() => {});
    await this.raw.ops.closeTab(Number(id)).catch(() => {});
  }

  /** holder 停：关掉整扇 run 窗。 */
  async closeRunWindow(): Promise<void> {
    const windowId = this.runWindowId;
    this.forgetRunMeta();
    if (windowId != null) await this.raw.ops.closeWindow(windowId).catch(() => {});
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

  private forgetPage(targetId: string): void {
    const page = this.pagesMap.get(targetId);
    if (page) {
      page.markClosed();
      this.pagesMap.delete(targetId);
    }
    if (targetId === this.runAnchorId) this.runAnchorId = null;
    if (targetId === this.runTabId) this.runTabId = null;
  }

  private forgetRunMeta(): void {
    this.runWindowId = null;
    this.runAnchorId = null;
    this.runTabId = null;
  }

  private async windowIdOf(targetId: string): Promise<number | undefined> {
    try {
      return (await this.raw.ops.windowOf(Number(targetId))).windowId;
    } catch {
      return undefined;
    }
  }

  private async attachTarget(targetId: string): Promise<CdpPage> {
    const existing = this.pagesMap.get(targetId);
    if (existing && !existing.isClosed()) return existing;
    await this.raw.ops.attach(Number(targetId));
    const page = new CdpPage(this.raw, targetId, targetId);
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
}

export class CdpBrowser {
  readonly raw: RawCdpConnection;
  private disconnectListeners: Set<() => void> = new Set();

  constructor(raw: RawCdpConnection) {
    this.raw = raw;

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

  async version(): Promise<string> {
    return this.raw.chromeVersion || "Google Chrome (extension)";
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

/** 扩展已经经 relay 连上 holder；这里只是把它包成 browser / context。 */
export async function connectChrome(): Promise<{
  browser: CdpBrowser;
  context: CdpContext;
}> {
  const raw = requireActiveLink().raw;
  await timeoutReject(raw.ops.listOwned(), CDP_SHORT_TIMEOUT_MS, "extension ping");
  const context = new CdpContext(raw);
  const browser = new CdpBrowser(raw);
  logger.info("extension connected");
  return { browser, context };
}

export async function disconnectChrome(browser: CdpBrowser): Promise<void> {
  await browser.close().catch(() => {});
  logger.info("extension link closed");
}
