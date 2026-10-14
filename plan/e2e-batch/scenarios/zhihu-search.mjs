export default async function (page) {
  await page.goto("https://www.zhihu.com/search?type=content&q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98");
  await page.waitFor(`document.querySelectorAll('.SearchResult-Card, [class*=SearchResult-Card]').length >= 2`, "搜索结果渲染", 25000);
  await new Promise((r) => setTimeout(r, 2000));
  await page.scroll(600);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(600);
  await new Promise((r) => setTimeout(r, 2000));
}
