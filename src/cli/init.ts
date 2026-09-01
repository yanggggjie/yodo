import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHomeLayout } from "../store/layout.js";
import { stopCurrentHolder } from "./spawn.js";

const PKG = "yodo-cli";
const LEGACY_PKG = "yodo-browser-skill";
const SKILL = "yodo";
const SKILL_REPO = "yanggggjie/yodo";

export type InitOptions = { local: boolean };

function cleanNpmEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD" || key === "PROJECT_CWD") {
      delete env[key];
    }
  }
  return env;
}

function run(args: string[], cwd: string): void {
  childProcess.execFileSync(args[0]!, args.slice(1), {
    cwd,
    env: cleanNpmEnv(),
    stdio: "inherit",
  });
}

function localRoot(): string {
  const root = process.cwd();
  const pkgFile = path.join(root, "package.json");
  const cliFile = path.join(root, "src", "cli", "index.ts");
  const distFile = path.join(root, "dist", "cli", "index.js");
  let pkg: { name?: string };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { name?: string };
  } catch {
    throw new Error(`--local 必须在 yodo 仓库根目录执行`);
  }
  if (pkg.name !== PKG || !fs.existsSync(cliFile)) {
    throw new Error(`--local 必须在 yodo 仓库根目录执行`);
  }
  if (!fs.existsSync(distFile)) {
    throw new Error("本地 dist/cli/index.js 不存在；请先执行 npm run build");
  }
  return root;
}

export async function handleInit(options: InitOptions): Promise<void> {
  const root = options.local ? localRoot() : process.cwd();
  const cliSource = options.local ? root : PKG;
  const skillSource = options.local ? root : SKILL_REPO;

  await stopCurrentHolder();
  run(["npm", "uninstall", "-g", LEGACY_PKG], root);
  console.log(`正在安装 CLI（${cliSource}）...`);
  run(["npm", "install", "-g", cliSource], root);
  console.log(`正在安装 skill（${skillSource}）...`);
  run(
    [
      "npx",
      "-y",
      "skills",
      "add",
      skillSource,
      "-g",
      "-y",
      "-a",
      "*",
      "-s",
      SKILL,
    ],
    root,
  );
  ensureHomeLayout();
  console.log("yodo init ok");
}
