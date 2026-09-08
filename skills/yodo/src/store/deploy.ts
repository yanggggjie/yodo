import * as fs from "node:fs";
import * as path from "node:path";

/** 安全移除路径：symlink 只删链接（不顺链删 target）；真目录 rm -rf；不存在跳过。 */
export function safeRemove(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

function isUnderNodeModules(srcAbs: string, src: string): boolean {
  const rel = path.relative(srcAbs, src);
  if (!rel || rel.startsWith("..")) return false;
  return rel.split(path.sep).includes("node_modules");
}

/** 把 srcAbs 整目录拷到 destAbs。不拷 `node_modules/`。先清空 dest。 */
export function copyRuntime(srcAbs: string, destAbs: string): void {
  safeRemove(destAbs);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(srcAbs, destAbs, {
    recursive: true,
    filter: (src) => !isUnderNodeModules(srcAbs, src),
  });
}
