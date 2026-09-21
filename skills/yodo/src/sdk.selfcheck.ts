import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-sdk-"));
process.env.HOME = TEST_HOME;
const { SESSION_DIR, SESSION_SOCK, SESSION_PID_FILE } = await import("./utils/constants.ts");
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.writeFileSync(SESSION_PID_FILE, `${process.pid}\n`);

const seen: string[] = [];
const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); seen.push(request.method);
      let result: unknown = {};
      if (request.method === "ping") result = { pid: process.pid, chrome: "mock", pages: 1, record: null };
      if (request.method === "run.begin") result = { pageId: "P1" };
      if (request.method === "cdp.send") result = { result: { value: "ok" } };
      if (request.method === "cdp.subscribe") {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cdp.event", params: { subscriptionId: request.params.subscriptionId, event: request.params.event, value: { timestamp: 1 } } })}\n`);
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
try {
  await yodo.run(async ({ page, _cdp }) => {
    assert.equal(page._targetId, "P1");
    assert.ok(_cdp.connection && _cdp.browser);
    const event = page.cdp.once("Page.loadEventFired");
    await page.cdp.send("Runtime.evaluate", { expression: "1" });
    await event;
    return "done";
  });
} finally { console.log = original; server.close(); fs.rmSync(TEST_HOME, { recursive: true, force: true }); }

assert.equal(JSON.parse(output.join("\n")).status, "success");
assert.deepEqual(seen, ["ping", "run.begin", "cdp.subscribe", "cdp.send", "cdp.unsubscribe", "run.end"]);
console.log("sdk selfcheck ok");
