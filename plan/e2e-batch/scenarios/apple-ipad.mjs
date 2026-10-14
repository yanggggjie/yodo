import { clickFirstVisible } from "../human.mjs";
export default async function (page) {
  await page.goto("https://www.apple.com.cn/ipad/");
  await page.waitFor(`document.querySelectorAll('a').length > 20`, "页面链接加载");
  await clickFirstVisible(page, 'a[href="/ipad-air/"]');
  await new Promise((r) => setTimeout(r, 2500));
}
