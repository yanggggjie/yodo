// 模拟真人：找不到或不在视口时像人一样向下滚，直到元素可见，再点击。
export async function reveal(page, selector, maxScrolls = 30) {
  for (let i = 0; i < maxScrolls; i++) {
    const visible = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; })()`);
    if (visible) return;
    await page.scroll(400);
  }
  throw new Error(`滚动后仍不可见：${selector}`);
}
export async function clickVisible(page, selector) { await reveal(page, selector); await page.click(selector); }

/** 点击页面上第一个"真正可见"的匹配（同一 selector 可能有隐藏的重复项）。找不到就滚动，直到可见。 */
export async function clickFirstVisible(page, selector, maxScrolls = 40) {
  for (let i = 0; i < maxScrolls; i++) {
    const hit = await page.eval(`(() => {
      for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight) {
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          // 没被挡住：该点最上层的元素就是它（或它的后代）
          const top = document.elementFromPoint(x, y);
          if (top && (top === el || el.contains(top))) return { x, y };
        }
      }
      return null;
    })()`);
    if (hit) {
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: hit.x, y: hit.y });
      await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
      return;
    }
    await page.scroll(400);
  }
  throw new Error(`滚动后仍没有可见的：${selector}`);
}
