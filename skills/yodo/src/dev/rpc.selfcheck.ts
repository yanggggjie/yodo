import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RawCdpConnection } from "../browser/index.ts";

// constants 在加载时按 HOME 计算路径：先把 HOME 指到临时目录再动态 import，避免碰真实数据。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yodo-dev-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { devRpc, DEV_FLAG } = await import("./rpc.ts");

const sent: { method: string; params: unknown; sessionId?: string }[] = [];
const raw = {
  ops: { listOwned: async () => ({ tabs: [{ tabId: 7, windowId: 1, url: "http://a.test/", title: "yodo record" }] }) },
  send: async (method: string, params: unknown, sessionId?: string) => { sent.push({ method, params, sessionId }); return { ok: true }; },
} as unknown as RawCdpConnection;

try {
  // 默认关闭：标记文件不存在时一律拒绝
  await assert.rejects(devRpc("dev.pages", {}, raw), /dev 未开启/);

  fs.mkdirSync(path.dirname(DEV_FLAG), { recursive: true });
  fs.writeFileSync(DEV_FLAG, "");
  assert.deepEqual(await devRpc("dev.pages", {}, raw), [{ pageId: "7", windowId: 1, url: "http://a.test/", title: "yodo record" }]);

  // 会关掉录制器已启用的域，或越出 yodo 页面的命令一律拒绝
  for (const method of ["Page.disable", "Network.disable", "Target.attachToTarget", "Browser.close", ""]) {
    await assert.rejects(devRpc("dev.cdp", { pageId: "7", method }, raw), /不允许/, method);
  }
  // 不属于 yodo 的页面（用户自己的 tab）拒绝
  await assert.rejects(devRpc("dev.cdp", { pageId: "999", method: "Runtime.evaluate" }, raw), /不属于 yodo/);
  assert.equal(sent.length, 0, "被拒绝的命令不能发出去");

  // 正常：按页面转发，sessionId 就是 pageId
  assert.deepEqual(await devRpc("dev.cdp", { pageId: "7", method: "Runtime.evaluate", params: { expression: "1" } }, raw), { ok: true });
  assert.deepEqual(sent, [{ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "7" }]);

  // 关闭后立即生效，不需要重启
  fs.rmSync(DEV_FLAG);
  await assert.rejects(devRpc("dev.pages", {}, raw), /dev 未开启/);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("dev rpc selfcheck ok");
