/**
 * dev Driver：在录制窗口里模拟用户操作。设计与约束见 plan/record-untrusted-and-dom-driver.md。
 * 全部是页面内的 DOM 操作（Runtime.evaluate），不使用 Input 域；录制器记录所有页面事件，不做区分。
 * 只用 Runtime.evaluate、Page.navigate、Page.handleJavaScriptDialog；不调用任何 *.disable。
 * 阻塞式对话框（confirm、alert）会让 evaluate 挂起：驱动在操作期间按 dialog 策略处理它。
 */
import { sessionRpc } from "../cli/rpc.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type DialogPolicy = "accept" | "dismiss";

const NAMED_KEYS: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

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

  /**
   * 执行一段页面脚本（返回字符串状态）。若页面弹出对话框，evaluate 会挂起，
   * 这里在等待期间按 dialog 策略处理它，然后取回结果。
   */
  private async act(expression: string, dialog: DialogPolicy): Promise<string> {
    let settled = false;
    const pending = this.eval<string>(expression).finally(() => { settled = true; });
    for (let waited = 0; !settled && waited < 40; waited++) {
      await sleep(100);
      if (waited >= 2) await this.cdp("Page.handleJavaScriptDialog", { accept: dialog === "accept" }).catch(() => {});
    }
    return pending;
  }

  private static check(result: string, selector: string): void {
    if (result === "missing") throw new Error(`找不到元素：${selector}`);
    if (result === "not-editable") throw new Error(`元素不可输入：${selector}`);
    if (result === "not-select") throw new Error(`元素不是下拉框：${selector}`);
  }

  /** 滚到元素中间，然后调用 click()。 */
  async click(selector: string, options: { dialog?: DialogPolicy } = {}): Promise<void> {
    const result = await this.act(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "missing";
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return "ok";
    })()`, options.dialog ?? "accept");
    DevPage.check(result, selector);
  }

  /** 聚焦后逐字符输入（每个字符一个 input 事件），最后派发 change。 */
  async type(selector: string, text: string, options: { dialog?: DialogPolicy } = {}): Promise<void> {
    const result = await this.act(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "missing";
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      const isText = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!isText && !el.isContentEditable) return "not-editable";
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = isText ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
      for (const ch of ${JSON.stringify(text)}) {
        if (setter) setter.call(el, el.value + ch);
        else el.innerText = el.innerText + ch;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    })()`, options.dialog ?? "accept");
    DevPage.check(result, selector);
  }

  /**
   * 按一个键，作用于当前焦点元素。
   * - 命名键（Enter、Tab、Escape、方向键）派发 keydown / keyup；Enter 在输入框所在表单上 requestSubmit()，Tab 让焦点离开当前元素。
   * - 收起的 <select> 上按方向键：改为下一个 / 上一个选项并派发 change（合成键盘事件不会改下拉框）。
   * - 单个字符：追加到当前文本框。
   */
  async press(key: string, options: { dialog?: DialogPolicy } = {}): Promise<void> {
    const named = NAMED_KEYS[key];
    const result = await this.act(`(() => {
      const el = document.activeElement ?? document.body;
      const named = ${JSON.stringify(named ?? null)};
      const key = ${JSON.stringify(key)};
      if (!named) {
        if (key.length !== 1) return "unsupported-key";
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, el.value + key);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return "ok";
      }
      const init = { key, code: named.code, keyCode: named.keyCode, bubbles: true, cancelable: true };
      if (el instanceof HTMLSelectElement && (key === "ArrowDown" || key === "ArrowUp")) {
        el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (key === "ArrowDown" ? 1 : -1)));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      }
      const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      if (proceed && key === "Enter" && el.form) el.form.requestSubmit();
      if (proceed && key === "Tab") el.blur();
      return "ok";
    })()`, options.dialog ?? "accept");
    if (result === "unsupported-key") throw new Error(`不支持的按键：${key}`);
  }

  /** 滚动页面（或指定容器）。位移要不小于 20px，并等录制器的 250ms 去抖。 */
  async scroll(deltaY: number, selector?: string): Promise<void> {
    await this.eval(`(() => {
      const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.scrollingElement"};
      if (!el) return "missing";
      el.scrollBy({ top: ${deltaY}, behavior: "instant" });
      return "ok";
    })()`);
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
