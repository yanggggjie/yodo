# AGENTS

`user goal` 的处理流程与 规范术语 见 `skills/yodo/SKILL.md`。本文只规定仓库边界、开发验证、分发发布和运行时实现。

## 1. 职责边界

### 1.1 分离安装与运行时职责

| 文件 | 职责 |
|---|---|
| `skills/yodo/install.md` | 只负责一次性安装与更新，并在结束前确保本机安装正确 |
| `skills/yodo/SKILL.md` | 只描述安装后的运行时任务；不提及、不跳转到、也不感知 `install.md` |

运行时 skill 不负责安装、更新或环境修复；相关变更只维护在 `install.md` 和仓库开发约束中。

## 2. 开发与验证

源码位于 `skills/yodo/src/`。Node ≥24 通过 strip types 直接运行 `.ts`，不生成编译产物。

### 2.1 本地安装

本地安装和更新必须读取并执行 `skills/yodo/install.md`。本地与在线流程相同，只有 skill 来源不同：本地使用当前 repository，在线使用 GitHub 默认分支 `main`。

本地同步 skill 时运行：

```bash
npm run dev:install
```

该命令只从当前 repository 同步 skill，不运行 `setup.js`。随后继续按 `install.md` 完成数据检查、setup、迁移、验收和用户报告。约束如下：

- 不把 `node skills/yodo/setup.js` 当作日常开发入口。
- 修改 `src/`、`skills/`、`templates/` 或 init 后，重新运行 `npm run dev:install`。
- 开发安装不使用线上 `main`。
- setup 必须从 `npm run dev:install` 安装后的 yodo skill 目录运行，不直接使用 repository 中的 `setup.js`。
- 本地开发安装遵循与在线更新相同的数据规则：保留 `task` 和 `record`，不处理 `temp`，覆盖 `src`，清理并重建 `session`。

### 2.2 检查与测试

Node strip types 不执行类型检查。运行 check 或 test 前，先安装 `skills/yodo/src/node_modules`；该目录被 gitignore，不进入 payload。

```bash
npm install --prefix skills/yodo/src --omit=optional
npm run check
npm test
npm run verify:pack
```

| 命令 | 作用 |
|---|---|
| `npm run check` | 运行 `tsc --noEmit` |
| `npm test` | 按文件名顺序逐个运行 `*.selfcheck.ts` |
| `npm run verify:pack` | 使用隔离 HOME 执行真实的 `skills add`、setup 和 doctor |

## 3. 分发与发布

### 3.1 Skill payload

`skills/yodo/` 是分发 payload：

```text
skills/yodo/
├── src/
├── package.json
├── package-lock.json
└── setup.js
```

不要将 `node_modules` 提交到 git 或放入 payload。用户或 agent 运行 `setup.js` 时，才在 `~/.yodo/src` 本地执行 `npm install`。

### 3.2 发布规则

- **安装**：对外命令为 `npx skills add yanggggjie/yodo`，来源是 GitHub 默认分支 `main`。
- **开发**：可以在任意 branch 开发，不要求同步维护发布文档。
- **发布分支**：用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，完成版本审计、测试和发布文档后 push；不修改 `main`。
- **发布到 main**：用户明确要求“发布到 main”时，将 release branch 相对 `main` 的提交 squash 为一个 release commit，合入并 push `main`。
- **发布**：不发布 npm 包，不创建 GitHub Release；release commit 进入 `main` 即完成发布。
- **版本**：发布时把根 `package.json` 和 `skills/yodo/src/package.json` 更新为本次版本，并同步 `package-lock.json`。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布前更新审计

只在用户要求“发布分支”时进行更新审计，不要求日常开发同步维护发布说明。版本号不明确时先询问用户。

创建 release branch 后，必须以 `git diff main...HEAD` 为准更新 `skills/yodo/update.md`。文件开头的 agent 更新指南保持稳定；将版本记录顶部的“待发布”改为本次版本号，只记录相对当前 `main` 发布版本的实际变化，不写开发过程或尚未实现的计划。发布后继续开发时，在版本记录顶部新增“待发布”。

