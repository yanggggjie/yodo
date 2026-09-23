import { evaluate } from "./page.js";

export async function click(page, selector) {
  const point = await evaluate(page, (value) => { const element = document.querySelector(value); if (!(element instanceof HTMLElement)) throw new Error(`DOM target not found: ${value}`); element.scrollIntoView({ block: "center", inline: "center" }); const rect = element.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) throw new Error(`DOM target not visible: ${value}`); const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2; const hit = document.elementFromPoint(x, y); if (!hit || (hit !== element && !element.contains(hit))) throw new Error(`DOM target obscured: ${value}`); return { x, y }; }, selector);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
}

export async function fill(page, selector, value) {
  await click(page, selector);
  const modifier = process.platform === "darwin" ? 4 : 2;
  await page.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: modifier });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: modifier });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await page.cdp.send("Input.insertText", { text: value });
  const actual = await evaluate(page, (inputSelector) => { const element = document.querySelector(inputSelector); if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value; if (element instanceof HTMLElement && element.isContentEditable) return element.innerText; throw new Error(`DOM fill target not editable: ${inputSelector}`); }, selector);
  if (actual !== value) throw new Error(`DOM fill value mismatch: ${selector}`);
}

export async function press(page, selector, key) {
  await evaluate(page, (value) => { const element = document.querySelector(value); if (!(element instanceof HTMLElement)) throw new Error(`DOM target not found: ${value}`); element.focus(); }, selector);
  const keys = { Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39], " ": ["Space", 32] };
  const info = keys[key]; if (!info) throw new Error(`Unsupported DOM key: ${key}`);
  await page.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: info[0], windowsVirtualKeyCode: info[1] });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: info[0], windowsVirtualKeyCode: info[1] });
}

export async function scroll(page, selector, { deltaX = 0, deltaY = 0 }) {
  const point = await evaluate(page, (value) => { const element = value ? document.querySelector(value) : document.documentElement; if (!(element instanceof Element)) throw new Error(`DOM scroll target not found: ${value}`); if (value) element.scrollIntoView({ block: "center", inline: "center" }); const rect = element.getBoundingClientRect(); return { x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)), y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)) }; }, selector);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
}

export async function check(page, selector, checked) { const current = await evaluate(page, (value) => { const element = document.querySelector(value); if (!(element instanceof HTMLInputElement) || !/^(checkbox|radio)$/.test(element.type)) throw new Error(`DOM check target invalid: ${value}`); return element.checked; }, selector); if (current !== checked) await click(page, selector); const actual = await evaluate(page, (value) => document.querySelector(value)?.checked, selector); if (actual !== checked) throw new Error(`DOM checked state mismatch: ${selector}`); }
export async function select(page, selector, value) { const actual = await evaluate(page, (input) => { const element = document.querySelector(input.selector); if (!(element instanceof HTMLSelectElement)) throw new Error(`DOM select target invalid: ${input.selector}`); element.value = input.value; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); return element.value; }, { selector, value }); if (actual !== value) throw new Error(`DOM select value mismatch: ${selector}`); }
export async function waitForSelector(page, selector, options = {}) { await evaluate(page, async (input) => { const started = Date.now(); while (Date.now() - started < input.timeout) { const element = document.querySelector(input.selector); const visible = element instanceof Element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0; if (input.state === "attached" ? element : visible) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`waitForSelector timeout: ${input.selector}`); }, { selector, state: options.state ?? "visible", timeout: options.timeout ?? 30_000 }); }
