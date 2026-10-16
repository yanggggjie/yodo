// 场景：重定向、下拉框、confirm 对话框、单页应用路由、target=_blank 新标签、跨站 iframe。
import { findPage } from "../../skills/yodo/src/dev/driver.ts";
import { sessionRpc } from "../../skills/yodo/src/cli/rpc.ts";

export default async function (page, base) {
  await page.goto(`${base}/old`);                       // 302 → /search?q=redirected
  await page.goto(`${base}/widgets`);
  await page.eval("document.querySelector('#color').focus()");
  await page.press("g");                                // 不点开原生下拉，用字符键切换到 green
  const clicking = page.click("#confirm");              // confirm 会阻塞页面，这次点击要等对话框处理完才返回，所以先不 await
  for (let i = 0; i < 30; i++) {                        // 录制期间由用户自己选，holder 不会替他点；这里选"取消"
    if (await page.cdp("Page.handleJavaScriptDialog", { accept: false }).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await clicking;
  console.log("confirm 的结果（标题）：", await page.eval("document.title"));
  await page.click("#spa");                             // pushState，不新建文档
  await page.click("#blank");                           // 新标签
  await new Promise((r) => setTimeout(r, 1500));
  console.log("点击新标签后的页面：", JSON.stringify(await sessionRpc("dev.pages", {}, 5000)));
  const tab = await findPage("商品 1", 3000).catch((e) => { console.log("新标签：", e.message.slice(0, 80)); return null; });
  await tab?.click("#buy").catch((e) => console.log("新标签点击失败：", e.message.slice(0, 120)));
  await new Promise((r) => setTimeout(r, 500));
}
