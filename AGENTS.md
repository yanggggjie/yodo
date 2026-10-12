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

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，完整执行 `skills/yodo/install.md`。不在本文件重复安装、迁移或验收步骤。

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

- **安装**：对外安装与更新以 `skills/yodo/install.md` 为准。
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

| 组成 | 位置 | 职责 |
|---|---|---|
| 命令入口 | `src/cli/yodo.ts`，由 `~/.yodo/bin/yodo` shim 调用 | `run`、`eval`、`record`、`doctor` |
| Task SDK | `src/sdk.ts` | 只向 task 暴露 `yodo.run({ page })`，在 client 进程运行 task 闭包 |
| task-lib | `~/.yodo/task/lib/`，源码在 `src/templates/task-lib/` | 页面操作 helper、`toggle`、`expectRequest`、URL 工具 |
| task | `~/.yodo/task/<name>.js` | 一个可独立执行和复用的流程，头部 `@status` 区分 `draft` 与 `verified` |

修改 task 直接改 `~/.yodo/task` 中的文件，不再使用 `temp` 候选目录。草稿用 `@status: draft` 标记。

命令入口的约定：

- 只有 `record` 通过 RPC 连 holder（`src/cli/session.ts` 确认 holder 在不在，`src/cli/rpc.ts` 发请求）；`run`、`eval` 在本地起子进程，task 内部才通过 SDK 连 holder。
- 握手失败返回 `need-install`、`need-chrome`、`need-extension`。没装 host 或 Chrome 没运行时立即返回，只有 `need-extension` 才等待扩展连接（`HOLDER_READY_MS`）。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`。退出码规则只有一条：`status` 为 `success` 时 0，其它一律非零（不另建错误码表；`protocol.ts` 的 `RPC_ERRORS` 只用于 holder 与 CLI 之间的 JSON-RPC）。
- 并发：holder 同时只允许一个 run。`run.begin` 遇到另一个 run 或录制操作（错误的 `data.reason` 为 `run` 或 `record-op`）时，SDK 每 500ms 重试，最多 `RUN_BUSY_WAIT_MS`（30 秒）；`reason` 为 `record`（录制进行中）时不等待，直接报错。
- task 文件头只认文件开头第一个块注释里的 `@标签`；读不了的文件在 `yodo run` 列表里标为 `status: "invalid"`，不影响其它 task。
- 超时只有两层：单步骤 `STEP_TIMEOUT_MS`（30 秒，`src/templates/task-lib/page.js`，用于 `evaluate`、`goto`、`waitForSelector`、`expectRequest`；单条 CDP 命令的 `CDP_COMMAND_TIMEOUT_MS` 同为 30 秒）；整个 task 子进程 `TASK_TIMEOUT_MS`（90 秒），task 头部可用 `@timeout <秒>` 覆盖。超时被 SIGKILL 终止并按失败返回，`eval` 对每个内层 task 单独计时。
- `waitForSelector` 在 Node 侧轮询，不在页面里跑长循环；它没有 `timeout` 参数，固定使用单步骤上限。
- `RpcPeer`（`src/cli/rpc.ts`）是唯一的 socket 客户端：`sessionRpc` 是一次一连接的用法，SDK 用它保持长连接并接收页面事件。

### 4.2 holder

`src/holder.ts` 是 native messaging host，由 Chrome 拉起，持有扩展通道。stdin 关闭时保存录制并退出。

holder 通过 socket 提供：

```text
run.begin / run.end
cdp.send        { pageId, method, params, timeoutMs? }
cdp.event       （推送）{ sessionId, method, params }
record.start / record.stop / record.abort
ping
```

- 同一时间只允许一个 run，与发起它的 socket 绑定。连接断开时执行 `run.end` 清理。
- 页面事件由 holder 按 `sessionId`（即 pageId）推送给当前 run 的 client，client 按 method 过滤。不再有 `cdp.subscribe` 与 scope。
- 不暴露 browser 级 CDP 命令。`cdp.send` 只接受存在的 page。

### 4.3 扩展

`src/chrome-extension/` 是薄层 CDP 代理，约 220 行。协议见 `src/browser/extension.ts`。

- 只操作由 holder 创建的窗口和 tab，以及 opener 属于 yodo 的新 tab。
- 操作：`openWindow`、`openTab`、`closeTab`、`closeWindow`、`listOwned`、`windowOf`、`attach`、`detach`、`send`。
- 事件：`debuggerEvent`、`debuggerDetach`、`tab.created`、`tab.updated`、`tab.removed`。

### 4.4 窗口

- 录制窗：`openWindow({focused: true})`，tab 标题 `yodo record`。stop、abort 或 holder 退出时关闭整扇窗口。
- run 窗：holder 记录 `runWindowId`，窗口与一个锚点 tab（`about:blank`，标题 `yodo run`）同时存在。锚点 tab 保留，保证窗口存活。
- 每次 run 新开一个 tab，结束时 detach 并关闭它。不复用 tab。
- run 窗被用户关闭后，下次 run 静默重建。holder 退出时关闭 run 窗。

### 4.5 录制

- `record start` 在 `~/.yodo/session/recording/<name>/` 下生成录制；`record stop` 移入 `~/.yodo/record/<name>/`。
- 录制输出：`timeline.jsonl`（request 行与 action 行）、请求文件与响应文件。没有 `DOMTimeline.jsonl`，没有 `final-state`，没有 `eventId`。
- action 类型：`click`、`value`、`checked`、`scroll`、`navigation`。`submit` 与 `keydown` 不记录。
- 脱敏保留；adblock 过滤保留。
- `record stop` 输出 `status`、`name`、`recordDir`、`timeline`。

### 4.6 存储与安装

- 用户数据目录只有 `~/.yodo/task`、`~/.yodo/record`，运行时状态在 `~/.yodo/session`，运行时代码在 `~/.yodo/src`。
- 运行历史写入 `~/.yodo/run/<task>/<时间戳>.json`（`eval` 为 `run/compose/`），保存输入参数与输出，每个 task 保留最近 20 份。
- 没有 `state.json`，不做失败统计，不做重试限制。
- `setup.js` 是安装引导脚本，依赖 skill 包本身，负责拷贝运行时、安装依赖、注册 native host、生成 shim、运行 `doctor`。
- `yodo doctor` 只读。

