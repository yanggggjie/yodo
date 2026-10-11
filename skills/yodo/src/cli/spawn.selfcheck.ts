import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPidAlive, stopPid } from "./spawn.ts";

const dummy = child_process.spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
  stdio: "ignore",
});
try {
  assert.ok(dummy.pid && isPidAlive(dummy.pid), "dummy 应活着");
  await stopPid(dummy.pid);
  assert.equal(isPidAlive(dummy.pid), false, "活着的 pid 应被停");
} finally {
  if (dummy.pid && isPidAlive(dummy.pid)) dummy.kill("SIGKILL");
}

console.log("cli spawn selfcheck ok");
