// 本地安装：导出 git 认的文件，再用 skills add 装成全局 skill。用法：npm run dev:install
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exportPayload } from "./export-payload.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-install-"));
try {
  exportPayload(REPO, tmp);
  execFileSync("npx", ["-y", "skills", "add", tmp, "-s", "yodo", "--copy", "-g", "-a", "*", "-y"], { stdio: "inherit" });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
