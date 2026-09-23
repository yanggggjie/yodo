/**
 * 主 Chrome（Stable）CDP connection。永不杀浏览器、永不关 tab。
 * 默认从 DevToolsActivePort 发现当前 browser WebSocket endpoint。
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sleep } from "../utils/async.ts";
import { HANDSHAKE_GUIDES } from "../protocol.ts";

export type CdpErrorCode = "permission-blocked";

export class CdpError extends Error {
  readonly code: CdpErrorCode;
  constructor(code: CdpErrorCode, message: string) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}

const TOGGLE_PAGE_URL = "chrome://inspect/#remote-debugging";
const CHROME_LAUNCH_MS = 1_500;
const ACTIVE_PORT_WAIT_MS = 2_000;
const ACTIVE_PORT_RETRY_MS = 200;

export class NeedInstallError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-install"]);
    this.name = "NeedInstallError";
  }
}

export class NeedChromeError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-chrome"]);
    this.name = "NeedChromeError";
  }
}

export class NeedRemoteDebuggingError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-remote-debugging"]);
    this.name = "NeedRemoteDebuggingError";
  }
}

export class NeedFileAccessError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${HANDSHAKE_GUIDES["need-file-access"]} 文件：${filePath}。系统错误：${detail}`);
    this.name = "NeedFileAccessError";
    this.filePath = filePath;
  }
}

export class NeedAllowError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-allow"]);
    this.name = "NeedAllowError";
  }
}

export function chromeUserDataDir(platform = process.platform): string {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
  }
  if (platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Google", "Chrome", "User Data");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

export function chromeAppPath(): string | null {
  if (process.platform === "darwin") {
    const p = "/Applications/Google Chrome.app";
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === "win32") {
    const local =
      process.env["LOCALAPPDATA"] ??
      path.join(os.homedir(), "AppData", "Local");
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 =
      process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    for (const p of [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  for (const candidate of [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function chromeInstalled(): boolean {
  return chromeAppPath() !== null;
}

export type ActivePort = { port: number; wsPath: string };

export function parseDevToolsActivePort(content: string): ActivePort | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const portText = lines[0] ?? "";
  const wsPath = lines[1] ?? "";
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!wsPath.startsWith("/")) return null;
  return { port, wsPath };
}

export function readDevToolsActivePort(filePath: string): ActivePort | null {
  try {
    return parseDevToolsActivePort(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EACCES" || code === "EPERM") throw new NeedFileAccessError(filePath, error);
    throw error;
  }
}

export async function endpointFromActivePort(active: ActivePort): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${active.port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    return `ws://127.0.0.1:${active.port}${active.wsPath}`;
  }
  if (response.status === 403) throw new NeedAllowError();
  if (response.status === 404 || !response.ok) {
    return `ws://127.0.0.1:${active.port}${active.wsPath}`;
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  return body.webSocketDebuggerUrl || `ws://127.0.0.1:${active.port}${active.wsPath}`;
}

function spawnChrome(url?: string): void {
  if (process.platform === "darwin") {
    const args = url ? ["-a", "Google Chrome", url] : ["-a", "Google Chrome"];
    child_process.spawn("open", args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    const args = url
      ? ["/c", "start", "", "chrome", url]
      : ["/c", "start", "", "chrome"];
    child_process.spawn("cmd", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const executable = chromeAppPath();
  if (!executable) throw new NeedInstallError();
  child_process
    .spawn(executable, url ? [url] : [], { detached: true, stdio: "ignore" })
    .unref();
}

function openChromeApp(): void {
  spawnChrome();
}

function openRemoteDebuggingPage(): void {
  spawnChrome(TOGGLE_PAGE_URL);
}

async function waitForActivePort(filePath: string): Promise<ActivePort | null> {
  const deadline = Date.now() + ACTIVE_PORT_WAIT_MS;
  while (Date.now() < deadline) {
    const active = readDevToolsActivePort(filePath);
    if (active) return active;
    await sleep(ACTIVE_PORT_RETRY_MS);
  }
  return null;
}

/** 启动或激活 Chrome，从 DevToolsActivePort 发现 browser WebSocket endpoint。 */
export async function resolveWsEndpoint(): Promise<string> {
  if (!chromeInstalled()) throw new NeedInstallError();

  try {
    openChromeApp();
  } catch (error) {
    if (error instanceof NeedInstallError) throw error;
    throw new NeedChromeError();
  }

  await sleep(CHROME_LAUNCH_MS);
  const activePortFile = path.join(chromeUserDataDir(), "DevToolsActivePort");
  const active = await waitForActivePort(activePortFile);
  if (!active) {
    openRemoteDebuggingPage();
    throw new NeedRemoteDebuggingError();
  }
  return endpointFromActivePort(active);
}
