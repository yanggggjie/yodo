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

/**
 * 哪些路径算运行时代码：排除 node_modules、自检（*.selfcheck.*）和夹具（fixtures/）。
 * 部署拷贝和版本哈希用同一条规则，不然测试文件的改动会触发不必要的重启。
 */
export function isRuntimePath(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..")) return true;
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules") || parts.includes("fixtures")) return false;
  return !/\.selfcheck\./.test(parts[parts.length - 1]!);
}

/** 把 srcAbs 的运行时代码拷到 destAbs（规则见 isRuntimePath）。先清空 dest。 */
export function copyRuntime(srcAbs: string, destAbs: string): void {
  safeRemove(destAbs);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(srcAbs, destAbs, {
    recursive: true,
    filter: (src) => isRuntimePath(srcAbs, src),
  });
}
