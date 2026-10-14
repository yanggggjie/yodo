> 注：本文中关于可信输入（isTrusted、Input.*）的决定已被 plan/record-untrusted-and-dom-driver.md 取代。

# yodo 重构方案（简化版）

## 目标

- 只保留三件事：录制、学习、运行。
- 不以兼容为由减少重构，可以不兼容现有 task 与 API。
- 模型只需要记住很少的规则，其余交给代码。

## 已确定的决策

1. **页面操作 helper 保留在 task-lib**：`click`、`fill`、`press`、`scroll`、`check`、`select`、`waitForSelector` 作为 task-lib 的通用 helper 保留。它们的实现只用页面内的 DOM 调用，不做可信输入，不做坐标计算。
2. **run 窗长期保持，但不做 holder 重启恢复**：holder 每次启动都视为新会话，不通过 `listOwned` 找回旧窗口。
3. **窗口标题必须正确**：录制窗与 run 窗的标题分别为 `yodo record`、`yodo run`，通过 tab 的 `document.title` 设置（窗口标题不可设置），每次创建后校验一次。
4. **run 窗静默重建**：发现窗口已被用户关闭时，直接重新创建，不报错、不提示。
5. **点击保持现状**：不改为可信输入，不增加坐标计算。

## 页面事件流（替代 cdp.subscribe）

- 删除 `cdp.subscribe` 与 `cdp.unsubscribe`，以及 scope 设计。
- `page.cdp.on(event, handler)` 保留，语义是"当前 page 的 CDP 事件流"：extension 把 `debuggerEvent` 带上 tabId 推给 holder，holder 只转发给该 tab 对应的 client。
- 不做全局订阅，事件只在开启对应 domain 之后才有。

### 用请求判断 DOM 操作是否成功

- 会发请求的操作（点赞、提交、关注等），用 `expectRequest` 判断：
  1. 期望的请求没有发出 → 操作没有生效，或点错了元素，报错。
  2. 请求失败（非 2xx）→ 报错，并返回状态码。
  3. 请求成功 → 返回 `body`，task 再检查一个业务字段（如 `is_upped: true`）。
- 不会发请求的操作（勾选、输入、滚动），用 `evaluate` 读取控件状态确认。
- 发完即忘的请求（埋点、统计）不能作为期望。
- 期望请求的来源：录制时动作与请求的关联结果（`triggeredBy` 的时间窗规则）。task 头部可以写 `@expect` 记录期望的方法与路径，但不由代码自动生成。
- 跨域 iframe 中的操作不在覆盖范围内（已妥协）。

## 运行时管理

### 录制窗

- 录制开始时 `openWindow({focused: true})`，窗口内的 tab 的 `document.title` 设为 `yodo record`，创建后校验一次（窗口标题不可设置）。
- 录制结束（stop、abort、holder 退出）时关闭整个窗口。
- 每次录制都新建，不复用。

### run 窗

- holder 内记录 `runWindowId`。第一次 run，或 `runWindowId` 无效时，`openWindow({focused: false})` 创建窗口，并开一个锚点 tab（`about:blank`，标题 `yodo run`，创建后校验）。锚点 tab 在窗口存续期间不关闭。
- 每次 run：在 run 窗里新开一个 tab，attach，执行 task，结束时 detach 并关闭这个 tab。每次都是全新的 tab，不复用。
- run 窗无效（`windowOf` 失败或窗口不存在）时，静默重建，然后继续运行。
- holder 退出时关闭 run 窗。holder 重启时不恢复旧窗口，直接按上面的规则重建。
- 同一时间只允许一个 run。

### 归属

- 扩展只接受由 holder 通过 `openWindow` / `openTab` 创建的 id，以及 opener 属于 yodo 的新 tab。
- 扩展的归属记录仅存于内存加 `chrome.storage.session`，只为防止误操作用户窗口，不作为恢复依据。

## 架构

