import * as fs from "node:fs";
import * as path from "node:path";
import { SESSION_LOG_MAX_BYTES } from "./constants.ts";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

let globalLogFile: string | undefined;
let minLevel: LogLevel = (process.env.YODO_LOG_LEVEL as LogLevel) || "INFO";

export function setLogFile(filePath: string | undefined): void {
  globalLogFile = filePath;
  if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function setMinLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** 丢掉最旧的，保住最近约 maxBytes（下一行 JSON 边界）。不要 truncate(0)。 */
export function dropOldestKeepNewest(filePath: string, maxBytes: number): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return;
  }
  if (st.size <= maxBytes) return;
  const start = st.size - maxBytes;
  const buf = Buffer.alloc(st.size - start);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const nl = buf.indexOf(0x0a);
  const body = nl >= 0 ? buf.subarray(nl + 1) : buf;
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, filePath);
}

function extraFields(meta?: unknown): Record<string, unknown> {
  if (meta === undefined) return {};
  if (meta instanceof Error) return { err: meta.stack || meta.message };
  if (typeof meta !== "object" || meta === null) return { err: String(meta) };
  const o = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof o.op === "string") out.op = o.op;
  if (typeof o.id === "string") out.id = o.id;
  if (typeof o.method === "string") out.method = o.method;
  if (typeof o.ms === "number") out.ms = o.ms;
  if (typeof o.err === "string") out.err = o.err;
  else if (o.err instanceof Error) out.err = o.err.stack || o.err.message;
  return out;
}

export class Logger {
  readonly scope: string;
  constructor(scope: string) {
    this.scope = scope;
  }

  debug(message: string, meta?: unknown): void {
    this.log("DEBUG", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.log("INFO", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.log("WARN", message, meta);
  }

  error(message: string, error?: unknown): void {
    this.log("ERROR", message, error);
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

    const rec: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg: message,
      ...extraFields(meta),
    };
    const line = JSON.stringify(rec);

    if (globalLogFile) {
      try {
        fs.appendFileSync(globalLogFile, line + "\n", "utf8");
        dropOldestKeepNewest(globalLogFile, SESSION_LOG_MAX_BYTES);
      } catch {
        /* best effort */
      }
    } else {
      console.error(line);
    }
  }
}

export function createLogger(scope: string): Logger {
  return new Logger(scope);
}
