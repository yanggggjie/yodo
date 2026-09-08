/**
 * 按 origin 找/开 page。脚本 import，不是 yodo 的 API。
 *
 * 只复用本次 run 窗里已挂上的同 origin tab，没有就在该窗现有 tab 上 goto。
 * 不挂、不关用户已有 tab。
 */
export async function pageForOrigin(browserContext, origin) {
  return browserContext.pageForOrigin(origin);
}
