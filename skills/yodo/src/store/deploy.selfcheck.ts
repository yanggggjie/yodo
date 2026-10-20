import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRuntimePath, mirrorPayload, safeRemove } from "./deploy.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-deploy-"));
try {
  const payload = path.join(tmp, "payload");
  const src = path.join(payload, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(src, "yodo.js"), "// entry\n");
  fs.writeFileSync(path.join(src, "sub", "a.txt"), "hi\n");
  fs.writeFileSync(path.join(src, "node_modules", "pkg", "index.js"), "no\n");
  fs.mkdirSync(path.join(src, "record", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(src, "record", "fixtures", "case.json"), "{}\n");
  fs.writeFileSync(path.join(src, "record", "dom.ts"), "// runtime\n");
  fs.writeFileSync(path.join(src, "record", "dom.selfcheck.ts"), "// test\n");
  fs.writeFileSync(path.join(src, ".DS_Store"), "junk\n");
  fs.mkdirSync(path.join(payload, "scripts", "dev"), { recursive: true });
  fs.writeFileSync(path.join(payload, "scripts", "dev", "replay.mjs"), "// script\n");
  fs.writeFileSync(path.join(payload, "AGENTS.md"), "docs\n");

  // 本机数据目录：镜像不能碰
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "task"), { recursive: true });
  fs.writeFileSync(path.join(home, "task", "mine.js"), "// user task\n");

  mirrorPayload(payload, home);
  assert.equal(fs.readFileSync(path.join(home, "src", "sub", "a.txt"), "utf8"), "hi\n");
  assert.ok(!fs.existsSync(path.join(home, "src", "node_modules")), "不应拷 node_modules");
  assert.ok(!fs.existsSync(path.join(home, "src", ".DS_Store")), "不应拷 .DS_Store");
  assert.ok(fs.existsSync(path.join(home, "src", "record", "dom.ts")), "运行时代码要拷");
  assert.ok(fs.existsSync(path.join(home, "src", "record", "dom.selfcheck.ts")), "自检也要拷：本机源码要能验证修改");
  assert.ok(fs.existsSync(path.join(home, "src", "record", "fixtures", "case.json")), "夹具也要拷");
  assert.ok(fs.existsSync(path.join(home, "scripts", "dev", "replay.mjs")), "scripts 随源码分发");
  assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), "docs\n", "顶层文档拷到 home 根");
  assert.equal(fs.readFileSync(path.join(home, "task", "mine.js"), "utf8"), "// user task\n", "不碰本机数据");
  assert.equal(isRuntimePath(src, path.join(src, "record", "requests.selfcheck.ts")), false, "自检不算运行时（不进版本哈希）");
  assert.equal(isRuntimePath(src, path.join(src, "record", "fixtures", "case.json")), false);
  assert.equal(isRuntimePath(src, path.join(src, "dev", "rpc.ts")), true, "dev/rpc.ts 被 holder 静态 import，算运行时");

  fs.writeFileSync(path.join(src, "sub", "a.txt"), "updated\n");
  fs.writeFileSync(path.join(home, "src", "stale.txt"), "gone\n");
  mirrorPayload(payload, home);
  assert.equal(fs.readFileSync(path.join(home, "src", "sub", "a.txt"), "utf8"), "updated\n");
  assert.ok(!fs.existsSync(path.join(home, "src", "stale.txt")), "顶层目录应先清空再拷");

  const gone = path.join(tmp, "gone");
  safeRemove(gone);
  assert.ok(!fs.existsSync(gone));

  console.log("store deploy selfcheck ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
