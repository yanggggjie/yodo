/**
 * `yodo eval '<代码>'`：顺序组合已有 task。
 * 代码写入 session/compose/<时间戳>.mjs，用 Node 执行，结束后删除。
 * 组合里只能通过注入的 task(name, ...args) 调用 task，不访问页面。
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMPOSE_DIR, RUN_DIR, TASK_DIR } from "../utils/constants.ts";
import { isHandshakeStatus, type HandshakeStatus } from "../protocol.ts";
import { writeRunHistory } from "../run-history.ts";
import { invokeTaskFile, taskFile, taskOutput, taskSummary, taskTimeoutMs } from "./tasks.ts";

export interface ComposePaths {
  taskDir: string;
  runDir: string;
  composeDir: string;
  /** 单个内层 task 的超时，默认按各 task 的 @timeout 或 TASK_TIMEOUT_MS；自检里调小。 */
  taskTimeoutMs?: number;
}

const DEFAULT_PATHS: ComposePaths = { taskDir: TASK_DIR, runDir: RUN_DIR, composeDir: COMPOSE_DIR };

/** 内层 task 失败（status 非 success）。 */
export class TaskError extends Error {
  task: string;
  constructor(task: string, message: string) {
    super(message);
    this.name = "TaskError";
    this.task = task;
  }
}

/** 内层 task 报告握手状态（need-install 等），组合整体按握手状态返回。 */
export class HandshakeError extends Error {
  status: HandshakeStatus;
  constructor(status: HandshakeStatus, guide: string) {
    super(guide);
    this.name = "HandshakeError";
    this.status = status;
  }
}

export type TaskFn = (name: string, ...args: unknown[]) => Promise<unknown>;

/** 创建注入给组合代码的 task()：检查存在与草稿，子进程运行，写运行历史，返回 result 或抛错。 */
export function createTask(paths: ComposePaths = DEFAULT_PATHS): TaskFn {
  return async (name, ...args) => {
    const file = taskFile(paths.taskDir, name);
    if (!fs.existsSync(file)) throw new TaskError(name, `task 不存在：${name}`);
    if (taskSummary(file).status === "draft") {
      throw new TaskError(name, `[${name}] 是草稿（@status: draft），组合中不允许调用；请先单独运行并验证为 verified`);
    }

    const argv = args.map((arg) => String(arg));
    const timeoutMs = paths.taskTimeoutMs ?? taskTimeoutMs(file);
    const run = invokeTaskFile(file, argv, timeoutMs);
    if (run.stderr) process.stderr.write(run.stderr);
    const output = taskOutput(run, timeoutMs) as {
      status?: string;
      result?: unknown;
      error?: string;
      guide?: string;
    };
    writeRunHistory(name, { args: argv, output }, paths.runDir);

    if (output.status && isHandshakeStatus(output.status)) {
      throw new HandshakeError(output.status, output.guide ?? "");
    }
    if (output.status !== "success") {
      throw new TaskError(name, `[${name}] ${output.error ?? `退出码 ${run.exitCode}`}`);
    }
    return output.result;
  };
}

function failureOutput(error: unknown): Record<string, unknown> {
  if (error instanceof HandshakeError) return { status: error.status, guide: error.message };
  if (error instanceof TaskError) return { status: "failure", error: error.message, failedTask: error.task };
  if (error instanceof Error) return { status: "failure", error: `${error.name}: ${error.message}` };
  return { status: "failure", error: String(error) };
}

/**
 * 组合脚本入口，由生成的 .mjs 调用。
 * 组合代码的 console 输出走 stderr，stdout 只输出一段 JSON。
 */
export async function runCompose(
  code: string,
  body: (task: TaskFn) => Promise<unknown>,
  paths: ComposePaths = DEFAULT_PATHS,
): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;

  let output: Record<string, unknown>;
  try {
    output = { status: "success", result: await body(createTask(paths)) };
  } catch (error) {
    output = failureOutput(error);
    process.exitCode = 1;
  }
  writeRunHistory("compose", { code, output }, paths.runDir);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

/** 生成组合脚本。用户代码放在函数体里，错误路径与 task 注入都由 runCompose 处理。 */
export function composeSource(code: string, paths: ComposePaths = DEFAULT_PATHS): string {
  return [
    `import { runCompose } from ${JSON.stringify(import.meta.url)};`,
    `await runCompose(${JSON.stringify(code)}, async (task) => {`,
    code,
    `}, ${JSON.stringify(paths)});`,
    "",
  ].join("\n");
}

/** 运行一次组合。返回子进程退出码与捕获的 stdout、stderr。 */
export function runEval(code: string, paths: ComposePaths = DEFAULT_PATHS): { exitCode: number; stdout: string; stderr: string } {
  fs.mkdirSync(paths.composeDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(paths.composeDir, `${stamp}-${process.pid}.mjs`);
  fs.writeFileSync(file, composeSource(code, paths), "utf8");
  try {
    const child = child_process.spawnSync(process.execPath, [file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
    });
    return { exitCode: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
