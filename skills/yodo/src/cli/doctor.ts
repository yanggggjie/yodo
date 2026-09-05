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

/** 排障：Node 版本、代码运行位置、~/.yodo 布局、holder 存活。 */
export function handleDoctor(): void {
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = Number.isFinite(major) && major >= 24;
  console.log(`node ${process.version} ${nodeOk ? "ok" : "需要 >=24"}`);
  if (!nodeOk) process.exitCode = 1;

  // 代码实际运行位置（symlink 会被 Node realized 成 skill 目录真实路径）
  console.log(`running from ${import.meta.dirname}`);

  // ~/.yodo/src 是链接还是拷贝
  const srcPath = path.join(YODO_HOME, "src");
  try {
    const st = fs.lstatSync(srcPath);
    if (st.isSymbolicLink()) {
      console.log(`~/.yodo/src → link → ${fs.readlinkSync(srcPath)}`);
    } else {
      console.log(`~/.yodo/src (copy)`);
    }
  } catch {
    console.log(`~/.yodo/src 缺失（跑 setup）`);
  }

  console.log(`~/.yodo ${fs.existsSync(YODO_HOME) ? "存在" : "缺失（跑 setup / init）"}`);
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

