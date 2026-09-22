import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CdpError,
  NeedAllowError,
  NeedChromeError,
  NeedFileAccessError,
  NeedInstallError,
  NeedRemoteDebuggingError,
  chromeInstalled,
  endpointFromActivePort,
  parseDevToolsActivePort,
  readDevToolsActivePort,
} from "./connect.ts";
import { handshakeStatusFromError } from "../protocol.ts";

assert.equal(typeof chromeInstalled(), "boolean");

assert.deepEqual(parseDevToolsActivePort("54321\n/devtools/browser/abc\n"), {
  port: 54321,
  wsPath: "/devtools/browser/abc",
});
assert.deepEqual(parseDevToolsActivePort("54321\r\n/devtools/browser/abc\r\n"), {
  port: 54321,
  wsPath: "/devtools/browser/abc",
});
assert.equal(parseDevToolsActivePort("0\n/devtools/browser/abc\n"), null);
assert.equal(parseDevToolsActivePort("65536\n/devtools/browser/abc\n"), null);
assert.equal(parseDevToolsActivePort("9222\n"), null);
assert.equal(parseDevToolsActivePort("9222\nnot-a-path\n"), null);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-devtools-port-"));
const activePortFile = path.join(tempDir, "DevToolsActivePort");
try {
  fs.writeFileSync(activePortFile, "54321\n/devtools/browser/abc\n", "utf8");
  assert.deepEqual(readDevToolsActivePort(activePortFile), {
    port: 54321,
    wsPath: "/devtools/browser/abc",
  });
  assert.equal(readDevToolsActivePort(path.join(tempDir, "missing")), null);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://live" }));
  assert.equal(await endpointFromActivePort({ port: 9222, wsPath: "/devtools/browser/file" }), "ws://live");
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(
    await endpointFromActivePort({ port: 9222, wsPath: "/devtools/browser/file" }),
    "ws://127.0.0.1:9222/devtools/browser/file",
  );
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(
    endpointFromActivePort({ port: 9222, wsPath: "/devtools/browser/file" }),
    NeedAllowError,
  );
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(handshakeStatusFromError(new NeedInstallError()), "need-install");
assert.equal(handshakeStatusFromError(new NeedChromeError()), "need-chrome");
assert.equal(handshakeStatusFromError(new NeedRemoteDebuggingError()), "need-remote-debugging");
assert.equal(handshakeStatusFromError(new NeedFileAccessError("/tmp/x", new Error("denied"))), "need-file-access");
assert.equal(
  handshakeStatusFromError(new CdpError("permission-blocked", "x")),
  "need-allow",
);
assert.equal(handshakeStatusFromError(new NeedAllowError()), "need-allow");
assert.equal(handshakeStatusFromError(new Error("stack")), null);

console.log("browser connect selfcheck ok");
