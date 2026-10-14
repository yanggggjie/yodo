import { clickFirstVisible } from "../human.mjs";
export default async function (page) {
  await page.goto("https://x.com/home");
  await page.waitFor(`document.querySelectorAll('article[data-testid="tweet"]').length >= 3`, "时间线渲染", 20000);
  // 切到"正在关注"标签（真人会点它）
  await clickFirstVisible(page, '[role="tab"]:not([aria-selected="true"])');
  await page.waitFor(`document.querySelectorAll('article[data-testid="tweet"]').length >= 3`, "关注时间线渲染", 20000);
  await page.scroll(700);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(700);
  await new Promise((r) => setTimeout(r, 2000));
}
