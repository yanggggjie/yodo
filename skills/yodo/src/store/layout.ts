import * as fs from "node:fs";
import * as path from "node:path";
import { SRC_ROOT } from "../utils/pkg-root.ts";
import { RECORD_DIR, SESSION_DIR, TASK_DIR } from "../utils/constants.ts";

function syncLib(taskDir: string): void {
  const source = path.join(SRC_ROOT, "templates", "task-lib");
  if (!fs.existsSync(source)) return;
  const target = path.join(taskDir, "lib");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

/** 建立目录并同步 task-lib。只创建 task、record、session 三个目录。 */
export function ensureHomeLayout(): void {
  for (const dir of [TASK_DIR, RECORD_DIR, SESSION_DIR]) fs.mkdirSync(dir, { recursive: true });
  syncLib(TASK_DIR);
}
