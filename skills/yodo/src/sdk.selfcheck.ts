// sdk 客户端全链路自检：用 mock holder（socket）代替真 Chrome，验证
// ensureHolder(ping) → HolderConn 多 op → run.begin/for-origin/goto/evaluate/run.end
// → fn+args 序列化把参数带到了 holder → success JSON 直出。
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// 必须在 import sdk/constants 之前改 HOME，让 SESSION_SOCK 指向临时目录
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-sdk-"));
process.env.HOME = HOME;

const { SESSION_DIR, SESSION_SOCK, SESSION_PID_FILE } = await import("./utils/constants.ts");
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.writeFileSync(SESSION_PID_FILE, `${process.pid}\n`); // 让 ensureAttached 认为 holder 活着

const seen: string[] = [];
const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (c) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line);
      seen.push(req.op);
      let res: Record<string, unknown> = { id: req.id, ok: true };
      if (req.op === "ping") res = { id: req.id, ok: true, pid: process.pid, chrome: "mock", pages: 0, record: null };
      else if (req.op === "page.for-origin") res = { id: req.id, ok: true, pageId: "P1", url: req.origin };
      else if (req.op === "page.evaluate") res = { id: req.id, ok: true, value: { exprHasArg: String(req.expr).includes('"hi"') } };
      sock.write(`${JSON.stringify(res)}\n`);
    }
  });
});
await new Promise<void>((r) => server.listen(SESSION_SOCK, () => r()));

const { yodo } = await import("./sdk.ts");

// 捕获 yodo.run 最终打印的 success JSON
const out: string[] = [];
const orig = console.log;
console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
process.argv[1] = path.join(HOME, "faketask.js");

try {
  await yodo.run(async ({ browserContext }) => {
    const page = await browserContext.pageForOrigin("https://x.test");
    await page.goto("https://x.test/y");
    return page.evaluate(async (k: string) => ({ k }), "hi");
  });
} finally {
  console.log = orig;
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

const printed = out.join("\n");
const parsed = JSON.parse(printed);
assert.equal(parsed.status, "success", `期望 success，得到：${printed}`);
assert.deepEqual(parsed.result, { exprHasArg: true }, "evaluate 的 fn+args 应把参数序列化传到 holder");
assert.deepEqual(
  seen,
  ["ping", "run.begin", "page.for-origin", "page.goto", "page.evaluate", "run.end"],
  `op 顺序不对：${seen.join(",")}`,
);
assert.equal(process.exitCode ?? 0, 0, "success 不应设非零退出码");

console.log = orig;
console.log("sdk selfcheck ok");
