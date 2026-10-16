import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// 用隔离的 HOME 真实运行命令行：不碰真实的 ~/.yodo，也不需要 Chrome。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-cli-"));
const taskDir = path.join(home, ".yodo", "task");
fs.mkdirSync(taskDir, { recursive: true });
const entry = path.join(import.meta.dirname, "yodo.ts");
const sdk = pathToFileURL(path.join(import.meta.dirname, "..", "sdk.ts")).href;

function yodo(...args: string[]): { code: number; out: string; json: any } {
  const run = child_process.spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let json: unknown;
  try { json = JSON.parse(run.stdout); } catch { json = undefined; }
  return { code: run.status ?? -1, out: run.stdout, json };
}

const write = (name: string, body: string): void => fs.writeFileSync(path.join(taskDir, `${name}.js`), body);
write("ok", `/**\n * @summary 回显\n * @param word 词\n * @param times? 次数\n */\nconsole.log(JSON.stringify({ status: "success", result: JSON.parse(process.env.YODO_PARAMS ?? "{}") }, null, 2));\n`);
write("draft", `/**\n * @status: draft\n */\nconsole.log(JSON.stringify({ status: "success", result: "d" }));\n`);
write("crash", `process.exit(3);\n`);
// 走 SDK、且没有 holder：握手失败，退出码必须非零
write("blocked", `import { yodo } from ${JSON.stringify(sdk)};\nawait yodo.run(async () => 1);\n`);
fs.mkdirSync(path.join(taskDir, "broken.js")); // 读不了的“文件”（目录）

try {
  // 用法与未知命令：统一的 failure 形状
  for (const args of [[], ["bogus"], ["eval"], ["record"]]) {
    const r = yodo(...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.json.status, "failure");
    assert.match(r.json.error, /用法/);
  }

  // run 列表：摘要正确，读不了的文件标成 invalid 而不是让整份列表失败
  const list = yodo("run");
  assert.equal(list.code, 0);
  const byName = Object.fromEntries((list.json as Array<{ name: string }>).map((t) => [t.name, t])) as Record<string, any>;
  assert.equal(byName.ok.summary, "回显");
  assert.equal(byName.draft.status, "draft");
  assert.equal(byName.broken.status, "invalid");

  // run：成功原样输出并写历史；缺失与崩溃都是带 status 的 failure
  const ok = yodo("run", "ok", "--word", "a");
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json, { status: "success", result: { word: "a" } });
  assert.deepEqual(yodo("run", "ok", "--word=b c", "--times", "2").json, { status: "success", result: { word: "b c", times: "2" } }, "--名字=值 与 --名字 值 都可以，值里可以有空格");
  for (const [args, pattern] of [
    [["run", "ok", "a"], /参数要写成 --名字 值/],
    [["run", "ok"], /缺少必填参数：--word/],
    [["run", "ok", "--word", "a", "--nope", "1"], /没有这些参数：--nope/],
    [["run", "ok", "--word"], /缺少值/],
    [["run", "ok", "--word", "a", "--word", "b"], /参数重复/],
  ] as Array<[string[], RegExp]>) {
    const bad = yodo(...args);
    assert.equal(bad.code, 1, args.join(" "));
    assert.equal(bad.json.status, "failure");
    assert.match(bad.json.error, pattern);
  }
  assert.equal(fs.readdirSync(path.join(home, ".yodo", "run", "ok")).length, 2, "只有真正运行过的调用写历史，参数校验失败的不写");
  const missing = yodo("run", "nope");
  assert.equal(missing.code, 1);
  assert.match(missing.json.error, /task 不存在/);
  const crash = yodo("run", "crash");
  assert.equal(crash.code, 3);
  assert.equal(crash.json.status, "failure");

  // 握手失败：run 与 record 一样输出 need-* 且退出码非零
  const blocked = yodo("run", "blocked");
  assert.equal(blocked.code, 1, "task 内的握手失败也应非零退出");
  assert.equal(blocked.json.status, "need-install");
  const started = Date.now();
  const record = yodo("record", "start");
  assert.equal(record.code, 1);
  assert.equal(record.json.status, "need-install");
  assert.ok(Date.now() - started < 3_000, "没装 host 时应立即返回");

  // eval：组合成功；草稿被拒绝
  const evalOk = yodo("eval", `return await task("ok", { word: "x" });`);
  assert.deepEqual(evalOk.json, { status: "success", result: { word: "x" } });
  const evalDraft = yodo("eval", `return await task("draft");`);
  assert.equal(evalDraft.code, 1);
  assert.equal(evalDraft.json.failedTask, "draft");

  // doctor --json：可解析，带 ok 与 checks
  const doctor = yodo("doctor", "--json");
  assert.equal(typeof doctor.json.ok, "boolean");
  assert.ok(doctor.json.checks.some((c: { name: string }) => c.name === "node"));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("cli yodo selfcheck ok");
