---
name: yodo
description: >-
  yodo：用本机已登录的 Chrome 做事。
  触发：yodo；要在已打开或已登录的网站上做事；等人之后用户回「好了」。
---

用 `yodo` 操作用户本机 Chrome（复用已登录态）。命令会自己连。

**入口**：本文 `yodo` 是简写，实际执行 `node ~/.yodo/src/yodo.js <子命令>`（Windows 用 home 下 `.yodo/src/yodo.js` 的绝对路径，`~` 不展开）。
**首次**：`~/.yodo/src` 不存在，就在本 skill 目录执行 `node setup.js`（把 `~/.yodo/src` 链接到 skill 源码——个别环境降级为拷贝——并建数据目录），再继续。
**边界**：`~/.yodo/src` 是 yodo 源码（通常是指向 skill 目录的链接），更新会整体覆盖；你的脚本只放 `~/.yodo/{task,tmp}`，更新不碰。改了源码可 `cd ~/.yodo/src && npx tsc --noEmit` 自检（运行期只 strip 类型、不做类型检查）。

有 `guide` → 原样念出，停，等「好了」。
对人说「用户目标」。`success` 后报告结果：做了什么（用 `result` / `resultFile`），并念 `result.url`——它直达结果页。
`task` 只指 `~/.yodo/task/*.js`。
先看 `~/.yodo/`，再写。目录与命令见文末「文件目录+CLI 设计」。

```text
用户目标 → 查 task/
              ├── 有 → yodo run <task> → 报告结果
              └── 没有 → record → 读抓包 → yodo run <tmp>
                            ├── success → mv → yodo run <task> → 报告结果
                            └── 5 次 failure → 停，写原因
```

## 1. 查 `task/`

`~/.yodo/task/*.js` 是已验证脚本。文件头有 `@summary`；有 `@param api.args.*` 的，`run` 时带 `--args` 或 `--args-file`。

按用户目标找能用的（怎么查自定）。

- 能直接跑 → `yodo run ~/.yodo/task/<name>.js`
- 现有 task 拼得起来 → 在 `tmp/` 写新文件（不改原文件），再 `run`
- 没有可跑的、又拼不出来 → `record`；没抓包不要先写脚本

完成：已经判定「能直接跑 / 能拼 / 没有」，并且已经 `run` 过匹配的文件，或已决定 record。

## 2. record

`yodo record start [name]` → 有 `guide` 就念，等「好了」→ `yodo record stop`。
只在新窗口做；已有窗不录。`stop` / `abort` 只关录制窗。

完成：`status: stopped` 且有 `recordDir`。`aborted` / `idle` = 没有可用抓包，停。

## 3. 读抓包，在 `tmp/` 里 `run`

`timeline.jsonl` 是抓包索引（小）：每行 `type`、`requestType`、`method`、`url`、`file`。
先从 timeline 定要重放的接口，再打开对应的 request（`01_GET_host.json`，小）：`url`、`frameUrl`、`headers`、`body`；这里的 `status` 是 HTTP，不是 CLI 枚举。
`*.response.json` / `*.response.html` 是拆出的响应体，大，不要整份读。

只重放抓到的请求；没有的不要补。
`late` 的 `mainDoc` 是迟到的页面快照（没有 `method` / HTTP `status`），比一次 HTML GET 信息更丰富。在这份快照里找信息；也可以对该 `url` 再做 HTML GET。不允许操作 DOM，也不允许拿 DOM 快照来操作。

在 `~/.yodo/tmp/<name>.js` 写脚本，按抓包在 `page.evaluate` 里发请求。`import` `_common/page-for-origin.js`。`args` 可缺省。`goto` 没有 `waitUntil`。

```javascript
export default async ({ browserContext, args }) => {
  const page = await pageForOrigin(browserContext, origin);
  return page.evaluate(async () => { /* fetch / XHR */ });
}
```

返回 `result.url` = 直达结果页的 URL：`import` `_common/url.js`，`serializeUrl({ bareUrl, query })` 由 args 现拼——`bareUrl` 取抓包里结果页那一发 `mainDoc`/`frameUrl`（不是 `fetch` 端点），`query` 取页面地址栏的那几个键（页面 query，不是 API 全套参数）。页面靠路径的就深链（如 `/pin/<id>`）；API 返回 id 时深链到那一条。

同一接口最多 5 次 `run`（只计有 `status` 的；只有 `error` 不算）。`failure` 且 403 可改页内 XHR 再试。页内太慢就减小数据量，不要加 `--timeout`。

- `status: success` → 写上 `@summary` 和用到的 `@param api.args.*`，`mv ~/.yodo/tmp/<name>.js ~/.yodo/task/<name>.js`，再 `run`。
- 5 次 `failure` → 停，写：接口、原因、试了什么。没出现 `status: success` 不准进 `task/`。

完成：`mv` 完成并 `run` 成功，或已写出原因并停。

## `CLI status`

有 `status` 按下表；只有 `error`、没有 `status`：命令没跑起来，停，不算进 5 次。`error` 一律是字符串。

| `status` | 做 |
|---|---|
| `need-*` / `recording` | 念 `guide`，停，等「好了」 |
| `stopped` | 读 `recordDir` |
| `success` | 用 `result` 或 `resultFile`；tmp 要留下 → `mv`。报告结果。 |
| `failure` | 已执行并抛错。不到 5 次就改再 `run` |
| `idle` / `aborted` | 没有可用抓包 |

卡住了杀 `~/.yodo/session/pid`。stdout 不够再看 `session/log.jsonl`。

## 文件目录+CLI 设计

```text
~/.yodo/
  task/      已验证脚本。小，任意读。
  tmp/       未验证脚本。唯一能随便写的地方。小，任意读。
  record/    抓包。record stop 后才有可用目录。
             timeline.jsonl              索引。行：type、requestType、method、url、file。小，任意读。
             01_GET_host.json            request：url（bareUrl + query）、frameUrl、headers、body；这里的 status 是 HTTP，不是 CLI 枚举。小，任意读。
             01_GET_host.response.json   响应体 > 1KB 时拆出。大，不要整份读。
             01_GET_host.response.html   整页 HTML。大，不要整份读。
  session/   pid · sock · log.jsonl。没有对应的 yodo 子命令。
```

大、不要整份读：`*.response.json`、`*.response.html`。

`recording` 时不要读 `record/.active/`。

`mv` 是 Unix `mv`，不是 yodo 子命令。

| 命令 | 读 | 写 |
|---|---|---|
| `yodo init` | — | 建 `task/`、`tmp/`、`record/`、`session/`（`setup.js` 已自动调） |
| `yodo doctor` | `~/.yodo/` | — 打印 Node 版本、布局、holder 状态 |
| `yodo record start [name]` | — | 开始往 `record/.active/<name>/` 抓；stdout：`recording` + `guide`（无 `recordDir`） |
| `yodo record stop` | — | 归档到 `record/<name>/`；stdout：`stopped` + `recordDir` |
| `yodo record abort` | — | 扔掉这次抓包；stdout：`aborted`。当时没在录：`idle` |
| `yodo run <file>` | `<file>`，来自 `task/` 或 `tmp/` | 不改脚本。`success` 时大切结果可在脚本同目录留下 `output.json`，stdout 给 `resultFile` |
| `mv tmp/… task/…` | — | 只有 `status: success` 之后 |
