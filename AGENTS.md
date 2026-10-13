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

### 2.3 dev：本地验证工具

`dev` 服务于本地修改代码、debug、调算法，目的是拿到真实数据和真实现象，不是 CI，也不是通过 / 失败。设计与分步见 [plan/dev-tools.md](plan/dev-tools.md)。

**克制原则**（违反任何一条，先删再加）：

1. **体量上限**：`dev` 相关代码（`skills/yodo/src/dev/`、`scripts/dev/`，不含 `*.selfcheck.*`）总量不超过生产代码的 15%。度量方式：生产代码为 `skills/yodo/src` 下除自检、`dev/` 外的 `.ts/.js/.mjs` 行数。
2. **可整体删除**：生产代码里对 `dev` 只允许一行式调用，不放逻辑。删掉 `src/dev/` 和这些调用后，应用行为完全不变。
3. **零新增运行时依赖**。本机开发工具只用于本地，不进发布内容。
4. **每个能力必须对应一个真实发生过的痛点**，写进 plan。"将来可能用到"不算理由。
5. **一进一出**：新增一个机制前，先评估能不能删掉旧的某个。
6. **默认关闭，关闭时零行为差异。**

另外：
- 不新增 hub、事件目录、探针、`dev.eval` 等通用机制。需要进入运行中的 holder 时，用 Node 自带的 inspector（`kill -USR1 <holder pid>`）。plan 的"不做的事"列出了每一项以及重新考虑的条件。
- `dev` 不出现在 usage 和 SKILL.md，只写在这里。

**用法**：

- 开关是标记文件：`touch ~/.yodo/session/dev` 开启，`rm ~/.yodo/session/dev` 关闭。holder 每次收到 `dev.*` 请求时检查，不需要重启。
- `dev.pages`：列出 yodo 的页面（pageId、windowId、url、标题）。`record.start` 之后，录制页的标题是 `yodo record`。
- `dev.cdp { pageId, method, params }`：对该页面发 CDP，包括录制窗口。拒绝 `*.disable`、`Target.*`、`Browser.*`。生产环境的 `cdp.send` 仍然只能在 run 中使用。
- 脚本通过现有的 `sessionRpc` 调用这些 method。`skills/yodo/src/dev/driver.ts` 的 `DevPage` 用 `Input.*` 模拟用户操作（`goto`、`click`、`type`、`scroll`、`waitFor`）。录制器只认 `isTrusted` 的事件，所以不能用 task-lib 的 `click`、`fill`。
- 流水线：`runPipeline()` 返回每一级的输入数、输出数和丢弃原因；录制结束时写一行 `pipeline N → M` 日志，`data.stages` 里是各级明细。

```bash
touch ~/.yodo/session/dev
node scripts/dev/record.mjs [场景.mjs]   # 起夹具 → 录制 → 模拟演示 → 停止，打印汇总并与上一次比较
node scripts/dev/replay.mjs <录制名>      # 用 dev 模式保存的原始事件离线重放流水线，不需要 Chrome
rm ~/.yodo/session/dev
```

`record.mjs` 产生的录制会出现在 `~/.yodo/record/`（以场景名开头），用完自行删除。

