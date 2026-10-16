import assert from "node:assert/strict";
import { DomRecordStore, pagesMissingScript, processDomTimeline, simpleDomTimeline } from "./dom.ts";

const base = { url: "https://example.com", frameUrl: "https://example.com", mainFrame: true };
const input = { ...base, role: "textbox", name: "搜索", selector: "#q" };

// 连续 fill 只留最后一条；先 fill 后 change 且值相同，只留一条
{
  const store = new DomRecordStore();
  store.append("p1", { ...input, t: 10, type: "fill", value: "a" });
  store.append("p1", { ...input, t: 20, type: "fill", value: "abc" });
  store.append("p1", { ...input, t: 30, type: "change", value: "abc" });
  assert.equal(processDomTimeline(store.events).filter((e) => e.type === "fill").length, 1);
  const rows = simpleDomTimeline(store.events);
  assert.equal(rows.length, 1);
  // 保留的是输入发生的那一条（t=20），失焦时重复的 change 被去掉
  assert.deepEqual(rows[0], { t: 20, type: "action", actionType: "value", role: "textbox", name: "搜索", selector: "#q", value: "abc" });
}

// 同一控件上的 click 紧接着 change：只保留 checked，且 checked 带状态、不带 value
{
  const store = new DomRecordStore();
  const box = { ...base, role: "checkbox", name: "同意", selector: "#agree" };
  store.append("p1", { ...box, t: 70, type: "click" });
  store.append("p1", { ...box, t: 71, type: "click" });
  store.append("p1", { ...box, t: 72, type: "change", checked: true });
  const rows = simpleDomTimeline(store.events);
  assert.deepEqual(rows.map((r) => r.actionType), ["checked"]);
  assert.equal(rows[0]!.checked, true);
  assert.equal("value" in rows[0]!, false);
}

// 超过时间窗的 click 保留；不同控件的 click 保留
{
  const store = new DomRecordStore();
  store.append("p1", { ...input, t: 1000, type: "click" });
  store.append("p1", { ...input, t: 1000 + 5000, type: "fill", value: "x" });
  store.append("p1", { ...base, role: "button", name: "提交", selector: "#go", t: 7000, type: "click" });
  assert.deepEqual(simpleDomTimeline(store.events).map((r) => r.actionType), ["click", "value", "click"]);
}

// 密码等敏感字段只有 valueRedacted；下拉框带 option
{
  const store = new DomRecordStore();
  store.append("p1", { ...base, role: "textbox", name: "密码", selector: "#pwd", t: 10, type: "fill", valueRedacted: true });
  store.append("p1", { ...base, role: "textbox", name: "密码", selector: "#pwd", t: 20, type: "change", valueRedacted: true });
  store.append("p1", { ...base, role: "combobox", name: "排序", selector: "#sort", t: 30, type: "change", value: "hot", selectedText: "热度" });
  const rows = simpleDomTimeline(store.events);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.valueRedacted, true);
  assert.equal("value" in rows[0]!, false);
  assert.equal(rows[1]!.option, "热度");
}

// 滚动：小于 20px 丢弃；整页滚动没有 selector；到底带 nearEnd；位移取整
{
  const store = new DomRecordStore();
  store.append("p1", { ...base, t: 50, type: "scroll", scroll: { deltaX: 0, deltaY: 5, nearEnd: false } });
  store.append("p1", { ...base, t: 60, type: "scroll", scroll: { deltaX: 0, deltaY: 300.4, nearEnd: true } });
  store.append("p1", { ...base, t: 70, type: "scroll", selector: "#list", role: "generic", scroll: { deltaX: 0, deltaY: -90, nearEnd: false } });
  const rows = simpleDomTimeline(store.events);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { t: 60, type: "action", actionType: "scroll", deltaY: 300, nearEnd: true });
  assert.equal(rows[1]!.selector, "#list");
  assert.equal(rows[1]!.deltaY, -90);
}

// 多个标签页才输出 tab；iframe 里的操作带 frame；iframe 里的导航不记录；相同地址的连续导航只记一条
{
  const store = new DomRecordStore();
  store.append("p1", { ...base, t: 1, type: "navigation" });
  store.append("p1", { ...base, t: 2, type: "navigation" });
  store.append("p1", { ...base, t: 3, type: "navigation", url: "about:blank", frameUrl: "about:blank", mainFrame: false });
  store.append("p2", { ...base, role: "button", name: "ok", selector: "#ok", t: 4, type: "click" });
  store.append("p2", { ...base, role: "button", name: "ok", selector: "#fb", t: 5, type: "click", mainFrame: false, frameUrl: "https://example.com/frame" });
  const rows = simpleDomTimeline(store.events);
  assert.deepEqual(rows.map((r) => [r.actionType, r.tab]), [["navigation", 1], ["click", 2], ["click", 2]]);
  assert.equal(rows[2]!.frame, "https://example.com/frame");
  const single = new DomRecordStore();
  single.append("p1", { ...input, t: 1, type: "click" });
  assert.equal("tab" in simpleDomTimeline(single.events)[0]!, false, "只有一个标签页时不输出 tab");
}

// 同一个动作被两份脚本各发一次：只留一条；同一毫秒的两条不同导航都保留
{
  const store = new DomRecordStore();
  store.append("p1", { ...input, t: 5, type: "click" });
  store.append("p1", { ...input, t: 5, type: "click" });
  assert.equal(store.events.length, 1);
  store.append("p1", { ...base, t: 9, type: "navigation", url: "https://example.com/a", frameUrl: "https://example.com/a" });
  store.append("p1", { ...base, t: 9, type: "navigation", url: "https://example.com/b", frameUrl: "https://example.com/b" });
  assert.equal(store.events.length, 3);
}

// 有网络请求、却没收到页面脚本 ready 的页面，按来源去重
{
  const req = (targetId: string, bareUrl: string) => ({ targetId, url: { bareUrl, query: {} } });
  const missing = pagesMissingScript([req("a", "https://x.com/i/api/1"), req("a", "https://x.com/i/api/2"), req("b", "https://ok.com/"), { targetId: undefined, url: { bareUrl: "https://z.com/", query: {} } }], new Set(["b"]));
  assert.deepEqual(missing, ["https://x.com"]);
}

console.log("record dom selfcheck ok");
