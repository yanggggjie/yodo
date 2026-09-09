# use case

来源：现有 `SKILL.md`、`skills/.temp-txt/`、`install.md`（安装不进本文件）、`src/bin/*.js`、`templates/task-common`。用户要求：完全重构；没有相关任务脚本、或无法组合完成任务时，立刻开录让用户演示，不要自主探索。

一条 use case：完成一个具体目标而进行的一组操作，并得到可观察结果。不是「第几步」，也不是注意事项。执行本 skill 时 `.yodo` 已立好。

## 跑已有 task
目标：用户要做的事，`.yodo/task/*.js` 里已有对得上的已验证脚本，跑完并对人讲结果。
操作：
- 分类：能直接跑 → `task/*.js` 里有对得上的；没有对得上的 → 不要自己打开站点查看，不要写脚本探接口，不要猜 URL，去「录用户操作」
- 按用户任务找 `task/*.js`（怎么查自定）
- 读文件头 `@summary`；用到的参数写在头注释里，对应 `argv` 位置
- 跑：`node <home>/.yodo/task/<name>.js [参数]`；参数走 `process.argv`，可缺省；不要改这份脚本
- 需要浏览器时命令会自己连
- stdout 对照：

| stdout | 做什么 |
|---|---|
| `need-install` / `need-chrome` / `need-remote-debugging` / `need-allow` | 把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide` |
| 只有 `error`、没有 `status` | 命令没跑起来，停，对人说明没跑起来 |
| `status: success` | 对人说这次做成了什么，用 `result` 或 `resultFile`。只说任务本身 |
| `status: failure` | 已经执行并抛错：停，对人说明原因，不要改 `task/` 里的原文件 |

- `success` 时大结果超过约 8KB 会落同目录 `output.json`，stdout 给 `resultFile`，打开它再讲
- 检验用的页面地址不要从脚本 return 里取。打开刚跑的那份 `task/*.js`，按它的 origin、`goto` / 路径模板、这次 argv，以及 `result` 里的 id，现拼用户能打开核对的 URL：必须带正确的 path 和 query。不要拿 fetch 端点当检验地址。页面靠路径的就深链（如 `/pin/<id>`）；query 用页面地址栏那几个键，不是 API 全套参数
- 跑 `task/` 不计入本用户任务的 8 次，也不计入同一接口的 3 次
- 卡住了杀 `session/pid`（断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`
- 用户要求断开连接时才跑 `node <home>/.yodo/src/bin/stop.js`
- 要先点一次授权也可以跑 `node <home>/.yodo/src/bin/start.js`（`ok` 即可继续；`need-*` 同样念 `guide`、等「好了」、再重跑），但跑 task 本身已经会连，不是必经
可观察结果：已跑过对得上的文件，并对人讲了结果；或已把 `guide` 念出并在等「好了」；或现成 task `failure` 后已停并说明。没有对得上的：已转入录用户操作，没有先探索站点。

## 组合现有 task
目标：没有一份直接对应，但现有脚本能拼成这次要的——只用这些脚本里已经验证过的逻辑，不发明新接口。
操作：
- 分类：能拼 → 只用现有脚本里已经验证过的逻辑，在 `tmp/` 写新文件；拼不成（需要现有脚本里没有的接口，或同一接口满 3 次还没 `success` 且合计未满 8）→ 去「录用户操作」；合计满 8 次还没 `success` → 停，对人说明试了什么、为什么不成，不要再跑 `tmp/`，不要开录
- 在 `.yodo/tmp/` 写新文件，不改 `task/` 原文件
- `import` `../task/_common/yodo.js`（`tmp` 里的文件用这条相对路径）
- 跑：`node <home>/.yodo/tmp/<name>.js [参数]`
- 需要浏览器时命令会自己连
- stdout 对照：

| stdout | 做什么 |
|---|---|
| `need-install` / `need-chrome` / `need-remote-debugging` / `need-allow` | 把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide` |
| 只有 `error`、没有 `status` | 命令没跑起来，停，对人说明；这次不计入同一接口的 3 次，也不计入本用户任务的 8 次 |
| `status: success` | 写上 `@summary` 和参数说明，只有出现过 `status: success` 才能 `mv` |
| `status: failure` | 同一接口不到 3 次、合计不到 8 次：改 `tmp/` 再跑 |

- 硬规则：本用户任务内，`node <home>/.yodo/tmp/` 且 stdout 为 `status: success` 或 `status: failure` 的次数合计最多 8；同一接口最多 3。先碰到哪条停哪条。不要第 4 次（同一接口），不要第 9 次（合计）。`need-*` 等人「好了」后重跑同一条、只有 `error` 没有 `status`、以及 `node .../task/`（含 `mv` 之后那遍）：都不算
- 没出现过 `success` 不准把脚本放进 `task/`
- `success` 后：`mv <home>/.yodo/tmp/<name>.js <home>/.yodo/task/<name>.js`（Unix `mv`，不是 yodo 子命令），再 `node <home>/.yodo/task/<name>.js [参数]`
- task 这遍同样会自己连浏览器；`need-*` 就把 `guide` 原样念给用户，停，等「好了」，再重跑
- 这遍 `success`：对人说这次做成了什么，用 `result` 或 `resultFile`。只说任务本身。大结果落同目录 `output.json` 时，打开 `resultFile` 再讲
- 检验用的页面地址不要从脚本 return 里取。打开刚跑的那份 `task/*.js`，按它的 origin、`goto` / 路径模板、这次 argv，以及 `result` 里的 id，现拼用户能打开核对的 URL：必须带正确的 path 和 query。不要拿 fetch 端点当检验地址。页面靠路径的就深链（如 `/pin/<id>`）；query 用页面地址栏那几个键，不是 API 全套参数
- 卡住了杀 `session/pid`（断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`
- 不要自己打开站点查看，不要写脚本探接口，不要猜请求
可观察结果：`tmp` 上出现过 `status: success`，`task/` 多了一份能再跑成功的文件，并对人讲了结果；或已转入录用户操作（拼不成 / 同一接口满 3 次）；或合计满 8 次后已停并报告。没有先自主探索。没出现过 `success` 不准进 `task/`。

## 录用户操作
目标：没有相关 task、或现有脚本拼不成这次任务时，立刻开录，让用户在新窗口演示一遍，拿到可读的抓包。
操作：
- 分类：该录 → 没有相关 task，或现有脚本拼不成（含同一接口满 3 次还没 success，合计未满 8）；不要录 → 合计已满 8 次还没 success；不要这次了 → `record-abort.js`
- 不要先自己打开站点查看、写脚本探接口、猜请求，再决定要不要录
- 只在新窗口做，已有窗不录。`stop` / `abort` 只关录制窗。5 分钟到会按 stop 归档
- 开录：`node <home>/.yodo/src/bin/record-start.js [name]`
- 需要浏览器时命令会自己连
- stdout 对照：

| stdout | 做什么 |
|---|---|
| `need-install` / `need-chrome` / `need-remote-debugging` / `need-allow` | 把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide` |
| `status: recording` | 把 `guide` 原样念给用户（请用户在新窗口做一遍），停，等用户回「好了」，再 `node <home>/.yodo/src/bin/record-stop.js`。这时还没有 `recordDir`，不要读 `record/.active/` |
| `status: stopped` 且有 `recordDir` | 去读这个目录 |
| `aborted` | 对人说明这次不要了；没有可用抓包，停 |
| `idle` | 对人说明当时没在录；没有可用抓包，停 |

- 不要这次了：`node <home>/.yodo/src/bin/record-abort.js`
- `recordDir` 里的文件：

| 文件 | 是什么 | 怎么读 |
|---|---|---|
| `timeline.jsonl` | 索引。行：`type`、`requestType`、`method`、`url`、`file` | 小，任意读 |
| `01_GET_host.json` | request：`url`（`bareUrl` + `query`）、`frameUrl`、`headers`、`body`；这里的 `status` 是 HTTP，不是 yodo 的 `status` | 小，任意读 |
| `01_GET_host.response.json` | 响应体 > 1KB 时拆出 | 大，不要整份读 |
| `01_GET_host.response.html` | 整页 HTML | 大，不要整份读 |

- 卡住了杀 `session/pid`（断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`
可观察结果：`status: stopped` 且手上有 `recordDir`，可以去写重放；或已说明没有抓到并停（`aborted` / `idle`）。开录之前没有自己打开站点、没有写探接口脚本。合计已满 8 次还没 success 时没有开录。

## 对着抓包写出脚本
目标：把抓到的请求变成可重复跑的自执行脚本。没有抓包就不要做这条。
操作：
- 分类：只重放抓到的请求；没抓到的不补、不猜。只发网络请求，不操作 DOM，也不拿 DOM 快照来操作。正路是复用已登录的 origin 页，在页内 `fetch` / XHR
- 先读 `timeline.jsonl`（小，索引），定要重放的接口，再打开对应的 request JSON（小）
- `late` 的 `mainDoc` 是迟到的页面快照，没有 `method`、也没有 HTTP `status`，比一次 HTML GET 信息更丰富：在这份快照里找信息，也可以对那个 `url` 再做 HTML GET
- 在 `tmp/<name>.js` 写自执行脚本，然后 `node <home>/.yodo/tmp/<name>.js [参数]`：

```javascript
import { yodo, pageForOrigin, serializeUrl } from "../task/_common/yodo.js";
const ORIGIN = "https://example.com";
const q = process.argv[2] ?? "默认值";
await yodo.run(async ({ browserContext }) => {
  const page = await pageForOrigin(browserContext, ORIGIN);
  await page.goto(serializeUrl({ bareUrl: `${ORIGIN}/search`, query: { q } }));
  const data = await page.evaluate(async (q) => {
    /* 带登录态 fetch / XHR；只能用可序列化参数，不能闭包外层变量 */
    return {};
  }, q);
  return data;
});
```

- `_common/yodo.js` 给出 `yodo`、`pageForOrigin`、`serializeUrl`、`parseUrl`。`pageForOrigin(browserContext, origin)` 只复用本次 run 窗里同 origin 的 page，没有就在该窗现有 tab 上 goto；不挂用户已有 tab。`yodo.run` 在本进程跑闭包，浏览器操作发给已连上的 Chrome；闭包 return 的值变成 stdout 的 `result`。不要在 return 里写 `url`
- `page.goto(url, { timeout }?)` 没有 `waitUntil`。`page.evaluate(fn, ...args)` 只能传可 JSON 序列化的参数。`page.url()` / `page.title()` / `page.close()` / `page.bringToFront()` / `browserContext.newPage()` 也在，写重放用不到就别用
- 需要浏览器时命令会自己连
- stdout 对照：

| stdout | 做什么 |
|---|---|
| `need-install` / `need-chrome` / `need-remote-debugging` / `need-allow` | 把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide` |
| 只有 `error`、没有 `status` | 命令没跑起来，停，对人说明；这次不计入同一接口的 3 次，也不计入本用户任务的 8 次 |
| `status: success` | 写上 `@summary` 和参数说明，只有出现过 `status: success` 才能 `mv` |
| `status: failure` 且 403 | 多半是缺客户端签名，改走页内 XHR（站点常 monkey-patch `XMLHttpRequest`，会自动注入 `a_bogus` / `X-Bogus`），比手写逆向稳。页内太慢就减小数据量 |
| `status: failure` | 同一接口不到 3 次、合计不到 8 次：改 `tmp/` 再跑 |

