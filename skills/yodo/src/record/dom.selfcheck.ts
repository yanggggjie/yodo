import assert from "node:assert/strict";
import { DomRecordStore, processDomTimeline, simpleDomTimeline } from "./dom.ts";

const store = new DomRecordStore();
const target = { tag: "input", id: "search", classes: ["field"] };
const base = { url: "https://example.com", frameUrl: "https://example.com", mainFrame: true };
store.append("page-1", { ...base, t: 10, type: "fill", role: "textbox", name: "搜索", target, value: "a" });
store.append("page-1", { ...base, t: 20, type: "fill", role: "textbox", name: "搜索", target, value: "abc" });
store.append("page-1", { ...base, t: 30, type: "click", target: { tag: "button", id: "submit" }, role: "button", name: "提交" });
store.append("page-1", { ...base, t: 40, type: "change", target: { tag: "input", attributes: { type: "checkbox" } }, role: "checkbox", name: "同意" });
store.append("page-1", { ...base, t: 50, type: "scroll", target: { tag: "div" }, scroll: { left: 0, top: 5, deltaX: 0, deltaY: 5, nearEnd: false } });
store.append("page-1", { ...base, t: 60, type: "scroll", target: { tag: "div" }, scroll: { left: 0, top: 300, deltaX: 0, deltaY: 300, nearEnd: false } });
// 同一复选框上的 click 紧接着 change：只保留 checked
const box = { tag: "input", attributes: { type: "checkbox" } };
store.append("page-1", { ...base, t: 70, type: "click", target: box, role: "checkbox", name: "同意" });
store.append("page-1", { ...base, t: 71, type: "change", target: box, role: "checkbox", name: "同意" });

// 连续 fill 只留最后一条
const processed = processDomTimeline(store.events);
assert.equal(processed.find((e) => e.type === "fill")?.value, "abc");

// timeline 中只出现 click、value、checked、scroll；submit 与 keydown 不记录
const rows = simpleDomTimeline(store.events);
assert.deepEqual(rows.map((r) => r.actionType), ["value", "click", "checked", "scroll", "checked"]);
assert.equal(rows.filter((r) => r.actionType === "scroll").length, 1, "小于 20px 的 scroll 丢弃");
assert.equal(rows[0]?.name, "搜索");
assert.equal("eventId" in rows[0]!, false);
assert.equal("target" in rows[0]!, false);
assert.equal("value" in rows[0]!, false);

console.log("record dom selfcheck ok");
