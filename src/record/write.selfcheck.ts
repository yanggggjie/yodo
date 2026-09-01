import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseUrl } from "../utils/url.js";
import { processTimelinePipeline } from "./pipeline.js";
import { writeArtifacts } from "./write.js";
import type { RawEvent, RawRequest } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-write-"));

const doc: RawRequest = {
  id: "request_001",
  mainFrame: true,
  requestType: "mainDoc",
  method: "GET",
  url: parseUrl("https://example.com/"),
  frameUrl: parseUrl("https://example.com/"),
  headers: {},
  status: 200,
  requestBody: null,
  responseBody: null,
  startedAt: 1000,
  endedAt: 1100,
  responseBodyPath: "request_001.response.html",
  late: true,
};
const xhr: RawRequest = {
  id: "request_002",
  mainFrame: false,
  requestType: "xhr",
  method: "POST",
  url: parseUrl("https://example.com/api"),
  frameUrl: parseUrl("https://example.com/"),
  headers: { "content-type": "application/x-www-form-urlencoded" },
  responseHeaders: { "content-type": "application/json" },
  status: 200,
  requestBody: { content: "hi", entityId: "1" },
  responseBody: { ok: true },
  startedAt: 1200,
  endedAt: 1250,
};
const failedXhr: RawRequest = {
  id: "request_failed",
  mainFrame: false,
  requestType: "xhr",
  method: "GET",
  url: parseUrl("https://example.com/failed"),
  frameUrl: parseUrl("https://example.com/"),
  headers: {},
  status: 500,
  requestBody: null,
  responseBody: null,
  startedAt: 1260,
};
const clickXhr: RawRequest = {
  id: "request_003",
  mainFrame: false,
  requestType: "xhr",
  method: "POST",
  url: parseUrl("https://example.com/api"),
  frameUrl: parseUrl("https://example.com/"),
  headers: { "content-type": "application/x-www-form-urlencoded" },
  status: 200,
  requestBody: { content: "hi", entityId: "1" },
  responseBody: { ok: true },
  startedAt: 1300,
  endedAt: 1350,
};

const raw: RawEvent[] = [
  doc,
  xhr,
  failedXhr,
  {
    id: "action_001",
    actionType: "click",
    startedAt: 1300,
    frameUrl: parseUrl("https://example.com/"),
    role: "button",
    name: "Go",
  },
  clickXhr,
  {
    id: "action_002",
    actionType: "scroll",
    startedAt: 1400,
    frameUrl: parseUrl("https://example.com/"),
  },
];
fs.writeFileSync(
  path.join(dir, "request_001.response.html"),
  "<html><body>Hello</body></html>\n",
);

const processed = processTimelinePipeline(raw);
const a = await writeArtifacts(dir, processed, "demo");
assert.equal(a.name, "demo");
assert.equal(a.requestsCount, 3);

const processed2 = processTimelinePipeline(raw);
assert.deepEqual(processed, processed2);

const lines = fs
  .readFileSync(a.timelineFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
assert.equal(lines.length, 5);
assert.equal(lines[0].type, "request");
assert.equal(lines[0].requestType, "mainDoc");
assert.equal(lines[0].file, "01_GET_example.com.json");
assert.equal(lines[0].status, undefined);
assert.equal(lines[0].frameUrl, undefined);
assert.equal(lines[2].type, "action");
assert.equal(lines[2].actionType, "click");

assert.ok(fs.existsSync(path.join(dir, "01_GET_example.com.response.html")));
const req1 = JSON.parse(fs.readFileSync(path.join(dir, "01_GET_example.com.json"), "utf8"));
assert.equal(req1.method, "GET");
assert.equal(req1.status, 200);
assert.equal(req1.late, true);
assert.equal(req1.id, undefined);
assert.equal(req1.responseBodyPath, "01_GET_example.com.response.html");

fs.rmSync(dir, { recursive: true, force: true });
console.log("record write selfcheck ok");
