import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copyRuntime, safeRemove } from "./deploy.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-deploy-"));
try {
  const src = path.join(tmp, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(src, "yodo.js"), "// entry\n");
  fs.writeFileSync(path.join(src, "sub", "a.txt"), "hi\n");
  fs.writeFileSync(path.join(src, "node_modules", "pkg", "index.js"), "no\n");

  const dest = path.join(tmp, "dest");
  copyRuntime(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, "sub", "a.txt"), "utf8"), "hi\n");
  assert.ok(
    !fs.existsSync(path.join(dest, "node_modules")),
    "不应拷 source 的 node_modules",
  );

  fs.writeFileSync(path.join(src, "sub", "a.txt"), "updated\n");
  fs.writeFileSync(path.join(dest, "stale.txt"), "gone\n");
  copyRuntime(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, "sub", "a.txt"), "utf8"), "updated\n");
  assert.ok(!fs.existsSync(path.join(dest, "stale.txt")), "dest 应先清空再拷");

  const gone = path.join(tmp, "gone");
  safeRemove(gone);
  assert.ok(!fs.existsSync(gone));

  console.log("store deploy selfcheck ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
