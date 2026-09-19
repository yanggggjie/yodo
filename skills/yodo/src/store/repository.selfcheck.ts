import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claimActive,
  createRecordName,
  normalizeRecordLabel,
  releaseActive,
  sweepDeadActive,
  validateRecordName,
} from "./repository.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-record-"));
assert.equal(validateRecordName("demo"), "demo");
assert.throws(() => validateRecordName("bad name"));
assert.equal(normalizeRecordLabel("  xhs favorite  "), "xhs-favorite");
assert.equal(normalizeRecordLabel("小红书"), "rec");
const generated = createRecordName("xhs favorite", "a7f3c1");
assert.equal(generated, "xhs-favorite-a7f3c1");

const name = await claimActive("sample", root);
assert.equal(name, "sample");
assert.ok(fs.existsSync(path.join(root, ".active", "sample", "pid")));
await assert.rejects(() => claimActive("other", root));

await releaseActive("sample", root);
assert.ok(!fs.existsSync(path.join(root, ".active", "sample")));

const dead = path.join(root, ".active", "dead");
fs.mkdirSync(dead, { recursive: true });
fs.writeFileSync(path.join(dead, "pid"), "99999999\n");
await sweepDeadActive(root);
assert.ok(!fs.existsSync(dead));

fs.rmSync(root, { recursive: true, force: true });
console.log("repository selfcheck ok");
