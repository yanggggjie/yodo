---
name: yodo
description: >-
  yodo：用本机已登录的 Chrome 做事。
  触发：yodo；要在已打开或已登录的网站上做事；等人之后用户回「好了」。
---

用 yodo 操作用户本机 Chrome（复用已登录态）。没有 CLI，只有脚本：

**跑 task**：`node ~/.yodo/task/<name>.js [参数]`（task 是自执行脚本，参数走命令行 argv）。
**record**：`node ~/.yodo/src/bin/record-start.js [name]` / `record-stop.js` / `record-abort.js`。
**其它**：`node ~/.yodo/src/bin/{start,stop,doctor,init}.js`。
（Windows 用 home 下 `.yodo/...` 的绝对路径，`~` 不展开。）

**首次**：`~/.yodo/src` 不存在，就在本 skill 目录执行 `node setup.js`（把 `~/.yodo/src` 链接到 skill 源码——个别环境降级为拷贝——并建数据目录），再继续。
**授权**：首次 `start` 或首个操作时，Chrome 会要一次远程调试授权（弹窗/infobar，念 `guide` 让用户点允许）；holder 保持期间免打扰，`stop` 或超时后需再授权一次。
**边界**：`~/.yodo/src` 是 yodo 源码（通常是指向 skill 目录的链接），更新会整体覆盖；你的脚本只放 `~/.yodo/{task,tmp}`，更新不碰。改了源码可 `cd ~/.yodo/src && npx tsc --noEmit` 自检（运行期只 strip 类型、不做类型检查）。

有 `guide` → 原样念出，停，等「好了」。
对人说「用户目标」。`success` 后报告结果：做了什么（用 `result` / `resultFile`），并念 `result.url`——它直达结果页。
`task` 只指 `~/.yodo/task/*.js`。
先看 `~/.yodo/`，再写。目录见文末。

```text
用户目标 → 查 task/
              ├── 有 → node task/<name>.js → 报告结果
              └── 没有 → record → 读抓包 → node tmp/<name>.js
                            ├── success → mv → node task/<name>.js → 报告结果
                            └── 5 次 failure → 停，写原因
```

## 1. 查 `task/`

`~/.yodo/task/*.js` 是已验证的自执行脚本。文件头有 `@summary`；用到的参数在头注释里写清对应 argv 位置。

按用户目标找能用的（怎么查自定）。

- 能直接跑 → `node ~/.yodo/task/<name>.js <参数>`
- 现有 task 拼得起来 → 在 `tmp/` 写新文件（不改原文件），再 `node ~/.yodo/tmp/<name>.js`
- 没有可跑的、又拼不出来 → `record`；没抓包不要先写脚本

完成：已经判定「能直接跑 / 能拼 / 没有」，并且已经跑过匹配的文件，或已决定 record。

## 2. record

`node ~/.yodo/src/bin/record-start.js [name]` → 有 `guide` 就念，等「好了」→ `node ~/.yodo/src/bin/record-stop.js`。
只在新窗口做；已有窗不录。stop / abort 只关录制窗。

完成：`status: stopped` 且有 `recordDir`。`aborted` / `idle` = 没有可用抓包，停。

## 3. 读抓包，在 `tmp/` 里跑

`timeline.jsonl` 是抓包索引（小）：每行 `type`、`requestType`、`method`、`url`、`file`。
先从 timeline 定要重放的接口，再打开对应的 request（`01_GET_host.json`，小）：`url`、`frameUrl`、`headers`、`body`；这里的 `status` 是 HTTP，不是 yodo 枚举。
`*.response.json` / `*.response.html` 是拆出的响应体，大，不要整份读。

只重放抓到的请求；没有的不要补。
`late` 的 `mainDoc` 是迟到的页面快照（没有 `method` / HTTP `status`），比一次 HTML GET 信息更丰富。在这份快照里找信息；也可以对该 `url` 再做 HTML GET。不允许操作 DOM，也不允许拿 DOM 快照来操作。

在 `~/.yodo/tmp/<name>.js` 写**自执行脚本**：`import` `../task/_common/yodo.js`，在 `await yodo.run(...)` 里按抓包在 `page.evaluate` 发请求。参数走 `process.argv`，可缺省。`goto` 没有 `waitUntil`。

