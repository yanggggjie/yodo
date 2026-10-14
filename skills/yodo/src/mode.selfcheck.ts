import assert from "node:assert/strict";
import { Mode } from "./mode.ts";

let recording: string | null = null;
const mode = new Mode<string>(() => recording);
const reason = (busy: ReturnType<Mode<string>["tryBeginRun"]>) => busy?.reason ?? null;

// 空闲：谁都能开始
assert.equal(mode.kind(), "idle");
assert.equal(reason(mode.tryBeginRun("a")), null);
assert.equal(mode.kind(), "run");
assert.equal(mode.runConn(), "a");

// run 进行中：另一个 run、record start 都被拒绝，reason 都是 run（SDK 会等）
assert.equal(reason(mode.tryBeginRun("b")), "run");
assert.equal(reason(mode.tryBeginRecordStart()), "run");
assert.match(mode.tryBeginRecordStart()!.message, /record start/);
// 别人不能结束我的 run
assert.equal(mode.endRun("b"), false);
assert.equal(mode.kind(), "run");
assert.equal(mode.endRun("a"), true);
assert.equal(mode.kind(), "idle");

// 录制操作进行中（start/stop/abort 正在执行）：run 要等（record-op），另一个录制操作被拒绝
assert.equal(reason(mode.tryBeginRecordStart()), null);
assert.equal(mode.kind(), "record-op");
assert.equal(reason(mode.tryBeginRun("a")), "record-op");
assert.equal(reason(mode.tryBeginRecordFinish()), "record-op");
mode.endRecordOp();
assert.equal(mode.kind(), "idle");

// 录制进行中：run 不等，直接失败（reason 是 record）；stop、abort 可以进入
recording = "demo";
assert.equal(mode.kind(), "record");
assert.equal(reason(mode.tryBeginRun("a")), "record");
assert.match(mode.tryBeginRun("a")!.message, /demo/);
assert.equal(reason(mode.tryBeginRecordFinish()), null);
assert.equal(mode.kind(), "record-op");
mode.endRecordOp();
recording = null;
assert.equal(mode.kind(), "idle");

// 被拒绝的 run 不会占住模式
assert.equal(reason(mode.tryBeginRun("a")), null);
assert.equal(reason(mode.tryBeginRun("b")), "run");
assert.equal(mode.runConn(), "a");

console.log("mode selfcheck ok");
