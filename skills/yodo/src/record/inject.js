/**
 * 注入录制页面的采集脚本：监听可信的 click、input、change、scroll，经 __yodoEvent binding 回传。
 * 每个事件直接带上 agent 写 DOM task 需要的字段：selector（尽量稳定且唯一）、role、name、输入值、滚动量。
 * 由 collect.ts 读取后交给 Page.addScriptToEvaluateOnNewDocument（以及已加载的文档）执行，运行在页面里，不能 import。
 */
(() => {
  // 同一个 world 里重复注入时，只有最后一份继续发事件。
  const gen = (window.__yodoGen = (window.__yodoGen || 0) + 1);
  const NAME_MAX = 80;
  const VALUE_MAX = 500;

  const text = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const clip = (s, n = NAME_MAX) => text(s).slice(0, n);
  const esc = (v) => (window.CSS?.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  const count = (selector) => {
    try { return document.querySelectorAll(selector); } catch { return []; }
  };
  const isUnique = (selector, el) => { const all = count(selector); return all.length === 1 && all[0] === el; };

  // ---- selector ----
  // 框架自动生成的 id、class（含长数字、哈希片段）不稳定，不用。
  const generated = (v) => /^(css|sc|jsx|emotion|radix|react|ember)[-_:]/i.test(v) || /\d{4,}/.test(v) || (/^[a-z0-9]{8,}$/i.test(v) && /\d/.test(v) && /[a-z]/i.test(v)) || /[:]/.test(v);
  const candidates = (el) => {
    const tag = el.tagName.toLowerCase();
    const out = [];
    if (el.id && !generated(el.id)) out.push("#" + esc(el.id));
    for (const key of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "placeholder", "title", "alt"]) {
      const value = el.getAttribute(key);
      if (value && value.length <= 100) out.push(`${tag}[${key}=${JSON.stringify(value)}]`);
    }
    const classes = [...el.classList].filter((c) => !generated(c)).slice(0, 3);
    if (classes.length) out.push(tag + classes.map((c) => "." + esc(c)).join(""));
    const href = tag === "a" ? el.getAttribute("href") : "";
    if (href && href.length <= 100) out.push(`a[href=${JSON.stringify(href)}]`);
    return out;
  };
  const selectorOf = (el) => {
    for (const selector of candidates(el)) if (isUnique(selector, el)) return selector;
    // 没有唯一的：从最近的、自己有唯一选择器的祖先出发，用 :nth-of-type 拼出一条路径，最多 5 层。
    const path = [];
    let cur = el;
    for (let i = 0; i < 5 && cur && cur.parentElement; i++) {
      const parent = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      path.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      const anchor = candidates(parent).find((s) => isUnique(s, parent));
      if (anchor) return anchor + " > " + path.join(" > ");
      cur = parent;
    }
    return path.join(" > ");
  };
  // shadow DOM 里的元素没法用 document 级选择器表达，用它所在的宿主元素。
  const lightHost = (el) => {
    let cur = el;
    for (let root = cur.getRootNode?.(); root instanceof ShadowRoot; root = cur.getRootNode?.()) cur = root.host;
    return cur;
  };

  // ---- role / name ----
  const roleOf = (el) => {
    const explicit = text(el.getAttribute("role")).split(" ")[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (tag === "dialog") return "dialog";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "generic";
  };
  const ownText = (el) => text([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  // direct 为真时（点到的不是可交互元素）只取元素自己的文字，不取整个容器的文字。
  const nameOf = (el, direct) => {
    const ids = el.getAttribute("aria-labelledby");
    if (ids) {
      const labelled = ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => text(n.textContent)).join(" ");
      if (labelled) return clip(labelled);
    }
    const aria = text(el.getAttribute("aria-label"));
    if (aria) return clip(aria);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if ((type === "button" || type === "submit" || type === "reset") && el.value) return clip(el.value);
      const labels = el.labels ? [...el.labels].map((l) => text(l.textContent)).filter(Boolean) : [];
      if (labels.length) return clip(labels.join(" "));
      const placeholder = text(el.getAttribute("placeholder"));
      if (placeholder) return clip(placeholder);
    }
    if (tag === "img") {
      const alt = text(el.getAttribute("alt"));
      if (alt) return clip(alt);
    }
    const own = direct ? ownText(el) : text(el.innerText ?? el.textContent);
    if (own) return clip(own);
    return clip(el.getAttribute("title"));
  };

  // ---- 敏感字段 ----
  const sensitive = (el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const hint = ["name", "id", "aria-label", "placeholder"].map((k) => el.getAttribute(k) || "").join(" ");
    return type === "password" || type === "file" || /one-time-code|cc-|password/.test(autocomplete) || /captcha|验证码|otp|password|passwd|credit.?card|银行卡/i.test(hint);
  };
  const fieldValue = (el) => {
    if (sensitive(el)) return { valueRedacted: true };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return { value: String(el.value).slice(0, VALUE_MAX) };
    if (el instanceof HTMLElement && el.isContentEditable) return { value: String(el.innerText || "").slice(0, VALUE_MAX) };
    return {};
  };

  // ---- 事件 ----
  const send = (payload) => {
    if (window.__yodoGen !== gen) return;
    try {
      window.__yodoEvent(JSON.stringify({ ...payload, frameUrl: location.href, mainFrame: window === window.top, startedAt: Date.now() }));
    } catch { /* binding 已经不在了 */ }
  };
  const ACTIONABLE = 'a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox], [tabindex]:not([tabindex="-1"])';
  const originOf = (e) => {
    const first = e.composedPath ? e.composedPath()[0] : e.target;
    return first instanceof Element ? first : e.target instanceof Element ? e.target : null;
  };
  const describe = (el, direct) => ({ role: roleOf(el), name: nameOf(el, direct), selector: selectorOf(lightHost(el)) });

  document.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const origin = originOf(e);
    if (!origin) return;
    // 点到按钮里的图标或文字，算作点了按钮；点到 label，算作点了它控制的输入框（浏览器随后会再对输入框发一次 click）。
    const hit = origin.closest(ACTIONABLE);
    const el = hit && hit.tagName === "LABEL" && hit.control ? hit.control : hit || origin;
    send({ kind: "click", ...describe(el, !hit) });
  }, true);

  document.addEventListener("input", (e) => {
    if (!e.isTrusted) return;
    const el = originOf(e);
    // 复选框、单选框、按钮的 input 事件没有值的含义；下拉框一次选择会连发 input 与 change。它们的状态都由 change 记录。
    if (!el || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && /^(checkbox|radio|file|button|submit|reset|image)$/.test(el.type))) return;
    send({ kind: "fill", ...describe(el, false), ...fieldValue(el) });
  }, true);

  document.addEventListener("change", (e) => {
    if (!e.isTrusted) return;
    const el = originOf(e);
    if (!el) return;
    const toggle = el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type);
    send({
      kind: "change",
      ...describe(el, false),
      ...(toggle ? { checked: el.checked } : fieldValue(el)),
      ...(el instanceof HTMLSelectElement ? { selectedText: clip(el.selectedOptions[0]?.textContent, 200) } : {}),
    });
  }, true);

  // 每个滚动目标上一次停下来的位置。第一次见到的容器按 0 算，整页按注入时的位置算。
  // 不能在第一个 scroll 事件里取基准：那时已经滚过去了，一次性跳转的位移会被算成 0。
  const initial = { left: window.scrollX, top: window.scrollY };
  const rest = new WeakMap();
  const timers = new WeakMap();
  const restOf = (target) => rest.get(target) || (target === document.scrollingElement ? initial : { left: 0, top: 0 });
  document.addEventListener("scroll", (e) => {
    const target = e.target === document ? document.scrollingElement : e.target;
    if (!(target instanceof Element)) return;
    clearTimeout(timers.get(target));
    timers.set(target, setTimeout(() => {
      const from = restOf(target);
      const deltaX = target.scrollLeft - from.left;
      const deltaY = target.scrollTop - from.top;
      if (Math.abs(deltaX) < 20 && Math.abs(deltaY) < 20) return; // 太小的位移不记，也不更新基准，累积够了再记
      rest.set(target, { left: target.scrollLeft, top: target.scrollTop });
      // 整页滚动不带 selector 和 name；容器滚动带上容器的 selector。
      const page = target === document.scrollingElement;
      send({
        kind: "scroll",
        ...(page ? { role: "", name: "" } : describe(target, true)),
        scroll: { deltaX, deltaY, nearEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 20 },
      });
    }, 250));
  }, true);

  // 脚本已经在这个文档里生效。宿主据此判断哪些页面的动作可以被录到。
  send({ kind: "ready" });
})()
