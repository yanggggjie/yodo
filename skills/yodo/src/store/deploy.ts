import * as fs from "node:fs";
import * as path from "node:path";

/** 安全移除路径：symlink 只删链接（不顺链删 target）；真目录 rm -rf；不存在跳过。 */
export function safeRemove(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return; // 不存在
  }
  if (st.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

export type DeployMode = "link" | "copy";

/**
 * 把 runtime 源码目录 srcAbs 暴露到 destAbs。
 * 主路径：symlink（Windows 用 junction，免权限；posix 普通 symlink，type 被忽略）。
 * 失败（EPERM / 网络盘 / 非 NTFS）或 forceCopy：整目录拷贝降级。
 * 幂等：destAbs 已是指向 srcAbs 的 symlink 直接返回。
 */
export function linkOrCopyRuntime(
  srcAbs: string,
  destAbs: string,
  opts: { forceCopy?: boolean } = {},
): DeployMode {
  // 幂等：已正确链接就跳过（forceCopy 时不短路，强制重建为拷贝）
  if (!opts.forceCopy) {
    try {
      const st = fs.lstatSync(destAbs);
      if (
        st.isSymbolicLink() &&
        fs.realpathSync(destAbs) === fs.realpathSync(srcAbs)
      ) {
        return "link";
      }
    } catch {
      /* 不存在，继续 */
    }
  }

  safeRemove(destAbs);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });

  if (!opts.forceCopy) {
    try {
      fs.symlinkSync(srcAbs, destAbs, "junction");
      return "link";
    } catch {
      /* 降级 copy */
    }
  }
  fs.cpSync(srcAbs, destAbs, { recursive: true });
  return "copy";
}
