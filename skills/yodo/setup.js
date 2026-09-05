// yodo bootstrap：把本 skill 的 src/（源码 + node_modules + templates）暴露到 ~/.yodo/src，
// 再建数据目录。主路径用 symlink（Windows junction），失败降级为 copy。
// 幂等：已是指向本 src 的链接直接跳过。用户/agent 的脚本在 ~/.yodo/{task,tmp}，本脚本永不碰。
// 用法：node <此 skill 目录>/setup.js
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linkOrCopyRuntime } from "./src/store/deploy.ts";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(`yodo 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");
const DEST = path.join(os.homedir(), ".yodo", "src");

const mode = linkOrCopyRuntime(SRC, DEST);
console.log(`yodo src ${mode === "link" ? "链接" : "拷贝"} → ${DEST}`);

// 建 ~/.yodo/{task,tmp,record,session} + templates
const init = spawnSync(process.execPath, [path.join(DEST, "yodo.js"), "init"], {
  stdio: "inherit",
});
process.exit(init.status ?? 0);
