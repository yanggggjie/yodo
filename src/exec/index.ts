/**
 * yodo run：在已有 Browser / BrowserContext 上跑任务脚本；不断开 CDP。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import type { CdpBrowser, CdpContext, CdpPage } from "../browser/index.js";
import { timeoutReject } from "../utils/async.js";
import { CDP_COMMAND_TIMEOUT_MS, HARD_PROBE_MS } from "../utils/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("exec");
const MAX_STDOUT_BYTES = 8 * 1024;

type TaskScript = (api: {
  browser: CdpBrowser;
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
        `export default async ({ browser, browserContext }) => { … }`,
    );
  }
  return script;
}

async function pagesSnapshot(
  ctx: CdpContext,
  before: Set<string>,
): Promise<string[]> {
  const rows: string[] = [];
  const live: { url: string; page: CdpPage }[] = [];
  for (const p of ctx.pages()) {
    if (p.isClosed()) continue;
    let url = "";
    try {
      url = p.url();
    } catch {
      continue;
    }
    if (!url || url === "about:blank") continue;
    if (before.has(url)) continue;
    live.push({ url, page: p });
  }

  if (live.length === 0) {
    return ["  （run 期间没有新开/导航的 page；失败发生在已有 tab 上，见 stack）"];
  }

  for (const { url, page } of live) {
    let title = "";
    try {
      title = await Promise.race([
        page.title(),
        new Promise<string>((r) => setTimeout(() => r(""), 500)),
      ]);
    } catch {
      title = "";
    }
    rows.push(title ? `  ${url}\t(${title})` : `  ${url}`);
  }
  return rows;
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
  script: string;
  scriptAbs: string;
  durationMs: number;
  result: unknown;
  logs: string[];
}): string {
  const resultStr = JSON.stringify(opts.result);
  const resultBytes = resultStr ? Buffer.byteLength(resultStr) : 0;

  if (resultBytes > MAX_STDOUT_BYTES) {
    const outputDir = path.dirname(opts.scriptAbs);
    const outputFile = path.join(outputDir, "output.json");
    try {
      fs.writeFileSync(outputFile, resultStr, "utf8");
      return JSON.stringify(
        {
          status: "success",
          script: opts.script,
          durationMs: opts.durationMs,
          resultFile: outputFile,
          resultBytes,
          ...(opts.logs.length ? { logs: opts.logs } : {}),
        },
        null,
        2,
      );
    } catch {
      const fallbackFile = path.join(
        os.tmpdir(),
        `yodo-output-${Date.now()}.json`,
      );
      fs.writeFileSync(fallbackFile, resultStr, "utf8");
      return JSON.stringify(
        {
          status: "success",
          script: opts.script,
          durationMs: opts.durationMs,
          resultFile: fallbackFile,
          resultBytes,
          ...(opts.logs.length ? { logs: opts.logs } : {}),
        },
        null,
        2,
      );
    }
  }

  return JSON.stringify(
    {
      status: "success",
      script: opts.script,
      durationMs: opts.durationMs,
      result: opts.result,
      ...(opts.logs.length ? { logs: opts.logs } : {}),
    },
    null,
    2,
  );
}

function runFailureJson(opts: {
  script: string;
  durationMs: number;
  err: unknown;
  scriptAbs: string;
  logs: string[];
  pages: string[];
}): string {
  const stack =
    opts.err instanceof Error
      ? formatStack(opts.err, opts.scriptAbs)
      : [String(opts.err)];
  const name = opts.err instanceof Error ? opts.err.name : "Error";
  const message =
    opts.err instanceof Error ? opts.err.message : String(opts.err);
  return JSON.stringify(
    {
      status: "failure",
      script: opts.script,
      durationMs: opts.durationMs,
      error: { name, message, stack },
      ...(opts.pages.length ? { pages: opts.pages } : {}),
      ...(opts.logs.length ? { logs: opts.logs } : {}),
      hint: "禁止使用 DOM 操作替代；若页内 XHR/fetch 5 次试跑均无法获取有效签名，请立即向用户报告「无法重放」。",
    },
    null,
    2,
  );
}

export async function runTask(
  browser: CdpBrowser,
  browserContext: CdpContext,
  filename: string,
  argsText?: string,
  timeoutMs = CDP_COMMAND_TIMEOUT_MS,
): Promise<string> {
  const abs = path.resolve(filename);
  logger.info(`load ${abs}`);
  const args = parseRunArgs(argsText);
  const script = await loadTaskScript(abs);

  const name = path.basename(abs);
  const started = Date.now();
  const logs: string[] = [];

  const before = new Set<string>();
  const restore = captureConsole(logs);
  const raw = browser.raw;
  const prevTimeout = raw?.commandTimeoutMs;
  if (raw) raw.commandTimeoutMs = timeoutMs;
  try {
    for (const p of browserContext.pages()) {
      if (p.isClosed()) continue;
      try {
        before.add(p.url());
      } catch {
        /* ignore */
      }
    }
    const value = await timeoutReject(
      Promise.resolve(
        script({
          browser,
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
      script: name,
      scriptAbs: abs,
      durationMs,
      result: value,
      logs,
    });
  } catch (err) {
    logger.warn(`task failed: ${name}`, err);
    const pages = await pagesSnapshot(browserContext, before).catch(() => []);
    return runFailureJson({
      script: name,
      durationMs: Date.now() - started,
      err,
      scriptAbs: abs,
      logs,
      pages,
    });
  } finally {
    restore();
    if (raw) raw.commandTimeoutMs = HARD_PROBE_MS;
    await browserContext.detachAllPages().catch((err) => {
      logger.warn("detachAllPages", err);
    });
    if (raw && prevTimeout !== undefined) raw.commandTimeoutMs = prevTimeout;
  }
}
