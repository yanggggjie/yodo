// 默认场景：登录、搜索、勾选、滚动、点进商品。拿到的 page 是 src/dev/driver.ts 的 DevPage。
export default async function (page, base) {
  await page.goto(`${base}/`);
  await page.type("#user", "alice");
  await page.type("#password", "s3cret-pass");
  await page.click("#signin");
  await page.type("#q", "耳机 pro");
  await page.click("#agree");
  await page.scroll(600);
  await page.scroll(-600);
  await page.click("#go");
  await page.waitFor("location.pathname === '/search' && document.readyState === 'complete'", "搜索结果页");
  await page.click("#item");
  await page.waitFor("location.pathname === '/item/1' && document.readyState === 'complete'", "商品页");
}
