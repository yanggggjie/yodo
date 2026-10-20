// yodo bootstrap：把本 skill 目录整个镜像到 ~/.yodo（src、scripts、文档），再在 ~/.yodo/src 里 npm install，然后建数据目录。
// 用户/agent 的脚本在 .yodo/task，本脚本永不碰。
// 用法：node <此 skill 目录>/setup.js
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mirrorPayload } from "./src/store/deploy.ts";
import { writeVersion } from "./src/store/version.ts";
import { restartDaemon, tryPing } from "./src/cli/session.ts";
import { writeShim, BIN_DIR } from "./src/cli/shim.ts";
import { ensureHomeLayout } from "./src/store/layout.ts";
import { EXTENSION_DIR, installNativeHost, manifestPath } from "./src/native-messaging-host/install.ts";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(`yodo 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = path.join(os.homedir(), ".yodo");
const DEST = path.join(HOME_DIR, "src");
const DEPS_MARKER = path.join("node_modules", "tldts", "dist", "cjs", "index.js");

mirrorPayload(HERE, HOME_DIR);
console.log(`yodo 源码镜像 → ${HOME_DIR}`);

const lock = path.join(DEST, "package-lock.json");
if (!fs.existsSync(lock)) {
  console.error(`缺少 ${lock}，无法安装依赖`);
  process.exit(1);
}

console.log(`yodo 依赖安装 → ${DEST}`);
const install = spawnSync("npm", ["install", "--omit=dev", "--omit=optional"], {
  cwd: DEST,
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
if (install.error) {
  console.error(`无法启动 npm：${install.error.message}`);
}
if (install.status !== 0) {
  console.error("npm install 失败");
  process.exit(install.status ?? 1);
}
if (!fs.existsSync(path.join(DEST, DEPS_MARKER))) {
  console.error(`npm install 后仍缺 ${DEPS_MARKER}`);
  process.exit(1);
}

const version = writeVersion(DEST);
console.log(`yodo 版本 → ${version.build}`);

installNativeHost(process.execPath);
console.log(`native messaging host 已注册 → ${manifestPath()}`);
console.log(`扩展目录 → ${EXTENSION_DIR}`);

ensureHomeLayout();
writeShim(process.execPath);
console.log(`yodo 命令 shim → ${BIN_DIR}`);

// 正在运行的 daemon 还是旧代码：build 不同才请它退出，扩展重连时会拉起新的（代码没变就不动，免得白白断一次扩展链路）。
// 旧 daemon 的 ping 里没有 build，也算不同。忙（run、录制）时换不掉，要提醒到位，
// 否则会一直用着旧 daemon，旧 daemon 的问题看起来像新代码的问题。
const running = await tryPing();
if (running && running.build !== version.build) {
  const restarted = await restartDaemon();
  if (restarted.action === "restarted") console.log("daemon 已更新为新版本");
  else if (restarted.action === "killed") console.log("旧 daemon 已退出，扩展重连时会启动新的");
  else if (restarted.action === "failed") console.log("旧 daemon 已退出，但新 daemon 还没连上；请稍等，或在 chrome://extensions 刷新 yodo");
  else if (restarted.action === "busy") console.log(`\n!!! daemon 正忙（${restarted.mode}），没有换成新代码，现在跑的还是旧版本。\n!!! 等 run 或录制结束后运行：yodo daemon restart\n`);
}

const doctor = spawnSync(process.execPath, [path.join(DEST, "cli", "yodo.ts"), "doctor"], {
  stdio: "inherit",
});
process.exit(doctor.status ?? 0);
