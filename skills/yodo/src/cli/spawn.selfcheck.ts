import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handshakeStatusFromMark } from "../protocol.ts";
import { pingMeansReady, readHandshakeFromLogFile } from "./spawn.ts";

assert.equal(pingMeansReady({ id: "1", ok: true }), true);
assert.equal(
  pingMeansReady({
    id: "1",
    ok: false,
    status: "need-allow",
    guide: "x",
  }),
  false,
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-spawn-"));
const logFile = path.join(dir, "log.jsonl");
const noise = Array.from({ length: 20 }, (_, i) =>
  JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", level: "INFO", scope: "holder", msg: `n${i}` }),
);
noise.push(
  JSON.stringify({
    ts: "2026-01-01T00:00:01.000Z",
    level: "WARN",
    scope: "holder",
    msg: "yodo:need-chrome",
  }),
);
for (let i = 0; i < 12; i++) {
  noise.push(
    JSON.stringify({
      ts: "2026-01-01T00:00:02.000Z",
      level: "INFO",
      scope: "holder",
      msg: `after${i}`,
    }),
  );
}
fs.writeFileSync(logFile, noise.join("\n") + "\n");
const last8 = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-8).join("\n");
assert.equal(handshakeStatusFromMark(last8), null);
assert.equal(readHandshakeFromLogFile(logFile), "need-chrome");

fs.rmSync(dir, { recursive: true, force: true });
console.log("cli spawn selfcheck ok");
