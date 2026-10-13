import assert from "node:assert/strict";
import {
  HANDSHAKE_GUIDES,
  formatErrorStdout,
  formatHandshakeStdout,
  handshakeStatusFromError,
} from "./protocol.ts";


class NeedInstallError extends Error {
  constructor() {
    super("x");
    this.name = "NeedInstallError";
  }
}
class NeedChromeError extends Error {
  constructor() {
    super("x");
    this.name = "NeedChromeError";
  }
}
class NeedExtensionError extends Error {
  constructor() {
    super("x");
    this.name = "NeedExtensionError";
  }
}

assert.equal(handshakeStatusFromError(new NeedInstallError()), "need-install");
assert.equal(handshakeStatusFromError(new NeedChromeError()), "need-chrome");
assert.equal(handshakeStatusFromError(new NeedExtensionError()), "need-extension");
assert.equal(handshakeStatusFromError(new Error("stack")), null);

const parsed = JSON.parse(formatHandshakeStdout("need-extension")) as { status: string; guide: string };
assert.equal(parsed.status, "need-extension");
assert.equal(parsed.guide, HANDSHAKE_GUIDES["need-extension"]);
assert.deepEqual(Object.keys(parsed).sort(), ["guide", "status"]);
assert.match(formatHandshakeStdout("need-install"), /"status": "need-install"/);
assert.deepEqual(JSON.parse(formatErrorStdout("boom")), { status: "failure", error: "boom" });

console.log("protocol selfcheck ok");
