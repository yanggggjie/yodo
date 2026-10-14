// 用法：node record-run.mjs <录制名> <场景.mjs>。场景 default export 是 async (driver) => {}，driver 是 dev DevPage。
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const SRC = "/Users/youshiyitian/Code/x/yodo/yodo-browser-skill/skills/yodo/src";
const { sessionRpc } = await import(pathToFileURL(path.join(SRC, "cli/rpc.ts")));
const { findPage } = await import(pathToFileURL(path.join(SRC, "dev/driver.ts")));
const [name, scenarioPath] = process.argv.slice(2);
const scenario = (await import(pathToFileURL(path.resolve(scenarioPath)))).default;
let stop;
try {
  console.log("record.start", await sessionRpc("record.start", { name }, 20_000));
  const driver = await findPage("yodo record");
  await scenario(driver);
  await new Promise((r) => setTimeout(r, 1500));
} catch (error) {
  console.error("场景失败：", error.message);
} finally {
  stop = await sessionRpc("record.stop", {}, 70_000);
  console.log("record.stop", JSON.stringify(stop));
}
