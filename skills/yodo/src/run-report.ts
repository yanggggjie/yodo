/**
 * client 侧的 run 结果格式化：console 捕获、success/failure JSON、栈裁剪。
 * 从旧 exec/index.ts 迁来——task 现在在 client 进程跑，这些也搬到 client。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_STDOUT_BYTES = 8 * 1024;

export function captureConsole(sink: string[]): () => void {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const write = (...args: unknown[]): void => {
    sink.push(args.map((a) => (typeof a === "string" ? a : logStringify(a))).join(" "));
  };
  console.log = write;
  console.info = write;
  console.warn = write;
  console.error = write;
  return () => {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  };
}

function logStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export function formatStack(err: unknown, scriptAbs: string): string[] {
  if (!(err instanceof Error)) return [String(err)];
  const head = `${err.name}: ${err.message}`;
  const raw = err.stack ?? "";
  const dir = path.dirname(scriptAbs);
  const dirUrl = pathToFileURL(dir).href;
  const commons = [
    path.join(dir, "_common"),
    path.resolve(dir, "..", "task", "_common"),
  ];
  const needles = [dir, dirUrl, ...commons.flatMap((p) => [p, pathToFileURL(p).href])];
  const all = raw
    .split("\n")
    .slice(1)
    .filter((l) => needles.some((n) => l.includes(n)))
    .map((l) => l.replace(/\?t=[\d.]+/g, "").trimEnd());
  const lines = [head, ...all];
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) lines.push(`caused by: ${cause.name}: ${cause.message}`);
  return lines;
}

export function runSuccessJson(scriptAbs: string, result: unknown): string {
  const resultStr = JSON.stringify(result);
  const resultBytes = resultStr ? Buffer.byteLength(resultStr) : 0;
  if (resultBytes > MAX_STDOUT_BYTES) {
    const outputFile = path.join(path.dirname(scriptAbs), "output.json");
    try {
      fs.writeFileSync(outputFile, resultStr, "utf8");
      return JSON.stringify({ status: "success", resultFile: outputFile }, null, 2);
    } catch {
      const fallback = path.join(os.tmpdir(), `yodo-output-${Date.now()}.json`);
      fs.writeFileSync(fallback, resultStr, "utf8");
      return JSON.stringify({ status: "success", resultFile: fallback }, null, 2);
    }
  }
  return JSON.stringify({ status: "success", result }, null, 2);
}

export function runFailureJson(err: unknown, scriptAbs: string): string {
  const lines = err instanceof Error ? formatStack(err, scriptAbs) : [String(err)];
  return JSON.stringify({ status: "failure", error: lines.join("\n") }, null, 2);
}
