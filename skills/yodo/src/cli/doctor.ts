import * as fs from "node:fs";
import * as path from "node:path";
import {
  RECORD_DIR,
  SESSION_DIR,
  TASK_DIR,
  YODO_HOME,
} from "../utils/constants.ts";
import { tryPing } from "./session.ts";
import { readVersion } from "../store/version.ts";
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
async function collectChecks(): Promise<Check[]> {
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

  // 判据只有 socket 能不能回 ping。pid 文件丢了不影响——它只是展示信息，不代表 holder 不在。
  const ping = await tryPing();
  const responding = ping?.extension === true;
  add({
    name: "holder",
    ok: responding,
    detail: !ping ? "无" : responding ? `alive pid=${ping.pid}` : `pid=${ping.pid} 在运行，扩展未连接`,
    fix: "在 Chrome 中点一下 yodo 扩展的 service worker 或工具栏图标；仍无响应则在 chrome://extensions 刷新扩展",
    optional: true,
  });

  // 版本：运行中的 daemon 和已加载的扩展是不是部署目录里的最新版本。不影响退出码。
  const installed = readVersion();
  if (installed && ping) {
    // 旧 daemon 的 ping 里没有 build，显示成"(无)"，同样算和已安装的不同。
    // 换代码只在 setup.js 或 yodo daemon restart 时发生，不是哪条命令自动做的；忙（run、录制）时换不掉，等空闲后再运行。
    const same = ping.build === installed.build;
    add({
      name: "daemon-build",
      ok: same,
      detail: same ? installed.build : `运行中 ${ping.build || "(无)"}，已安装 ${installed.build}`,
      fix: "运行 yodo daemon restart",
      optional: true,
    });
    if (ping.extension) {
      const loaded = ping.extensionBuild ?? "";
      add({
        name: "extension-build",
        ok: loaded === installed.extension,
        detail: loaded === installed.extension ? loaded : loaded ? `已加载 ${loaded}，已安装 ${installed.extension}` : "扩展没有报告版本，可能是旧版本",
        fix: "在 chrome://extensions 里刷新 yodo 扩展",
        optional: true,
      });
    }
  }

  return checks;
}

/** 排障：默认文字，`--json` 输出 `{ ok, checks }`。失败项带 fix。 */
export async function handleDoctor(json: boolean): Promise<void> {
  const checks = await collectChecks();
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
