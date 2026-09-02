/**
 * yodo run：在已有 Browser / BrowserContext 上跑脚本；不断开 CDP。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import type { CdpBrowser, CdpContext } from "../browser/index.js";
import { timeoutReject } from "../utils/async.js";
import { CDP_COMMAND_TIMEOUT_MS, CDP_SHORT_TIMEOUT_MS } from "../utils/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("exec");
const MAX_STDOUT_BYTES = 8 * 1024;

type TaskScript = (api: {
  browserContext: CdpContext;
  args?: unknown;
}) => Promise<unknown> | unknown;

function isTaskScript(v: unknown): v is TaskScript {
  return typeof v === "function";
}

export function parseRunArgs(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const peek = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    throw new Error(
      `入参不是合法 JSON：${msg}\n收到：${peek}\n` +
        `例：--args='{"q":"cdp","n":3}' 或 --args-file=input.json`,
    );
  }
}

export function importUrl(abs: string): string {
  const url = pathToFileURL(abs);
  url.search = `?t=${Date.now()}`;
  return url.href;
}

let mtimeHook = false;
function ensureEsmMtimeHook(): void {
  if (mtimeHook) return;
  mtimeHook = true;
  register(new URL("./esm-mtime-hook.js", import.meta.url).href, import.meta.url);
}

export async function loadTaskScript(abs: string): Promise<TaskScript> {
  ensureEsmMtimeHook();
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到脚本：${abs}`);
  }
  if (!/\.(js|mjs)$/i.test(abs)) {
    throw new Error(
      `脚本须是 .js / .mjs（ESM，default export async 函数）：${abs}`,
    );
  }
  const mod = (await import(importUrl(abs))) as { default?: unknown };
  const script = mod.default;
  if (!isTaskScript(script)) {
    throw new Error(
      `脚本须 default export 一个 async 函数：\n` +
        `export default async ({ browserContext, args }) => { … }`,
    );
  }
  return script;
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
  if (cause instanceof Error) {
    lines.push(`caused by: ${cause.name}: ${cause.message}`);
  }
  return lines;
}

function captureConsole(sink: string[]): () => void {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const write = (...args: unknown[]) => {
    sink.push(
      args.map((a) => (typeof a === "string" ? a : logStringify(a))).join(" "),
    );
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

function runSuccessJson(opts: {
  scriptAbs: string;
  result: unknown;
}): string {
  const resultStr = JSON.stringify(opts.result);
  const resultBytes = resultStr ? Buffer.byteLength(resultStr) : 0;

  if (resultBytes > MAX_STDOUT_BYTES) {
    const outputDir = path.dirname(opts.scriptAbs);
    const outputFile = path.join(outputDir, "output.json");
    try {
      fs.writeFileSync(outputFile, resultStr, "utf8");
      return JSON.stringify({ status: "success", resultFile: outputFile }, null, 2);
    } catch {
      const fallbackFile = path.join(
        os.tmpdir(),
        `yodo-output-${Date.now()}.json`,
      );
      fs.writeFileSync(fallbackFile, resultStr, "utf8");
      return JSON.stringify({ status: "success", resultFile: fallbackFile }, null, 2);
    }
  }

  return JSON.stringify({ status: "success", result: opts.result }, null, 2);
}

function runFailureJson(opts: {
  err: unknown;
  scriptAbs: string;
}): string {
  const lines =
    opts.err instanceof Error
      ? formatStack(opts.err, opts.scriptAbs)
      : [String(opts.err)];
  return JSON.stringify({ status: "failure", error: lines.join("\n") }, null, 2);
}

export async function runTask(
  browser: CdpBrowser,
  browserContext: CdpContext,
  file: string,
  argsText?: string,
  timeoutMs = CDP_COMMAND_TIMEOUT_MS,
): Promise<string> {
  const abs = path.resolve(file);
  logger.info(`load ${abs}`);
  const args = parseRunArgs(argsText);
  const script = await loadTaskScript(abs);

  const name = path.basename(abs);
  const started = Date.now();
  const restore = captureConsole([]);
  const raw = browser.raw;
  const prevTimeout = raw?.commandTimeoutMs;
  if (raw) raw.commandTimeoutMs = timeoutMs;
  try {
    const value = await timeoutReject(
      Promise.resolve(
        script({
          browserContext,
          args,
        }),
      ),
      timeoutMs,
      "run",
    );
    const durationMs = Date.now() - started;
    logger.info(`task ok: ${name} ${durationMs}ms`);
    return runSuccessJson({
      scriptAbs: abs,
      result: value,
    });
  } catch (err) {
    logger.warn(`task failed: ${name}`, err);
    return runFailureJson({
      err,
      scriptAbs: abs,
    });
  } finally {
    restore();
    if (raw) raw.commandTimeoutMs = CDP_SHORT_TIMEOUT_MS;
    await browserContext.detachAllPages().catch((err) => {
      logger.warn("detachAllPages", err);
    });
    if (raw && prevTimeout !== undefined) raw.commandTimeoutMs = prevTimeout;
  }
}
