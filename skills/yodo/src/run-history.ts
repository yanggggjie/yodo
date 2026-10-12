import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DIR, RUN_HISTORY_KEEP } from "./utils/constants.ts";

/**
 * 把一次运行的输入与输出写到 <runDir>/<name>/<时间戳>.json，并删除超出份数的旧记录。
 * 时间戳按字典序即时间序；同一毫秒的冲突用 `_1`、`_2` 后缀（`_` 排在 `.` 之后，顺序仍正确）。
 */
export function writeRunHistory(name: string, entry: unknown, runDir = RUN_DIR, keep = RUN_HISTORY_KEEP): void {
  const dir = path.join(runDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let file = path.join(dir, `${stamp}.json`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stamp}_${i}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
}
