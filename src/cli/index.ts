#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "../utils/constants.js";
import {
  formatHandshakeStdout,
  type SessionResponse,
} from "../protocol.js";
import { resolveRunTarget, RUN_USAGE } from "./run-input.js";
import { handleInit } from "./init.js";
import { ensureSessionAndRpc, rpcExistingSession } from "./spawn.js";

const HELP = `yodo

命令：
  yodo init [--local]
  yodo record start [name] [--goal="..."]
  yodo record stop
  yodo record abort
  yodo run <file> [--args='<json>' | --args-file=<file>] [--timeout=<15-60>]
`;

function error(message: string): never {
  console.log(`error: ${message}`);
  process.exit(1);
}

function printResponse(
  res: SessionResponse,
  phase: "run" | "record",
): void {
  if (res.ok) {
    console.log(res.text ?? "");
    return;
  }
  if (res.status) {
    console.log(formatHandshakeStdout(res.status, res.phase ?? phase, res.guide));
    return;
  }
  error(res.error ?? "session rpc failed");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    argv.length === 0 ||
    ["help", "--help", "-h"].includes(argv[0]!)
  ) {
    console.log(HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const [command, ...rest] = argv;
  const phase: "run" | "record" = command === "record" ? "record" : "run";

  try {
    if (command === "init") {
      const parsed = parseArgs({
        args: rest,
        options: {
          local: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
      });
      if (parsed.positionals.length > 0) {
        throw new Error(`init 不接受位置参数：${parsed.positionals[0]}`);
      }
      await handleInit({ local: Boolean(parsed.values.local) });
      return;
    }

    if (command === "run") {
      const target = resolveRunTarget(rest);
      const result = await ensureSessionAndRpc(
        {
          op: "run",
          filename: target.filename,
          argsText: target.argsText,
          timeoutMs: target.timeoutSec * 1000,
        },
        target.timeoutSec * 1000 + CLI_RPC_BUFFER_MS,
      );
      printResponse(result, "run");
      return;
    }

    if (command === "record") {
      const [sub, ...recordArgs] = rest;
      if (sub === "start") {
        const parsed = parseArgs({
          args: recordArgs,
          options: {
            goal: { type: "string" },
          },
          allowPositionals: true,
          strict: true,
        });
        if (parsed.positionals.length > 1) {
          throw new Error("record start 最多接受一个名称");
        }
        const name = parsed.positionals[0];
        if (parsed.values.goal !== undefined && !parsed.values.goal.trim()) {
          throw new Error("--goal 不能为空");
        }
        const result = await ensureSessionAndRpc(
          {
            op: "record.start",
            ...(name ? { name } : {}),
            goal: parsed.values.goal,
          },
          15_000,
        );
        printResponse(result, "record");
        return;
      }
      if (sub === "stop" || sub === "abort") {
        if (recordArgs.length > 0) error(`record ${sub} 不接受参数`);
        const result = await rpcExistingSession(
          { op: sub === "stop" ? "record.stop" : "record.abort" },
          sub === "stop" ? RECORD_STOP_RPC_MS : 15_000,
        );
        if (!result) {
          console.log("record: idle");
          return;
        }
        printResponse(result, "record");
        return;
      }
      error(`未知 record 子命令：${sub ?? "(none)"}`);
    }

    error(`未知命令 "${command}"。用 yodo help 查看用法。`);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    // listen 之前 holder 崩溃：spawn 已把 mark 收成 Response；这里只处理非 handshake
    error(msg === RUN_USAGE ? RUN_USAGE : msg);
  }
}

main();
