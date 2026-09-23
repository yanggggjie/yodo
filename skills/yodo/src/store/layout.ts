import * as fs from "node:fs";
import * as path from "node:path";
import { SRC_ROOT } from "../utils/pkg-root.ts";
import {
  ACTIVE_RECORD_DIR,
  RECORD_DIR,
  SESSION_DIR,
  TASK_DIR,
  TEMP_DIR,
  YODO_HOME,
} from "../utils/constants.ts";

function copyIfPresent(source: string, target: string): void {
  if (fs.existsSync(source)) fs.cpSync(source, target, { force: true });
}

function syncLib(taskDir: string): void {
  const source = path.join(SRC_ROOT, "templates", "task-lib");
  if (!fs.existsSync(source)) return;
  const target = path.join(taskDir, "lib");
  fs.rmSync(path.join(taskDir, "_common"), { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

/** 建立当前版本目录。不会迁移、读取或删除旧目录，也不会清理 temp。 */
export function ensureHomeLayout(homeDir: string = YODO_HOME): void {
  const taskDir = homeDir === YODO_HOME ? TASK_DIR : path.join(homeDir, "task");
  const tempDir = homeDir === YODO_HOME ? TEMP_DIR : path.join(homeDir, "temp");
  const recordDir =
    homeDir === YODO_HOME ? RECORD_DIR : path.join(homeDir, "record");
  const activeRecordDir =
    homeDir === YODO_HOME
      ? ACTIVE_RECORD_DIR
      : path.join(recordDir, ".active");
  const sessionDir =
    homeDir === YODO_HOME ? SESSION_DIR : path.join(homeDir, "session");

  for (const dir of [
    homeDir,
    taskDir,
    tempDir,
    recordDir,
    activeRecordDir,
    sessionDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  syncLib(taskDir);
  copyIfPresent(
    path.join(SRC_ROOT, "templates", "task-package.json"),
    path.join(taskDir, "package.json"),
  );
  copyIfPresent(
    path.join(SRC_ROOT, "templates", "temp-package.json"),
    path.join(tempDir, "package.json"),
  );
}
