/**
 * yodo 唯一命令入口：run / eval / record / doctor。
 * 由 ~/.yodo/bin/yodo shim 调用：node ~/.yodo/src/cli/yodo.ts "$@"
 *
 * 只有 record 通过 RPC 连 holder；run / eval 在本地起子进程，task 内部才连 holder。
 * 所有命令失败时 stdout 都是 { status: "failure", error }，握手失败是 { status: "need-*", guide }，退出码非零。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSessionAndRpc } from "./session.ts";
import { handleDoctor } from "./doctor.ts";
import { runEval } from "./compose.ts";
import { invokeTaskFile, taskFile, taskOutput, taskSummary, taskTimeoutMs } from "./tasks.ts";
import { writeRunHistory } from "../run-history.ts";
import { formatErrorStdout } from "../protocol.ts";
import { assertNode24 } from "../utils/node.ts";
import { TASK_DIR, CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "../utils/constants.ts";

const USAGE = "用法：yodo run [task] [args] | yodo eval '<代码>' | yodo record start|stop|abort | yodo doctor [--json]";

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function fail(error: string): void {
  console.log(formatErrorStdout(error));
  process.exitCode = 1;
}

function listTasks(): void {
  if (!fs.existsSync(TASK_DIR)) { print([]); return; }
  const files = fs.readdirSync(TASK_DIR).filter((f) => f.endsWith(".js")).sort();
  // 单个文件读不了不应让整份列表失败：标成 invalid 并带上原因
  print(files.map((f) => {
    try { return taskSummary(path.join(TASK_DIR, f)); }
    catch (error) { return { name: path.basename(f, ".js"), status: "invalid", summary: "", params: [], error: error instanceof Error ? error.message : String(error) }; }
  }));
}

/**
 * yodo run <task> [args...]：子进程运行 task（最长 TASK_TIMEOUT_MS，task 头部 @timeout 可调整），写运行历史，退出码透传。
 * task 的 JSON 原样输出；超时或输出无法解析时输出合成的 failure。
 */
function runTask(name: string, args: string[]): void {
  const file = taskFile(TASK_DIR, name);
  if (!fs.existsSync(file)) return fail(`task 不存在：${name}`);
  const timeoutMs = taskTimeoutMs(file);
  const run = invokeTaskFile(file, args, timeoutMs);
  const output = taskOutput(run, timeoutMs);
  if (run.stderr) process.stderr.write(run.stderr);
  const synthesized = run.timedOut || run.output === undefined;
  if (synthesized) print(output);
  else process.stdout.write(run.stdout);
  writeRunHistory(name, { args, output });
  process.exitCode = synthesized ? run.exitCode || 1 : run.exitCode;
}

/** yodo eval '<代码>'：顺序组合 task，代码里用 task(name, ...args) 调用。 */
function evalCompose(code: string): void {
  const run = runEval(code);
  process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exitCode = run.exitCode;
}

async function recordCall(method: "record.start" | "record.stop" | "record.abort", params: Record<string, unknown> | undefined, timeout: number): Promise<void> {
  try { print(await ensureSessionAndRpc(method, params, timeout)); }
  catch (error) {
    const value = error as { data?: { status?: string }; message?: string };
    if (value.data?.status) { print({ status: value.data.status, guide: value.message ?? "" }); process.exitCode = 1; }
    else fail(value.message ?? String(error));
  }
}

async function main(argv: string[]): Promise<void> {
  assertNode24();
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case "run":
      if (!sub) return listTasks();
      return runTask(sub, rest);
    case "eval":
      if (sub) return evalCompose(sub);
      break;
    case "record":
      if (sub === "start") return recordCall("record.start", rest[0] ? { name: rest[0] } : undefined, 15_000);
      if (sub === "stop") return recordCall("record.stop", undefined, RECORD_STOP_RPC_MS + CLI_RPC_BUFFER_MS);
      if (sub === "abort") return recordCall("record.abort", undefined, 15_000);
      break;
    case "doctor":
      return handleDoctor(argv.includes("--json"));
  }
  fail(USAGE);
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
