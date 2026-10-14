import type { PageHandle } from "../../sdk.ts";

/** until 默认 "domcontentloaded"；"commit" 只等导航提交；同文档跳转（hash、pushState）等 navigatedWithinDocument。 */
export function goto(page: PageHandle, url: string, options?: { timeout?: number; until?: "commit" | "domcontentloaded" | "load" }): Promise<void>;
export function evaluate<T = unknown>(page: PageHandle, fnOrString: string | ((...args: any[]) => T | Promise<T>), ...args: unknown[]): Promise<Awaited<T>>;
export function expectRequest(
  page: PageHandle,
  match: { method: string; path: string },
  action: () => Promise<unknown> | unknown,
  options?: { timeout?: number },
): Promise<{ status: number | undefined; body: { body: string; base64Encoded: boolean } }>;
