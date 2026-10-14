# 架构简化与优化

## 范围

四项，按这个顺序做：

| 编号 | 内容 | 风险 |
|---|---|---|
| A | daemon 与扩展的版本检测，空闲时自动换成新代码 | 低 |
| B | 部署时不再把自检和夹具拷到 `~/.yodo/src` | 很低 |
| C | run / record 的"谁在忙"收成一个明确的模式 | 低 |
| D | "哪些窗口、tab 是 yodo 的"只留扩展里一份，缩小对账 | 高，分阶段，有关卡 |

不做的（各有原因，见文末）：relay / daemon / 扩展的分层、三层协议合并、`record/` 再拆、task-lib 去掉复制、页面事件按需订阅。

## 现状证据

- 生产代码约 4600 行：`record/` 1865（40%）、`browser/` 707、`cli/` 674、扩展 246、`holder.ts` 239、`sdk.ts` 90。自检约 2335 行，dev 工具 343 行（在 [dev-tools.md](dev-tools.md) 设的 15% 上限内）。
- 每次安装之后，运行中的 daemon 还是旧代码，需要手动 `kill`。原因：`ping` 只返回 `pid / chrome / extension / pages / record`，没有版本；`setup.js` 又不停 daemon。
- 扩展 `manifest.json` 的版本写死 `0.1.0`，hello 里的 `extensionVersion` 永远不变，无法判断已加载的扩展是不是最新。
- `run.begin` 与 `record.start` 里一共 5 处各写各的 `RUN_BUSY` 判断；"忙"由 `activeRunConn`、`recordBusy`、`liveRecordName()` 三处状态组成，`record/index.ts` 有 9 个模块级可变变量。
- "哪些 tab 是 yodo 的"有三份：扩展的 `owned`（写入 `storage.session` 与 `storage.local`）、`CdpContext` 的 `pagesMap / runWindowId / runAnchorId / runTabId`、录制器的 `RecordWindowTracker`；`reconcile` 约 50 行和扩展的恢复逻辑约 40 行都是为了让它们一致。
- `copyRuntime` 只排除 `node_modules`，`*.selfcheck.*` 和 `record/fixtures/` 都会被部署。`dev/rpc.ts` 是 `holder.ts` 静态 import 的，不能一起排除；它由标记文件 `~/.yodo/session/dev` 控制，默认关闭。

## A. 版本检测与自动重启

**目标**：安装之后不用手动重启 daemon；扩展没刷新时 `doctor` 能说出来。

**为什么现在可以做**：relay / daemon 拆开之后，重启 daemon 只会丢 run 和录制的状态，空闲时重启是安全的。daemon 退出后 relay 随之退出，扩展按指数退避重连（1 秒起，上限 `RETRY_MAX_MS`），Chrome 重新拉起 relay，relay 再拉起新 daemon。

**设计**

- `setup.js` 在 `~/.yodo/src/.version` 写入 `{ build, extension }`：
  - `build`：`src` 下运行时代码（排除 `node_modules`、自检、夹具）内容的哈希；
  - `extension`：`chrome-extension/` 下 `background.js` 和 `manifest.json` 的哈希。
- daemon 启动时读一次 `.version`，记为自己的 `build`。`ping` 新增 `build`、`extensionBuild`、`mode`。
- 扩展启动时对自己的 `background.js` 取哈希（`fetch(chrome.runtime.getURL(...))` + `crypto.subtle.digest`），随 `hello` 发给 daemon。
- 新增 RPC `daemon.exit`：只在模式为 `idle` 时接受（先回应，再 `shutdown(0)`）；否则返回 `RUN_BUSY`，不退出。
- `ensureAttached`（CLI 与 SDK 共用）：`ping` 的 `build` 与磁盘上 `.version` 不同、且 `mode` 为 `idle` 时，发一次 `daemon.exit`，然后按现有逻辑等待新 daemon 连上。每次调用最多重启一次，避免循环。忙的时候不重启，继续用现有的，下次空闲时再换。
- `setup.js` 结束时做同样的事（复用同一个函数）；忙就打印"daemon 正忙，空闲后自动更新"。
- `doctor` 新增两项：daemon 是否最新；扩展是否最新（不同则提示"在 chrome://extensions 里刷新 yodo"）。

**步骤**

1. `.version` 的写入与读取（`store/` 下一个小函数），`setup.js` 调用。
2. `ping` 带 `build`、`mode`；`daemon.exit`（依赖 C 的模式，A 先用现有的"没有 run、没有录制、没有录制操作"判断，C 完成后改为读模式）。
3. `ensureAttached` 与 `setup.js` 的重启逻辑；`doctor` 两项。
4. 扩展的 `buildId`：`hello` 带上，selfcheck 用假 `chrome` 对象覆盖。
5. 更新 install.md（不再需要手动重启 daemon；扩展代码改动仍要刷新）、AGENTS.md 4.2。

**测试**

- e2e（假扩展）：改 `.version` 后 `ensureAttached` 使 daemon 换成新 pid；run 进行中不重启；`daemon.exit` 忙时拒绝。
- 扩展 selfcheck：`hello` 含 `buildId`。
- 真机：改一行 daemon 代码 → `setup.js` → 下一条命令自动换成新 daemon，窗口数量不增加。

