import * as fs from "node:fs";
import * as path from "node:path";
import { PKG_ROOT } from "../utils/pkg-root.js";
import {
  ACTIVE_RECORD_DIR,
  RECORD_DIR,
  SESSION_DIR,
  TASK_DIR,
  TMP_DIR,
  YODO_HOME,
} from "../utils/constants.js";

function copyIfPresent(source: string, target: string): void {
  if (fs.existsSync(source)) fs.cpSync(source, target, { force: true });
}

function syncCommon(taskDir: string): void {
  const source = path.join(PKG_ROOT, "templates", "task-common");
  if (!fs.existsSync(source)) return;
  const target = path.join(taskDir, "_common");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

/** 建立当前版本目录。不会迁移、读取或删除旧目录，也不会清理 tmp。 */
export function ensureHomeLayout(homeDir: string = YODO_HOME): void {
  const taskDir = homeDir === YODO_HOME ? TASK_DIR : path.join(homeDir, "task");
  const tmpDir = homeDir === YODO_HOME ? TMP_DIR : path.join(homeDir, "tmp");
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
    tmpDir,
    recordDir,
    activeRecordDir,
    sessionDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  syncCommon(taskDir);
  copyIfPresent(
    path.join(PKG_ROOT, "templates", "task-package.json"),
    path.join(taskDir, "package.json"),
  );
  copyIfPresent(
    path.join(PKG_ROOT, "templates", "tmp-package.json"),
    path.join(tmpDir, "package.json"),
  );
}
