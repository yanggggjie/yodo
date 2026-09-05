import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureHomeLayout } from "./layout.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-home-"));
ensureHomeLayout(home);

for (const name of ["task", "tmp", "record", "session"]) {
  assert.ok(fs.existsSync(path.join(home, name)), `missing ${name}`);
}
assert.ok(fs.existsSync(path.join(home, "record", ".active")));
assert.ok(!fs.existsSync(path.join(home, "handbook")));
assert.ok(!fs.existsSync(path.join(home, "learn")));
assert.ok(fs.existsSync(path.join(home, "task", "_common", "page-for-origin.js")));
assert.ok(fs.existsSync(path.join(home, "task", "_common", "url.js")));
assert.ok(!fs.existsSync(path.join(home, "task", "_common", "effect-after-run.js")));
assert.ok(fs.existsSync(path.join(home, "task", "package.json")));
assert.ok(fs.existsSync(path.join(home, "tmp", "package.json")));

const probe = path.join(home, "tmp", "keep.js");
fs.writeFileSync(probe, "keep");
ensureHomeLayout(home);
assert.equal(fs.readFileSync(probe, "utf8"), "keep");

fs.rmSync(home, { recursive: true, force: true });
console.log("layout.selfcheck: ok");