**风险与未验证**

- 扩展里 `fetch(chrome.runtime.getURL("background.js"))` 在 MV3 service worker 中是否可用，我还没有实测，第 4 步第一件事就是验证；不行就改为 `manifest.json` 的 `version` 字段，由 `setup.js` 在内容变化时自动递增。
- daemon 退出到新 daemon 就绪之间有几秒空档，期间命令会等 `HOLDER_READY_MS`（8 秒）；指数退避多次失败后的重连间隔可能更长，需要真机看一次。

## B. 部署过滤

**目标**：用户机器上的 `~/.yodo/src` 只有运行时代码。

- `copyRuntime` 的过滤器除 `node_modules` 外，再排除文件名含 `.selfcheck.` 的文件和 `record/fixtures/` 目录。
- 保留 `dev/`：`holder.ts` 静态 import 了 `dev/rpc.ts`，它默认关闭、有命令白名单。`scripts/dev/` 在 `src` 之外，本来就不部署。
- `verify:pack` 加断言：部署目录里没有 `*.selfcheck.*` 和 `fixtures/`。
- 注意：A 里的 `build` 哈希要用同一个过滤规则，不然测试文件的改动会触发不必要的重启。过滤规则放在一处导出。

## C. 统一模式

**目标**：`run / record` 是否忙，只有一个来源；`RUN_BUSY` 的判断只写一处。

**设计**：新增 `src/mode.ts`（约 40 行）。

- 状态：`idle`、`run`（带发起它的连接）、`record-op`（start / stop / abort 正在执行）；"录制进行中"仍以 `liveRecordName()` 为准，由注入的函数读取，避免和 `record/index.ts` 重复保存。
- 接口：`tryBeginRun(conn)`、`endRun(conn)`、`tryBeginRecordOp()`、`endRecordOp()`、`current()`。`try*` 在忙时返回 `{ reason, message }`，`reason` 保持现有的 `"run" | "record" | "record-op"`，SDK 的等待规则不变。
- `holder.ts` 里 5 处判断和 `recordBusy`、`activeRunConn` 的"是否忙"用法都改成调用它；`ping` 报告 `mode`；`daemon.exit` 读它。
- 不改行为：`activeRunConn` 仍用于事件回流，只是"是否忙"不再散落。

**测试**：表驱动 selfcheck，行是当前状态（idle / run / record-op / 录制中），列是操作（run.begin、record.start、stop、abort、daemon.exit），断言结果与现有行为一致，再对照 e2e。

## D. 所有权单一来源（分阶段，有关卡）

**目标**：窗口、tab 的所属与类型只在扩展里登记一份；daemon 和录制器不再各存一份，`reconcile` 随之缩小。

**为什么放最后**：改动最大，涉及扩展，需要你刷新扩展，而且只有在真机上才能证明和现在等价。前三项完成后再决定是否继续。

**阶段**

- **D0 特性固化**：先把现在 `reconcile`、`RecordWindowTracker`、扩展恢复的行为写成 selfcheck（假扩展）：刷新扩展时 run 进行中；孤儿 run 窗口；录制进行中不碰录制窗口；收养已有的 run 窗口；用户关掉 run 窗口后重建。这一步不改任何生产代码，本身就有价值。
- **D1 扩展给窗口打类型**：`openWindow` 的 `kind` 已有 `record`，补上 `run` 和"锚点"标记，`listOwned` 与 `tab.*` 事件都带上 `kind`。持久化沿用现在的两份存储。
- **D2 run 窗口交给扩展**：新增扩展操作 `ensureRunWindow`（幂等：存在就返回，不存在就创建，必要时收养）；`CdpContext` 去掉 `runWindowId / runAnchorId` 的自管逻辑；`reconcile` 缩成"丢弃已不存在的页面记录"，孤儿窗口由扩展按类型清理，不再靠标题识别。
- **D3 录制器用事件里的类型**：`isTargetIncluded` 改为依据扩展上报的 `kind`，`activeWindowIds` 去掉。

**关卡与退出条件**：每个阶段结束都要 (1) D0 的所有场景仍通过，(2) 真机回归清单通过，(3) 净代码量下降。任何一条不满足，就回退到上一阶段，保留 D0 的测试。预计 D2、D3 净删除一百多行，这是估计，不是测量。

## 真机回归清单（A、D 共用）

1. 刷新扩展，run 窗口和录制窗口数量不增加；
2. run 进行中刷新扩展，task 得到明确的错误，窗口被清理；
3. 录制进行中刷新扩展，录制窗口保留，录制可以正常 stop；
4. 手动关掉 run 窗口后再运行，自动重建；
5. 改一行 daemon 代码后 `setup.js`，下一条命令自动换成新 daemon；
6. 录制含弹窗和在录制窗口里 Cmd+T 开的新 tab，stop 后 timeline 合理。

## 不做的

