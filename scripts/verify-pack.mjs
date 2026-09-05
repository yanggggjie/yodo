// 分发烟测：把本 repo 的 skill 用 `skills add --copy` 装进隔离 HOME，断言 payload 完整
// （src、node_modules、setup.js 都在），再从安装位跑 setup + doctor，确认自足可运行。
// 用法：npm run verify:pack
import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-pack-"));
const env = { ...process.env, HOME, USERPROFILE: HOME };

function findSkillDir() {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === "yodo" && path.basename(d) === "skills") hits.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(HOME, 0);
  return hits[0];
}

try {
  console.log(`[verify:pack] HOME=${HOME}`);
  execFileSync(
    "npx",
    ["-y", "skills@latest", "add", REPO, "-s", "yodo", "--copy", "-g", "-a", "*", "-y"],
    { env, stdio: "ignore" },
  );

  const skillDir = findSkillDir();
  assert.ok(skillDir, "skills add 后未找到已安装的 yodo skill 目录");

  for (const rel of [
    "SKILL.md",
    "setup.js",
    "src/yodo.js",
    "src/holder.ts",
    "src/cli/index.ts",
    "src/store/deploy.ts",
    "src/templates/task-common/url.js",
    "src/node_modules/@ghostery",
    "src/node_modules/tldts",
  ]) {
    assert.ok(fs.existsSync(path.join(skillDir, rel)), `payload 缺 ${rel}`);
  }

  // 从安装位跑 setup（link/copy 到 ~/.yodo/src），再 doctor
  const setup = spawnSync(process.execPath, [path.join(skillDir, "setup.js")], {
    env,
    encoding: "utf8",
  });
  assert.equal(setup.status, 0, `setup 失败：${setup.stderr}`);
  assert.ok(fs.existsSync(path.join(HOME, ".yodo", "src", "yodo.js")), "~/.yodo/src 未建好");

  const doctor = spawnSync(
    process.execPath,
    [path.join(HOME, ".yodo", "src", "yodo.js"), "doctor"],
    { env, encoding: "utf8" },
  );
  assert.equal(doctor.status, 0, `doctor 失败：${doctor.stderr}`);

  console.log("[verify:pack] ok — payload 完整且自足可运行");
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}
