import * as child_process from "node:child_process";

/** 在系统文件管理器中打开并选中路径。失败时静默返回 false，由调用方输出路径作为备用。 */
export function revealPath(target: string): boolean {
  const [cmd, args] = process.platform === "darwin"
    ? ["open", ["-R", target]]
    : process.platform === "win32"
      ? ["explorer", [`/select,${target}`]]
      : ["xdg-open", [target]];
  try {
    child_process.spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}
