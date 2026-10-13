// 本地夹具网站：第一方 shop.localhost，第三方 tracker.localhost（同一个端口，按 Host 区分）。
// Chrome 把 *.localhost 指向本机；tldts 把它们当作不同的站点。内容只放用来看录制行为的必要部分。
import * as http from "node:http";

const items = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `商品 ${i + 1}`, price: 10 + i }));
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function startFixture() {
  let port = 0;
  const html = (res, body, status = 200) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  const json = (res, body, status = 200, extra = {}) => { res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if ((req.headers.host ?? "").startsWith("tracker.")) {
      const cors = { "access-control-allow-origin": "*" };
      if (url.pathname === "/pixel.gif") { res.writeHead(200, { "content-type": "image/gif", ...cors }); return res.end(GIF); }
      return json(res, { ok: true }, 200, cors);
    }
    switch (url.pathname) {
      case "/": return html(res, `<!doctype html><meta charset=utf-8><title>Shop</title><body style="margin:0">
<h1>Shop</h1>
<form id=login action="/login" method=post onsubmit="event.preventDefault(); fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:user.value,password:password.value})}).then(()=>document.title='logged in')">
  <input id=user name=user placeholder="用户名"><input id=password name=password type=password placeholder="密码"><button id=signin type=submit>登录</button>
</form>
<form id=search action="/search"><input id=q name=q placeholder="搜索商品"><button id=go type=submit>搜索</button></form>
<label><input type=checkbox id=agree> 同意条款</label>
<div style="height:2400px">filler</div>
<img src="http://tracker.localhost:${port}/pixel.gif?v=1">
<script>
  fetch('/api/items');            // 第一方 XHR，响应大于 1KB
  fetch('/missing');              // 404，应被丢弃
  for (let i = 0; i < 3; i++) fetch('http://tracker.localhost:${port}/collect?i=' + i);  // 第三方，同一个地址重复
</script></body>`);
      case "/api/items": return json(res, items);
      case "/search": return html(res, `<!doctype html><meta charset=utf-8><title>结果</title><h1>结果：${url.searchParams.get("q") ?? ""}</h1><a id=item href="/item/1">商品 1</a>`);
      case "/item/1": return html(res, `<!doctype html><meta charset=utf-8><title>商品 1</title><h1>商品 1</h1>`);
      case "/old": res.writeHead(302, { location: "/search?q=redirected" }); return res.end();
      case "/login": return json(res, { ok: true });
      default: return json(res, { error: "not found" }, 404);
    }
  });
  await new Promise((resolve) => server.listen(0, "::", resolve));
  port = server.address().port;
  return { base: `http://shop.localhost:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}
