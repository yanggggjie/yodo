import { evaluate, STEP_TIMEOUT_MS } from "./page.js";

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
/**
 * 等待 selector 出现（visible：有尺寸；attached：存在于 DOM），最长 STEP_TIMEOUT_MS。
 * 在 Node 侧轮询，每次只做一次快速 evaluate，不在页面里跑长循环，超时报具体错误。
 */
export async function waitForSelector(page, selector, options = {}) {
  const state = options.state ?? "visible";
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const found = await evaluate(page, (input) => {
      const element = document.querySelector(input.selector);
      if (!(element instanceof Element)) return false;
      if (input.state === "attached") return true;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, { selector, state });
    if (found) return;
    if (Date.now() >= deadline) throw new Error(`waitForSelector timeout: ${selector}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function defaultIsOn(el) {
  return el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true" || el.checked === true;
}

/**
 * 把 selector 对应控件设为 target 状态：已满足返回 "already"，否则点击一次返回 "done"。
 * isOn 可选，是自包含的函数 (el) => boolean，用于读取非标准的状态（如 class）。
 */
export async function toggle(page, selector, { target, isOn } = {}) {
  if (typeof target !== "boolean") throw new Error("toggle 需要 { target: true | false }");
  const source = (isOn ?? defaultIsOn).toString();
  const current = await evaluate(page, (value, fnSource) => {
    const element = document.querySelector(value);
    if (!element) throw new Error(`未找到 ${value}`);
    return Boolean(new Function(`return (${fnSource})`)()(element));
  }, selector, source);
  if (current === target) return "already";
  await click(page, selector);
  return "done";
}
