import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 从 task 文件头读取 @summary、@status 与 @param 行，不执行脚本。 */
export function taskSummary(file: string): { name: string; status: string; summary: string; params: string[] } {
  const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 40);
  const field = (tag: string): string => head.find((line) => line.includes(`@${tag}`))?.split(`@${tag}`)[1]?.replace(/^:/, "").trim() ?? "";
  return {
    name: path.basename(file, ".js"),
    status: field("status") || "verified",
    summary: field("summary"),
    params: head.filter((line) => line.includes("@param")).map((line) => line.split("@param")[1]!.trim()),
  };
}

export function taskFile(taskDir: string, name: string): string {
  return path.join(taskDir, `${name}.js`);
}

/**
 * 取 stdout 中最后一段完整 JSON。task 的 result 是多行 JSON，前面允许有其它输出。
 * 找不到时返回 undefined。
 */
export function parseLastJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { /* 继续按行首 { 回溯 */ }
  const starts = [...trimmed.matchAll(/^\{/gm)].map((m) => m.index ?? 0).reverse();
  for (const start of starts) {
    try { return JSON.parse(trimmed.slice(start)); } catch { /* 下一个候选 */ }
  }
  return undefined;
}

export interface TaskInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout 中解析出的 JSON；无法解析时为 undefined。 */
  output: unknown;
}

/** 子进程运行 task 文件，捕获 stdout 与 stderr；stdin 关闭。 */
export function invokeTaskFile(file: string, args: string[]): TaskInvocation {
  const child = child_process.spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  const stdout = child.stdout ?? "";
  return { exitCode: child.status ?? 1, stdout, stderr: child.stderr ?? "", output: parseLastJson(stdout) };
}
