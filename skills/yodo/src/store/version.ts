import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SRC_ROOT } from "../utils/pkg-root.ts";
import { isRuntimePath } from "./deploy.ts";

/** setup.js 写在部署目录里；daemon 启动时记下自己的 build，CLI 拿它对比磁盘上的最新值。 */
export const VERSION_FILE = ".version";

export type Version = {
  /** 运行时代码内容的哈希（规则见 isRuntimePath，不含本文件）。 */
  build: string;
  /** 扩展的 background.js 与 manifest.json 内容的哈希；扩展启动时对自己算同一个值。 */
  extension: string;
};

const short = (hash: crypto.Hash): string => hash.digest("hex").slice(0, 16);

function listFiles(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (!isRuntimePath(root, file)) continue;
    if (entry.isDirectory()) listFiles(root, file, out);
    else if (entry.isFile() && entry.name !== VERSION_FILE) out.push(file);
  }
}

export function computeVersion(root: string): Version {
  const files: string[] = [];
  listFiles(root, root, files);
  files.sort();
  const build = crypto.createHash("sha256");
  for (const file of files) build.update(path.relative(root, file)).update("\0").update(fs.readFileSync(file));
  const extension = crypto.createHash("sha256");
  for (const name of ["background.js", "manifest.json"]) {
    const file = path.join(root, "chrome-extension", name);
    if (fs.existsSync(file)) extension.update(fs.readFileSync(file));
  }
  return { build: short(build), extension: short(extension) };
}

export function writeVersion(root: string): Version {
  const version = computeVersion(root);
  fs.writeFileSync(path.join(root, VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
  return version;
}

/** 部署目录里没有 .version（开发时直接从仓库运行）返回 null，此时不做版本比较。 */
export function readVersion(root: string = SRC_ROOT): Version | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, VERSION_FILE), "utf8")) as Partial<Version>;
    return typeof parsed.build === "string" && typeof parsed.extension === "string" ? { build: parsed.build, extension: parsed.extension } : null;
  } catch {
    return null;
  }
}
