// 防回潮：源码与 AGENTS.md 里不能再出现 isTrusted、Input.dispatch/insert 等 CDP 输入调用，也不能再把事件说成"可信"。
// 例外：storage 的 id 是否可信（与事件无关），只在包含 storage 的行出现时允许。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /isTrusted|Input\.(dispatch|insert|synthesize|emulate|set)|可信/;
const ALLOWED_LINE = /storage|id 可信/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fixtures") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield file;
  }
}

const hits = [];
const scan = (file) => {
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (FORBIDDEN.test(line) && !ALLOWED_LINE.test(line)) hits.push(`${path.relative(HERE, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
};
for (const file of walk(HERE)) if (file !== fileURLToPath(import.meta.url)) scan(file);
scan(path.resolve(HERE, "../../../AGENTS.md"));

assert.deepEqual(hits, [], `发现已移除的 trusted / Input 相关内容：\n${hits.join("\n")}`);
console.log("guard selfcheck ok");
