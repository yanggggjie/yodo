import assert from "node:assert/strict";
import {
  HANDSHAKE_GUIDES,
  HANDSHAKE_MARKS,
  formatHandshakeStdout,
  handshakeStatusFromError,
  handshakeStatusFromMark,
} from "./protocol.js";

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
  constructor(readonly code: string) {
    super("x");
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

const stdout = formatHandshakeStdout("need-allow", "record");
const parsed = JSON.parse(stdout) as {
  status: string;
  phase: string;
  guide: string;
};
assert.equal(parsed.status, "need-allow");
assert.equal(parsed.phase, "record");
assert.equal(parsed.guide, HANDSHAKE_GUIDES["need-allow"]);
assert.deepEqual(Object.keys(parsed).sort(), ["guide", "phase", "status"]);

const installOut = formatHandshakeStdout("need-install", "run");
assert.match(installOut, /"status": "need-install"/);
assert.match(installOut, /"phase": "run"/);

console.log("protocol selfcheck ok");
