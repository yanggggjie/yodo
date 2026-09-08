---
name: yodo
description: >-
  触发词 yodo；操作本机已登录带有票据的 Chrome 来完成用户任务。
  .yodo 在用户 home 下。跑命令用绝对路径。
  没有 .yodo/src、Node 不够、或初始化不确定：读 install.md。
---

流程、目录、脚本。始终按流程走：流程会在目录里落下文件；要推进流程，就去执行或写入对应的脚本。

`task` 只指 `.yodo/task/*.js`。先看 `.yodo/`，再写。对人说任务本身，不播报内部状态。

## 1. 流程

```text
用户任务 → 查 task/
              ├── 有 → node task/<name>.js → 报告结果
              └── 没有 → record → 读抓包 → node tmp/<name>.js
                            ├── success → mv → node task/<name>.js → 报告结果
                            └── 5 次 failure → 停，写原因
```

**查 task。** `task/*.js` 是已经跑通的。文件头有 `@summary`；用到的参数写在头注释里，对应 `argv` 位置。按用户任务找能用的（怎么查自定）。

能直接跑：`node task/<name>.js <参数>`。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。只有 `error`、没有 `status`：命令没跑起来，停，对人说明没跑起来。`success`：对人说这次做成了什么，用 stdout 里的 `result` 或 `resultFile`，并念出 `result.url`（它直达结果页）。只说任务本身，不播报内部状态。大结果落同目录 `output.json` 时，stdout 给的是 `resultFile`，打开它再讲。`failure`：已经执行并抛错——直接跑现成 task 失败就停，对人说明失败原因，不要改 `task/` 里的原文件。卡住了就杀 `session/pid`（会断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`。

现有 task 拼得起来：在 `tmp/` 写新文件，不改原文件，再 `node tmp/<name>.js`。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。只有 `error`、没有 `status`：命令没跑起来，停，对人说明没跑起来，这次不算进 5 次。`success`：写上 `@summary` 和参数说明，只有出现过 `status: success` 才能 `mv tmp/<name>.js task/<name>.js`（`mv` 是 Unix `mv`，不是 yodo 子命令），再 `node task/<name>.js`。task 这遍同样会自己连浏览器；连不上就把 `guide` 原样念给用户，停，等用户回「好了」，再重跑。不轮询，不改写 `guide`。这遍 `success`：对人说这次做成了什么，用 stdout 里的 `result` 或 `resultFile`，并念出 `result.url`（它直达结果页）。只说任务本身，不播报内部状态。大结果落同目录 `output.json` 时，stdout 给的是 `resultFile`，打开它再讲。`failure` 不到 5 次就改 `tmp/` 再跑；满 5 次就停，写清接口、原因、试了什么，并对人说明这次做不成。没出现过 `success` 不准把脚本放进 `task/`。卡住了就杀 `session/pid`（会断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`。

没有可跑的、又拼不出来：去录。没抓包不要先写脚本探接口。

**record。** `node src/bin/record-start.js [name]`。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。`status: recording`：把 `guide` 原样念给用户，停，等用户回「好了」，再 `node src/bin/record-stop.js`。只在新窗口录，已有窗不录。stop / abort 只关录制窗。`status: stopped` 且有 `recordDir`：去读这个目录。`aborted` / `idle`：没有可用抓包，停，对人说明这次没有抓到。卡住了就杀 `session/pid`（会断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`。

**读抓包，在 tmp 里试。** 先读 `timeline.jsonl`（小，索引），定要重放的接口，再打开对应的 request（`01_GET_host.json`，小）。只重放抓到的；没抓到的不补。`late` 的 `mainDoc` 是迟到的页面快照，没有 `method`、也没有 HTTP `status`，比一次 HTML GET 信息更丰富——在这份快照里找信息，也可以对那个 `url` 再做 HTML GET。只发网络请求，不操作 DOM，也不拿 DOM 快照来操作。

在 `tmp/<name>.js` 写脚本，然后 `node tmp/<name>.js`。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。同一接口最多试 5 次，只计有 `status` 的。只有 `error`、没有 `status`：命令没跑起来，停，对人说明没跑起来，这次不算进 5 次。`failure` 且 403，多半是缺客户端签名，改走页内 XHR（站点常 monkey-patch `XMLHttpRequest`，会自动注入 `a_bogus` / `X-Bogus`），比手写逆向稳。页内太慢就减小数据量。

`success`：写上 `@summary` 和参数说明，只有出现过 `status: success` 才能 `mv tmp/<name>.js task/<name>.js`（`mv` 是 Unix `mv`，不是 yodo 子命令），再 `node task/<name>.js`。task 这遍会自己连浏览器；连不上就把 `guide` 原样念给用户，停，等用户回「好了」，再重跑。不轮询，不改写 `guide`。这遍 `success`：对人说这次做成了什么，用 stdout 里的 `result` 或 `resultFile`，并念出 `result.url`（它直达结果页）。只说任务本身，不播报内部状态。大结果落同目录 `output.json` 时，stdout 给的是 `resultFile`，打开它再讲。

5 次 `failure`：停，写清接口、原因、试了什么，并对人说明这次做不成。没出现过 `success` 不准把脚本放进 `task/`。卡住了就杀 `session/pid`（会断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`。

`need-chrome` / `need-remote-debugging` / `need-allow` 是第一次连浏览器时的事，不是安装：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。Chrome 根本没装，才会看到 `need-install`：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑。不轮询，不改写 `guide`。这里碰到了就当场接住。

