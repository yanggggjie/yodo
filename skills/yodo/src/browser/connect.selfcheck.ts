import assert from "node:assert/strict";
import { NeedChromeError, NeedExtensionError, NeedInstallError, chromeAppPath, chromeInstalled } from "./connect.ts";
import { handshakeStatusFromError } from "../protocol.ts";

assert.equal(handshakeStatusFromError(new NeedInstallError()), "need-install");
assert.equal(handshakeStatusFromError(new NeedChromeError()), "need-chrome");
assert.equal(handshakeStatusFromError(new NeedExtensionError()), "need-extension");
assert.equal(chromeInstalled(), chromeAppPath() !== null);

console.log("browser connect selfcheck ok");
