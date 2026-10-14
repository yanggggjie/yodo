import { evaluate, STEP_TIMEOUT_MS } from "./page.js";
import { callOn, describeTarget, locate, withElement } from "./locate.js";

// ponytail: events from these helpers are untrusted and carry no pointer coordinates.
// Sliders, clientX menus, and editor-owned documents need a task-level evaluate. Do not switch these back to Input.*.
// target 是 CSS 选择器字符串，或 { role, name }。两者都会等元素可见、可操作（timeout 毫秒，默认 10 秒）。

export async function click(page, target, options) {
  await withElement(page, target, options, (el) => {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
  });
}

export async function fill(page, target, value, options) {
  const actual = await withElement(page, target, options, (element, inputValue) => {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) throw new Error("DOM fill value setter missing");
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
    throw new Error("DOM fill target not editable");
  }, value);
  if (actual !== value) throw new Error(`DOM fill value mismatch: ${describeTarget(target)}`);
}

export async function press(page, target, key, options) {
  await withElement(page, target, options, (element, inputKey) => {
    const codes = { Enter: "Enter", Escape: "Escape", Tab: "Tab", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", " ": "Space" };
    const code = codes[inputKey];
    if (!code) throw new Error(`Unsupported DOM key: ${inputKey}`);
    element.focus();
    const init = { key: inputKey, code, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keyup", init));
  }, key);
}

export async function scroll(page, selector, { deltaX = 0, deltaY = 0 }) {
  await evaluate(page, (value, dx, dy) => {
    const element = value ? document.querySelector(value) : (document.scrollingElement || document.documentElement);
    if (!(element instanceof Element)) throw new Error(`DOM scroll target not found: ${value}`);
    element.scrollBy({ left: dx, top: dy, behavior: "instant" });
  }, selector ?? null, deltaX, deltaY);
}

export async function check(page, target, checked, options) {
  const current = await withElement(page, target, options, (element) => {
    if (!(element instanceof HTMLInputElement) || !/^(checkbox|radio)$/.test(element.type)) throw new Error("DOM check target is not a checkbox or radio");
    return element.checked;
  });
  if (current === checked) return "already";
  await click(page, target, options);
  return "done";
}

export async function select(page, target, value, options) {
  const actual = await withElement(page, target, options, (element, optionValue) => {
    if (!(element instanceof HTMLSelectElement)) throw new Error("DOM select target is not a select element");
    const option = [...element.options].find((o) => o.value === optionValue || o.textContent.trim() === optionValue);
    if (!option) throw new Error(`DOM select option not found: ${optionValue}`);
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  }, value);
  if (!actual) throw new Error(`DOM select failed: ${describeTarget(target)}`);
}

/**
 * 等待 selector 出现（visible：有尺寸；attached：存在于 DOM），最长 STEP_TIMEOUT_MS。
 * 在 Node 侧轮询，每次只做一次快速 evaluate，不在页面里跑长循环，超时报具体错误。
 * 只用于 CSS 选择器；动作本身（click 等）已经会等，一般不需要单独调用。
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
 * 把 target 对应控件设为 target 状态：已满足返回 "already"，否则点击一次返回 "done"。
 * isOn 可选，是自包含的函数 (el) => boolean，用于读取非标准的状态（如 class）。
 */
export async function toggle(page, target, { target: wanted, isOn, ...options } = {}) {
  if (typeof wanted !== "boolean") throw new Error("toggle 需要 { target: true | false }");
  const source = (isOn ?? defaultIsOn).toString();
  const current = await withElement(page, target, options, (element, fnSource) => Boolean(new Function(`return (${fnSource})`)()(element)), source);
  if (current === wanted) return "already";
  await click(page, target, options);
  return "done";
}
