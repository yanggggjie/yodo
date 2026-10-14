export default async function (page) {
  // 搜索结果页直接打开（首页搜索框的提交在驱动里无效，见 e2e-batch-issues D1）
  await page.goto("https://s.taobao.com/search?q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98");
  await page.waitFor(`document.querySelectorAll('[class*=Card--], [class*=Card-]').length >= 3 || document.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]').length >= 3`, "搜索结果渲染", 25000);
  await new Promise((r) => setTimeout(r, 2000));
  await page.scroll(700);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(700);
  await new Promise((r) => setTimeout(r, 2000));
}
