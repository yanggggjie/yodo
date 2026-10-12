import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeRunHistory } from "./run-history.ts";

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-run-history-"));
try {
  // 紧跟着写，多条会落在同一毫秒，覆盖 `_N` 后缀的情况。
  for (let i = 1; i <= 21; i++) writeRunHistory("demo", { i }, runDir, 20);

  const dir = path.join(runDir, "demo");
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 20, "超过 20 份时应删除最旧的");

  const newest = JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)!), "utf8")) as { i: number };
  assert.equal(newest.i, 21, "最后一份应是最新一次运行");
  const oldest = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")) as { i: number };
  assert.equal(oldest.i, 2, "保留的最旧一份应是第 2 次运行");
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("run history selfcheck ok");
