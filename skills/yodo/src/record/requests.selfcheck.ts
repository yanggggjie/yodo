import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { processTimelinePipeline } from "./pipeline.ts";
import { writeArtifacts } from "./write.ts";
import { lateAttachVariant, loadFixture, loadGolden, replay, replayStore } from "./fixtures/helpers.ts";

const fx = loadFixture();

// 1. 真实 Chrome 抓到的事件回放后，与旧实现的输出完全一致
assert.deepEqual(replay(fx), loadGolden("local-site"));

// 2. 重定向：302 的中间跳不留下记录，只留最终请求（旧实现里它是未完成的请求，stop 时被丢弃）
const rows = replay(fx) as Array<{ requestType: string; url: { bareUrl: string }; status?: number; responseBodyPath?: unknown; responseBody: unknown; responseBodyUnavailableReason?: string; errorText?: string }>;
const paths = rows.map((r) => r.url.bareUrl.replace("http://127.0.0.1:18765", ""));
assert.ok(!paths.includes("/redirect") && paths.includes("/final"));

// 3. 大于 1KB 的 JSON 写成单独文件，小的内联
const big = rows.find((r) => r.url.bareUrl.endsWith("/api/big"))!;
assert.ok(big.responseBodyPath && big.responseBody === null);
const small = rows.find((r) => r.url.bareUrl.endsWith("/api/small"))!;
assert.deepEqual(small.responseBody, { ok: true });

// 4. 连接中断：记 errorText，没有响应体；非 HTML 的主文档：标记 document-not-html；扩展等非 http 请求被丢弃
assert.equal(rows.find((r) => r.url.bareUrl.endsWith("/api/fail"))!.errorText, "net::ERR_EMPTY_RESPONSE");
assert.equal(rows.find((r) => r.url.bareUrl.endsWith("/plain"))!.responseBodyUnavailableReason, "document-not-html");
assert.ok(!paths.some((p) => p.startsWith("chrome-extension")));

// 5. 晚 attach（页面在开始采集之前已经加载完）：补抓一条主文档，标记 late，并且在 stop 时不会被当成未完成的请求丢掉
const lateRows = replay(lateAttachVariant(fx)) as Array<{ id: string; late?: boolean; requestType: string; url: { bareUrl: string } }>;
assert.deepEqual(lateRows, loadGolden("local-site-late"));
const late = lateRows.filter((r) => r.late);
assert.equal(late.length, 1);
assert.equal(late[0]!.requestType, "mainDoc");
assert.equal(late[0]!.url.bareUrl, "http://127.0.0.1:18765/");

// 6. 补抓的主文档能走完整条管线并落盘：过滤、脱敏、去重、写 timeline.jsonl
{
  const { rows, dir, cleanup } = replayStore(lateAttachVariant(fx));
  try {
    const processed = processTimelinePipeline(rows);
    assert.ok(processed.some((r) => r.late), "late 行经过管线后仍在");
    await writeArtifacts(dir, processed, [], "selfcheck");
    const timeline = fs.readFileSync(path.join(dir, "timeline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const doc = timeline.find((r) => r.type === "request" && r.requestType === "mainDoc" && r.url === "http://127.0.0.1:18765/");
    assert.ok(doc?.file, "timeline 里有补抓主文档的请求行");
    assert.ok(fs.existsSync(path.join(dir, doc.file)));
  } finally {
    cleanup();
  }
}

console.log("record requests selfcheck ok");
