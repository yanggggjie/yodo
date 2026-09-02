#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "../utils/constants.js";
import {
  formatErrorStdout,
  formatHandshakeStdout,
  isHandshakeStatus,
  type SessionResponse,
} from "../protocol.js";
import { formatIdleStdout } from "../record/write.js";
import { resolveRunTarget, RUN_USAGE } from "./run-input.js";
import { handleInit } from "./init.js";
import { ensureSessionAndRpc, rpcExistingSession } from "./spawn.js";

const HELP = `yodo

命令：
  yodo init
  yodo record start [name]
  yodo record stop
  yodo record abort
  yodo run <file> [--args='<json>' | --args-file=<file>] [--timeout=<15-60>]
`;

function fail(message: string): never {
  console.log(formatErrorStdout(message));
  process.exit(1);
}

function printResponse(res: SessionResponse): void {
  if (res.ok) {
    console.log(res.text ?? "");
    return;
  }
  if (res.status && isHandshakeStatus(res.status)) {
    console.log(formatHandshakeStdout(res.status, res.guide));
    return;
  }
  fail(res.error ?? "session rpc failed");
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
          file: target.file,
          argsText: target.argsText,
          timeoutMs: target.timeoutSec * 1000,
        },
        target.timeoutSec * 1000 + CLI_RPC_BUFFER_MS,
      );
      printResponse(result);
      return;
    }

    if (command === "record") {
      const [sub, ...recordArgs] = rest;
      if (sub === "start") {
        const parsed = parseArgs({
          args: recordArgs,
          options: {},
          allowPositionals: true,
          strict: true,
        });
        if (parsed.positionals.length > 1) {
          throw new Error("record start 最多接受一个名称");
        }
        const name = parsed.positionals[0];
        const result = await ensureSessionAndRpc(
          {
            op: "record.start",
            ...(name ? { name } : {}),
          },
          15_000,
        );
        printResponse(result);
        return;
      }
      if (sub === "stop" || sub === "abort") {
        if (recordArgs.length > 0) fail(`record ${sub} 不接受参数`);
        const result = await rpcExistingSession(
          { op: sub === "stop" ? "record.stop" : "record.abort" },
          sub === "stop" ? RECORD_STOP_RPC_MS : 15_000,
        );
        if (!result) {
          console.log(formatIdleStdout());
          return;
        }
        printResponse(result);
        return;
      }
      fail(`未知 record 子命令：${sub ?? "(none)"}`);
    }

    fail(`未知命令 "${command}"。用 yodo help 查看用法。`);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    fail(msg === RUN_USAGE ? RUN_USAGE : msg);
  }
}

main();