```javascript
import { yodo, pageForOrigin, serializeUrl } from "../task/_common/yodo.js";
const ORIGIN = "https://example.com";
const q = process.argv[2] ?? "默认值";   // 参数 = argv，不用 --args
await yodo.run(async ({ browserContext }) => {
  const page = await pageForOrigin(browserContext, ORIGIN);
  await page.goto(serializeUrl({ bareUrl: `${ORIGIN}/search`, query: { q } }));
  const data = await page.evaluate(async (q) => {
    /* 带登录态 fetch / XHR；只能用可序列化参数，不能闭包外层变量 */
    return {};
  }, q);
  return { ...data, url: serializeUrl({ bareUrl: `${ORIGIN}/search`, query: { q } }) };
});
```

`yodo.run` 把 `{status:"success", result}` 或 `{status:"failure", error}` 直出 stdout。

返回 `result.url` = 直达结果页的 URL：`serializeUrl({ bareUrl, query })` 由参数现拼——`bareUrl` 取抓包里结果页那一发 `mainDoc`/`frameUrl`（不是 `fetch` 端点），`query` 取页面地址栏的那几个键（页面 query，不是 API 全套参数）。页面靠路径的就深链（如 `/pin/<id>`）；API 返回 id 时深链到那一条。

同一接口最多 5 次跑（只计有 `status` 的；只有 `error` 不算）。`failure` 且 403 可改页内 XHR 再试。页内太慢就减小数据量。

- `status: success` → 写上 `@summary` 和参数说明，`mv ~/.yodo/tmp/<name>.js ~/.yodo/task/<name>.js`，再跑。
- 5 次 `failure` → 停，写：接口、原因、试了什么。没出现 `status: success` 不准进 `task/`。

完成：`mv` 完成并跑成功，或已写出原因并停。

## `status`

有 `status` 按下表；只有 `error`、没有 `status`：命令没跑起来，停，不算进 5 次。`error` 一律是字符串。

| `status` | 做 |
|---|---|
| `need-*` / `recording` | 念 `guide`，停，等「好了」 |
| `stopped` | 读 `recordDir` |
| `success` | 用 `result` 或 `resultFile`；tmp 要留下 → `mv`。报告结果。 |
| `failure` | 已执行并抛错。不到 5 次就改再跑 |
| `idle` / `aborted` | 没有可用抓包 |

卡住了杀 `~/.yodo/session/pid`。stdout 不够再看 `session/log.jsonl`。

## 文件目录

```text
~/.yodo/
  src/       yodo 源码（指向 skill 的链接）。bin/ 在 src/bin/。别在这写业务脚本。
  task/      已验证的自执行脚本 + _common/。小，任意读。
  tmp/       未验证脚本。唯一能随便写的地方。小，任意读。
  record/    抓包。record stop 后才有可用目录。
             timeline.jsonl              索引。行：type、requestType、method、url、file。小，任意读。
             01_GET_host.json            request：url（bareUrl + query）、frameUrl、headers、body；这里的 status 是 HTTP。小，任意读。
             01_GET_host.response.json   响应体 > 1KB 时拆出。大，不要整份读。
             01_GET_host.response.html   整页 HTML。大，不要整份读。
  session/   pid · sock · log.jsonl。
```

大、不要整份读：`*.response.json`、`*.response.html`。
`recording` 时不要读 `record/.active/`。
`mv` 是 Unix `mv`。

| 脚本 | 读 | 写 |
|---|---|---|
| `node src/bin/init.js` | — | 建 `task/`、`tmp/`、`record/`、`session/`（`setup.js` 已自动调） |
| `node src/bin/start.js` | — | 拉起 holder 并连 Chrome（点一次授权后保持）；`ok` 或 `need-*` |
| `node src/bin/stop.js` | — | 停 holder（授权失效） |
| `node src/bin/doctor.js` | `~/.yodo/` | 打印 Node 版本、运行路径、holder 与授权状态、布局 |
| `node src/bin/record-start.js [name]` | — | 开始往 `record/.active/<name>/` 抓；stdout：`recording` + `guide` |
| `node src/bin/record-stop.js` | — | 归档到 `record/<name>/`；stdout：`stopped` + `recordDir` |
| `node src/bin/record-abort.js` | — | 扔掉这次抓包；`aborted`。当时没在录：`idle` |
| `node task/<name>.js [参数]` | `<file>` | 不改脚本。`success` 时大结果落脚本同目录 `output.json`，stdout 给 `resultFile` |
| `mv tmp/… task/…` | — | 只有 `status: success` 之后 |
