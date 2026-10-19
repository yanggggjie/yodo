import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkParams, headerTags, legacyParamHint, invokeTaskFile, paramSpecs, parseCliParams, taskOutput, taskSummary, taskTimeoutMs } from "./tasks.ts";
import { TASK_TIMEOUT_MS } from "../utils/constants.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-tasks-"));
try {
  const hang = path.join(dir, "hang.js");
  fs.writeFileSync(hang, `console.log("started");\nsetInterval(() => {}, 1000);\n`);
  const crash = path.join(dir, "crash.js");
  fs.writeFileSync(crash, `process.exit(3);\n`);
  const ok = path.join(dir, "ok.js");
  fs.writeFileSync(ok, `console.log(JSON.stringify({ status: "success", result: 1 }));\n`);

  // 超时：进程被终止，合成 failure（带 status），不依赖 task 自己输出
  const started = Date.now();
  const timedOut = invokeTaskFile(hang, {}, 400);
  assert.ok(Date.now() - started < 5_000, "超时后应及时返回");
  assert.equal(timedOut.timedOut, true);
  const failure = taskOutput(timedOut, 400);
  assert.equal(failure.status, "failure");
  assert.match(String(failure.error), /未结束/);

  // 无法解析的输出：合成 failure，带退出码
  const crashed = invokeTaskFile(crash, {});
  assert.equal(crashed.timedOut, false);
  assert.equal(crashed.exitCode, 3);
  assert.match(String(taskOutput(crashed).error), /退出码 3/);

  // @timeout：文件头声明的秒数覆盖默认值；缺失或非法时用默认
  const slow = path.join(dir, "slow.js");
  fs.writeFileSync(slow, `/**\n * @summary 慢\n * @timeout 180\n */\n`);
  assert.equal(taskSummary(slow).timeout, 180);
  assert.equal(taskTimeoutMs(slow), 180_000);
  assert.equal(taskSummary(ok).timeout, undefined);
  assert.equal(taskTimeoutMs(ok), TASK_TIMEOUT_MS);
  const bad = path.join(dir, "bad.js");
  fs.writeFileSync(bad, `/**\n * @timeout abc\n */\n`);
  assert.equal(taskTimeoutMs(bad), TASK_TIMEOUT_MS);

  // 文件头只认开头的块注释：代码里出现的 @status 不算；冒号可有可无；多个 @param 都保留
  const tricky = path.join(dir, "tricky.js");
  fs.writeFileSync(tricky, [
    "/**",
    " * @summary 搜索",
    " * @status draft",
    " * @param term 词",
    " * @param count? 数量，默认 3",
    " */",
    "// @status: verified",
    "const note = '@summary 不是头部';",
    "",
  ].join("\n"));
  assert.deepEqual(taskSummary(tricky), { name: "tricky", status: "draft", summary: "搜索", params: ["term 词", "count? 数量，默认 3"] });
  assert.deepEqual(paramSpecs(tricky), [{ name: "term", optional: false, description: "词" }, { name: "count", optional: true, description: "数量，默认 3" }]);
  assert.equal(checkParams(tricky, { term: "a" }), undefined);
  assert.match(checkParams(tricky, { count: "1" })!, /缺少必填参数：--term/);
  assert.match(checkParams(tricky, { term: "a", x: "1" })!, /没有这些参数：--x；可用：--term、--count/);
  assert.deepEqual(parseCliParams(["--term", "a b", "--count=5"]), { params: { term: "a b", count: "5" } });
  assert.deepEqual(parseCliParams(["--empty="]), { params: { empty: "" } }, "--名字= 表示空字符串");
  assert.ok("error" in parseCliParams(["pos"]));
  assert.ok("error" in parseCliParams(["--a", "1", "--a", "2"]));
  // v1 的 task 没有 @param：报错里提示改写；声明了 @param 的不提示
  const legacy = path.join(dir, "legacy.js");
  fs.writeFileSync(legacy, "console.log(process.argv[2]);\n");
  assert.match(checkParams(legacy, { q: "1" })!, /没有声明 @param.*SKILL\.md/);
  assert.match(legacyParamHint(legacy), /具名参数/);
  assert.equal(legacyParamHint(tricky), "");
  assert.doesNotMatch(checkParams(tricky, { x: "1" })!, /没有声明 @param/);
  const noHeader = path.join(dir, "plain.js");
  fs.writeFileSync(noHeader, "// @status: draft\nconsole.log(1);\n");
  assert.equal(taskSummary(noHeader).status, "verified", "没有块注释头部时按 verified");
  assert.deepEqual(headerTags("#!/usr/bin/env node\n/** @status: draft */\n"), [["status", "draft"]]);

  // 正常输出：原样返回解析结果
  assert.deepEqual(taskOutput(invokeTaskFile(ok, {})), { status: "success", result: 1 });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("cli tasks selfcheck ok");
