import { evaluate } from "./page.js";

// ponytail: events from these helpers are untrusted and carry no pointer coordinates.
// Sliders, clientX menus, and editor-owned documents need a task-level evaluate. Do not switch these back to Input.*.

export async function click(page, selector) {
  await evaluate(page, (value) => {
    const element = document.querySelector(value);
    if (!(element instanceof HTMLElement)) throw new Error(`DOM target not found: ${value}`);
    if (element.matches(":disabled")) throw new Error(`DOM target disabled: ${value}`);
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
  }, selector);
}

export async function fill(page, selector, value) {
  const actual = await evaluate(page, (inputSelector, inputValue) => {
    const element = document.querySelector(inputSelector);
    if (!(element instanceof HTMLElement)) throw new Error(`DOM target not found: ${inputSelector}`);
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) throw new Error(`DOM fill value setter missing: ${inputSelector}`);
      setter.call(element, inputValue);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return element.value;
    }
    if (element.isContentEditable) {
      element.innerText = inputValue;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return element.innerText;
    }
    throw new Error(`DOM fill target not editable: ${inputSelector}`);
  }, selector, value);
  if (actual !== value) throw new Error(`DOM fill value mismatch: ${selector}`);
}

export async function press(page, selector, key) {
  await evaluate(page, (value, inputKey) => {
    const element = document.querySelector(value);
    if (!(element instanceof HTMLElement)) throw new Error(`DOM target not found: ${value}`);
    const codes = { Enter: "Enter", Escape: "Escape", Tab: "Tab", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", " ": "Space" };
    const code = codes[inputKey];
    if (!code) throw new Error(`Unsupported DOM key: ${inputKey}`);
    element.focus();
    const init = { key: inputKey, code, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keyup", init));
  }, selector, key);
}

export async function scroll(page, selector, { deltaX = 0, deltaY = 0 }) {
  await evaluate(page, (value, dx, dy) => {
    const element = value ? document.querySelector(value) : (document.scrollingElement || document.documentElement);
    if (!(element instanceof Element)) throw new Error(`DOM scroll target not found: ${value}`);
    element.scrollBy({ left: dx, top: dy, behavior: "instant" });
  }, selector ?? null, deltaX, deltaY);
}

export async function check(page, selector, checked) { const current = await evaluate(page, (value) => { const element = document.querySelector(value); if (!(element instanceof HTMLInputElement) || !/^(checkbox|radio)$/.test(element.type)) throw new Error(`DOM check target invalid: ${value}`); return element.checked; }, selector); if (current !== checked) await click(page, selector); const actual = await evaluate(page, (value) => document.querySelector(value)?.checked, selector); if (actual !== checked) throw new Error(`DOM checked state mismatch: ${selector}`); }
export async function select(page, selector, value) { const actual = await evaluate(page, (input) => { const element = document.querySelector(input.selector); if (!(element instanceof HTMLSelectElement)) throw new Error(`DOM select target invalid: ${input.selector}`); element.value = input.value; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); return element.value; }, { selector, value }); if (actual !== value) throw new Error(`DOM select value mismatch: ${selector}`); }
export async function waitForSelector(page, selector, options = {}) { await evaluate(page, async (input) => { const started = Date.now(); while (Date.now() - started < input.timeout) { const element = document.querySelector(input.selector); const visible = element instanceof Element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0; if (input.state === "attached" ? element : visible) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`waitForSelector timeout: ${input.selector}`); }, { selector, state: options.state ?? "visible", timeout: options.timeout ?? 30_000 }); }
