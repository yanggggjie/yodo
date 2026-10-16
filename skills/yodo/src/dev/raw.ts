/**
 * dev 模式下保存录制的原始事件（脱敏之前，可能含密码和 token），供离线重放流水线。
 * 只写到 ~/.yodo/dev/raw/<name>/，权限 0600，不进 record/；用完 rm -rf ~/.yodo/dev。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { YODO_HOME } from "../utils/constants.ts";
import { DEV_FLAG } from "./rpc.ts";

export function saveRaw(name: string, events: unknown, dom: unknown): void {
  if (!fs.existsSync(DEV_FLAG)) return;
  const dir = path.join(YODO_HOME, "dev", "raw", name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify(events), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "dom.json"), JSON.stringify(dom), { mode: 0o600 });
}
