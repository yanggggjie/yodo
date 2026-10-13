/**
 * client 侧的 task run 输出格式化：console 重定向、success/failure JSON、栈裁剪。
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** task 运行期间把 console 输出改走 stderr，stdout 只留最后那段 JSON。返回恢复函数。 */
export function consoleToStderr(): () => void {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error;
  return () => Object.assign(console, original);
}

export function formatStack(err: unknown, scriptAbs: string): string[] {
  if (!(err instanceof Error)) return [String(err)];
  const head = `${err.name}: ${err.message}`;
  const raw = err.stack ?? "";
  const dir = path.dirname(scriptAbs);
  const dirUrl = pathToFileURL(dir).href;
  const libraries = [
    path.join(dir, "lib"),
    path.resolve(dir, "..", "task", "lib"),
  ];
  const needles = [dir, dirUrl, ...libraries.flatMap((p) => [p, pathToFileURL(p).href])];
  const all = raw
    .split("\n")
    .slice(1)
    .filter((l) => needles.some((n) => l.includes(n)))
    .map((l) => l.replace(/\?t=[\d.]+/g, "").trimEnd());
  const lines = [head, ...all];
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) lines.push(`caused by: ${cause.name}: ${cause.message}`);
  return lines;
}

/** stdout 始终输出完整 JSON；大结果由 task 自己裁剪，不再落盘。 */
export function runSuccessJson(result: unknown): string {
  return JSON.stringify({ status: "success", result }, null, 2);
}

export function runFailureJson(err: unknown, scriptAbs: string): string {
  const lines = err instanceof Error ? formatStack(err, scriptAbs) : [String(err)];
  return JSON.stringify({ status: "failure", error: lines.join("\n") }, null, 2);
}
