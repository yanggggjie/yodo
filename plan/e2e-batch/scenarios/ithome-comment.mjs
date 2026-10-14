import { clickFirstVisible } from "../human.mjs";
export default async function (page) {
  await page.goto("https://www.ithome.com/1/013/074.htm");
  await page.waitFor(`document.querySelectorAll('p').length >= 5`, "文章加载", 20000);
  await page.scroll(600);
  await clickFirstVisible(page, 'a#gocomm');
  await new Promise((r) => setTimeout(r, 3000));
  await page.scroll(400);
  await new Promise((r) => setTimeout(r, 2000));
}
