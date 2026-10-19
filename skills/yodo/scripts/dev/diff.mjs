// 和上一次的结果比较：只列出多了、少了哪些行。差异不是失败，只是让你看见改动的影响。
import * as fs from "node:fs";
import * as path from "node:path";

export function compareWithLast(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : null;
  fs.writeFileSync(file, lines.join("\n") + "\n");
  if (!previous) { console.log("（没有上一次的结果可比较）"); return; }
  const before = new Set(previous), after = new Set(lines);
  const removed = previous.filter((l) => !after.has(l)), added = lines.filter((l) => !before.has(l));
  if (!removed.length && !added.length) { console.log("与上一次相同"); return; }
  for (const l of removed) console.log(`- ${l}`);
  for (const l of added) console.log(`+ ${l}`);
}

export function printStages(stages) {
  for (const s of stages) {
    const dropped = Object.entries(s.dropped).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  ${s.name.padEnd(13)} ${String(s.in).padStart(3)} → ${String(s.out).padStart(3)}  ${dropped}`);
  }
}
