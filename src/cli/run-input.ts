/** yodo run 入参解析：位置参数文件，可选 JSON 参数 / 参数文件。 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RUN_TIMEOUT_SEC_MAX, RUN_TIMEOUT_SEC_MIN } from "../utils/constants.js";

export const RUN_USAGE =
  "用法：yodo run <file> [--args='{\"q\":\"…\"}' | --args-file=<path>] [--timeout=<15-60>]";

export type RunTarget = { file: string; argsText?: string; timeoutSec: number };

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return join(process.env.HOME ?? "", value.slice(2));
  return value;
}

export function parseTimeoutSec(raw: string | undefined): number {
  if (raw === undefined) return RUN_TIMEOUT_SEC_MIN;
  const t = raw.trim();
  if (!/^[0-9]+$/.test(t)) {
    throw new Error(
      `--timeout 必须是 ${RUN_TIMEOUT_SEC_MIN}～${RUN_TIMEOUT_SEC_MAX} 的整数秒；${RUN_USAGE}`,
    );
  }
  const n = Number(t);
  if (n < RUN_TIMEOUT_SEC_MIN || n > RUN_TIMEOUT_SEC_MAX) {
    throw new Error(
      `--timeout 必须是 ${RUN_TIMEOUT_SEC_MIN}～${RUN_TIMEOUT_SEC_MAX} 的整数秒；${RUN_USAGE}`,
    );
  }
  return n;
}

export function resolveRunTarget(args: string[]): RunTarget {
  let values: {
    args?: string;
    "args-file"?: string;
    timeout?: string;
  };
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args,
      options: {
        args: { type: "string" },
        "args-file": { type: "string" },
        timeout: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${msg}；${RUN_USAGE}`);
  }

  if (positionals.length > 1) {
    throw new Error(`run 最多接受一个目标文件位置参数；${RUN_USAGE}`);
  }

  const rawFile = positionals[0];
  if (!rawFile || !rawFile.trim()) {
    throw new Error(`缺少目标文件；${RUN_USAGE}`);
  }

  const file = resolve(expandHome(rawFile.trim()));
  if (!existsSync(file)) {
    throw new Error(`找不到脚本：${file}`);
  }

  const argsText = values.args;
  const argsFile = values["args-file"];
  const timeoutSec = parseTimeoutSec(values.timeout);

  if (argsText !== undefined && argsFile !== undefined) {
    throw new Error(`不能同时指定 --args 和 --args-file；${RUN_USAGE}`);
  }

  if (argsText !== undefined) {
    if (!argsText.trim()) {
      throw new Error(`--args 是空的；${RUN_USAGE}`);
    }
    return { file, argsText, timeoutSec };
  }

  if (argsFile !== undefined) {
    if (!argsFile.trim()) {
      throw new Error(`--args-file 不能为空；${RUN_USAGE}`);
    }
    const resolvedArgsFile = resolve(expandHome(argsFile.trim()));
    if (!existsSync(resolvedArgsFile)) {
      throw new Error(`找不到参数文件：${resolvedArgsFile}`);
    }
    const content = readFileSync(resolvedArgsFile, "utf8");
    if (!content.trim()) {
      throw new Error(`参数文件为空：${resolvedArgsFile}`);
    }
    return { file, argsText: content, timeoutSec };
  }

  return { file, timeoutSec };
}
