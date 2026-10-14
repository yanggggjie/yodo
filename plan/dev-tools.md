> 注：本文中关于可信输入（isTrusted、Input.*）的决定已被 plan/record-untrusted-and-dom-driver.md 取代。

# dev：本地开发验证工具

## 约束（先于一切）

`dev` 的复杂度不能超过它所服务的代码。以下是硬约束，违反任何一条就先删再加：

1. **体量上限**：`dev` 相关代码总量不超过生产代码的 15%，约 700 行（生产代码现为约 4,800 行）。
2. **可整体删除**：生产代码里只允许一行式的调用，不放逻辑。删掉 `src/dev/` 和这些一行调用后，应用行为完全不变。
3. **零新增运行时依赖。** 本机开发工具（如 DuckDB）只用于本地，不进 skill 的发布内容。
4. **每个能力必须对应一个真实发生过的痛点**，写在本文。"将来可能用到"不算理由。
5. **一进一出**：新增一个机制时，先评估能不能删掉旧的某个。
6. **默认关闭，关闭时零行为差异。**

## 决定一览

| 问题 | 决定 |
|---|---|
| 名字 | 叫 `dev`。不叫 debugger（与 `chrome.debugger` 撞名）。不再使用"元层"这个词 |
| 目的 | 服务于本地修改代码、debug、调算法，拿到真实数据和真实现象。不是 CI，不是通过 / 失败 |
| 开关 | 标记文件 `~/.yodo/session/dev`，用 `touch` / `rm` 开关，不加 CLI 子命令。holder 在每次 `dev.*` 请求入口检查，不需要重启 |
| 与 holder 通信 | 脚本直接用现有的 `sessionRpc`，新增两个 RPC：`dev.pages`、`dev.cdp` |
| 模拟用户 | Driver 只用 `Input.*` 发受信任事件。录制器的 click、fill、change 监听器都有 `isTrusted` 判断 |
| 看见 | 录制流水线每一级返回丢弃原因；一次录制结束写一行汇总日志；dev 模式下保存原始事件 |
| 回放 | 只做数据回放：把保存的原始事件重新喂给流水线 |
| 原始事件 | 脱敏之前的数据，含密码和 token。只在 dev 模式写 `~/.yodo/dev/raw/<name>/`，权限 0600，不进 `record/`，不进发布内容 |
| 不做 | 见"不做的事" |
| 文档 | 只写进 AGENTS.md，不写进 SKILL.md 和 usage |

## 1. 要解决的痛点

| 痛点 | 对应的做法 |
|---|---|
| 改了录制代码，只能读输出猜发生了什么，看不到每一级丢了什么、为什么丢 | 流水线返回丢弃原因，录制结束写汇总 |
| 想用真实数据调过滤、去重、脱敏，每次都要开浏览器录一遍 | 保存原始事件，离线重放流水线 |
| 外部没办法"开始录制、像用户一样操作 Chrome、停止录制"，无法自动复现一次演示 | `dev.pages` + `dev.cdp` + Driver |

## 2. 组成

### 2.1 dev 通道（`src/dev/rpc.ts`，约 60 行）

holder 的 `dispatch` 增加一行：`dev.*` 交给 `src/dev/rpc.ts` 处理。

| method | 作用 |
|---|---|
| `dev.pages` | 列出 yodo 的页面：pageId、windowId、url、标题。录制页在 `record.start` 之后标题是 `yodo record`，Driver 靠标题找到它 |
| `dev.cdp` | `{ pageId, method, params }`，对该页面发 CDP，可用于录制窗口。拒绝 `*.disable`、`Target.*`、`Browser.*` |

入口先检查标记文件，不存在就返回错误。生产环境的 `cdp.send`（只能在 run 中使用）不变。

页面事件不推送：Driver 靠轮询 `Runtime.evaluate` 等待，避免引入订阅机制。

### 2.2 流水线返回丢弃原因（`record/pipeline.ts`）

现状：`processTimelinePipeline` 依次做 `filterSuccessOnly → filterAdblock → sanitize → dedupe`，只返回结果。

改为：每一级返回 `{ kept, dropped: [{ event, reason }] }`，新增 `runPipeline()` 返回每一级的输入数、输出数、按原因分类的丢弃数；`processTimelinePipeline` 变成 `runPipeline(...).events`。

