import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TASK_TIMEOUT_MS } from "../utils/constants.ts";

export interface TaskSummary {
  name: string;
  status: string;
  summary: string;
  params: string[];
  /** 文件头 `@timeout <秒>` 声明的上限；未声明时不出现。 */
  timeout?: number;
}

/**
 * 读取文件开头的块注释里的 `@标签 值` 行（支持 `@status: draft` 与 `@status draft`）。
 * 只看第一个块注释：代码里恰好出现 `@status` 之类的文字不会被误读；没有块注释时返回空。
 */
export function headerTags(text: string): Array<[string, string]> {
  const block = /^\s*(?:#![^\n]*\n\s*)?\/\*\*?([\s\S]*?)\*\//.exec(text);
  if (!block) return [];
  const tags: Array<[string, string]> = [];
  for (const line of block[1]!.split("\n")) {
    const match = /^\s*\*?\s*@([A-Za-z]+):?\s*(.*?)\s*$/.exec(line);
    if (match) tags.push([match[1]!, match[2]!]);
  }
  return tags;
}

/** 从 task 文件头读取 @summary、@status、@timeout 与 @param，不执行脚本。 */
export function taskSummary(file: string): TaskSummary {
  const tags = headerTags(fs.readFileSync(file, "utf8"));
  const first = (tag: string): string => tags.find(([key]) => key === tag)?.[1] ?? "";
  const timeout = Number(first("timeout"));
  return {
    name: path.basename(file, ".js"),
    status: first("status") || "verified",
    summary: first("summary"),
    params: tags.filter(([key]) => key === "param").map(([, value]) => value),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

/** 这个 task 的最长运行时间：文件头声明的 @timeout，否则 TASK_TIMEOUT_MS。 */
export function taskTimeoutMs(file: string): number {
  const declared = taskSummary(file).timeout;
  return declared ? declared * 1000 : TASK_TIMEOUT_MS;
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
  /** 超过 timeoutMs 被终止。 */
  timedOut: boolean;
}

/** 子进程运行 task 文件，捕获 stdout 与 stderr；stdin 关闭；超过 timeoutMs 终止进程。 */
export function invokeTaskFile(file: string, args: string[], timeoutMs = TASK_TIMEOUT_MS): TaskInvocation {
  const child = child_process.spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const stdout = child.stdout ?? "";
  const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { exitCode: child.status ?? 1, stdout, stderr: child.stderr ?? "", output: parseLastJson(stdout), timedOut };
}

/** 一次 task 运行的结果 JSON。超时或输出无法解析时合成 failure，保证总有 status。 */
export function taskOutput(run: TaskInvocation, timeoutMs = TASK_TIMEOUT_MS): { status?: string; [key: string]: unknown } {
  if (run.timedOut) return { status: "failure", error: `task 超过 ${timeoutMs / 1000} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>` };
  return (run.output as { status?: string } | undefined) ?? { status: "failure", error: `无法解析输出（退出码 ${run.exitCode}）` };
}