每个版本必须包含：

- **用户可见变化**：只说明用户能感知的新增功能、优化和行为变化，不写 API、内部架构或实现方式。
- **用户数据变化**：用表格说明 `~/.yodo` 各路径是否受影响，以及 agent 需要执行什么。

审计必须覆盖以下数据：

| 数据 | 更新规则 |
|---|---|
| `~/.yodo/task` | 重要数据，必须保留。存在 API、目录或格式兼容性变化时，agent 必须先备份，再逐个修正并验证已有 task；setup 不自动改写 task。 |
| `~/.yodo/record` | 保留原数据，不得修改或迁移已有 record。 |
| `~/.yodo/temp` | 不重要，不处理，也不保证兼容。 |
| `~/.yodo/src` | 直接覆盖为当前版本。 |
| `~/.yodo/session` | 停止旧 holder 后直接清理，由当前版本重新建立。 |

发布前必须确认：

- `update.md` 按新到旧保留全部已发布版本；最新版本只描述 `main...HEAD` 相对上一发布版本的变化。
- 已根据实际 diff 检查 API、目录、配置和数据格式的 breaking change。
- task 存在兼容性变化时，`update.md` 给出明确的备份、修改和验证方法，并要求 agent 完成迁移。
- `install.md` 链接 `update.md`。
- README 靠前位置链接 `update.md`。
- setup 和迁移过程不会修改已有 record。

### 3.4 合入 `main`

用户明确要求“发布到 main”后：

1. 确认 release branch 已通过审核，工作区干净且完整检查通过。
2. 拉取最新 `main`，重新确认 `main...HEAD` 的 diff；发生变化时重新完成更新审计。
3. 将 release branch 相对 `main` 的全部提交 squash 为一个 release commit。
4. 将 release commit 合入并 push `main`。
5. 用户要求或发布规则需要时，创建并 push `vX.Y.Z` tag。

未收到“发布到 main”时，不得修改或 push `main`。

## 4. 运行时架构

### 4.1 对外接口

对外接口由三部分组成：

| 组成 | 文件 | 职责 |
|---|---|---|
| Task SDK | `src/sdk.ts` | 只向 task 暴露 `yodo.run()`，并在 client 进程运行 task 闭包 |
| Control | `src/control.ts`、`src/bin/*.js` | 安装后运行 start、stop、init、doctor 和 record 管理命令 |
| task lib | `src/templates/task-lib/` | 向 task 提供通用且有完整行为保证的 helper |
| `task` | 自执行程序 | 使用 SDK 完成一个可独立执行和复用的流程 |

修改 `capability` 时，不直接编辑 `~/.yodo/task` 中的文件。先复制到 `~/.yodo/temp` 作为 `candidate`，验证成功后再替换原文件；验证前必须保留原版本。

### 4.2 holder

`src/holder.ts` 是常驻进程，持有唯一 CDP 连接以维持 Chrome 远程调试授权。实测连接数归零时授权失效，因此 holder 必须常驻。

holder 通过 socket 暴露运行生命周期、通用 CDP 和 record RPC：

```text
run.begin
run.end
cdp.send
cdp.subscribe
cdp.unsubscribe
record.*
ping
```

同时只允许一个 `holder run`，并与发起它的 socket 绑定。连接断开（包括 client 崩溃）时，立即执行 `run.end` 清理。

### 4.3 client

client 位于 `src/sdk.ts`。`yodo.run(fn)` 在当前 client 进程运行 task 闭包，并直接提供当前 task 独占的运行页面 `page`。`page.cdp` 通过 socket 委托 holder 执行页面级 CDP；高级 `_cdp.connection` 和 `_cdp.browser` 只用于 page scope 不足时的排障或能力探索。

task 常用导航、evaluate 和 DOM 操作从 `~/.yodo/task/lib/index.js` 导入。Task SDK 不公开 start、stop、init、doctor 或 record 管理能力。

### 4.4 `record`

