export default async function (page) {
  await page.goto("https://t.bilibili.com/");
  await page.waitFor(`document.querySelectorAll('.bili-dyn-item').length >= 3`, "动态列表渲染", 20000);
  await page.scroll(600);
  await new Promise((r) => setTimeout(r, 1500));
  await page.scroll(600);
  await new Promise((r) => setTimeout(r, 2000));
}
