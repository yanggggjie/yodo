import assert from "node:assert/strict";
import { createRecordName, normalizeRecordLabel, validateRecordName } from "./repository.ts";

assert.equal(validateRecordName("demo"), "demo");
assert.throws(() => validateRecordName("bad name"));
assert.equal(normalizeRecordLabel("  xhs favorite  "), "xhs-favorite");
assert.equal(normalizeRecordLabel("小红书"), "rec");
assert.equal(createRecordName("xhs favorite", "a7f3c1"), "xhs-favorite-a7f3c1");

console.log("repository selfcheck ok");