- **relay / daemon / 扩展分层、三层协议**：由 Chrome 的限制决定，合并会更难读。
- **`record/` 再拆**：刚拆过且有夹具保护，缺的是真机回归，不是再拆。
- **task-lib 去掉复制**：要改 task 的 import 约定，已有 task 要同步，收益有限。
- **页面事件按需订阅**：只是读代码看出来的风险，没有遇到过；遇到再做。
- **并发**：已决定保持串行。完成 C 之后，将来改并发规则只需动一处。

## 验收

- `npm run check`、`npm test`、`npm run verify:pack` 通过。
- A：安装之后无需手动重启 daemon；`doctor` 能指出扩展没刷新。
- B：部署目录里没有自检和夹具。
- C：`RUN_BUSY` 的判断只出现在 `mode.ts`。
- D：D0 的场景全部通过，真机回归清单通过；否则回退。

## 执行结果

**A、B、C 已完成并验证；D 按关卡在 D0 停止，没有做 D1 到 D3。**

### A 版本检测与自动重启

- 新增 `store/version.ts`（`.version`：`build` 与 `extension` 两个哈希）；`ping` 返回 `mode`、`build`、`extensionBuild`；新增只在空闲时接受的 `daemon.exit`；`restartStaleDaemon`（`cli/session.ts`）被 `ensureAttached` 和 `setup.js` 共用；`doctor` 新增 `daemon-build`、`extension-build` 两项（都是可选项，不影响退出码）。
- 扩展的 `hello` 带 `buildId`。`fetch(chrome.runtime.getURL(...))` 在 MV3 service worker 里是否可用，**还没有在真实 Chrome 里验证**，需要刷新扩展之后看 `doctor` 的 `extension-build`；读不到时 `buildId` 是空串，`doctor` 会提示"扩展没有报告版本，可能是旧版本"。
- 在真实环境里验证了 daemon 部分：给一个运行时文件加一行注释，只跑 `setup.js`，daemon 在约 1.3 秒内被自动换成新进程（pid 变化，窗口数量不变），没有手动干预；还原后再装一次又换了一次。
- 与计划的差异：忙时（run、录制）不动；旧 daemon（`ping` 里没有 `mode`）不动，所以升到这个版本时，最后一次需要手动重启。

### B 部署过滤

- `store/deploy.ts` 导出 `isRuntimePath`（排除 `node_modules`、`*.selfcheck.*`、`record/fixtures/`），部署拷贝和版本哈希共用。`dev/` 保留。`verify:pack` 断言部署目录里没有自检和夹具，有 `.version` 和 `dev/rpc.ts`。

### C 统一模式

- 新增 `src/mode.ts`，`holder.ts` 里 `activeRunConn`、`recordBusy` 和 5 处 `RUN_BUSY` 判断都改成调用它；`reason` 与提示文字不变，SDK 不用改。表驱动自检覆盖 run、record-op、录制进行中三种状态下 run.begin、record.start、stop、abort 的结果。
- 一个很小的行为变化：`record stop`、`record abort` 遇到另一个录制操作正在执行时，错误码从内部错误改为 `RUN_BUSY`（`reason: record-op`），文字不变。

### D 所有权单一来源：停在 D0

- **D0**：已有的自检覆盖了需要固化的行为——`browser/session.selfcheck.ts`（`reconcile` 的扩展刷新、holder 重启收养、录制窗口、run 进行中、保活窗）、`chrome-extension/background.restore.selfcheck.mjs`（扩展刷新后的恢复）、`record/collect.selfcheck.ts`（录制器的窗口规则）。不需要新增。
- **D1 到 D3 没做**，按计划的关卡判断：
  - 能删的：daemon 侧 `ensureRunWindow` 与 `reconcile` 里按标题收养和关孤儿的部分约 35 行，录制器 `RecordWindowTracker` 的窗口集合约 20 行。
  - 要加的：扩展里窗口类型的持久化与恢复、新的 `ensureRunWindow` 操作、`listOwned` 新字段约 40 行，加上要同步修改的 4 套假扩展（`session`、`collect`、e2e、`background` 的自检）。
  - **关键原因**：扩展刷新后从 `storage.local` 恢复登记，靠的是"窗口里有标题为 yodo 的 tab"，这是浏览器重启后 tab id 会被复用时唯一可靠的校验。标题识别不会消失，改后会变成"类型"和"标题"两套机制并存，更复杂。
  - 净代码量不会下降，还需要你刷新扩展并手动跑完 6 条真机回归，所以不做。这是依据代码量估算和上面的原因判断的，没有真的实现一遍再测量。
- 顺带发现的小问题，没有处理：录制窗口靠标题识别，用户在里面导航之后标题就变了，`reconcile` 不再把它当录制窗口，没有录制时它不会被当作孤儿窗口关闭。需要处理的话，最小的做法是让扩展给录制窗口打类型（已经有 `recordWindows`）并在 `listOwned` 里返回，只改这一处识别，不需要完整的 D。

### 真机回归清单

- 已验证：第 5 条（改一行代码后 `setup.js`，daemon 自动换成新的）。
- 需要你刷新扩展之后验证：第 1 到 4、6 条，以及 `doctor` 的 `extension-build` 是否变为 ok。
