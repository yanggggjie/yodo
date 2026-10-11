import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { RECORD_DIR } from "../utils/constants.ts";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function normalizeRecordLabel(value?: string): string {
  const normalized = (value || "rec")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || "rec";
}

export function validateRecordName(value: string): string {
  const name = value.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `record 名称无效：${JSON.stringify(value)}；须匹配 ${NAME_RE}`,
    );
  }
  return name;
}

export function createRecordName(label?: string, random = crypto.randomBytes(3).toString("hex")): string {
  return validateRecordName(`${normalizeRecordLabel(label)}-${random}`);
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
