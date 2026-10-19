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
 * 只用于版本哈希：整个 skill 目录都会镜像到本机，但改自检、夹具不该触发重启 daemon。
 */
export function isRuntimePath(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..")) return true;
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules") || parts.includes("fixtures")) return false;
  return !/\.selfcheck\./.test(parts[parts.length - 1]!);
}

/** 镜像时跳过的路径：依赖在本机安装，.DS_Store 是系统杂物。 */
export function isMirrorPath(root: string, p: string): boolean {
  const parts = path.relative(root, p).split(path.sep);
  return !parts.includes("node_modules") && parts[parts.length - 1] !== ".DS_Store";
}

/**
 * 把 skill 的整个目录镜像到 homeAbs（~/.yodo）：顶层文件直接覆盖，顶层目录（src、scripts）先清空再拷。
 * 只动 payload 里有的名字，不碰 task、record、run、session、bin 这些本机数据。
 */
export function mirrorPayload(payloadAbs: string, homeAbs: string): void {
  fs.mkdirSync(homeAbs, { recursive: true });
  for (const entry of fs.readdirSync(payloadAbs, { withFileTypes: true })) {
    const from = path.join(payloadAbs, entry.name);
    const to = path.join(homeAbs, entry.name);
    if (!isMirrorPath(payloadAbs, from)) continue;
    if (entry.isDirectory()) {
      safeRemove(to);
      fs.cpSync(from, to, { recursive: true, filter: (p) => isMirrorPath(payloadAbs, p) });
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}