录制由 holder 侧的 `record/*` 负责采集，client 只发送 `record.*` op。

### 4.5 Holder 与 session

`~/.yodo/session/` 包含：

| 文件 | 用途 |
|---|---|
| `sock` | client 与 holder 的本地 socket |
| `pid` | holder 进程号 |
| `log.jsonl` | holder 日志 |

`holder run` 没有 abort op。中止时关闭 client 进程，holder 收到 socket close 后清理。holder 占死或 `task` 同步死循环时终止 `pid`；这只断开 CDP，不关闭 Chrome。

holder 返回的 `ok` 只表示 op 已执行。`result` 由 client 侧 `yodo.run` 生成，并在 stdout 输出 `task status` `success` 或 `failure`；判断 `task` 成功时只看该 `task status`。

### 4.6 管理录制窗口 attach

- **attach 范围**：禁止在 browser 级启用 `Target.setAutoAttach`；只对录制窗口中的 page 执行 `attachToTarget`，不 attach 其它窗口、`chrome://` 或 `devtools://`。
- **新页面**：popup 依赖对应 page session 的 related `setAutoAttach`，参数为 `waitForDebuggerOnStart: false`、`filter: [{ type: "page" }]`；sibling 新 tab 由 `Target.setDiscoverTargets` 通知，再按 `windowId` 判断是否 attach。
- **窗口**：使用 `newWindow: true`、`background: true`、`focus: false` 创建；空白 tab 的 `document.title` 为 `yodo record`，不调用 `Page.bringToFront`。
- **空闲与收尾**：idle holder 只保留 CDP WebSocket，设置 `autoAttach: false`、`discover: false`；stop、abort 或超时后关闭整扇录制窗口。

### 4.7 管理运行窗口 attach

- **创建**：`run.begin` 确保后台运行窗口存在；不存在或被用户关闭时，以 `newWindow: true`、`background: true`、`focus: false` 重新创建。唯一 tab 标题为 `yodo run`。
- **复用**：`newPage` 返回唯一 tab，并先导航到 `about:blank`；不新开 tab，也不连接用户已有 tab。CDP 无法在不抢前台时把新 tab 放入指定窗口，因此必须复用该 tab。
- **清理**：`run.end` 把 tab 导航到 `about:blank` 并恢复标题，但不关闭窗口；holder 停止时才关闭整扇窗口。若关闭后 Chrome 将没有其它窗口，先创建一扇后台空白窗口。
- **恢复**：用户手动关闭窗口后，下次 `run.begin` 再创建。`goto` 不支持 `waitUntil`。

## 5. `record material` 处理

### 5.1 收尾

- stop、abort、5 分钟超时或断线时，关闭 discover，detach 自己 attach 的 page，并关闭录制窗口。
- 第一条 document 请求漏录时，可以补当前 `outerHTML` 并标记为 `late`。它是迟到的页面快照，不能伪装成 HTTP 200。
- `late` 比单次 HTML GET 包含更多信息；可以查找快照，也可以对其 URL 再发 HTML GET，但不操作 DOM，也不把快照当成页面操作。
- 响应体超过 1KB 时，拆成 `*.response.json` 或 `*.response.html`。

### 5.2 过滤

- 只保留 2xx 成功请求；没有 HTTP `status` 的 `late` 仍保留。
- 不保留 301 或 302。
- 不设置 `navigateTimeWindowMs` 或 `eventTimeWindowAfterMs`。
- timeline 行不写 `frameUrl`；`mainDoc` 是页面上下文锚点；request 文件仍保留 `frameUrl`。
- 使用 `@ghostery/adblocker` 过滤第三方无关打点；`mainDoc` 和 `doc` 始终保留。

### 5.3 去重与脱敏

| 类型 | 处理 |
|---|---|
| `mainDoc` / `doc` | 不去重 |
| 同 site 的第一方 xhr/fetch | 全部保留 |
| 第三方请求 | 按 `method + bareUrl` 去重，只保留最后一次 |
| 敏感字段与密码 | 落盘前替换为稳定 alias |
