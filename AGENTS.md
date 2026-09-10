# AGENTS

Agent 流程见 `skills/yodo/SKILL.md`。下面只写实现。

## 开发

源码在 `skills/yodo/src/`，Node ≥24 直接跑 `.ts`（strip types，无编译产物）。

`setup.js` 把 skill 的 `src/` 拷贝到 `~/.yodo/src`，再在该目录 `npm install`。数据目录 `.yodo/{task,tmp,record,session}` 独立，更新不碰。

开发、联调、装到本机 agent：**只走** `npm run dev:install`。不要单独跑 `node skills/yodo/setup.js` 当日常入口。

```bash
npm run dev:install  # 本地 skills add + setup（拷贝 + npm install）
```

改 `src/`、`skills/`、`templates/` 或 init 后再跑一遍 `dev:install`。不要用线上 `main` 做开发安装。

检查（strip 不做类型检查，类型靠这一步）。仓库里跑 check/test 需要 `skills/yodo/src/node_modules`（gitignore，不进 payload）：

```bash
npm install --prefix skills/yodo/src --omit=optional
npm run check        # tsc --noEmit
npm test             # 逐个跑 *.selfcheck.ts
npm run verify:pack  # 隔离 HOME 真跑 skills add + setup + doctor
```

分发：`skills/yodo/` 作为 skill payload（`src/` 源码 + `package.json` + `package-lock.json` + `setup.js`）。**不**把 `node_modules` 放进 git 或 payload。用户/agent 跑 `setup.js` 时在 `~/.yodo/src` 本地 `npm install`。

## 发布

对外装机：`npx skills add yanggggjie/yodo`（GitHub 默认分支 `main`）。不发 npm，不建 GitHub Release。

发布 = 把要出的树合进 `main`，并把版本写成这一版。版本写在根 `package.json` 和 `skills/yodo/src/package.json`（`package-lock.json` 跟着改）。需要可回溯时打 `vX.Y.Z` tag。

---

## 架构：holder 续授权 + client-side task

对外：`src/sdk.ts`（`yodo` SDK）+ `src/bin/*.js`（薄脚本）+ 自执行 task。

- **holder**（`src/holder.ts`，常驻）：持有**一条** CDP 连接 = 续着 Chrome 远程调试授权（实测：连接归零授权即失效，所以必须常驻）。socket 上暴露**高层 op**：`run.begin/end`、`page.goto/evaluate/url/title/close/bring-to-front`、`context.new-page`、`record.*`、`ping`。同时只允许一个 run；run 绑发起它的那条 socket 连接，连接断开（含 client 崩溃）即 `run.end` 清理。
- **client**（`src/sdk.ts`）：`yodo.run(fn)` 在**本进程**跑 task 闭包；`browserContext`/`page` 是 proxy，方法经 socket 发 op 给 holder，holder 在那条连接上执行 CDP 回传结果。`page.evaluate(fn,args)` 由 client 把 `fn.toString()`+args 拼成表达式发过去。
- **record**：仍在 holder 侧采集（复用 `record/*`），client 只发 `record.*` op。

## holder / session

`.yodo/session/`：`sock`、`pid`、`log.jsonl`。run 没有 abort（关掉 client 进程即中止，holder 收到 socket close 后清理）。占死或同步死循环时杀 `pid`（断 CDP，不杀 Chrome）。

holder 对每个 op 回 `ok`；task 的业务结果由 client 侧 `yodo.run` 拼成 `status: success/failure` 直出 stdout。`ok` 表示这条 op 跑完了；业务结果只看 stdout 的 `status`。

## CDP attach

- 录制期间不要 browser 级 `Target.setAutoAttach`。只 `attachToTarget` 录制窗里的 page；popup 靠该 page session 上 related `setAutoAttach`（`waitForDebuggerOnStart: false`，`filter: [{ type: "page" }]`）。sibling 新 tab 用 `Target.setDiscoverTargets` 通知后再按 `windowId` 决定是否 attach。别人窗零 CDP。`chrome://` / `devtools://` 不 attach。idle holder 只留 CDP WebSocket，`autoAttach: false`，`discover: false`。
- 演示 / record：新窗口后台（`newWindow: true`、`background: true`、`focus: false`），空白 tab 的 `document.title` 设为 `yodo record`。不 `Page.bringToFront`。`stop` / `abort` / 超时后关掉这一扇录制窗。
- run：`run.begin` 确保一扇后台窗（没有或已被关就开；`newWindow: true`、`background: true`、`focus: false`；唯一 tab 标题 `yodo run`）。`newPage` 还这个 tab（先 `goto about:blank`），不新开 tab，不挂用户已有 tab。CDP 不能在不抢前台的情况下把新 tab 开进指定窗。`run.end` 再 `goto about:blank` 并把标题改回 `yodo run`，不关窗。holder 停才关整扇窗；若会关到 Chrome 只剩它，先开一扇后台空白窗。用户把窗关了，下次 `run.begin` 再开一扇。
- `goto` 没有 `waitUntil`。

## 收尾与过滤

- `stop` / `abort` / 5 分钟到 / 断线会关 discover、detach 自己挂过的 page、关录制窗。漏掉的第一发 document 可补 `late` 的当前 `outerHTML`；`late` 是迟到的页面快照，不装成 HTTP 200。比一次 HTML GET 信息更丰富：在这份快照里找信息，也可以对该 `url` 再做 HTML GET。不操作 DOM，不拿快照当页面操作。响应体 > 1KB 拆 `*.response.json` / `*.response.html`。
- 仅保留 2xx 成功请求（`late` 无 HTTP `status`，仍留下）。不保留 301/302。不设 `navigateTimeWindowMs` / `eventTimeWindowAfterMs`。
- timeline 行不写 `frameUrl`。`mainDoc` 是页面上下文锚点；request 仍带 `frameUrl`。
- `@ghostery/adblocker` 过滤第三方无关打点，`mainDoc` / `doc` 始终保留。
- 去重：`mainDoc`/`doc` 不去重；同 site 第一方 xhr/fetch 全留；第三方同 `method+bareUrl` 只留最后一次。
- 敏感字段与密码落盘前脱敏为稳定 alias。
