import assert from "node:assert/strict";
import {
  HANDSHAKE_GUIDES,
  HANDSHAKE_MARKS,
  formatErrorStdout,
  formatHandshakeStdout,
  handshakeStatusFromError,
  handshakeStatusFromMark,
} from "./protocol.ts";

assert.equal(handshakeStatusFromMark("yodo:need-install"), "need-install");
assert.equal(
  handshakeStatusFromMark(`boom\n${HANDSHAKE_MARKS["need-allow"]}\n`),
  "need-allow",
);
assert.equal(
  handshakeStatusFromMark(`x ${HANDSHAKE_MARKS["need-remote-debugging"]}`),
  "need-remote-debugging",
);
assert.equal(handshakeStatusFromMark("Error: raw CDP WebSocket open failed"), null);

class NeedInstallError extends Error {
  constructor() {
    super("x");
    this.name = "NeedInstallError";
  }
}
class CdpError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("x");
    this.code = code;
    this.name = "CdpError";
  }
}

assert.equal(handshakeStatusFromError(new NeedInstallError()), "need-install");
assert.equal(
  handshakeStatusFromError(new CdpError("chrome-not-running")),
  "need-chrome",
);
assert.equal(
  handshakeStatusFromError(new CdpError("cdp-port-missing")),
  "need-remote-debugging",
);
assert.equal(
  handshakeStatusFromError(new CdpError("permission-blocked")),
  "need-allow",
);
assert.equal(handshakeStatusFromError(new Error("stack")), null);

const stdout = formatHandshakeStdout("need-allow");
const parsed = JSON.parse(stdout) as {
  status: string;
  guide: string;
};
assert.equal(parsed.status, "need-allow");
assert.equal(parsed.guide, HANDSHAKE_GUIDES["need-allow"]);
assert.deepEqual(Object.keys(parsed).sort(), ["guide", "status"]);

const installOut = formatHandshakeStdout("need-install");
assert.match(installOut, /"status": "need-install"/);
assert.doesNotMatch(installOut, /phase/);
assert.equal(formatErrorStdout("boom"), '{"error":"boom"}');

console.log("protocol selfcheck ok");
