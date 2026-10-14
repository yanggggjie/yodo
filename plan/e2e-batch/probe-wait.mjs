import { pathToFileURL } from "node:url";
const SRC = "/Users/youshiyitian/Code/x/yodo/yodo-browser-skill/skills/yodo/src";
const { sessionRpc } = await import(pathToFileURL(SRC + "/cli/rpc.ts"));
const { findPage } = await import(pathToFileURL(SRC + "/dev/driver.ts"));
const [url, expr, waitMs] = process.argv.slice(2);
await sessionRpc("record.start", { name: "probe-tmp" }, 20000);
try {
  const page = await findPage("yodo record");
  await page.goto(url);
  await new Promise((r) => setTimeout(r, Number(waitMs ?? 6000)));
  console.log(JSON.stringify(await page.eval(expr), null, 1));
} finally { await sessionRpc("record.abort", {}, 20000).catch(() => {}); }