- `reason` 取固定值：`non-2xx`、`redirect`、`adblock`、`third-party-duplicate`。
- 输出内容不变：同一份输入，结果与现在逐字节一致。改动前后各跑一次对比，作为这一步的前置检查。
- `doFinish` 末尾写一行汇总日志（走现有 `logger`）：名称、各类型行数、按原因分类的丢弃数、警告。

### 2.3 保存原始事件（`record/index.ts` 加一行调用）

dev 模式开启时，录制结束前把 `current.events` 与 `domStore.events` 写到 `~/.yodo/dev/raw/<name>/`（`events.json`、`dom.json`、`meta.json`）。权限 0600。AGENTS.md 明确写出这里可能有密码和 token，用完 `rm -rf ~/.yodo/dev`。

### 2.4 Driver（`src/dev/driver.ts`，约 150 行）

客户端库，基于 `sessionRpc("dev.cdp")`，只用 `Input.*`、只读的 `Runtime.evaluate`、`DOM.getBoxModel`、`Page.navigate`。

| 方法 | 实现 |
|---|---|
| `goto(url)` | `Page.navigate`，再等地址变化且 `readyState === "complete"`。录制脚本注入在隔离 world、先于页面脚本执行，所以不需要单独等"就绪" |
| `waitFor(表达式)` | 轮询 `Runtime.evaluate` 直到成立或超时 |
| `click(选择器)` | 读元素中心，依次发 `mouseMoved`、`mousePressed`、`mouseReleased` |
| `type(选择器, 文本)` | 先点击聚焦，逐字 `dispatchKeyEvent`，最后 Tab 失焦才会触发 `change` |
| `scroll({ y })` | `mouseWheel`，位移不小于 20px，并等 300ms 以上 |

### 2.5 夹具与脚本（`scripts/dev/`，约 250 行，不进发布内容）

- `fixture.mjs`：本地 HTTP 服务。第一方 `shop.localhost`，第三方 `tracker.localhost`（`tldts` 把它们解析成不同域名，Chrome 把 `*.localhost` 指向本机）。内容只放必要的：带密码的表单、带查询参数的搜索、一个第一方 XHR、一个大于 1KB 的响应、一次 301/302、一个第三方打点。
- `shop.mjs`：默认场景，登录、搜索、勾选、滚动、点进商品。
- `diff.mjs`：与上一次比较、打印流水线各级的小工具。
- `record.mjs <场景.mjs>`：起夹具、开始录制、执行场景（场景是一个函数，拿到 Driver）、停止录制，打印汇总。
- `replay.mjs <raw 目录>`：import 流水线，重放原始事件，打印每一级的输入、输出、丢弃原因；结果存成 `replay-<序号>.json`，并与上一次比较，列出多了、少了哪些行。

## 3. 分步

### 第 0 步：先验证假设（最小代价）【已完成】

只做 2.1 的 `dev.pages` / `dev.cdp` 和一个临时脚本，回答下面的问题。如果假设不成立，后面要改路线。

1. `Input.dispatchMouseEvent` / `dispatchKeyEvent` 产生的事件，录制器是否接收？timeline 里是否出现对应的 click、fill、change 行？
2. 逐字输入后 Tab 失焦，能否稳定产生 `change`？
3. timeline 里的 `navigation` 行是怎么产生的？`Page.navigate` 能否触发？
4. `window.__yodoGen` 能否作为"录制脚本已生效"的判断？
5. 滚动 20px 阈值与 250ms 去抖下，`mouseWheel` 能否产生一条 scroll 行？

完成的标志：贴出模拟操作后录制器产生的真实 timeline。

结果（在真实 Chrome 里用 Driver 模拟一次演示）：

| 假设 | 结果 |
|---|---|
| 1. `Input.*` 事件被录制器接收 | **成立**。出现 value、checked、click、scroll 行，且带 `selector`（`#q`、`#agree`、`#go`） |
| 2. 逐字输入后 Tab 失焦产生 change | **成立**。中英文混合的 `耳机 pro` 被完整记录 |
| 3. `navigation` 行的来源 | 来自 `Page.frameNavigated`（跨页）和 `Page.navigatedWithinDocument`（单页应用）。`Page.navigate` 会触发 |
| 4. `window.__yodoGen` 可判断就绪 | **不成立**。录制脚本在隔离 world 里，主页面看不到。结论：删掉 `waitReady`，`goto` 等到加载完成即可 |
| 5. `mouseWheel` 产生 scroll 行 | **成立**。`deltaY` 为 600 和 -600 各一行 |

