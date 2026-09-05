import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { ACTIVE_RECORD_DIR, RECORD_DIR } from "../utils/constants.ts";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function validateRecordName(value: string): string {
  const name = value.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `record 名称无效：${JSON.stringify(value)}；须匹配 ${NAME_RE}`,
    );
  }
  return name;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(dir: string): Promise<number | undefined> {
  try {
    const pid = Number((await fs.readFile(path.join(dir, "pid"), "utf8")).trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Leftover `.active/<name>` with a dead pid is dropped. */
export async function sweepDeadActive(
  root = RECORD_DIR,
): Promise<void> {
  const activeRoot =
    root === RECORD_DIR ? ACTIVE_RECORD_DIR : path.join(root, ".active");
  await fs.mkdir(activeRoot, { recursive: true });
  let entries: Dirent[];
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(activeRoot, entry.name);
    const pid = await readPid(dir);
    if (pid && pidAlive(pid)) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function claimActive(
  rawName: string,
  root = RECORD_DIR,
): Promise<string> {
  const name = validateRecordName(rawName);
  const activeRoot =
    root === RECORD_DIR ? ACTIVE_RECORD_DIR : path.join(root, ".active");
  await fs.mkdir(activeRoot, { recursive: true });
  const entries = await fs.readdir(activeRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory())) {
    throw new Error("已有 active record；请先 record stop 或 record abort");
  }
  const dir = path.join(activeRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "pid"), `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return name;
}

export async function releaseActive(
  rawName: string,
  root = RECORD_DIR,
): Promise<void> {
  const name = validateRecordName(rawName);
  const activeRoot =
    root === RECORD_DIR ? ACTIVE_RECORD_DIR : path.join(root, ".active");
  await fs.rm(path.join(activeRoot, name), { recursive: true, force: true });
}

export async function hasLiveActive(root = RECORD_DIR): Promise<boolean> {
  const activeRoot =
    root === RECORD_DIR ? ACTIVE_RECORD_DIR : path.join(root, ".active");
  if (!(await exists(activeRoot))) return false;
  const entries = await fs.readdir(activeRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pid = await readPid(path.join(activeRoot, entry.name));
    if (pid && pidAlive(pid)) return true;
  }
  return false;
}