```text
skills/yodo/                       （分发 payload）
├── setup.js                       # 引导脚本：拷贝 src、安装依赖、注册 native host、生成 shim
└── src/
    ├── cli/yodo.ts                # 唯一的命令入口：run / record / doctor
    └── ...                        # holder、扩展、录制、task-lib 等运行时代码

~/.yodo/                           （安装结果，不在仓库里）
├── src/                           # setup 拷贝来的运行时
├── bin/
│   ├── yodo                       # sh shim：node ~/.yodo/src/cli/yodo.ts "$@"
│   └── yodo.cmd                   # Windows shim，内容相同
├── task/
└── record/
```

- `yodo` 只有一个入口，子命令包括 `run`、`record`、`doctor`。`start` 与 `stop` 已删除：holder 由 Chrome 拉起，yodo 无法启动或真正停止它；连接状态用 `doctor` 查看，停止需在 `chrome://extensions` 关闭扩展。
- `run` 不带参数时列出 task 摘要，不运行脚本。
- shim 由 `setup.js` 生成，不进入仓库。`install.md` 要写明 shim 的位置，以及在 PATH 里之前用绝对路径调用。
- holder 作为 native messaging host 运行，由 Chrome 拉起，不通过 `yodo` 命令启动。
- 扩展保持现有设计，约 220 行。
- holder 只做三件事：socket 协议、tab 操作、run 与录制的状态。
- `CdpContext` 保留锚点 tab，用于窗口存活；去掉 `ensureAnchor` 的 tab 复用、`endRunTabs` 的导航回收与标题技巧。popup 归属由扩展的归属规则替代，不再保留独立的追踪逻辑。

## 录制


- 网络请求与 DOM 事件合并成一份 `timeline.jsonl`，按时间排序。接口响应单独存为文件，路径写在 timeline 中。
- 去掉简化版与完整版两份输出，去掉 `eventId` 交叉引用。
- 保留 adblock 过滤（`@ghostery/adblocker`），`mainDoc` 与 `doc` 始终保留。
- 保留敏感信息脱敏（cookie、authorization、密码等），落盘前替换为稳定 alias。
- 录制的操作类型只有四种：`click`、`value`、`checked`、`scroll`（小于 20px 丢弃）。`navigation` 保留。
- 不采集：`submit`、`keydown`（已删除，不再注入监听）；指针坐标、`pointerdown`、滚轮位移。提交由随后的接口请求说明。
- 同一控件上的 `click` 若被 `checked` 或 `value` 说明，只留属性那一条；连续的 `value` 只留最后一条。
- 只采集可信的原生事件，脚本派发的事件丢弃。

### 弹窗（popup）归属：已验证，结论如下

- 实测（IT 之家）：点击后产生的新窗口被录到了（`about:blank` 之后紧接着导航到弹出的页面），扩展的归属规则与录制侧采集正常。
- 结论：保留扩展的归属规则（录制窗与 run 窗内的 tab、opener 属于 yodo 的新 tab）。手势时间窗（`isWithinGestureWindow`）保留，不再作为待验证项。
- noopener 弹窗仍可能漏掉，接受这个缺口，不再单独验证。

扩展化之后，归属规则由扩展提供，录制侧只保留三条：

1. 录制窗或 run 窗内的 tab：属于 yodo，直接采集。
2. `openerTabId` 属于 yodo 的新 tab：由扩展自动纳入并上报 `tab.created`，录制侧采集。
3. 其它 tab：不采集。

旧的手势时间窗（`isWithinGestureWindow`）用于"无窗口信息的 noopener 弹窗"。是否删除，实现后用真实页面验证再决定，实现前保留现有代码。

未验证的边界：`rel="noopener"` 或 `window.open` 不带 opener 的弹窗，Chrome 不会给出 `openerTabId`，扩展不会纳入，录制会漏掉。
## record stop 的输出

`yodo record stop` 的 stdout 为 JSON，字段固定，不包含统计或任何判断结论：

```json
{
  "status": "stopped",
  "name": "<record name>",
  "recordDir": "<录制目录的绝对路径>",
  "timeline": "<recordDir>/timeline.jsonl"
}
```

- `recordDir` 是唯一的材料目录，所有文件都在它下面。
- `timeline` 指向按时间排序的索引，是读取录制的入口。
- 不输出计数。模型需要了解录制内容时，直接读 timeline 与响应文件。

