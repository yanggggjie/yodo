/**
 * yodo 唯一命令入口：run / record / doctor。
 * 由 ~/.yodo/bin/yodo shim 调用：node ~/.yodo/src/cli/yodo.ts "$@"
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSessionAndRpc } from "./spawn.ts";
import { handleDoctor } from "./doctor.ts";
import { TASK_DIR, CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "../utils/constants.ts";

function assertNode24(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) throw new Error(`yodo 需要 Node >=24，当前 ${process.version}`);
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

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

function listTasks(): void {
  if (!fs.existsSync(TASK_DIR)) { print([]); return; }
  const files = fs.readdirSync(TASK_DIR).filter((f) => f.endsWith(".js")).sort();
  print(files.map((f) => taskSummary(path.join(TASK_DIR, f))));
}

/** yodo run <task> [args...]：子进程运行 task，stdout/stderr 原样透传，退出码透传。 */
function runTask(name: string, args: string[]): void {
  const file = path.join(TASK_DIR, `${name}.js`);
  if (!fs.existsSync(file)) { print({ error: `task 不存在：${name}` }); process.exitCode = 1; return; }
  const child = child_process.spawnSync(process.execPath, [file, ...args], { stdio: "inherit" });
  process.exitCode = child.status ?? 1;
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
    case "record":
      if (sub === "start") return recordCall("record.start", rest[0] ? { name: rest[0] } : undefined, 15_000);
      if (sub === "stop") return recordCall("record.stop", undefined, RECORD_STOP_RPC_MS + CLI_RPC_BUFFER_MS);
      if (sub === "abort") return recordCall("record.abort", undefined, 15_000);
      break;
    case "doctor":
      return handleDoctor();
  }
  print({ error: "用法：yodo run [task] [args] | yodo record start|stop|abort | yodo doctor" });
  process.exitCode = 1;
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    print({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
