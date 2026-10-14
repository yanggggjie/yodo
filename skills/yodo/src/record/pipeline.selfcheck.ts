import assert from "node:assert/strict";
import { parseUrl } from "../utils/url.ts";
import {
  RecordSanitizer,
  dedupeTimeline,
  loadAdblockEngine,
  processTimelinePipeline,
  runPipeline,
  shouldSkipRecordUrl,
} from "./pipeline.ts";
import type { RawEvent, RawRequest } from "./types.ts";

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
    xhr("request_001", "https://www.zhihu.com/page", "https://api.zhihu.com/x", 2),
    xhr("request_002", "https://www.zhihu.com/page", "https://hm.baidu.com/hm.js", 3),
    xhr("request_003", "https://www.zhihu.com/page", "https://hm.baidu.com/hm.js", 4),
  ];
  assert.equal(dedupeTimeline(timeline), 1);
  assert.equal(timeline.length, 2);
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
assert.match(headers.value.Authorization, /^Bearer ⟨secret_001:jwt⟩$/);
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
assert.ok(once.every((e) => "requestType" in e));

// 脱敏别名不带原值的长度
assert.ok(!JSON.stringify(once).includes("bytes="), "别名不应泄漏密码长度");

// runPipeline：结果与 processTimelinePipeline 一致；每一级的数量首尾相接，丢弃数与差值一致
const { events: explained, stages } = runPipeline(raw, engine);
assert.deepEqual(explained, once);
assert.deepEqual(stages.map((s) => s.name), ["success-only", "adblock", "sanitize", "dedupe"]);
assert.equal(stages[0]!.in, raw.length);
assert.equal(stages.at(-1)!.out, once.length);
for (let i = 1; i < stages.length; i++) assert.equal(stages[i]!.in, stages[i - 1]!.out, `${stages[i]!.name} 的输入应等于上一级的输出`);
for (const s of stages) assert.equal(Object.values(s.dropped).reduce((a, b) => a + b, 0), s.in - s.out, `${s.name} 的丢弃数应等于 in - out`);

console.log("record pipeline selfcheck ok");