## 学习

- 不提供 `yodo learn` 命令。模型直接读取 `record stop` 输出的 `timeline` 与 `recordDir` 下的响应文件。
- 材料不做分阶段门控，模型按需读取任意文件。
- network 还是 dom 的选择由模型依据材料判断。SKILL 不写固定判断规则，不规定签名头的识别方式，也不定义"纯接口"。

## 输出大小：从源头控制

- stdout 输出全量 `result`，不做文件兜底，不做截断，不生成 `runs/` 目录。
- 控制输出大小的责任在 task：`result` 只包含用户要求的字段。原始接口响应、整段 HTML、完整列表只能在 task 内部用于取值，不能原样返回。
- task 文件头 `@summary` 写明 `result` 的结构（字段名与含义），让调用者在运行前就知道会得到什么。
- 录制侧的接口响应只存为文件，不进入 stdout；模型需要看响应时，直接读录制目录里的文件，不通过 `run` 输出。
- 不设运行时上限。超大结果是 task 的设计问题，应该修改 task，而不是由 runner 截断。

## 运行

- `yodo run <task> [args]` 启动脚本，原样输出脚本的 `status` 与 `result`。
- `yodo run`（不带参数）列出 `~/.yodo/task` 中每个 task 的摘要（名称、`@status`、`@summary`、参数说明），不运行任何脚本。不做关键词过滤，由模型自行阅读列表。
- 不做失败次数统计，不做止损，不做重试，不做 `state.json`。同一个 task 可以被任意次数运行，次数不限制。
- 不做失败分类，不做 `verify`，不做 `@effect` 与 `unknown` 状态。
- 草稿与验证过的脚本都在 `~/.yodo/task`，用 `@status: draft | verified` 区分，仅作为提示，不影响运行。

## 失败的处理

- 失败由脚本自己报告：脚本抛出的错误原样输出到 stderr，退出码非零。
- 是否重试、是否修改脚本、是否告诉用户，由模型根据错误信息决定。
- 写操作的状态确认由 task 自己用 `evaluate` 完成（例如点击前先读取状态），不由 runner 强制。

## task 的 API（重新设计）

- 保留：`yodo.run(fn)`、`page.evaluate(fn, ...args)`、`page.cdp.send`、`page.cdp.on`、`goto`、`serializeUrl`、`parseUrl`，以及页面操作 helper（`click`、`fill`、`press`、`scroll`、`check`、`select`、`waitForSelector`）。
- 新增：`expectRequest(page, { method, path }, action, { timeout })`：执行 `action` 前开启 Network 监听，等待匹配的请求，返回该请求的 `{ status, body }`。用于判断会发请求的 DOM 操作是否成功。
- 删除：`_cdp.connection`、`_cdp.browser`。
- 副作用 helper：`toggle(page, selector, { target: true })`，先读取当前状态，已满足则返回 `already`，否则点击一次并返回 `done`。

## 存储

- 目录只保留：`~/.yodo/task`、`~/.yodo/record`。
- 删除 `~/.yodo/temp`、`.active` 认领文件、`sweepDeadActive`。

## 安装

- 第一次安装前，`~/.yodo` 不存在，`yodo` 命令也不存在。安装入口是 skill 包里的 `setup.js`，只依赖 skill 包本身，不依赖 `~/.yodo`，也不依赖 `yodo` 命令。
- `node setup.js` 依次执行：
  1. 检查 Node ≥24。
  2. 停止旧的 holder（升级时）。
  3. 拷贝 `src/` 到 `~/.yodo/src/`，安装依赖。
  4. 写入 native host 的启动脚本与 manifest。
  5. 生成 `~/.yodo/bin/yodo` 与 `yodo.cmd` shim。
  6. 创建 `~/.yodo/task/` 与 `~/.yodo/record/`。
  7. 输出扩展的加载路径（`~/.yodo/src/chrome-extension`）。
