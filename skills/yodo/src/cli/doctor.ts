import * as fs from "node:fs";
import * as path from "node:path";
import {
  RECORD_DIR,
  SESSION_DIR,
  TASK_DIR,
  YODO_HOME,
} from "../utils/constants.ts";
import { isPidAlive, readSessionPid } from "./spawn.ts";
import { chromeRunning } from "../browser/connect.ts";
import { EXTENSION_ID, HOLDER_ENTRY, RELAY_ENTRY, launcherPath, manifestPath, nativeHostInstalled } from "../native-messaging-host/install.ts";

const DEPS_MARKER = path.join("node_modules", "tldts", "dist", "cjs", "index.js");
const SETUP_FIX = "运行 setup.js";

interface Check {
  name: string;
  ok: boolean;
  /** 通过时说明当前状态；失败时说明看到的值。 */
  detail: string;
  /** 失败时的修复命令，文字版与 --json 相同。 */
  fix: string;
  /** 可选项不影响退出码与顶层 ok（如 Chrome 未运行、holder 未连接）。 */
  optional?: boolean;
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** 只读检查：不写任何文件，不改注册表。 */
function collectChecks(): Check[] {
  const checks: Check[] = [];
  const add = (check: Check): void => { checks.push(check); };

  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = Number.isFinite(major) && major >= 24;
  add({ name: "node", ok: nodeOk, detail: process.version, fix: "安装 Node >=24" });
  add({ name: "platform", ok: true, detail: process.platform, fix: "" });
  add({ name: "home", ok: exists(YODO_HOME), detail: YODO_HOME, fix: SETUP_FIX });
  add({ name: "entry", ok: true, detail: import.meta.dirname, fix: "" });

  const srcPath = path.join(YODO_HOME, "src");
  add({ name: "src", ok: exists(srcPath), detail: srcPath, fix: SETUP_FIX });
  const marker = path.join(srcPath, DEPS_MARKER);
  add({ name: "deps", ok: exists(marker), detail: marker, fix: SETUP_FIX });

  for (const [name, dir] of [
    ["task", TASK_DIR],
    ["record", RECORD_DIR],
    ["session", SESSION_DIR],
  ] as const) {
    add({ name, ok: exists(dir), detail: dir, fix: SETUP_FIX });
  }

  const manifest = manifestPath();
  const manifestOk = nativeHostInstalled();
  add({ name: "native-host", ok: manifestOk, detail: manifest, fix: SETUP_FIX });
  if (manifestOk) {
    const launcher = launcherPath();
    const launcherOk = exists(launcher) && exists(HOLDER_ENTRY) && exists(RELAY_ENTRY);
    add({ name: "launcher", ok: launcherOk, detail: launcher, fix: SETUP_FIX });

    let idOk = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { allowed_origins?: string[] };
      idOk = parsed.allowed_origins?.includes(`chrome-extension://${EXTENSION_ID}/`) ?? false;
    } catch {
      idOk = false;
    }
    add({ name: "extension-id", ok: idOk, detail: EXTENSION_ID, fix: "运行 setup.js 重写 manifest" });
  }

  const chrome = chromeRunning();
  add({ name: "chrome", ok: chrome, detail: chrome ? "running" : "未运行", fix: "启动 Google Chrome", optional: true });

  const pid = readSessionPid();
  const alive = pid !== null && isPidAlive(pid);
  add({
    name: "holder",
    ok: alive,
    detail: pid ? (alive ? `alive pid=${pid}` : `stale pid=${pid}`) : "无",
    fix: "在 Chrome 中点一下 yodo 扩展的 service worker 或工具栏图标",
    optional: true,
  });

  return checks;
}

/** 排障：默认文字，`--json` 输出 `{ ok, checks }`。失败项带 fix。 */
export function handleDoctor(json: boolean): void {
  const checks = collectChecks();
  const ok = checks.every((check) => check.ok || check.optional);
  if (!ok) process.exitCode = 1;

  if (json) {
    const out = checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      detail: check.detail,
      ...(check.ok ? {} : { fix: check.fix }),
    }));
    console.log(JSON.stringify({ ok, checks: out }, null, 2));
    return;
  }

  for (const check of checks) {
    console.log(check.ok ? `${check.name} ok ${check.detail}`.trimEnd() : `${check.name} ${check.detail} 失败（${check.fix}）`);
  }
}
