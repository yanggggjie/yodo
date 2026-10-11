import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ensureHomeLayout 写的是 ~/.yodo，用临时 HOME 的子进程运行，不碰真实目录。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-home-"));
const layout = path.join(path.dirname(fileURLToPath(import.meta.url)), "layout.ts");
const run = spawnSync(process.execPath, ["-e", `import("${layout}").then((m) => m.ensureHomeLayout())`], {
  env: { ...process.env, HOME: home },
  encoding: "utf8",
});
assert.equal(run.status, 0, run.stderr);

for (const name of ["task", "record", "session"]) {
  assert.ok(fs.existsSync(path.join(home, ".yodo", name)), `missing ${name}`);
}
assert.ok(!fs.existsSync(path.join(home, ".yodo", "temp")), "temp 不再创建");
assert.ok(!fs.existsSync(path.join(home, ".yodo", "record", ".active")), "active 不再创建");
assert.ok(fs.existsSync(path.join(home, ".yodo", "task", "lib", "index.js")));

fs.rmSync(home, { recursive: true, force: true });
console.log("layout.selfcheck: ok");
