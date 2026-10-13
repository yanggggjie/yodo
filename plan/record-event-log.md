# 录制：事件收集与处理解耦

## 背景

[collect.ts](../skills/yodo/src/record/collect.ts) 约 720 行，其中网络采集（`startCdpNetworkRecorder`）约 500 行，是一个 440 行的闭包函数。它同时做三件事：

1. 决定哪些 tab 要 attach；
2. 把 `requestWillBeSent` → `responseReceived` → `loadingFinished` 拼成一条请求记录；
3. 在事件处理函数里直接发 CDP 命令取响应体、写文件。

三件事缠在一起，只能靠真机验证。DOM 动作那一侧已经是"先收集、stop 时再处理"（`DomRecordStore` + `simpleDomTimeline`），网络侧是唯一边收边算的部分。

## 目标

- 采集端只负责 attach 和把原始事件追加到日志，尽量笨。
- 请求拼装、frame 地址、重定向、分类全部放到 stop 时，由一个纯函数完成。
- 真实录制得到的日志直接作为自检的夹具。
- 不改变对外行为：`timeline.jsonl` 和请求文件的格式、`record stop` 的输出都保持不变。

## attach 的作用与限制

- 扩展里的 `attach` 就是 `chrome.debugger.attach({ tabId })`，是扩展拿到 tab 的 CDP 事件、向它发 CDP 命令的唯一办法。
- 事件只在 attach 之后才会产生；晚 attach 会漏掉之前的事件。
- 因此下面两件事**不能**推迟到 stop：
  1. attach 本身；
  2. 取响应体：`Network.getResponseBody` 只能在 Chrome 还保留资源缓冲区时调用，页面跳转或 tab 关闭后会被清掉。
- 补抓主文档（`maybeLateDocument`）要读活着的页面，也必须在现场做。

## 目标结构

```text
采集（现场，尽量笨）
  对每个已 attach 的 tab，把白名单内的 CDP 事件原样追加到内存日志：
      { t, tabId, method, params }
  现场只做三件不可推迟的事：
      attach
      取响应体        → 追加一条 yodo.body 事件
      补抓主文档      → 追加一条 yodo.snapshot 事件

处理（stop 时，纯函数）
  assemble(日志) → RawRequest[]
  再走现有的 过滤 → adblock → 脱敏 → 去重 → 落盘
```

### 日志白名单

- Network：`requestWillBeSent`、`responseReceived`、`loadingFinished`、`loadingFailed`
- Page：`frameNavigated`、`loadEventFired`
- 自定义：`yodo.body`、`yodo.snapshot`
- 只记录 resource type 为 document / xhr / fetch 的 Network 事件，其余资源（图片、脚本等）在采集时丢弃。

### 日志的存放

- **只放内存，不落盘**。日志里有未脱敏的 Cookie、Authorization 和响应体，落盘会新增磁盘上的敏感数据暴露面。
- stop 或 abort 之后立即丢弃。
- 设总量上限，超限则停止追加并在 `record stop` 之后的日志里提示。上限数值待测量后确定。

### tab 的纳入规则

- 现状：`RecordWindowTracker.isTargetIncluded` 有窗口和 opener 两条规则，扩展侧还有一层所有权判断。
- 目标：宿主不再判断，扩展报告的 tab 一律 attach。扩展本来就只报告 yodo 拥有的 tab（`tabs.onCreated` 只纳入 opener 属于 yodo 的新 tab）。
- 这一点是读代码得出的推断，**需要在真实录制里对比验证**后才能删规则。
- 合并状态：sessionId 与 targetId 都是 tabId 的字符串，把 `sessionsBySessionId`、`sessionsByTarget`、`sessionToTarget`、`pendingSessions`、`pipelinedTargets`、`ignoredTargets`、`frameUrlMap` 七份状态合成一张 `Map<tabId, TabState>`。

## 步骤