- 扩展由用户手动加载（Load unpacked），不能由 agent 或脚本完成。安装结束后，agent 必须提示用户：
  1. 打开 `chrome://extensions`，开启「开发者模式」。
  2. 点「加载已解压的扩展程序」，选择 `~/.yodo/src/chrome-extension`。
  3. 完成后回复「好了」。
- 用户回复后，agent 运行 `~/.yodo/bin/yodo doctor` 验收；扩展未连接时，`doctor` 报告 `need-extension` 的处理方式。
- 扩展加载步骤写在 `install.md` 中，按上述顺序执行。
- `yodo doctor` 只读。`~/.yodo` 不存在时，输出"未安装"，指向 `install.md`，退出码非零，不抛异常。
- `install.md` 写明：安装完成后，agent 用 `~/.yodo/bin/yodo` 的绝对路径调用；可选地把 `~/.yodo/bin` 加入 PATH。
- 安装目录与部署版本可能不同，doctor 必须从 `~/.yodo/src` 运行。

## 迁移（由 install.md 指引执行）

- 迁移不写进 `yodo install` 代码。它是 `skills/yodo/install.md` 中的一个步骤，由重新安装时的 agent 按指引执行。
- `install.md` 只描述安装与升级的步骤；`SKILL.md` 不提及迁移（与 AGENTS.md 的分工一致）。
- `install.md` 中的迁移步骤：
  1. 检查 `~/.yodo/temp/` 是否存在。不存在则跳过整个迁移。
  2. 对其中每个 `.js` 文件：
     - 与 `~/.yodo/task/` 中同名文件内容相同：删除 temp 中的副本。
     - 名称不冲突：移动到 `~/.yodo/task/`，文件头加入 `@status: draft`（已有 `@status` 的不改）。
     - 名称冲突且内容不同：移动到 `~/.yodo/task/`，文件名加 `-from-temp` 后缀，标为 `draft`，并告诉用户，由用户决定保留哪一个。
  3. 删除 temp 中的非 `.js` 文件（如 `output.json`、`package.json`）。
  4. 删除 `~/.yodo/temp/` 目录，以及 `~/.yodo/state.json`（若存在）。
  5. 向用户报告移动、删除、重命名的文件清单。
- 步骤必须能重复执行：第二次运行时 temp 不存在，直接跳过。
- `task/` 中已有的、没有 `@status` 的脚本视为 `verified`，迁移步骤不改写它们。

## 删除清单

| 删除项 | 理由 |
|---|---|
| `_cdp.connection` / `_cdp.browser` | 已无 browser 级命令可用 |
| `@ghostery/adblocker` | 录制不再过滤广告 |
| `temp` 目录与 promote 流程 | 用 `@status` 替代 |
| 两份 timeline、`eventId` 交叉引用 | 一份 timeline 足够 |
| run 窗的 tab 复用与导航回收 | 每次新开 tab，结束时关闭；锚点 tab 只用于保持窗口存活 |
| `bin/*.js`、`init.js` | 收敛到 `src/cli/yodo.ts` 一个入口 |
| 大部分 selfcheck | 换成少量端到端测试 |
| `run-report.ts` 中的 console 捕获与堆栈格式化 | 只输出 `status` 与 `result` |

## 分阶段执行

1. **阶段一：CLI 与存储**。合并 bin，删除 temp，实现 `src/cli/yodo.ts` 与 shim。
2. **阶段二：运行时管理**。实现录制窗、run 窗（含锚点保活、静默重建与标题校验），去掉 `ensureAnchor` 的 tab 复用逻辑。
3. **阶段三：录制重写**。合并为一份 timeline，去掉 adblock 与复杂追踪。用真实站点录制验证。
4. **阶段四：record stop 输出**。按"record stop 的输出"一节实现 JSON 输出（状态、名称、录制目录、timeline 路径）。
5. **阶段五：task API 与 SKILL**。保留并整理 task-lib 的 helper，新增 `toggle`；精简 SKILL.md 为 `run → 没有就 record → 读材料 → run` 四步。

每个阶段结束后，用一个示例 task 跑通 `record → 读材料 → run` 链路，作为回归测试。

## 与之前的方案

