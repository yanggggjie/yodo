import * as fs from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonAtomic(
  file: string,
  value: unknown,
): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function writeTextAtomic(
  file: string,
  content: string,
): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFileAtomic(file, content, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