1. **加日志，行为不变**：在现有逻辑旁边把白名单事件追加到内存日志。通过环境变量 `YODO_RECORD_LOG=<路径>` 在调试时把日志导出为 JSON，默认关闭。
2. **采集夹具**：在真机上录制几个典型场景，导出日志作为夹具：
   - 普通搜索页（document + xhr）；
   - 带重定向的登录或跳转；
   - 弹窗（`window.open`、`target=_blank`）；
   - 超大响应体；
   - 页面在 attach 之前就已加载完的情况（触发补抓主文档）。
3. **写 `assemble(日志)`**：纯函数，放在独立文件。用夹具断言它的输出与现有逻辑一致（请求数、URL、状态、响应体或文件）。
4. **切换**：确认一致后，让 stop 使用 `assemble`，删除采集端的拼装闭包。
5. **收缩规则**：验证 tab 纳入规则等价后，删掉 tracker 里多余的判断，合并状态表。
6. **补重定向链**：`requestWillBeSent` 带 `redirectResponse` 时，保留前一跳。现状（读代码得出，未实测）是同一个 `requestId` 的记录被覆盖，前一跳因没有状态被 `dropIncompleteRequests` 删掉。
7. **文档**：更新 AGENTS.md 4.5。

## 不做的事

- 不引入 puppeteer / playwright：它们依赖 browser 级 CDP（`Target`），而扩展里只有 `chrome.debugger` 的单 tab 会话。
- 不引入 `chrome-har`：它是批处理的（事件收齐后转换），产出 HAR，之后还要再转成现有的请求记录，适配成本和新增依赖都不划算。如果将来重定向等逻辑变复杂再重新评估。
- 不把页面里的 `fetch` / XHR 猴子补丁作为主方案：看不到浏览器自己加的请求头，漏掉 Service Worker 和 `sendBeacon` 的请求，且可能被站点检测。
- 不使用 `chrome.webRequest`：MV3 里拿不到响应体。
- 不加 `webNavigation` 权限，弹窗归属保持现在基于 `openerTabId` 的做法。

## 已单独完成的两项

这两项与解耦无关，已在同一次改动里完成，不用等事件日志重构：

- **不再自动接受 JS 对话框**：删除了 `Page.javascriptDialogOpening` → `accept: true` 的处理函数。用户在录制时遇到 `confirm` 可以自己选，不会被替用户点「确定」。去掉后对话框是否仍能被用户手动操作，需要用带 `confirm` 的页面实测一次。
- **录制窗口里用户自己开的新 tab 会被纳入**：
  - 扩展：`openWindow` 增加 `kind`（`"record"` 表示录制窗口）；`chrome.tabs.onCreated` 在「opener 属于 yodo」或「窗口是录制窗口」时纳入新 tab；`recordWindows` 同时写入 `storage.session` 与 `storage.local`；窗口关闭或移除时清理。run 窗口不放宽。
  - 宿主：不用改，`isTargetIncluded` 已有「所在窗口属于录制窗口则纳入」的规则。
  - 限制：新标签页（`chrome://newtab`）无法 attach，用户在里面第一次导航之后才 attach，第一次文档请求可能记成补抓的主文档（`late: true`）。这是依据 Chrome 对 `chrome://` 页面的限制判断的，需要真机确认。
  - 未处理：从别的窗口拖进来的 tab（`chrome.tabs.onAttached`）；外部应用的链接落进录制窗口时也会被记录。
  - 这使得「扩展报告的 tab 一律 attach」的假设更站得住，步骤 5 收缩 tab 纳入规则时可以引用。

## 风险

- 日志的内存量没有测过。需要白名单、类型过滤和总量上限。
- 等价性只能靠真实录制的夹具来证明；夹具覆盖不到的场景，切换后可能出现差异。因此步骤 4 之前不删旧逻辑。
- 删除 tracker 规则依赖「扩展只报告 yodo 拥有的 tab」这个推断，步骤 5 之前必须在真机上验证。

