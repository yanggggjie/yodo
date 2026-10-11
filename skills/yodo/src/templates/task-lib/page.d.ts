import type { PageHandle } from "../../sdk.ts";

export function goto(page: PageHandle, url: string, options?: { timeout?: number }): Promise<void>;
export function evaluate<T = unknown>(page: PageHandle, fnOrString: string | ((...args: any[]) => T | Promise<T>), ...args: unknown[]): Promise<Awaited<T>>;
export function expectRequest(
  page: PageHandle,
  match: { method: string; path: string },
  action: () => Promise<unknown> | unknown,
  options?: { timeout?: number },
): Promise<{ status: number | undefined; body: { body: string; base64Encoded: boolean } }>;
