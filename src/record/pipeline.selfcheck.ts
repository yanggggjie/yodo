import assert from "node:assert/strict";
import { parseUrl } from "../utils/url.js";
import {
  RecordSanitizer,
  dedupeTimeline,
  loadAdblockEngine,
  processTimelinePipeline,
  shouldSkipRecordUrl,
} from "./pipeline.js";
import type { RawEvent, RawRequest } from "./types.js";

function xhr(
  id: string,
  frameUrl: string,
  bareUrl: string,
  startedAt: number,
  method = "GET",
  status = 200,
): RawRequest {
  return {
    id,
    mainFrame: false,
    requestType: "xhr",
    method,
    url: parseUrl(bareUrl),
    frameUrl: parseUrl(frameUrl),
    headers: {},
    requestBody: null,
    responseBody: null,
    startedAt,
    status,
  };
}

function doc(
  id: string,
  frameUrl: string,
  bareUrl: string,
  startedAt: number,
  mainFrame = true,
): RawRequest {
  return {
    id,
    mainFrame,
    requestType: mainFrame ? "mainDoc" : "doc",
    method: "GET",
    url: parseUrl(bareUrl),
    frameUrl: parseUrl(frameUrl),
    headers: {},
    requestBody: null,
    responseBody: null,
    startedAt,
    status: 200,
  };
}

function action(frameUrl: string, startedAt: number): RawEvent {
  return {
    id: "action_001",
    actionType: "click",
    startedAt,
    frameUrl: parseUrl(frameUrl),
  };
}

{
  const timeline: RawEvent[] = [
    doc("request_001", "https://example.com/a", "https://example.com/a", 1),
    doc("request_002", "https://example.com/a", "https://example.com/a", 2),
  ];
  assert.equal(dedupeTimeline(timeline), 0);
  assert.equal(timeline.length, 2);
}

{
  const timeline: RawEvent[] = [
    doc("request_001", "https://www.zhihu.com/", "https://www.zhihu.com/", 1),
    xhr("request_002", "https://www.zhihu.com/", "https://www.zhihu.com/api/a", 2),
    xhr("request_003", "https://www.zhihu.com/", "https://api.zhihu.com/api/a", 3),
  ];
  assert.equal(dedupeTimeline(timeline), 0);
  assert.equal(timeline.length, 3);
}

{
  const timeline: RawEvent[] = [
    doc("request_001", "https://www.zhihu.com/", "https://www.zhihu.com/", 1),
    xhr("request_002", "https://www.zhihu.com/", "https://hm.baidu.com/hm.js?x=1", 2),
    xhr("request_003", "https://www.zhihu.com/", "https://hm.baidu.com/hm.js?x=2", 3),
  ];
  assert.equal(dedupeTimeline(timeline), 1);
  assert.equal(timeline.length, 2);
  assert.equal((timeline[1] as RawRequest).id, "request_003");
}

{
  const timeline: RawEvent[] = [
    action("https://www.zhihu.com/page", 1),
    xhr("request_001", "https://www.zhihu.com/page", "https://api.zhihu.com/x", 2),
    xhr("request_002", "https://www.zhihu.com/page", "https://hm.baidu.com/hm.js", 3),
    xhr("request_003", "https://www.zhihu.com/page", "https://hm.baidu.com/hm.js", 4),
  ];
  assert.equal(dedupeTimeline(timeline), 1);
  assert.equal(timeline.length, 3);
}

const sanitizer = new RecordSanitizer();
const headers = sanitizer.sanitizeHeaders({
  Authorization: "Bearer aaa.bbb.ccc",
  Cookie: "sid=secret-value; theme=dark",
});
const body = sanitizer.sanitizeBody(
  { token: "aaa.bbb.ccc", itemId: "123456789" },
  "request-body",
);
assert.match(headers.value.Authorization, /Bearer ⟨secret_001:jwt:/);
assert.match(String(body.value && (body.value as { token: string }).token), /secret_001/);
assert.equal((body.value as { itemId: string }).itemId, "123456789");

const engine = await loadAdblockEngine();
assert.equal(
  shouldSkipRecordUrl(
    "https://hm.baidu.com/hm.js?abc",
    "fetch",
    "https://www.ithome.com/",
    engine,
  ),
  true,
);
assert.equal(
  shouldSkipRecordUrl(
    "https://www.zhihu.com/api/v4/me",
    "fetch",
    "https://www.zhihu.com/",
    engine,
  ),
  false,
);

const raw: RawEvent[] = [
  doc("request_001", "https://example.com/", "https://example.com/", 1000),
  xhr("request_ok", "https://example.com/", "https://example.com/api", 1200, "POST"),
  xhr("request_fail", "https://example.com/", "https://example.com/fail", 1260, "GET", 500),
  action("https://example.com/", 1300),
  {
    ...xhr("request_ad", "https://example.com/", "https://hm.baidu.com/hm.js", 1400),
    headers: { Authorization: "Bearer aaa.bbb.ccc" },
  },
];

const once = processTimelinePipeline(raw, engine);
const twice = processTimelinePipeline(raw, engine);
assert.deepEqual(once, twice);

const reqs = once.filter((e): e is RawRequest => "requestType" in e);
assert.ok(reqs.every((r) => r.status === undefined || (r.status >= 200 && r.status < 300)));
assert.ok(!reqs.some((r) => r.url.bareUrl.includes("hm.baidu.com")));
assert.ok(once.some((e) => "actionType" in e));

console.log("record pipeline selfcheck ok");