## 验收

- `npm run check`、`npm test`、`npm run verify:pack` 全部通过。
- 对每个夹具，`assemble` 的输出与旧逻辑一致。
- 在真机上录制一次（含弹窗和重定向），`timeline.jsonl` 的请求行与动作行与改动前的结构一致。
- `collect.ts` 行数明显下降，采集端不再包含请求拼装逻辑。

## 执行结果

已实现，与上面的设计有几处不同，原因都写在下面。

**做了什么**

- 新增 `record/requests.ts`：`RequestAssembler`，不做 I/O，只有一个入口 `feed(事件)`。事件格式就是上面的日志格式（`yodo.tab`、`yodo.frameTree`、`yodo.body`、`yodo.snapshot`、`yodo.tabGone` 加 CDP 事件）。
- `record/collect.ts` 的网络采集端缩成一层薄的驱动：attach、开启域、取响应体、读页面 HTML；七份 tab 状态合成一张 `Map<tabId, 阶段>`。`collect.ts` 从 722 行降到 399 行，拼装逻辑独立成 `requests.ts`（279 行）。
- `startInjectEvents` 不再需要 `sessionToTarget`，sessionId 就是 tabId。
- 夹具：`record/fixtures/local-site.json` 是在真实 Chrome 里加载一个本地站点抓到的 CDP 事件（主文档、iframe、XHR、fetch、POST、超过 1 KB 的 JSON、404、连接中断、302 重定向、非 HTML 文档、一个外部扩展的请求）。
- 自检：`record/requests.selfcheck.ts` 回放夹具；`collect.selfcheck.ts` 用内存版 raw 连接驱动真实的采集端，并验证导出的日志可原样回放。

**与设计不同的地方**

- 拼装器是**增量**的（事件进来就处理），不是 stop 时一次性批处理。原因：取响应体需要先知道响应头，必须在 `loadingFinished` 时就判断；增量的拼装器同样可以回放，等价但更简单。
- **日志不常驻内存**，只在设置 `YODO_RECORD_LOG` 时导出，避免默认多留一份含密钥的数据。

**用旧实现做基准**

重构前先用旧实现在这份真实夹具上跑出"黄金输出"（两种场景：正常、晚 attach），重构后的拼装器和采集端都必须逐字段一致，才算通过。

**发现并修复的问题**

- 补抓的主文档（`maybeLateDocument`）从来没有对输出产生过作用：补抓的行没有 HTTP 状态，在 stop 时被 `dropIncompleteRequests` 当成未完成的请求删掉了（旧实现里晚 attach 场景的日志是 `incomplete=2`）。现在 `dropIncompleteRequests` 保留 `late` 行，并加了测试：补抓行能走完过滤、脱敏、去重、落盘，出现在 `timeline.jsonl` 里。这是**有意的行为变化**，晚 attach 场景的黄金输出因此多一条 `late` 行；正常场景输出没有变化。
- 这也让上面"用户在录制窗口自己开的新 tab，第一次文档请求会被补抓"的说法真正成立（之前它是错的）。

**没有做的**

- **收缩 `RecordWindowTracker` 的纳入规则**：需要在真机录制里验证"扩展报告的 tab 一律 attach"和现有规则等价，没有验证就不删。
- **补重定向链**：重定向的中间跳现在在拼装器里仍然是未完成的请求，stop 时被丢弃，和旧实现一致。即使保留它，管线里的 `filterSuccessOnly` 也只放行 2xx，会再把它过滤掉。要真正记录重定向链，需要同时改拼装器和这个过滤器，目前没有人需要，所以没做。

**还没验证的**

- 真实 Chrome 里用户手动演示一次完整的录制（尤其是弹窗、Cmd+T 新 tab）。夹具来自真实 Chrome，但录制流程里的 attach 时机只在内存版 raw 连接上测过。
