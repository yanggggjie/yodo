// 用法：node <skill 目录>/scripts/dev/replay.mjs（本机是 ~/.yodo/scripts/dev/replay.mjs） <录制名|raw 目录>
// 把 dev 模式下保存的原始事件重新喂给流水线，打印每一级的输入、输出与丢弃原因，并与上一次重放比较。不需要 Chrome。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareWithLast, printStages } from "./diff.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const { runPipeline, loadAdblockEngine } = await import(pathToFileURL(path.join(src, "record/pipeline.ts")));

const arg = process.argv[2];
if (!arg) { console.error("用法：node scripts/dev/replay.mjs <录制名|raw 目录>"); process.exit(1); }
const dir = fs.existsSync(arg) ? path.resolve(arg) : path.join(os.homedir(), ".yodo", "dev", "raw", arg);
const raw = JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8"));

const { events, stages } = runPipeline(raw, await loadAdblockEngine());
console.log(`重放 ${dir}`);
printStages(stages);

const lines = events.map((e) => `${e.requestType} ${e.method} ${e.url.bareUrl}${e.status ? " " + e.status : ""}`.replace(/localhost:\d+/g, "localhost:PORT"));
console.log("与上一次比较：");
compareWithLast(path.join(dir, "replay-last.txt"), lines);
for (const l of lines) console.log(`  ${l}`);
