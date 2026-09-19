import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DomRecordStore, processDomTimeline, simpleDomTimeline, writeDomTimeline } from "./dom.ts";

const store = new DomRecordStore();
const target = { tag: "input", id: "search", classes: ["field"] };
store.append("page-1", {
  t: 10,
  type: "fill",
  url: "https://example.com",
  frameUrl: "https://example.com",
  mainFrame: true,
  role: "textbox",
  name: "搜索",
  target,
  value: "a",
});
store.append("page-1", {
  t: 20,
  type: "fill",
  url: "https://example.com",
  frameUrl: "https://example.com",
  mainFrame: true,
  role: "textbox",
  name: "搜索",
  target,
  value: "abc",
});
store.append("page-1", {
  t: 30,
  type: "click",
  url: "https://example.com",
  frameUrl: "https://example.com",
  mainFrame: true,
  target: { tag: "button", id: "submit" },
  ancestors: [{ tag: "form", classes: ["editor"] }],
  role: "button",
  name: "提交",
});
store.append("page-1", {
  t: 40,
  type: "final-state",
  url: "https://example.com/result",
  frameUrl: "https://example.com/result",
  mainFrame: true,
  title: "完成",
  elements: [{ tag: "button", attributes: { "aria-label": "已提交" } }],
});

const processed = processDomTimeline(store.events);
assert.equal(processed.length, 3);
assert.equal(processed[0]?.value, "abc");
assert.equal(processed[1]?.type, "click");
const simple = simpleDomTimeline(store.events);
assert.equal(simple.length, 2);
assert.equal(simple[0]?.eventId, "dom_002");
assert.equal(simple[0]?.name, "搜索");
assert.equal("target" in simple[0]!, false);
assert.equal("value" in simple[0]!, false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-dom-"));
await writeDomTimeline(dir, store.events);
const file = path.join(dir, "DOM", "DOMTimeline.jsonl");
assert.ok(fs.existsSync(file));
const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.equal(lines.length, 3);
assert.equal(lines[0].eventId, "dom_002");
assert.equal(lines[1].ancestors[0].tag, "form");
assert.equal(lines[2].type, "final-state");
fs.rmSync(dir, { recursive: true, force: true });

console.log("record dom selfcheck ok");
