import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handshakeStatusFromMark } from "../protocol.ts";
import { createLogger, dropOldestKeepNewest, setLogFile } from "./logger.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-log-"));
const file = path.join(dir, "log.jsonl");
setLogFile(file);

const log = createLogger("test");
log.warn("yodo:need-chrome");
const raw = fs.readFileSync(file, "utf8").trim();
const rec = JSON.parse(raw) as { ts: string; level: string; scope: string; msg: string };
assert.equal(rec.level, "WARN");
assert.equal(rec.scope, "test");
assert.equal(rec.msg, "yodo:need-chrome");
assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
assert.equal(handshakeStatusFromMark(raw), "need-chrome");

const small = path.join(dir, "trim.jsonl");
const lines: string[] = [];
for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ n: i, pad: "x".repeat(20) }));
fs.writeFileSync(small, lines.join("\n") + "\n");
dropOldestKeepNewest(small, 120);
const kept = fs.readFileSync(small, "utf8").trim().split("\n");
assert.ok(fs.statSync(small).size <= 120 + 80);
assert.ok(kept.length >= 1);
const last = JSON.parse(kept[kept.length - 1]!) as { n: number };
assert.equal(last.n, 19);
for (const line of kept) JSON.parse(line);

setLogFile(undefined);
fs.rmSync(dir, { recursive: true, force: true });
console.log("utils logger selfcheck ok");