## 2. 目录

路径相对用户 home 下的 `.yodo/`。文中写相对路径，跑命令用绝对路径。

```text
.yodo/
  src/       yodo 源码。bin 在 src/bin/。别在这写业务脚本（更新会覆盖）。
  task/      已验证的自执行脚本 + _common/。小，任意读。
  tmp/       还没验证的脚本。唯一能随便写的地方。小，任意读。
  record/    抓包。record stop 之后才有可用目录。
             timeline.jsonl              索引。小，任意读。
             01_GET_host.json            request：url、frameUrl、headers、body；
                                         这里的 status 是 HTTP，不是流程里的 status。
                                         小，任意读。
             01_GET_host.response.json   响应体。大，不要整份读。
             01_GET_host.response.html   整页 HTML。大，不要整份读。
  session/   pid · sock · log.jsonl。没有对应的业务脚本。
```

正在 `recording` 时不要读 `record/.active/`。大、不要整份读的只有拆出来的响应体。

## 3. 脚本

bin 把流程往前推。业务脚本先写在 tmp 里试；试通了，用 mv 挪到 task。task 只收已经跑通的。

### a. bin

在 `.yodo/src/bin/`。推进流程，不写业务。

| 脚本 | 做什么 |
|---|---|
| `node src/bin/record-start.js [name]` | 开始往 `record/.active/<name>/` 抓。需要浏览器时会自己连。连不上：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。`recording`：把 `guide` 原样念给用户，停，等用户回「好了」，再跑 `record-stop`。这时还没有 `recordDir`，不要去读 `record/.active/`。 |
| `node src/bin/record-stop.js` | 归档到 `record/<name>/`。`stopped` 且有 `recordDir`：去读这个目录。`aborted` / `idle`：没有可用抓包，停，对人说明这次没有抓到。 |
| `node src/bin/record-abort.js` | 扔掉这次抓包。`aborted`：对人说明这次不要了。当时没在录是 `idle`：对人说明当时没在录。 |
| `node src/bin/start.js` | 拉起并连 Chrome（点一次授权后保持）。`ok`：连上了，继续流程。`need-*`：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。 |
| `node src/bin/stop.js` | 停掉连接（授权失效）。对人只在他要求断开时说一声已断开，不播报内部状态。 |
| `node src/bin/doctor.js` | 排障：路径不对、布局缺、holder 占死。打印 Node、`platform`、`home`、布局、连接。这是给自己看的，不要把整段输出念给用户。 |

`init.js` 建数据目录，安装时由 `setup.js` 调用，用户任务流程里用不到。

### b. task

已经跑通的自执行脚本，只从 tmp `mv` 进来，不要在这里新建或改原文件。

跑：`node task/<name>.js [参数]`。参数走 `process.argv`，可缺省。脚本不改自己。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。`success`：对人说这次做成了什么，用 stdout 里的 `result` 或 `resultFile`，并念出 `result.url`（它直达结果页）。只说任务本身，不播报内部状态。大结果落同目录 `output.json` 时，stdout 给的是 `resultFile`，打开它再讲。

头注释写 `@summary`，用到的参数写清对应 argv。`import` `../task/_common/yodo.js`（task 目录里的文件用 `./_common/yodo.js`）。

### c. tmp

唯一能随便写的地方。组合现有 task，或对着抓包写新脚本，都在这里试。

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
  return { ...data, url: serializeUrl({ bareUrl: `${ORIGIN}/search`, query: { q } }) };
});
```

`yodo.run` 把 `{status:"success", result}` 或 `{status:"failure", error}` 直出 stdout。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。

`result.url` 用 `serializeUrl({ bareUrl, query })` 现拼：`bareUrl` 取抓包里结果页那一发 `mainDoc` / `frameUrl`（不是 fetch 端点），`query` 取页面地址栏那几个键（页面 query，不是 API 全套参数）。页面靠路径的就深链（如 `/pin/<id>`）；API 返回 id 时深链到那一条。`goto` 没有 `waitUntil`。只发网络请求，不操作 DOM。

`tmp` 上的 `success` 还不能结束：写上 `@summary` 和参数说明，只有出现过 `status: success` 才能 `mv tmp/<name>.js task/<name>.js`（`mv` 是 Unix `mv`，不是 yodo 子命令），再 `node task/<name>.js`。task 这遍 `success`：对人说这次做成了什么，用 stdout 里的 `result` 或 `resultFile`，并念出 `result.url`（它直达结果页）。只说任务本身，不播报内部状态。大结果落同目录 `output.json` 时，stdout 给的是 `resultFile`，打开它再讲。`failure` 不到 5 次就改再跑；满 5 次就停，写清接口、原因、试了什么，并对人说明这次做不成。没出现过 `success` 不准把脚本放进 `task/`。

### d. mv

`mv` 是 Unix `mv`，不是 yodo 子命令。只有出现过 `status: success` 才能 `mv tmp/<name>.js task/<name>.js`。挪过去之后再 `node task/<name>.js`。需要浏览器时命令会自己连。连不上或要等人：把 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。这遍 `success`：对人说这次做成了什么，用 stdout 里的 `result` 或 `resultFile`，并念出 `result.url`（它直达结果页）。只说任务本身，不播报内部状态。大结果落同目录 `output.json` 时，stdout 给的是 `resultFile`，打开它再讲。
