import * as fs from "node:fs";
import * as path from "node:path";
import {
  RECORD_DIR,
  SESSION_DIR,
  TASK_DIR,
  TMP_DIR,
  YODO_HOME,
} from "../utils/constants.ts";
import { isPidAlive, readSessionPid } from "./spawn.ts";

const DEPS_MARKER = path.join("node_modules", "tldts", "dist", "cjs", "index.js");

/** 排障：Node 版本、代码运行位置、`.yodo/` 布局、依赖、holder 存活。 */
export function handleDoctor(): void {
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = Number.isFinite(major) && major >= 24;
  console.log(`node ${process.version} ${nodeOk ? "ok" : "需要 >=24"}`);
  if (!nodeOk) process.exitCode = 1;
  console.log(`platform ${process.platform}`);
  console.log(
    `home ${YODO_HOME} ${fs.existsSync(YODO_HOME) ? "ok" : "缺失（跑 setup / init）"}`,
  );

  console.log(`running from ${import.meta.dirname}`);

  const srcPath = path.join(YODO_HOME, "src");
  if (fs.existsSync(srcPath)) {
    console.log(`src ok`);
  } else {
    console.log(`src 缺失（跑 setup）`);
    process.exitCode = 1;
  }

  const marker = path.join(srcPath, DEPS_MARKER);
  console.log(`deps ${fs.existsSync(marker) ? "ok" : "缺失（再跑 setup）"}`);
  if (!fs.existsSync(marker)) process.exitCode = 1;

  for (const [name, dir] of [
    ["task", TASK_DIR],
    ["tmp", TMP_DIR],
    ["record", RECORD_DIR],
    ["session", SESSION_DIR],
  ] as const) {
    console.log(`  ${name}/ ${fs.existsSync(dir) ? "ok" : "缺失"}`);
  }

  const pid = readSessionPid();
  console.log(
    `holder ${pid ? (isPidAlive(pid) ? `alive pid=${pid}` : `stale pid=${pid}`) : "无"}`,
  );
}
