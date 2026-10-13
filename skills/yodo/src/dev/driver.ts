/**
 * dev Driver：像用户一样操作 yodo 的页面（主要是录制窗口）。设计与约束见 AGENTS.md 2.3。
 * 录制器只认 isTrusted 的 click / input / change，所以输入全部走 CDP 的 Input.*。
 * 只用 Input.*、只读的 Runtime.evaluate、Page.navigate；不调用任何 *.disable，也不用 scrollIntoView（会产生被录制的 scroll）。
 * 不需要等"录制脚本就绪"：它注入在隔离 world 里（页面看不到），但在页面脚本之前就执行，goto 等到文档加载完时早已就绪。
 */
import { sessionRpc } from "../cli/rpc.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Point = { x: number; y: number };

export class DevPage {
  readonly pageId: string;
  constructor(pageId: string) { this.pageId = pageId; }

  cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return sessionRpc("dev.cdp", { pageId: this.pageId, method, params }, 30_000);
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** 轮询直到条件成立，超时抛错。 */
  async waitFor(expression: string, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await this.eval<boolean>(expression).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
      await sleep(100);
    }
  }

  async goto(url: string): Promise<void> {
    const before = await this.eval<string>("location.href").catch(() => "");
    const r = await this.cdp("Page.navigate", { url });
    if (r.errorText) throw new Error(`导航失败：${r.errorText}`);
    // 地址变了且文档加载完；同一地址的导航没法区分新旧文档，等一小会儿
    if (before === new URL(url).href) await sleep(500);
    else await this.waitFor(`location.href !== ${JSON.stringify(before)} && document.readyState === 'complete'`, `加载 ${url}`);
  }

  private async center(selector: string): Promise<Point> {
    const p = await this.eval<Point | "missing" | "offscreen">(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "missing";
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return "offscreen";
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (p === "missing") throw new Error(`找不到元素：${selector}`);
    if (p === "offscreen") throw new Error(`元素不在视口内，先 scroll：${selector}`);
    return p;
  }

  async click(selector: string): Promise<void> {
    const { x, y } = await this.center(selector);
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** 点击聚焦后逐字输入；最后按 Tab 失焦，输入框的 change 才会触发。 */
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    for (const ch of text) {
      if (ch.charCodeAt(0) < 128) {
        await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
        await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      } else {
        await this.cdp("Input.insertText", { text: ch });
      }
    }
    await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  }

  /** 滚轮滚动。位移要不小于 20px，并等录制器的 250ms 去抖。 */
  async scroll(deltaY: number): Promise<void> {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY });
    await sleep(400);
  }
}

/** 按标题找 yodo 的页面。刚 record.start 之后，录制页的标题是 "yodo record"。 */
export async function findPage(title: string, timeoutMs = 5_000): Promise<DevPage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pages = await sessionRpc("dev.pages", {}, 5_000) as { pageId: string; title: string }[];
    const hit = pages.find((p) => p.title === title);
    if (hit) return new DevPage(hit.pageId);
    if (Date.now() > deadline) throw new Error(`找不到标题为 ${title} 的页面：${JSON.stringify(pages)}`);
    await sleep(200);
  }
}
