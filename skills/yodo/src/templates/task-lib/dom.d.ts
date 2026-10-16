import type { PageHandle } from "../../sdk.ts";

/** 定位：CSS 选择器，或无障碍角色与名称（需唯一）。 */
export type Target = string | { role: string; name: string };
export type ActionOptions = { timeout?: number };

export function click(page: PageHandle, target: Target, options?: ActionOptions): Promise<void>;
export function fill(page: PageHandle, target: Target, value: string, options?: ActionOptions): Promise<void>;
export function press(page: PageHandle, target: Target, key: string, options?: ActionOptions): Promise<void>;
export function scroll(page: PageHandle, selector: string | undefined, options: { deltaX?: number; deltaY?: number }): Promise<void>;
export function check(page: PageHandle, target: Target, checked: boolean, options?: ActionOptions): Promise<"already" | "done">;
export function select(page: PageHandle, target: Target, value: string, options?: ActionOptions): Promise<void>;
export function waitForSelector(page: PageHandle, selector: string, options?: { state?: "attached" | "visible" }): Promise<void>;
export function toggle(
  page: PageHandle,
  target: Target,
  options: { target: boolean; isOn?: (el: Element) => boolean } & ActionOptions,
): Promise<"already" | "done">;
