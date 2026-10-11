/**
 * 注册 native messaging host：写启动脚本与 manifest（macOS / Linux 写目录，Windows 写注册表）。
 * 只写 Google Chrome，不写其它浏览器。doctor 只调用 nativeHostInstalled 做只读检查。
 */
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NATIVE_HOST_NAME = "com.yodo.connect";
/** 由 chrome-extension/manifest.json 的 key 决定；改 key 会改变这个 ID。 */
export const EXTENSION_ID = "apnadjjfmlppoolfkobcbppllognhkcb";

const YODO_HOME = path.join(os.homedir(), ".yodo");
/** setup.js 把 src/ 拷到这里；扩展与 manifest 都指向这个稳定位置。 */
export const DEPLOYED_SRC = path.join(YODO_HOME, "src");
export const EXTENSION_DIR = path.join(DEPLOYED_SRC, "chrome-extension");
export const HOLDER_ENTRY = path.join(DEPLOYED_SRC, "holder.ts");
const WIN_REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

export function launcherPath(): string {
  return path.join(DEPLOYED_SRC, "native-messaging-host", process.platform === "win32" ? "nm-host.bat" : "nm-host.sh");
}

/** manifest 文件位置（Windows 上 manifest 可放任意位置，由注册表指向）。 */
export function manifestPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
  }
  if (process.platform === "win32") {
    return path.join(YODO_HOME, "native-host", `${NATIVE_HOST_NAME}.json`);
  }
  return path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
}

export function nativeHostInstalled(): boolean {
  if (!fs.existsSync(manifestPath())) return false;
  if (process.platform === "win32") {
    return child_process.spawnSync("reg", ["query", WIN_REG_KEY]).status === 0;
  }
  return true;
}

/** 写启动脚本与 manifest。nodePath 写进启动脚本，Chrome 拉起时不依赖 PATH。 */
export function installNativeHost(nodePath: string = process.execPath): string {
  const launcher = launcherPath();
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(launcher, `@echo off\r\n"${nodePath}" "${HOLDER_ENTRY}" %*\r\n`);
  } else {
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${nodePath}" "${HOLDER_ENTRY}" "$@"\n`, { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
  }
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "yodo native messaging host (holder)",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  const file = manifestPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  if (process.platform === "win32") {
    const r = child_process.spawnSync("reg", ["add", WIN_REG_KEY, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
    if (r.status !== 0) throw new Error(`注册表写入失败：${r.stderr?.toString() ?? ""}`);
  }
  return file;
}
