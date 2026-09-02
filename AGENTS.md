# AGENTS

Agent 流程见 `skills/yodo/SKILL.md`。下面只写实现。

## 开发安装

改 `src/`、`skills/`、`templates/` 或 init 后执行：

```bash
npm run dev:install
```

它 build 后执行本地 `yodo init --local`。开发时不要用线上 `@latest`。`init --local` 只给开发用。

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
