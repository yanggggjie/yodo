import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunTarget } from "./run-input.js";

const dir = mkdtempSync(join(tmpdir(), "yodo-run-sc-"));
const script = join(dir, "t.js");
writeFileSync(script, "export default async () => 1\n");

const argsFile = join(dir, "input.json");
writeFileSync(argsFile, '{"q":"test"}\n');

assert.deepEqual(resolveRunTarget([script]), { filename: script, timeoutSec: 15 });
assert.deepEqual(resolveRunTarget([script, '--args={"a":1}']), {
  filename: script,
  argsText: '{"a":1}',
  timeoutSec: 15,
});
assert.deepEqual(resolveRunTarget([script, `--args-file=${argsFile}`]), {
  filename: script,
  argsText: '{"q":"test"}\n',
  timeoutSec: 15,
});

assert.deepEqual(resolveRunTarget([`--filename=${script}`]), {
  filename: script,
  timeoutSec: 15,
});
assert.deepEqual(resolveRunTarget(["--filename", script, '--args={"a":1}']), {
  filename: script,
  argsText: '{"a":1}',
  timeoutSec: 15,
});
assert.deepEqual(resolveRunTarget(["--filename", script, `--args-file=${argsFile}`]), {
  filename: script,
  argsText: '{"q":"test"}\n',
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
  ["--filename=/nope/nope.js"],
  [`--filename=${script}`, "--args="],
  [`--filename=${script}`, "--args-file="],
  [`--filename=${script}`, '--args={"a":1}', `--args-file=${argsFile}`],
  [`--filename=${script}`, "--secret=abc"],
  [`--filename=${script}`, "--timeout=14"],
  [`--filename=${script}`, "--timeout=61"],
  [`--filename=${script}`, "--timeout=15.5"],
  [`--filename=${script}`, "--timeout=abc"],
  [script, script],
]) {
  assert.throws(() => resolveRunTarget(bad), `应拒绝：${JSON.stringify(bad)}`);
}

console.log("cli run-input selfcheck ok");
