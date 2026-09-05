# AGENTS

Agent 流程见 `skills/yodo/SKILL.md`。下面只写实现。

## 开发

源码在 `skills/yodo/src/`，Node ≥24 直接跑 `.ts`（strip types，无编译产物）。

`setup.js` 把 `~/.yodo/src` **链接**到 skill 源码（Windows 用 junction；建不了链接的环境降级为整目录拷贝），数据目录 `~/.yodo/{task,tmp,record,session}` 独立，更新不碰。

日常开发（快速迭代，`~/.yodo/src` 直接链到 repo 源码）：

```bash
node skills/yodo/setup.js                 # ~/.yodo/src → 本 repo 的 skills/yodo/src
node ~/.yodo/src/yodo.js <record|run|doctor> …
```

检查（strip 不做类型检查，类型靠这一步）：

```bash
npm run check        # tsc --noEmit
npm test             # 逐个跑 *.selfcheck.ts（含 deploy 的 link/copy 自检）
npm run verify:pack  # 隔离 HOME 真跑 skills add，断言 payload 完整 + 自足可运行
```

模拟正式分发：

```bash
npm run dev:install  # 本地 skills add（把 payload 装进各 agent 的 skills 目录）+ setup
```

分发：`skills/yodo/` 整个作为 skill payload（含 `src/`、vendored `node_modules`、`setup.js`），`skills add` 递归拷贝整棵目录（只排除 `.git`/`__pycache__` 等，不过滤 `node_modules`）。改运行时依赖：删 `skills/yodo/src/node_modules`，用纯运行时树（`npm install --omit=dev --omit=optional`，确认无 `*.node`）重建。

---

## holder / session

`~/.yodo/session/`：`sock`、`pid`、`log.jsonl`。占死或同步死循环时杀 `pid`（断 CDP，不杀 Chrome）。`run` 没有 abort。

holder `ok` 表示这条 op 跑完了；业务结果只看 stdout 的 `status`。

## CDP attach

- 录制期间不要 browser 级 `Target.setAutoAttach`。只 `attachToTarget` 录制窗里的 page；popup 靠该 page session 上 related `setAutoAttach`（`waitForDebuggerOnStart: false`，`filter: [{ type: "page" }]`）。sibling 新 tab 用 `Target.setDiscoverTargets` 通知后再按 `windowId` 决定是否 attach。别人窗零 CDP。`chrome://` / `devtools://` 不 attach。idle holder 只留 CDP WebSocket，`autoAttach: false`，`discover: false`。`yodo run` 按 origin 只挂一个 page，不全量 attach。
- `pageForOrigin`：已有同 origin 的 page 就复用；找不到就打开。
- `goto` 没有 `waitUntil`。

## 收尾与过滤

- `stop` / `abort` / 5 分钟到 / 断线会关 discover、detach 自己挂过的 page、关录制窗。漏掉的第一发 document 可补 `late` 的当前 `outerHTML`；`late` 是迟到的页面快照，不装成 HTTP 200。比一次 HTML GET 信息更丰富：在这份快照里找信息，也可以对该 `url` 再做 HTML GET。不操作 DOM，不拿快照当页面操作。响应体 > 1KB 拆 `*.response.json` / `*.response.html`。
- 仅保留 2xx 成功请求（`late` 无 HTTP `status`，仍留下）。不保留 301/302。不设 `navigateTimeWindowMs` / `eventTimeWindowAfterMs`。
- timeline 行不写 `frameUrl`。`mainDoc` 是页面上下文锚点；request 仍带 `frameUrl`。
- `@ghostery/adblocker` 过滤第三方无关打点，`mainDoc` / `doc` 始终保留。
- 去重：`mainDoc`/`doc` 不去重；同 site 第一方 xhr/fetch 全留；第三方同 `method+bareUrl` 只留最后一次。
- 敏感字段与密码落盘前脱敏为稳定 alias。
