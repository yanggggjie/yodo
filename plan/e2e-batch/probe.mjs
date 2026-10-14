// 用法：node probe.mjs <url> <js表达式>。开一段探测录制（结束即丢弃），在录制窗口里执行表达式并打印结果。
import { pathToFileURL } from "node:url";
const SRC = "/Users/youshiyitian/Code/x/yodo/yodo-browser-skill/skills/yodo/src";
const { sessionRpc } = await import(pathToFileURL(SRC + "/cli/rpc.ts"));
const { findPage } = await import(pathToFileURL(SRC + "/dev/driver.ts"));
const [url, expr] = process.argv.slice(2);
await sessionRpc("record.start", { name: "probe-tmp" }, 20000);
try {
  const page = await findPage("yodo record");
  await page.goto(url);
  await new Promise((r) => setTimeout(r, 2500));
  console.log(JSON.stringify(await page.eval(expr), null, 1));
} finally {
  await sessionRpc("record.abort", {}, 20000).catch(() => {});
}
