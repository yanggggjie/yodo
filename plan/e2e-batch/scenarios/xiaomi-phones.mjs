export default async function (page) {
  await page.goto("https://www.mi.com/tw/phone/");
  await page.waitFor(`document.querySelectorAll('a[href*="/tw/product/"]').length >= 5`, "商品列表渲染", 20000);
  await page.scroll(800);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(800);
  await new Promise((r) => setTimeout(r, 2000));
}