- 硬规则：本用户任务内，`node <home>/.yodo/tmp/` 且 stdout 为 `status: success` 或 `status: failure` 的次数合计最多 8（含组合阶段已用掉的）；同一接口最多 3。先碰到哪条停哪条。不要第 4 次（同一接口），不要第 9 次（合计）。`need-*` 等人「好了」后重跑同一条、只有 `error` 没有 `status`、以及 `node .../task/`（含 `mv` 之后那遍）：都不算
- 没出现过 `success` 不准把脚本放进 `task/`
- `success` 后：`mv <home>/.yodo/tmp/<name>.js <home>/.yodo/task/<name>.js`，再 `node <home>/.yodo/task/<name>.js [参数]`
- task 这遍会自己连浏览器；`need-*` 就把 `guide` 原样念给用户，停，等「好了」，再重跑
- 这遍 `success`：对人说这次做成了什么，用 `result` 或 `resultFile`。只说任务本身。大结果落同目录 `output.json` 时，打开 `resultFile` 再讲
- 检验用的页面地址不要从脚本 return 里取。打开刚跑的那份 `task/*.js`，按它的 origin、`goto` / 路径模板、这次 argv，以及 `result` 里的 id，现拼用户能打开核对的 URL：必须带正确的 path 和 query。不要拿 fetch 端点当检验地址。页面靠路径的就深链（如 `/pin/<id>`）；query 用页面地址栏那几个键，不是 API 全套参数
- 同一接口满 3 次、或合计满 8 次，仍无 `success`：停，写清接口、原因、试了什么，并对人说明这次做不成。不要再改 `tmp/` 再跑
- 卡住了杀 `session/pid`（断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`
可观察结果：`mv` 完成并跑成功，已对人讲了结果；或满 3 / 满 8 后停，写清接口、原因、试了什么。没出现过 `success` 不准进 `task/`。
