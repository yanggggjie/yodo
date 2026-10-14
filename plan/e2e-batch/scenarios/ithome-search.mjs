import { clickFirstVisible } from "../human.mjs";
export default async function (page) {
  await page.goto("https://www.ithome.com/");
  await page.waitFor(`document.querySelectorAll('a').length > 20`, "首页加载");
  await page.click('input[name="q"]');
  await page.type('input[name="q"]', "iPhone");
  await page.press("Enter");
  await page.waitFor(`location.href.includes("q=") || location.href.includes("search")`, "搜索结果页", 15000);
  await new Promise((r) => setTimeout(r, 2500));
  await page.scroll(400);
  await new Promise((r) => setTimeout(r, 1000));
}
