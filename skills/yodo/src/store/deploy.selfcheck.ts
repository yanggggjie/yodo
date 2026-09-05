import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linkOrCopyRuntime, safeRemove } from "./deploy.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-deploy-"));
try {
  // 造一个假的「skill src」
  const src = path.join(tmp, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "yodo.js"), "// entry\n");
  fs.writeFileSync(path.join(src, "sub", "a.txt"), "hi\n");

  // 1) safeRemove：symlink 只删链接，不顺链删 target
  const link = path.join(tmp, "alink");
  fs.symlinkSync(src, link, "junction");
  safeRemove(link);
  assert.ok(!fs.existsSync(link), "链接应被删除");
  assert.ok(fs.existsSync(path.join(src, "yodo.js")), "target 不应被顺链删除");

  // 2) link 主路径：dest 是 symlink，能读到 src 内容
  const dest = path.join(tmp, "dest");
  let mode = linkOrCopyRuntime(src, dest);
  assert.equal(mode, "link", "posix 应走 symlink");
  assert.ok(fs.lstatSync(dest).isSymbolicLink(), "dest 应为 symlink");
  assert.equal(fs.readFileSync(path.join(dest, "sub", "a.txt"), "utf8"), "hi\n");

  // 3) 幂等：再调一次仍是 link，不报错
  mode = linkOrCopyRuntime(src, dest);
  assert.equal(mode, "link", "重复调用应幂等");

  // 4) copy 降级：forceCopy 得到真目录（非 symlink），内容完整
  const dest2 = path.join(tmp, "dest2");
  mode = linkOrCopyRuntime(src, dest2, { forceCopy: true });
  assert.equal(mode, "copy", "forceCopy 应走 copy");
  assert.ok(!fs.lstatSync(dest2).isSymbolicLink(), "copy 结果应为真目录");
  assert.equal(fs.readFileSync(path.join(dest2, "sub", "a.txt"), "utf8"), "hi\n");

  // 5) 从 link 切到 copy：dest 原为 symlink，safeRemove 后重建为真目录，src 不受损
  mode = linkOrCopyRuntime(src, dest, { forceCopy: true });
  assert.equal(mode, "copy");
  assert.ok(!fs.lstatSync(dest).isSymbolicLink(), "应替换为真目录");
  assert.ok(fs.existsSync(path.join(src, "yodo.js")), "src 仍完好");

  console.log("store deploy selfcheck ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
