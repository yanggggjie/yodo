import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YODO_HOME } from "../utils/constants.ts";

export const BIN_DIR = path.join(YODO_HOME, "bin");
export const ENTRY = path.join(YODO_HOME, "src", "cli", "yodo.ts");

/** 写入 ~/.yodo/bin/yodo（sh）与 yodo.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "yodo");
  const cmd = path.join(BIN_DIR, "yodo.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${nodePath}" "${ENTRY}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n"${nodePath}" "${ENTRY}" %*\r\n`);
  return [sh, cmd];
}

export const HOME_DIR = os.homedir();
