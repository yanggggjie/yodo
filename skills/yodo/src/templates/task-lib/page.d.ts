import type { PageHandle } from "../../sdk.ts";

/** until 默认 "domcontentloaded"；"commit" 只等导航提交；同文档跳转（hash、pushState）等 navigatedWithinDocument。 */
export function goto(page: PageHandle, url: string, options?: { timeout?: number; until?: "commit" | "domcontentloaded" | "load" }): Promise<void>;
export function evaluate<T = unknown>(page: PageHandle, fnOrString: string | ((...args: any[]) => T | Promise<T>), ...args: unknown[]): Promise<Awaited<T>>;
/** 在 run 窗口里另开一个页面并导航到 url，返回新页面的句柄（run 结束时自动关闭）。 */
export function openPage(page: PageHandle, url: string): Promise<PageHandle>;
/** 执行 action 期间页面想打开新窗口（window.open、<a target=_blank>）时，由 yodo 在 run 窗口另开页面并返回句柄；页面自己不会开新标签。 */
export function expectPopup(page: PageHandle, action: () => Promise<unknown> | unknown, options?: { timeout?: number }): Promise<PageHandle>;
export function expectRequest(
  page: PageHandle,
  match: { method: string; path: string },
  action: () => Promise<unknown> | unknown,
  options?: { timeout?: number },
): Promise<{ status: number | undefined; body: string }>;
