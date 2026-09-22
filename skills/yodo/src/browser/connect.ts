/**
 * 主 Chrome（Stable）CDP connection。永不杀浏览器、永不关 tab。
 * 直接启动或激活 Chrome，只尝试固定 CDP port。
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { sleep } from "../utils/async.ts";
import { HANDSHAKE_GUIDES } from "../protocol.ts";
import { SESSION_CONFIG_FILE } from "../utils/constants.ts";

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
const PORT_WAIT_MS = 2_000;
const PORT_RETRY_MS = 200;
export const DEFAULT_CDP_PORT = 9222;

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

export class NeedCdpPortError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-cdp-port"]);
    this.name = "NeedCdpPortError";
  }
}

export class NeedAllowError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-allow"]);
    this.name = "NeedAllowError";
  }
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

function portLive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function wsFromHttp(port: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    throw new Error("fetch-failed");
  }
  if (response.status === 403) {
    throw new CdpError("permission-blocked", HANDSHAKE_GUIDES["need-allow"]);
  }
  if (!response.ok) throw new Error(`http-${response.status}`);
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error("no-ws");
  return body.webSocketDebuggerUrl;
}

export function parseCdpPort(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function parseCdpPortConfig(content: string): number | null {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  const match = /^YODO_CDP_PORT=(\d+)$/.exec(lines[0] ?? "");
  return parseCdpPort(match?.[1]);
}

export function configuredCdpPort(
  envValue = process.env["YODO_CDP_PORT"],
  configFile = SESSION_CONFIG_FILE,
): number {
  const fromEnv = parseCdpPort(envValue);
  if (fromEnv !== null) return fromEnv;
  try {
    return parseCdpPortConfig(fs.readFileSync(configFile, "utf8")) ?? DEFAULT_CDP_PORT;
  } catch {
    return DEFAULT_CDP_PORT;
  }
}

async function tryWs(port: number): Promise<string | undefined> {
  if (!(await portLive(port))) return undefined;
  try {
    return await wsFromHttp(port);
  } catch (error) {
    if (error instanceof CdpError) throw error;
    return undefined;
  }
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

async function waitForWs(port: number): Promise<string | undefined> {
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    const endpoint = await tryWs(port);
    if (endpoint) return endpoint;
    await sleep(PORT_RETRY_MS);
  }
  return undefined;
}

/** 启动或激活 Chrome 后连接配置的 CDP port；失败时向用户询问实际 port。 */
export async function resolveWsEndpoint(): Promise<string> {
  if (!chromeInstalled()) throw new NeedInstallError();

  try {
    openChromeApp();
  } catch (error) {
    if (error instanceof NeedInstallError) throw error;
    throw new NeedChromeError();
  }

  await sleep(CHROME_LAUNCH_MS);
  try {
    const endpoint = await waitForWs(configuredCdpPort());
    if (endpoint) return endpoint;
  } catch (error) {
    if (error instanceof CdpError && error.code === "permission-blocked") {
      throw new NeedAllowError();
    }
    throw error;
  }

  openRemoteDebuggingPage();
  throw new NeedCdpPortError();
}
