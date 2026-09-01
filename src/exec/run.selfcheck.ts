import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRunArgs, runTask } from "./index.js";
import type { CdpBrowser, CdpContext } from "../browser/index.js";

assert.deepEqual(parseRunArgs('{"a":1}'), { a: 1 });
assert.throws(() => parseRunArgs("{a:1}"), /不是合法 JSON/);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-run-selfcheck-"));
const mockBrowser = { raw: { commandTimeoutMs: 15_000 } } as CdpBrowser;
const mockContext = {
  pages: () => [],
  detachAllPages: async () => {},
} as unknown as CdpContext;

const smallScript = path.join(tmpDir, "small.js");
fs.writeFileSync(
  smallScript,
  `export default async ({ args }) => {
    return { greeting: "hello", value: args?.name || "world" };
  };`,
);
const smallOut = await runTask(mockBrowser, mockContext, smallScript, '{"name":"alice"}');
const smallParsed = JSON.parse(smallOut) as {
  status: string;
  result: { greeting: string; value: string };
};
assert.equal(smallParsed.status, "success");
assert.deepEqual(smallParsed.result, { greeting: "hello", value: "alice" });

const largeScript = path.join(tmpDir, "large.js");
fs.writeFileSync(
  largeScript,
  `export default async () => {
    return { data: "x".repeat(10000) };
  };`,
);
const largeOut = await runTask(mockBrowser, mockContext, largeScript);
const largeParsed = JSON.parse(largeOut) as { status: string; resultFile: string; resultBytes: number };
assert.equal(largeParsed.status, "success");
assert.ok(largeParsed.resultBytes > 8192);
assert.ok(fs.existsSync(largeParsed.resultFile));

const errorScript = path.join(tmpDir, "error.js");
fs.writeFileSync(
  errorScript,
  `export default async () => { throw new Error("something went wrong"); };`,
);
const errorOut = await runTask(mockBrowser, mockContext, errorScript);
const errorParsed = JSON.parse(errorOut) as { status: string; error: { message: string } };
assert.equal(errorParsed.status, "failure");
assert.equal(errorParsed.error.message, "something went wrong");

const slowScript = path.join(tmpDir, "slow.js");
fs.writeFileSync(
  slowScript,
  `export default async () => { await new Promise((r) => setTimeout(r, 200)); return 1; };`,
);
const slowOut = await runTask(mockBrowser, mockContext, slowScript, undefined, 50);
const slowParsed = JSON.parse(slowOut) as { status: string; error: { message: string } };
assert.equal(slowParsed.status, "failure");
assert.match(slowParsed.error.message, /timeout/);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("exec run selfcheck ok");