- 本方案取代 `skill-simplification.md` 中关于目录、流程与次数限制的设计。合规测试与判断表不再作为规则写入 SKILL。

## 测试

- 单元：扩展通道的分帧与应答匹配（已有）。
- 扩展桩测试：tab 归属、事件转发（已有）。
- holder 端到端：run 窗创建与重建、标题、录制窗关闭（需更新）。
- 链路测试：`record → 读材料 → run` 用一个真实站点的简单操作（如搜索）。

## 风险

- helper 的实现保持简单，只做页面内的 DOM 调用；复杂操作由 task 用 `evaluate` 自己写。SKILL 只说明 helper 的用法，不提供片段。
- 不做 holder 重启恢复，holder 退出时若 run 窗未关闭，会留下一个空窗口；这是接受的代价。
- 录制不再过滤广告，timeline 会更大。

本轮依据
~/Code/x/yodo/yodo-browser-skill/plan/skill-simplification.md
      # 对照旧的精简方案，确认哪些设计被本方案取代


## 实现时要改掉的地方

以下内容在现有文件中与新方案冲突，实现时一并改写或删除。

### skills/yodo/SKILL.md

- 第 2.2 节：`temp` 与 `task` 的区分，改为只有 `~/.yodo/task`，用 `@status` 标记。
- 第 2.3 节：「缺少 capability 时不得自行打开目标站点……」等规则，改为由 `run`（列表）、`record` 的命令结果决定，不再靠文字约束。
- 第 3.1 节：`command status` 表改为 `yodo run` 的 stdout 格式（`task status` 与 `result` 的 JSON），删除 `output.json`、`resultFile` 与 8KB 规则。
- 第 4 节：拆分与匹配的细则，压缩为 `run` 列表的结果如何使用。
- 第 5.1 节：`node ~/.yodo/task/*.js` 改为 `yodo run <task> [args]`。
- 第 5.2 节：「修改 capability」的 candidate 流程删除，改为直接改 `~/.yodo/task` 中的脚本并标记 `@status: draft`。
- 第 6 节：`~/.yodo/src/bin/record-*.js` 改为 `yodo record start|stop|abort`；`recordDir` 的文件结构改为一份 `timeline.jsonl` 与响应文件。
- 第 7 节、第 8 节：network 两次尝试与 DOM 阶段规则删除。SKILL 不再规定次数，不再规定阶段门控，只说明 `record stop` 输出的 `timeline` 路径与读取方式，以及 network 或 dom 的选择由模型依据材料决定。
- 第 8.2 节：helper 的用法说明保留，删除"优先使用 lib 中已有的通用操作"之外的示例代码。
- 第 9.1 节：`_cdp.connection`、`_cdp.browser` 的说明删除。
- 第 10 节：有副作用的操作规则保留文字版：执行前先用 `evaluate` 读状态，已满足则不再操作。

### AGENTS.md

- 第 52、55 行：`setup.js` 仍是安装入口，改写其描述（引导脚本、生成 shim）。
- 第 91 行：`~/.yodo/temp` 的 candidate 流程删除。
- 第 113 行：`_cdp.connection` 与 `_cdp.browser` 的说明删除。
- 目录结构中的 `temp`、`bin` 相关条目同步删除。

### skills/yodo/install.md

- 安装步骤改写为 `node setup.js` 的顺序（见 plan"安装"一节），补充 shim 位置与 PATH 说明，`doctor` 的未安装输出。扩展加载步骤保留。

### 代码

