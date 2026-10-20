import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-sdk-"));
process.env.HOME = TEST_HOME;
const { SESSION_DIR, SESSION_SOCK } = await import("./utils/constants.ts");
fs.mkdirSync(SESSION_DIR, { recursive: true });

const seen: string[] = [];
const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); seen.push(request.method);
      let result: unknown = {};
      if (request.method === "ping") result = { pid: process.pid, chrome: "mock", extension: true, pages: 1, record: null };
      if (request.method === "run.begin") result = { pageId: "P1" };
      if (request.method === "cdp.send") {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { result: { value: "ok" } } })}\n`);
        // 页面事件由 holder 推送，按 pageId 与 method 分发
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cdp.event", params: { sessionId: "P1", method: "Page.loadEventFired", params: {} } })}\n`);
        continue;
      }
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  });
});
await new Promise<void>((resolve) => server.listen(SESSION_SOCK, resolve));

const { yodo } = await import("./sdk.ts");
const output: string[] = []; const original = console.log; console.log = (...args) => output.push(args.map(String).join(" "));
process.argv[1] = path.join(TEST_HOME, "faketask.js");
let firstRunLines = 0;
const stderrChunks: string[] = []; const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown) => { stderrChunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
try {
  await yodo.run(async ({ page }) => {
    console.log("debug-line");
    const event = page.cdp.once("Page.loadEventFired");
    await page.cdp.send("Runtime.evaluate", { expression: "1" });
    await event;
    return "done";
  });
  firstRunLines = output.length;
  // 监听函数里抛错：成为这次 run 的失败（带上这个错误），而不是进程的未捕获异常；task 函数里后面的代码不会再跑
  let reachedEnd = false;
  await yodo.run(async ({ page }) => {
    page.cdp.on("Page.loadEventFired", () => { throw new Error("listener boom"); });
    await page.cdp.send("Runtime.evaluate", { expression: "1" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    reachedEnd = true;
    return "should not be reported";
  });
  assert.equal(reachedEnd, false, "监听函数失败后 run 不再等 task 函数");
  process.exitCode = 0; // 上面那次失败设置了退出码，这里复位，免得自检进程本身报失败
} finally { console.log = original; process.stderr.write = originalStderrWrite; server.close(); fs.rmSync(TEST_HOME, { recursive: true, force: true }); }

assert.equal(JSON.parse(output.slice(0, firstRunLines).join("\n")).status, "success");
assert.ok(!output.join("\n").includes("debug-line"), "task 的 console 输出不能进 stdout");
const second = JSON.parse(output.slice(firstRunLines).join("\n"));
assert.equal(second.status, "failure");
assert.match(second.error, /listener boom/);
assert.ok(stderrChunks.join("").includes("debug-line"), "task 的 console 输出应走 stderr");
assert.deepEqual(seen, ["ping", "run.begin", "cdp.send", "run.end", "ping", "run.begin", "cdp.send", "run.end"]);
console.log("sdk selfcheck ok");
