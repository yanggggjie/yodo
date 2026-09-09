// yodo bootstrap：把本 skill 的 src/ 拷到 .yodo/src，再 npm install，然后建数据目录。
// 用户/agent 的脚本在 .yodo/{task,tmp}，本脚本永不碰。
// 用法：node <此 skill 目录>/setup.js
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyRuntime } from "./src/store/deploy.ts";
import { stopCurrentHolder } from "./src/cli/spawn.ts";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(`yodo 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");
const DEST = path.join(os.homedir(), ".yodo", "src");
const DEPS_MARKER = path.join("node_modules", "tldts", "dist", "cjs", "index.js");

await stopCurrentHolder();
copyRuntime(SRC, DEST);
console.log(`yodo src 拷贝 → ${DEST}`);

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
});
if (install.status !== 0) {
  console.error("npm install 失败");
  process.exit(install.status ?? 1);
}
if (!fs.existsSync(path.join(DEST, DEPS_MARKER))) {
  console.error(`npm install 后仍缺 ${DEPS_MARKER}`);
  process.exit(1);
}

const init = spawnSync(process.execPath, [path.join(DEST, "bin", "init.js")], {
  stdio: "inherit",
});
process.exit(init.status ?? 0);
