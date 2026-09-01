import assert from "node:assert/strict";
import {
  CdpError,
  NeedAllowError,
  NeedChromeError,
  NeedInstallError,
  chromeInstalled,
  resolveLaunchPlan,
} from "./connect.js";
import { handshakeStatusFromError } from "../protocol.js";

assert.equal(typeof chromeInstalled(), "boolean");

assert.equal(resolveLaunchPlan(false, false), "need-install");
assert.equal(resolveLaunchPlan(true, false), "launch");
assert.equal(resolveLaunchPlan(true, true), "connect");
assert.equal(resolveLaunchPlan(false, true), "connect");

assert.equal(handshakeStatusFromError(new NeedInstallError()), "need-install");
assert.equal(handshakeStatusFromError(new NeedChromeError()), "need-chrome");
assert.equal(
  handshakeStatusFromError(new CdpError("chrome-not-running", "x")),
  "need-chrome",
);
assert.equal(
  handshakeStatusFromError(new CdpError("cdp-toggle-off", "x")),
  "need-remote-debugging",
);
assert.equal(
  handshakeStatusFromError(new CdpError("permission-blocked", "x")),
  "need-allow",
);
assert.equal(handshakeStatusFromError(new NeedAllowError()), "need-allow");
assert.equal(handshakeStatusFromError(new Error("stack")), null);

console.log("browser connect selfcheck ok");
