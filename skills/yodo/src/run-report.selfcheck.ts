import assert from "node:assert/strict";
import { RpcError } from "./cli/rpc.ts";
import { formatStack } from "./run-report.ts";

// RpcError 的 message 就是 holder 给用户的说明，不加类名前缀；普通错误保持 "名称: 消息"
assert.equal(formatStack(new RpcError(-32002, "录制 x 正在进行，请先 record stop", { reason: "record" }), "/tmp/t.js")[0], "录制 x 正在进行，请先 record stop");
assert.equal(formatStack(new Error("boom"), "/tmp/t.js")[0], "Error: boom");
assert.deepEqual(formatStack("plain", "/tmp/t.js"), ["plain"]);

console.log("run report selfcheck ok");
