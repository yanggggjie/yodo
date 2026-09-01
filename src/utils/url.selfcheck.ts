import assert from "node:assert/strict";
import { parseUrl, serializeUrl, urlOrigin, isSameSite, registrableDomain } from "./url.js";

const encoded = parseUrl(
  "https://example.com/search?type=content&q=%E9%9F%A9%E5%9B%BD",
);
assert.equal(encoded.bareUrl, "https://example.com/search");
assert.equal(encoded.query.type, "content");
assert.equal(encoded.query.q, "韩国");
assert.equal(
  serializeUrl({ bareUrl: "https://example.com/search", query: { q: "韩国" } }),
  "https://example.com/search?q=%E9%9F%A9%E5%9B%BD",
);
assert.equal(urlOrigin(encoded), "https://example.com");

assert.equal(registrableDomain(parseUrl("https://www.zhihu.com/path")), "zhihu.com");
assert.equal(registrableDomain(parseUrl("https://api.zhihu.com/x")), "zhihu.com");
assert.ok(isSameSite(parseUrl("https://www.zhihu.com/a"), parseUrl("https://api.zhihu.com/b")));
assert.ok(!isSameSite(parseUrl("https://www.zhihu.com/a"), parseUrl("https://hm.baidu.com/b")));

const plain = parseUrl("https://example.com/path");
assert.deepEqual(plain.query, {});
assert.equal(serializeUrl(plain), "https://example.com/path");

console.log("url selfcheck ok");
