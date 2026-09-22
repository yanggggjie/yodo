import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CDP_PORT,
  CdpError,
  NeedAllowError,
  NeedChromeError,
  NeedCdpPortError,
  NeedInstallError,
  chromeInstalled,
  configuredCdpPort,
  parseCdpPort,
  parseCdpPortConfig,
} from "./connect.ts";
import { handshakeStatusFromError } from "../protocol.ts";

assert.equal(typeof chromeInstalled(), "boolean");

assert.equal(DEFAULT_CDP_PORT, 9222);
assert.equal(parseCdpPort("54321"), 54321);
assert.equal(parseCdpPort("0"), null);
assert.equal(parseCdpPort("65536"), null);
assert.equal(parseCdpPort(" 9222"), null);
assert.equal(parseCdpPort("9222;echo bad"), null);
assert.equal(parseCdpPortConfig("YODO_CDP_PORT=54321\n"), 54321);
assert.equal(parseCdpPortConfig("export YODO_CDP_PORT=54321\n"), null);
assert.equal(parseCdpPortConfig("YODO_CDP_PORT=54321\nOTHER=x\n"), null);
assert.equal(configuredCdpPort("12345", "/missing"), 12345);
assert.equal(configuredCdpPort("bad", "/missing"), 9222);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-cdp-port-"));
const configFile = path.join(tempDir, "config.env");
try {
  fs.writeFileSync(configFile, "YODO_CDP_PORT=54321\n", "utf8");
  assert.equal(configuredCdpPort(undefined, configFile), 54321);
  assert.equal(configuredCdpPort("12345", configFile), 12345);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.equal(handshakeStatusFromError(new NeedInstallError()), "need-install");
assert.equal(handshakeStatusFromError(new NeedChromeError()), "need-chrome");
assert.equal(handshakeStatusFromError(new NeedCdpPortError()), "need-cdp-port");
assert.equal(
  handshakeStatusFromError(new CdpError("permission-blocked", "x")),
  "need-allow",
);
assert.equal(handshakeStatusFromError(new NeedAllowError()), "need-allow");
assert.equal(handshakeStatusFromError(new Error("stack")), null);

console.log("browser connect selfcheck ok");
