import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunTarget } from "./run-input.ts";

const dir = mkdtempSync(join(tmpdir(), "yodo-run-sc-"));
const script = join(dir, "t.js");
writeFileSync(script, "export default async () => 1\n");

const argsFile = join(dir, "input.json");
writeFileSync(argsFile, `${JSON.stringify({ q: "test" })}\n`);

assert.deepEqual(resolveRunTarget([script]), { file: script, timeoutSec: 15 });
assert.deepEqual(resolveRunTarget([script, "--args={\"a\":1}"]), {
  file: script,
  argsText: '{"a":1}',
  timeoutSec: 15,
});
assert.deepEqual(resolveRunTarget([script, `--args-file=${argsFile}`]), {
  file: script,
  argsText: `${JSON.stringify({ q: "test" })}\n`,
  timeoutSec: 15,
});
assert.equal(resolveRunTarget([script, "--timeout=60"]).timeoutSec, 60);
assert.equal(resolveRunTarget([script, "--timeout", "15"]).timeoutSec, 15);

for (const bad of [
  [],
  ["--code=x"],
  ["--js=x"],
  ["--args-file=/nope/nonexistent.json"],
  ["/nope/nonexistent.js"],
  [`--filename=${script}`],
  [script, "--args="],
  [script, "--args-file="],
  [script, "--args={\"a\":1}", `--args-file=${argsFile}`],
  [script, "--secret=abc"],
  [script, "--timeout=14"],
  [script, "--timeout=61"],
  [script, "--timeout=15.5"],
  [script, "--timeout=abc"],
  [script, "--goal=x"],
  [script, script],
]) {
  assert.throws(() => resolveRunTarget(bad), `应拒绝：${JSON.stringify(bad)}`);
}

console.log("cli run-input selfcheck ok");
