/**
 * yodo 唯一命令入口：run / eval / record / doctor。
 * 由 ~/.yodo/bin/yodo shim 调用：node ~/.yodo/src/cli/yodo.ts "$@"
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSessionAndRpc } from "./spawn.ts";
import { handleDoctor } from "./doctor.ts";
import { runEval } from "./compose.ts";
import { invokeTaskFile, taskFile, taskSummary } from "./tasks.ts";
import { writeRunHistory } from "../run-history.ts";
import { TASK_DIR, CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "../utils/constants.ts";

function assertNode24(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) throw new Error(`yodo 需要 Node >=24，当前 ${process.version}`);
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function listTasks(): void {
  if (!fs.existsSync(TASK_DIR)) { print([]); return; }
  const files = fs.readdirSync(TASK_DIR).filter((f) => f.endsWith(".js")).sort();
  print(files.map((f) => taskSummary(path.join(TASK_DIR, f))));
}

/** yodo run <task> [args...]：子进程运行 task，stdout 原样输出，stderr 透传，退出码透传，并写运行历史。 */
function runTask(name: string, args: string[]): void {
  const file = taskFile(TASK_DIR, name);
  if (!fs.existsSync(file)) { print({ error: `task 不存在：${name}` }); process.exitCode = 1; return; }
  const run = invokeTaskFile(file, args);
  process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  writeRunHistory(name, {
    args,
    output: run.output ?? { status: "failure", error: `无法解析输出（退出码 ${run.exitCode}）` },
  });
  process.exitCode = run.exitCode;
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
    else { print({ error: value.message ?? String(error) }); process.exitCode = 1; }
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
  print({ error: "用法：yodo run [task] [args] | yodo eval '<代码>' | yodo record start|stop|abort | yodo doctor [--json]" });
  process.exitCode = 1;
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    print({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
