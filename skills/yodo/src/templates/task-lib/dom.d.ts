import type { PageHandle } from "../../sdk.ts";

export function click(page: PageHandle, selector: string): Promise<void>;
export function fill(page: PageHandle, selector: string, value: string): Promise<void>;
export function press(page: PageHandle, selector: string, key: string): Promise<void>;
export function scroll(page: PageHandle, selector: string | undefined, options: { deltaX?: number; deltaY?: number }): Promise<void>;
export function check(page: PageHandle, selector: string, checked: boolean): Promise<void>;
export function select(page: PageHandle, selector: string, value: string): Promise<void>;
export function waitForSelector(page: PageHandle, selector: string, options?: { state?: "attached" | "visible"; timeout?: number }): Promise<void>;