- `src/browser/session.ts`：run 窗的 `ensureAnchor` 复用逻辑（约 502–505 行）删除，改为每次新开 tab，结束时关闭；锚点 tab 保留。`endRunTabs` 的导航回收改为关闭。
- `src/sdk.ts`：删除 `_cdp` 字段与 `cdp.subscribe` 的 scope 设计；`page.cdp` 简化为 `send` 与 `on`；新增 `expectRequest`（放在 task-lib 中）。
- `src/holder.ts`：删除 `FORBIDDEN_ADVANCED` 列表。协议上不暴露 browser 级命令，禁止项不再需要单独列出。
- `src/record/collect.ts`、`src/record/dom.ts`、`src/record/types.ts`：操作类型改为上面四种；合并两份 timeline；删除 adblock、late mainDoc、popup tracker 的复杂逻辑。
- `src/templates/task-lib/dom.js`、`dom.d.ts`、`index.js`、`index.d.ts`：保留页面操作 helper，新增 `toggle`，去掉可信输入相关实现。
- `src/task-lib.selfcheck.ts`：补充 `toggle` 的断言（已满足时不点击）。
- `src/constants.ts`：删除 `TEMP_DIR`。
- `src/store/layout.ts`：只创建 `task` 与 `record`。
- `src/run-report.ts`：删除 `output.json` 与 `resultFile`，stdout 只输出 `task status` 与 `result`；删除 console 捕获与堆栈格式化。
- `src/store/repository.ts`：删除 `.active` 认领相关函数，改为用 holder 内存中的录制状态。
- `bin/*.js`、`init.js`：删除，功能并入 `src/cli/yodo.ts`。`setup.js` 保留并改写为引导脚本。

### 已有用户文件

- `~/.yodo/temp/` 下的脚本（当前有 `zhihu-search-like-first.js` 等）：迁移到 `~/.yodo/task` 时补上 `@status: draft`，或删除。
- `~/.yodo/task/` 中已有的 capability 不做兼容，按 `@status: verified` 保留；import 的 helper 与新版签名不一致时，逐个修改。

## 串联与组合（已确定）

### 1. 只有一个命令：`yodo run`

- 不新增 `chain`、`do`、`pipe` 等命令。
- `yodo run <task> [args]`：运行 task，行为与现在一致。
- `yodo run -e "<代码>"`：组合模式，代码中可调用 `task(name, ...args)`。
- `yodo run --stdin`：从标准输入读取组合代码，用于长代码，避免引号问题。
- 组合模式本身不计入任何 task，也不能被复用；可复用的部分必须是 task。

### 2. 组合代码的语义

- `task(name, ...args)` 返回该 task 的 `result`；`status: failure` 时抛出异常。
- `task()` 内部走与 `yodo run <task>` 相同的路径，输出的 `status` 与 `result` 一致。
- task 之间的中间结果是 JS 对象，不需要 `map`、jq 或临时文件。

### 3. 不做的事

- 不做串联描述语法（`a | b`、`then`、路径表达式）。
- 不做 jq 或 JSONata 之类的转换依赖。
- 不做 `runs/` 目录与 `yodo result` 命令。`result` 由 `yodo run` 直接输出到 stdout；需要留痕时由调用者自行重定向。

### 4. 输出

- stdout 只输出 `task status` 与 `result` 的 JSON。
- 状态、进度和错误输出到 stderr。

### 5. 安全

- `-e` 与 `--stdin` 执行的是调用者提供的代码，等同于运行脚本。SKILL 要说明：不要把外部内容直接拼进组合代码。

### 6. 待定

- 扇出：上游结果是数组，需要对每一条运行下游 task。建议：由组合代码自己用 `for` 循环调用 `task()`，不引入额外语法。
- 中途失败：组合代码中前一个 `task()` 抛出异常时，整段代码停止；是否自动重试由代码决定，runner 不自动重跑。

## 不支持的功能

- **证书错误忽略**（`Security.setIgnoreCertificateErrors`）：扩展的 `chrome.debugger` 会话里该命令不可用（实测返回 `'Security.setIgnoreCertificateErrors' wasn't found`），不做按 tab 设置。yodo 的 task 很少需要忽略证书错误；遇到证书错误的站点不在支持范围内。

## 录制的已确定决策（实测后）

- timeline 行不记录 `tabId`、`windowId`。窗口归属以录制时的扩展规则为准，不在记录里追加字段。
- 站点内的第一方 block 请求（如 IT 之家的 `block/*.html`、`adtemplate`）暂不做过滤，保留在 timeline 中。
- `record stop` 输出保持 `status`、`name`、`recordDir`、`timeline`。

## 待定

（当前无待定项。）

