/**
 * ESM loader：给本地 `.js` import 带上文件 mtime。
 *
 * `yodo run` 只给任务入口加 `?t=`，手册片段是传递 import，改完片段再跑会静默
 * 用 cache。按 mtime 戳 URL 后，改文件即失效。同一轮加载里 mtime 不变，同一
 * 模块仍只实例化一次。
 */
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ResolveContext = { parentURL?: string };
type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Promise<{ url: string; format?: string | null; shortCircuit?: boolean }>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<{ url: string; format?: string | null; shortCircuit?: boolean }> {
  const r = await nextResolve(specifier, context);
  if (!r.url.startsWith("file:")) return r;
  const u = new URL(r.url);
  if (u.searchParams.has("t")) return r;
  if (u.pathname.includes("/node_modules/")) return r;
  if (!/\.(m?js)$/.test(u.pathname)) return r;
  try {
    u.searchParams.set("t", String(statSync(fileURLToPath(u)).mtimeMs));
    return { url: u.href, shortCircuit: true, format: r.format ?? "module" };
  } catch {
    return r;
  }
}
