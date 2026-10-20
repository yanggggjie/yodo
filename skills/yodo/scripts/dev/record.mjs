// 用法：node <skill 目录>/scripts/dev/record.mjs（本机是 ~/.yodo/scripts/dev/record.mjs） [场景.mjs]
// 起夹具 → record.start → 场景里用 Driver 模拟用户操作 → record.stop → 打印汇总，并与上一次比较。需要 dev 已开启。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFixture } from "./fixture.mjs";
import { compareWithLast, printStages } from "./diff.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const { sessionRpc } = await import(pathToFileURL(path.join(src, "cli/rpc.ts")));
const { findPage } = await import(pathToFileURL(path.join(src, "dev/driver.ts")));

const flag = path.join(os.homedir(), ".yodo", "session", "dev");
if (!fs.existsSync(flag)) { console.error(`dev 未开启：touch ${flag}`); process.exit(1); }

const scenarioPath = path.resolve(process.argv[2] ?? fileURLToPath(new URL("./shop.mjs", import.meta.url)));
const scenario = (await import(pathToFileURL(scenarioPath))).default;
const name = path.basename(scenarioPath, ".mjs");

const fixture = await startFixture();
let stop;
try {
  await sessionRpc("record.start", { name }, 20_000);
  await scenario(await findPage("yodo record"), fixture.base);
} finally {
  stop = JSON.parse(await sessionRpc("record.stop", {}, 70_000));
  fixture.close();
}

if (!stop.recordDir) { console.log(JSON.stringify(stop)); process.exit(1); }
const rows = fs.readFileSync(path.join(stop.recordDir, "timeline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// 归一化：去掉时间戳，端口换成 PORT，这样两次运行才能比较
const norm = (r) => { const { t, ...rest } = r; return JSON.stringify(rest).replace(/localhost:\d+/g, "localhost:PORT"); };
const lines = rows.map(norm);

console.log(`录制：${stop.recordDir}`);
console.log(`timeline ${rows.length} 行：` + Object.entries(rows.reduce((a, r) => { const k = r.actionType ?? r.requestType ?? r.type; a[k] = (a[k] ?? 0) + 1; return a; }, {})).map(([k, v]) => `${k}=${v}`).join(" "));
if (stop.warnings?.length) console.log("警告：", JSON.stringify(stop.warnings));

const log = fs.readFileSync(path.join(os.homedir(), ".yodo", "session", "log.jsonl"), "utf8").trim().split("\n").reverse();
const summary = log.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r?.msg?.startsWith("pipeline ") && r.data?.stages);
if (summary) { console.log(`流水线 ${summary.msg}`); printStages(summary.data.stages); }

console.log("与上一次比较：");
compareWithLast(path.join(os.homedir(), ".yodo", "dev", "runs", name, "last.txt"), lines);
for (const l of lines) console.log(`  ${l.slice(0, 200)}`);
process.exit(0);
