/**
 * dev 通道：本地验证用，默认关闭。设计与约束见 AGENTS.md 2.3。
 * 开关是标记文件 ~/.yodo/session/dev，每次请求都检查，不需要重启 holder。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SESSION_DIR } from "../utils/constants.ts";
import { RPC_ERRORS } from "../protocol.ts";
import type { RawCdpConnection } from "../browser/index.ts";

export const DEV_FLAG = path.join(SESSION_DIR, "dev");

/** 会关掉录制器已启用的域，或越出 yodo 自己页面的命令。 */
const DENIED = /\.disable$|^Target\.|^Browser\./;

function fail(message: string, code: number): never {
  throw Object.assign(new Error(message), { code });
}

export async function devRpc(method: "dev.pages" | "dev.cdp", params: Record<string, unknown>, raw: RawCdpConnection): Promise<unknown> {
  if (!fs.existsSync(DEV_FLAG)) fail(`dev 未开启：touch ${DEV_FLAG}`, RPC_ERRORS.METHOD_NOT_FOUND);
  if (method === "dev.pages") {
    const { tabs } = await raw.ops.listOwned();
    return tabs.map((t) => ({ pageId: String(t.tabId), windowId: t.windowId, url: t.url, title: t.title }));
  }
  const cdp = String(params.method ?? "");
  if (!cdp || DENIED.test(cdp)) fail(`dev.cdp 不允许：${cdp || "(空)"}`, RPC_ERRORS.INVALID_PARAMS);
  // 只要是扩展纳入的页面就行（录制器自己 attach 的新标签不在 CdpContext 里）；是否已 attach 由扩展检查
  const pageId = String(params.pageId ?? "");
  const { tabs } = await raw.ops.listOwned();
  if (!tabs.some((t) => String(t.tabId) === pageId)) fail(`page 不属于 yodo：${pageId}`, RPC_ERRORS.PAGE_NOT_FOUND);
  return raw.send(cdp, (params.params as Record<string, unknown> | undefined) ?? {}, pageId, typeof params.timeoutMs === "number" ? params.timeoutMs : undefined);
}
