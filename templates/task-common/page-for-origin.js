/**
 * 按 origin 找/开 page。脚本 import，不是 yodo 的 API。找不到就打开。
 *
 * 复用用户已打开的 tab（登录态就在那里），没有才新开。
 * 不关用户已有 tab；自己 newPage 开的可自己收。
 */
export async function pageForOrigin(browserContext, origin) {
  return browserContext.pageForOrigin(origin);
}
