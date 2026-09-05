import { parseArgs } from "node:util";
import { CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "../utils/constants.ts";
import {
  formatErrorStdout,
  formatHandshakeStdout,
  isHandshakeStatus,
  type SessionResponse,
} from "../protocol.ts";
import { formatIdleStdout } from "../record/write.ts";
import { resolveRunTarget, RUN_USAGE } from "./run-input.ts";
import { handleInit } from "./init.ts";
import { handleDoctor } from "./doctor.ts";
import { ensureSessionAndRpc, rpcExistingSession } from "./spawn.ts";

const HELP = `yodo

命令：
  node ~/.yodo/src/yodo.js init
  node ~/.yodo/src/yodo.js doctor
  node ~/.yodo/src/yodo.js record start [name]
  node ~/.yodo/src/yodo.js record stop
  node ~/.yodo/src/yodo.js record abort
  node ~/.yodo/src/yodo.js run <file> [--args='<json>' | --args-file=<file>] [--timeout=<15-60>]
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
      if (rest.length > 0) {
        throw new Error(`init 不接受参数：${rest[0]}`);
      }
      await handleInit();
      return;
    }

    if (command === "doctor") {
      if (rest.length > 0) {
        throw new Error(`doctor 不接受参数：${rest[0]}`);
      }
      handleDoctor();
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
