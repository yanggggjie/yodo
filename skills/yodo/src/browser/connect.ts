/**
 * 主 Chrome（Stable）CDP 发现。永不杀浏览器、永不关 tab。
 * 连不上按层立刻失败，等人回「好了」再重试；不要轮询弹窗。
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { sleep } from "../utils/async.ts";
import { HANDSHAKE_GUIDES, type HandshakeStatus } from "../protocol.ts";

export type CdpErrorCode =
  | "chrome-not-running"
  | "cdp-toggle-off"
  | "cdp-port-missing"
  | "permission-blocked";

export class CdpError extends Error {
  readonly code: CdpErrorCode;
  constructor(code: CdpErrorCode, message: string) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}

/** 内部：拉起 Chrome vs 连已有进程。等人的 `need-*` 不在这里。 */
export type LaunchPlan = "launch" | "connect";

const TOGGLE_PAGE_URL = "chrome://inspect/#remote-debugging";
const CHROME_LAUNCH_MS = 1_500;
const PORT_WAIT_MS = 2_000;

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

export class NeedAllowError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-allow"]);
    this.name = "NeedAllowError";
  }
}

/** running 优先：已在跑就连。未安装返回 null，调用方抛 NeedInstallError。 */
export function resolveLaunchPlan(
  installed: boolean,
  running: boolean,
): LaunchPlan | null {
  if (running) return "connect";
  if (!installed) return null;
  return "launch";
}

function handshakeError(kind: HandshakeStatus): Error {
  if (kind === "need-install") return new NeedInstallError();
  if (kind === "need-chrome") return new NeedChromeError();
  if (kind === "need-remote-debugging") return new NeedRemoteDebuggingError();
  return new NeedAllowError();
}

function toHandshakeError(error: unknown): Error {
  if (error instanceof NeedInstallError) return error;
  if (error instanceof NeedChromeError) return error;
  if (error instanceof NeedRemoteDebuggingError) return error;
  if (error instanceof NeedAllowError) return error;
  if (error instanceof CdpError) {
    if (error.code === "chrome-not-running") return handshakeError("need-chrome");
    if (error.code === "cdp-toggle-off" || error.code === "cdp-port-missing") {
      return handshakeError("need-remote-debugging");
    }
    if (error.code === "permission-blocked") return handshakeError("need-allow");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function shouldOpenRemoteDebuggingPage(error: unknown): boolean {
  return (
    error instanceof NeedRemoteDebuggingError ||
    (error instanceof CdpError &&
      (error.code === "cdp-toggle-off" || error.code === "cdp-port-missing"))
  );
}

function chromeUserDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome",
    );
  }
  if (process.platform === "win32") {
    const local =
      process.env["LOCALAPPDATA"] ??
      path.join(os.homedir(), "AppData", "Local");
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

function portLive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

function chromeRunning(): boolean {
  if (process.platform === "win32") {
    try {
      const out = child_process.execFileSync("tasklist", [], {
        encoding: "utf8",
        timeout: 5_000,
      }).toLowerCase();
      return out.includes("chrome.exe");
    } catch {
      return true;
    }
  }
  const lock = path.join(chromeUserDataDir(), "SingletonLock");
  try {
    const target = fs.readlinkSync(lock);
    const pid = Number(target.split("-").pop());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function remoteDebuggingUserEnabled(): boolean | null {
  const statePath = path.join(chromeUserDataDir(), "Local State");
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      devtools?: { remote_debugging?: { "user-enabled"?: boolean } };
    };
    const v = state.devtools?.remote_debugging?.["user-enabled"];
    if (v === true) return true;
    if (v === false) return false;
  } catch {
    /* ignore */
  }
  return null;
}

function readActivePort(
  base: string,
): { port: number; wsPath: string } | null {
  try {
    const lines = fs
      .readFileSync(path.join(base, "DevToolsActivePort"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const port = Number(lines[0]);
    const wsPath = lines[1] ?? "";
    if (!Number.isFinite(port) || port > 65535 || port <= 0) return null;
    return { port, wsPath };
  } catch {
    return null;
  }
}

async function wsFromHttp(port: number, wsPath: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    throw new Error("fetch-failed");
  }
  if (res.status === 403) {
    throw new CdpError("permission-blocked", HANDSHAKE_GUIDES["need-allow"]);
  }
  if (res.status === 404) {
    if (!wsPath) throw new Error("404-no-path");
    return `ws://127.0.0.1:${port}${wsPath}`;
  }
  if (!res.ok) throw new Error(`http-${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error("no-ws");
  return body.webSocketDebuggerUrl;
}

async function tryWs(): Promise<string | undefined> {
  const base = chromeUserDataDir();
  const active = readActivePort(base);
  if (active && (await portLive(active.port))) {
    try {
      return await wsFromHttp(active.port, active.wsPath);
    } catch (e) {
      if (e instanceof CdpError) throw e;
    }
  }
  for (const probe of [9222, 9223]) {
    if (!(await portLive(probe))) continue;
    try {
      return await wsFromHttp(probe, "");
    } catch (e) {
      if (e instanceof CdpError) throw e;
    }
  }
  return undefined;
}

async function getWsUrl(): Promise<string> {
  if (!chromeRunning()) {
    throw new CdpError("chrome-not-running", HANDSHAKE_GUIDES["need-chrome"]);
  }
  const first = await tryWs();
  if (first) return first;
  if (remoteDebuggingUserEnabled() === true) {
    const deadline = Date.now() + PORT_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(200);
      const url = await tryWs();
      if (url) return url;
    }
  }
  if (remoteDebuggingUserEnabled() === false) {
    throw new CdpError(
      "cdp-toggle-off",
      HANDSHAKE_GUIDES["need-remote-debugging"],
    );
  }
  throw new CdpError(
    "cdp-port-missing",
    HANDSHAKE_GUIDES["need-remote-debugging"],
  );
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
  const exe = chromeAppPath() ?? "google-chrome-stable";
  child_process
    .spawn(exe, url ? [url] : [], { detached: true, stdio: "ignore" })
    .unref();
}

function openChromeApp(): void {
  spawnChrome();
}

function openRemoteDebuggingPage(): void {
  spawnChrome(TOGGLE_PAGE_URL);
}

/** 没开 Chrome 就拉起；按层失败，开关页只在 remote-debugging 层打开。 */
export async function resolveWsEndpoint(): Promise<string> {
  const plan = resolveLaunchPlan(chromeInstalled(), chromeRunning());
  if (plan === null) throw new NeedInstallError();
  if (plan === "launch") {
    openChromeApp();
    await sleep(CHROME_LAUNCH_MS);
    if (!chromeRunning()) throw new NeedChromeError();
  }
  try {
    return await getWsUrl();
  } catch (error) {
    const mapped = toHandshakeError(error);
    if (shouldOpenRemoteDebuggingPage(mapped)) openRemoteDebuggingPage();
    throw mapped;
  }
}
