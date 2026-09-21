import type { PageHandle } from "../../sdk.ts";

export function goto(page: PageHandle, url: string, options?: { timeout?: number }): Promise<void>;
export function evaluate<T = unknown>(page: PageHandle, fnOrString: string | ((...args: any[]) => T | Promise<T>), ...args: unknown[]): Promise<Awaited<T>>;