另外：元素在视口外时 Driver 直接报错，不使用 `scrollIntoView`，因为程序化滚动也会被录制成 scroll 行。

### 第 1 步：看见【已完成】

2.2 + 2.3 + `replay.mjs`。

完成的标志：对一次真实录制，打印每一级的输入、输出、丢弃原因，并展示改动一处过滤规则后的差异。

### 第 2 步：驱动【已完成】

2.4 + 夹具 + `record.mjs`。

完成的标志：一条命令跑完"开始录制 → 模拟演示 → 停止录制"，打印汇总，并与上一次的结果比较。

## 4. 不做的事

下面这些都评估过，**现在不做**。重新考虑的条件是：出现一个具体的、靠现有手段解决不了的问题。

| 不做 | 理由 | 重新考虑的条件 |
|---|---|---|
| 自写事件 hub、`waterfall`、探针 | 到目前为止的问题（对账、超时、`ping`）都是读代码加看日志定位的，没有一个需要"运行中改变行为" | 出现第一个必须在运行中替换或包装某一步才能验证的问题。观察用 Node 自带的 `EventEmitter` 起步 |
| 事件目录与一致性检查脚本 | 单人项目靠约定足够，是持续的维护负担 | 事件多到需要登记时 |
| logger 改成订阅者 | 用户看不到收益，动的是稳定代码 | 无 |
| `dev.eval`、状态只读视图 | 需要进运行中的 holder 时，用 Node 自带的 inspector：`kill -USR1 <pid>` | 无法用 inspector 满足时 |
| 内存黑匣子 | 日志文件本身保留最近 20MB | 无 |
| 页面事件订阅（`dev.subscribe`） | Driver 用轮询即可 | 轮询明显不够用时 |
| 操作回放（重放 timeline 里的动作） | 需要先确认 Driver 可行 | 第 2 步完成后，有重复复现演示的需求时 |
| 链路回放（假链路重放 CDP 事件） | 数据回放已经覆盖算法调试 | 要调试采集器本身而不是流水线时 |
| "测试就是不变量探针" | 会让测试耦合内部事件名；共用假链路只需要一个普通辅助模块 | 无 |
| DuckDB / Perfetto 导出 | 现在的量不需要；对比先用脚本做 | 事件量大到脚本不够用时 |

## 5. 改动的文件

| 文件 | 改动 |
|---|---|
| `src/dev/rpc.ts` | 新增，`dev.pages`、`dev.cdp` 与标记文件检查 |
| `src/dev/driver.ts` | 新增，Driver 库 |
| `src/holder.ts` | `dispatch` 增加一行转发 `dev.*` |
| `src/protocol.ts` | `RpcMethod` 增加两个 method |
| `src/record/pipeline.ts` | 流水线返回丢弃原因，新增 `runPipeline` |
| `src/record/index.ts` | `doFinish` 写汇总日志；dev 模式下一行调用保存原始事件 |
| `scripts/dev/` | 新增 `fixture.mjs`、`record.mjs`、`replay.mjs` |
| `AGENTS.md` | 新增一节"dev"：开关、两个 RPC、原始事件的安全提醒、约束 |

## 6. 风险

| 风险 | 对策 |
|---|---|
| `dev.cdp` 能对 yodo 的页面发任意 CDP | 默认关闭，标记文件；拒绝 `*.disable`、`Target.*`、`Browser.*`；只作用于 yodo 自己的页面（`pageById` 的既有范围） |
| 原始事件含未脱敏的密码和 token | 只在 dev 模式写；单独目录；权限 0600；AGENTS.md 提醒用完删除 |
| Driver 破坏录制器 | 只用白名单方法，不调用 `*.disable` |
| 流水线重构改变输出 | 改动前后各跑一次，逐字节对比 |
| 第 0 步的假设不成立 | 先验证，再投入后面的步骤；不成立就改路线或收缩范围 |
| `dev` 本身变复杂 | 上面六条约束；每次增加前先看体量 |
