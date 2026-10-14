export default async function (page) {
  await page.goto("https://x.com/search?q=claude&src=typed_query&f=live");
  await page.waitFor(`document.querySelectorAll('article[data-testid="tweet"]').length >= 3`, "搜索结果渲染", 25000);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(700);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(700);
  await new Promise((r) => setTimeout(r, 2000));
}
