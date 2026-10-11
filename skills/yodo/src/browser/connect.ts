/**
 * Chrome 本机状态检测。连接本身由扩展经 native messaging 建立（见 extension.ts），
 * 这里只负责判断"还缺什么"：Chrome 没装、没运行、扩展未连接。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export class NeedExtensionError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-extension"]);
    this.name = "NeedExtensionError";
  }
}

export function chromeAppPath(): string | null {
  if (process.platform === "darwin") {
    const p = "/Applications/Google Chrome.app";
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    for (const p of [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  for (const candidate of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function chromeInstalled(): boolean {
  return chromeAppPath() !== null;
}

/** Chrome 进程是否在运行。Chrome 运行但扩展未连接 → need-extension；未运行 → need-chrome。 */
export function chromeRunning(): boolean {
  if (process.platform === "darwin") {
    return spawnSync("pgrep", ["-x", "Google Chrome"]).status === 0;
  }
  if (process.platform === "win32") {
    return spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe"]).stdout?.toString().includes("chrome.exe") ?? false;
  }
  return spawnSync("pgrep", ["-x", "chrome"]).status === 0 || spawnSync("pgrep", ["-x", "google-chrome"]).status === 0;
}
