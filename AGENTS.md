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

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，必须完整执行 `skills/yodo/install.md`。

本地与在线安装或更新的唯一区别是 skill 来源：

- 本地使用当前 repository。
- 在线使用 GitHub 默认分支 `main`。

本地同步 skill 时运行：

```bash
npm run dev:install
```

除上述 source 和同步 command 外，不在本文件重复安装、迁移或验收规则。安装、迁移和验收以 `skills/yodo/install.md` 为准。用户能感知的变化写在 README「更新记录」。

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
- **发布**：不发布 npm 包，不创建 GitHub Release。release commit 进入 `main` 即完成发布。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布分支

用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，不修改 `main`，也不 push。然后：

1. 把本次版本号改成一致：根 `package.json`、`skills/yodo/src/package.json`，以及 `skills/yodo/src/package-lock.json` 里 yodo 包自己的 `version`。
2. 把本次发布里用户能感知的变化写入 README 的「2.2 更新记录」，版本号与上面相同。

完成后停下来，等用户测试和检查。用户自己 push。

### 3.4 发布到 `main`

用户明确要求“发布到 main”时，将发布分支相对 `main` 的提交压缩为一个提交，合入 `main`。

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
