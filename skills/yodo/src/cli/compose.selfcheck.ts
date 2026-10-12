import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTask, HandshakeError, runEval, TaskError, type ComposePaths } from "./compose.ts";
import { parseLastJson } from "./tasks.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-compose-"));
const taskDir = path.join(root, "task");
const runDir = path.join(root, "run");
const composeDir = path.join(root, "compose");
const paths: ComposePaths = { taskDir, runDir, composeDir };

fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, "ok.js"), `console.log(JSON.stringify({ status: "success", result: process.argv.slice(2) }, null, 2));\n`);
fs.writeFileSync(path.join(taskDir, "noisy.js"), `console.log("progress line");\nconsole.log(JSON.stringify({ status: "success", result: process.argv.slice(2) }, null, 2));\n`);
fs.writeFileSync(path.join(taskDir, "bad.js"), `console.log(JSON.stringify({ status: "failure", error: "boom" }, null, 2));\nprocess.exitCode = 1;\n`);
fs.writeFileSync(path.join(taskDir, "guide.js"), `console.log(JSON.stringify({ status: "need-extension", guide: "请连接扩展" }, null, 2));\nprocess.exitCode = 1;\n`);
fs.writeFileSync(path.join(taskDir, "draft.js"), `/**\n * @status: draft\n */\nconsole.log(JSON.stringify({ status: "success", result: "draft" }));\n`);

try {
  // parseLastJson：多行 JSON 前允许有其它输出
  assert.deepEqual(parseLastJson(`noise\n{\n  "a": 1\n}\n`), { a: 1 });
  assert.equal(parseLastJson("   "), undefined);

  // 注入的 task()
  const task = createTask(paths);
  assert.deepEqual(await task("ok", "a", 2), ["a", "2"]);
  assert.deepEqual(await task("noisy", "x"), ["x"], "前面的非 JSON 输出应被跳过");

  await assert.rejects(task("bad"), (error) => error instanceof TaskError && error.task === "bad" && error.message.startsWith("[bad] boom"));
  await assert.rejects(task("draft"), (error) => error instanceof TaskError && /草稿/.test(error.message));
  await assert.rejects(task("missing"), (error) => error instanceof TaskError && error.task === "missing");
  await assert.rejects(task("guide"), (error) => error instanceof HandshakeError && error.status === "need-extension");
  assert.equal(fs.readdirSync(path.join(runDir, "ok")).length, 1, "内层 task 应写运行历史");

  // 完整组合：顺序执行、stdout 只有 JSON、console 走 stderr
  const chain = runEval(`
    console.log("composing");
    const first = await task("ok", "1");
    return await task("ok", ...first, "2");
  `, paths);
  assert.equal(chain.exitCode, 0, chain.stderr);
  assert.deepEqual(JSON.parse(chain.stdout), { status: "success", result: ["1", "2"] });
  assert.match(chain.stderr, /composing/);

  const failed = runEval(`return await task("bad");`, paths);
  assert.equal(failed.exitCode, 1);
  const failedOutput = JSON.parse(failed.stdout) as { status: string; failedTask?: string; error: string };
  assert.equal(failedOutput.status, "failure");
  assert.equal(failedOutput.failedTask, "bad");

  const draft = runEval(`return await task("draft");`, paths);
  assert.equal(draft.exitCode, 1);
  assert.match(JSON.parse(draft.stdout).error, /草稿/);

  const ownError = runEval(`throw new Error("组合自身出错");`, paths);
  assert.equal(ownError.exitCode, 1);
  const ownOutput = JSON.parse(ownError.stdout) as { status: string; failedTask?: string; error: string };
  assert.equal(ownOutput.status, "failure");
  assert.equal(ownOutput.failedTask, undefined);
  assert.match(ownOutput.error, /组合自身出错/);

  const handshake = runEval(`return await task("guide");`, paths);
  assert.equal(handshake.exitCode, 1);
  assert.deepEqual(JSON.parse(handshake.stdout), { status: "need-extension", guide: "请连接扩展" });

  assert.equal(fs.readdirSync(composeDir).length, 0, "组合脚本运行后应删除");
  assert.equal(fs.readdirSync(path.join(runDir, "compose")).length, 5, "每次组合都应写运行历史");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("cli compose selfcheck ok");