**安全**：dev 模式下保存的原始事件是脱敏**之前**的数据，可能含密码和 token。它们只写到 `~/.yodo/dev/`（权限 0600），不进 `record/`，不进发布内容；用完 `rm -rf ~/.yodo/dev`。

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
- 握手失败返回 `need-install`、`need-chrome`、`need-extension`。`ping` 返回 `extension`（扩展链路是否接着）：holder 在 relay 断开后还会存活，所以 ping 通不代表可用；`extension` 不为 `true`（或 holder 不在）时，没装 host 或 Chrome 没运行立即返回，只有 `need-extension` 才等待扩展连接（`HOLDER_READY_MS`）。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`。退出码规则只有一条：`status` 为 `success` 时 0，其它一律非零（不另建错误码表；`protocol.ts` 的 `RPC_ERRORS` 只用于 holder 与 CLI 之间的 JSON-RPC）。
- 并发：holder 同时只允许一个 run。`run.begin` 遇到另一个 run 或录制操作（错误的 `data.reason` 为 `run` 或 `record-op`）时，SDK 每 500ms 重试，最多 `RUN_BUSY_WAIT_MS`（30 秒）；`reason` 为 `record`（录制进行中）时不等待，直接报错。
- task 文件头只认文件开头第一个块注释里的 `@标签`；读不了的文件在 `yodo run` 列表里标为 `status: "invalid"`，不影响其它 task。
- 超时只有两层：单步骤 `STEP_TIMEOUT_MS`（30 秒，`src/templates/task-lib/page.js`，用于 `evaluate`、`goto`、`waitForSelector`、`expectRequest`；单条 CDP 命令的 `CDP_COMMAND_TIMEOUT_MS` 同为 30 秒）；整个 task 子进程 `TASK_TIMEOUT_MS`（90 秒），task 头部可用 `@timeout <秒>` 覆盖。超时被 SIGKILL 终止并按失败返回，`eval` 对每个内层 task 单独计时。
- `waitForSelector` 在 Node 侧轮询，不在页面里跑长循环；它没有 `timeout` 参数，固定使用单步骤上限。
- `RpcPeer`（`src/cli/rpc.ts`）是唯一的 socket 客户端：`sessionRpc` 是一次一连接的用法，SDK 用它保持长连接并接收页面事件。

### 4.2 relay 与 holder

三段进程，各自的生命周期不同：

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay（`src/native-messaging-host/relay.ts`） | Chrome（native messaging host） | 无，只在 stdio 与 `ext.sock` 之间原样转发字节 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| holder（`src/holder.ts`，daemon） | relay（`ext.sock` 连不上时 detached 拉起） | 持有扩展链路、run、录制、窗口 | 不随 relay 断开退出；无 relay、无 run、无录制超过 10 分钟才退出 |
| 扩展（`src/chrome-extension/`） | Chrome | 所有权登记、debugger 附加状态 | service worker 可随时重启，靠对账恢复 |

relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，holder 只 `detach` 链路，不退出，所以窗口与录制不丢。扩展每次 `hello` 之后，holder 做一次对账，见 4.4。

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

- 只操作由 holder 创建的窗口和 tab，以及两类新 tab：opener 属于 yodo 的 tab；开在录制窗口里的 tab（用户在录制窗口自己按 Cmd+T 开的 tab 没有 opener）。`openWindow` 的 `kind: "record"` 标记录制窗口，run 窗口不放宽。
- 操作：`openWindow`、`openTab`、`closeTab`、`closeWindow`、`listOwned`、`windowOf`、`attach`、`detach`、`send`。
- 事件：`debuggerEvent`、`debuggerDetach`、`tab.created`、`tab.updated`、`tab.removed`。

### 4.4 窗口

- 录制窗：`openWindow({focused: false})`，不抢用户焦点，tab 标题 `yodo record`；agent 要告诉用户切换到这个窗口。stop、abort 或 holder 退出时关闭整扇窗口。
- run 窗：holder 记录 `runWindowId`，窗口与一个锚点 tab（`about:blank`，标题 `yodo run`）同时存在。锚点 tab 保留，保证窗口存活。
- 每次 run 新开一个 tab，结束时 detach 并关闭它。不复用 tab。
- run 窗被用户关闭后，下次 run 静默重建。holder 退出时关闭 run 窗。
- 对账：扩展每次 `hello` 之后，holder 调用 `listOwned`，先丢弃 debugger 附加状态未知的页面记录，再按标题（`yodo run`、`yodo record`）识别 yodo 的窗口：当前 `runWindowId` 的窗口保留，只关掉其中除锚点外的残留 tab；其它 `yodo run` 窗口是孤儿，整扇关闭；录制进行中不关 `yodo record` 窗口。只关被标题确认的窗口，从不按 id 关闭用户的窗口。
- 所有权登记同时写入 `chrome.storage.session`（service worker 重启后可信，扩展刷新会清空）和 `chrome.storage.local`（扩展刷新后仍在，但 tab id 在浏览器重启后会被复用）。恢复 `local` 里的登记时，只接受仍然存在、且窗口里有标题为 `yodo run` 或 `yodo record` 的 tab 的窗口，其余丢弃。`listOwned` 返回每个 tab 的 `title`，holder 对账靠它识别 yodo 的窗口。

### 4.5 录制

- `record start` 在 `~/.yodo/session/recording/<name>/` 下生成录制；`record stop` 移入 `~/.yodo/record/<name>/`。
- 录制输出：`timeline.jsonl`（request 行与 action 行）、请求文件与响应文件。没有 `DOMTimeline.jsonl`，没有 `final-state`，没有 `eventId`。
- action 类型：`click`、`value`、`checked`、`scroll`、`navigation`。`submit` 与 `keydown` 不记录。
- 页面脚本（`record/inject.js`）在页面里直接产出 timeline 需要的字段：`selector`（候选依次为稳定的 `id`、`data-testid` 等、`name`、`aria-label`、`placeholder`、稳定的 class，要求在文档里唯一；都不唯一时用 `:nth-of-type` 拼路径）、`role`、`name`（`aria-labelledby` → `aria-label` → `<label>` → `placeholder` → 自己的文字，最长 80 字符；没有可交互元素的点击只取元素自己的文字）、输入值、滚动量。点到按钮里的图标算点了按钮，点 `<label>` 算点了它控制的输入框。宿主不再采集元素的祖先、子节点等整份描述；判断是不是同一控件只比较 `selector`。
- 脚本的注入：`Page.addScriptToEvaluateOnNewDocument` 只对之后新建的文档生效，所以 attach 时还要对已存在的 frame（含 iframe）用 `Page.createIsolatedWorld` + `Runtime.evaluate` 立刻补注入，否则晚 attach 的页面（尤其单页应用）整页录不到动作。脚本加载后发 `ready`；stop 时有网络请求却没收到 `ready` 的页面，进入 `record stop` 的 `warnings`。
- 单页应用的路由变化（`Page.navigatedWithinDocument`）记为 `navigation`；iframe 里的导航不记录。
- 验证：`record/fixtures/dom-events.json` 是在真实 Chrome 里用可信的鼠标、键盘输入抓到的页面事件，其中的 `ax` 是同一页面上 Chrome 无障碍树给出的 role 和 name，`collect.selfcheck.ts` 逐个对照。
- 脱敏保留；adblock 过滤保留。
- 网络采集分两层：`record/collect.ts` 的采集端只做 attach 和所有 I/O（开启域、取响应体、读页面 HTML），事件交给 `record/requests.ts` 的 `RequestAssembler` 拼成请求记录。拼装器不做任何 I/O，只有一个入口 `feed(事件)`；需要取响应体或补抓主文档时返回一个动作，采集端执行后再把结果作为 `yodo.body`、`yodo.snapshot` 事件喂回去。设置 `YODO_RECORD_LOG=<路径>` 时，stop 时把喂给拼装器的全部事件写成 JSON（含未脱敏的数据，默认不记录），可直接作为测试夹具，放进 `record/fixtures/` 即可回放。
- 补抓的主文档（`late: true`）：页面在开始采集之前就已经加载完时，读取当前页面的 HTML 补一条主文档。`dropIncompleteRequests` 不会删除它。
- 录制期间不处理 JS 对话框（`alert`、`confirm`、`prompt`、`beforeunload`），由用户在页面里自己选，不自动点「确定」。
- 录制窗口里用户自己新开的 tab 会被纳入：扩展纳入后宿主按窗口规则 attach。新标签页是 `chrome://` 页面，无法 attach；用户在里面首次导航后才 attach，第一次文档请求可能记成补抓的主文档（`late: true`）。
- `record stop` 输出 `status`、`name`、`recordDir`、`timeline`；有页面的动作没录到时多一个 `warnings` 数组。

### 4.6 存储与安装

- 用户数据目录只有 `~/.yodo/task`、`~/.yodo/record`，运行时状态在 `~/.yodo/session`，运行时代码在 `~/.yodo/src`。
- 运行历史写入 `~/.yodo/run/<task>/<时间戳>.json`（`eval` 为 `run/compose/`），保存输入参数与输出，每个 task 保留最近 20 份。
- 没有 `state.json`，不做失败统计，不做重试限制。
- `setup.js` 是安装引导脚本，依赖 skill 包本身，负责拷贝运行时、安装依赖、注册 native host、生成 shim、运行 `doctor`。
- `yodo doctor` 只读。

