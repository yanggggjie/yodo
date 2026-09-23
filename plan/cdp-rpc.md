# 在 CLI task 中通过 RPC 暴露完整 CDP

## 决策

本次改造采用以下方案：

- `task.js` 始终在 CLI Node 进程执行。
- holder 持有唯一的共享 CDP WebSocket connection。
- task 通过 RPC 调用 holder 中的 CDP。
- task 正常使用当前运行页面的 `page.cdp`；排障或能力探索时可使用带下划线的 `_cdp.connection`、`_cdp.browser`。
- 只公开显式的 typed `send`、`on`、`once`。
- 不提供 `cdp.Page.enable()` 形式的 Domains facade。
- 不使用 JavaScript `Proxy` 动态生成 domain 和 method。
- 不为每个 CDP command 手写 RPC operation。
- 不保留旧 `page.*` 高层 API；这是 breaking change。
- 常见高层操作迁移到公开的 `~/.yodo/task/lib` 标准库。

目标写法：

```js
await yodo.run(async ({ page, _cdp }) => {
  await Promise.all([
    page.cdp.send("Page.enable"),
    page.cdp.send("Runtime.enable"),
    page.cdp.send("Network.enable"),
  ]);

  const urls = [];
  const off = await page.cdp.on(
    "Network.requestWillBeSent",
    ({ request }) => urls.push(request.url),
  );

  const loaded = page.cdp.once("Page.loadEventFired", { timeout: 30_000 });
  await page.cdp.send("Page.navigate", { url: "https://example.com" });
  await loaded;

  const title = await page.cdp.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });

  await off();
  return {
    title: title.result.value,
    urls,
  };
});
```

正常 task 不使用 `_cdp`。只有 `page.cdp` 和 `lib` 无法提供足够的观察或控制能力时，才使用 `_cdp` 排障或验证新的通用能力。

## 执行位置

```text
CLI Node 进程
  task.js、业务逻辑、工具函数、CDP event callback
          │ Unix socket RPC
          ▼
holder Node 进程
  run 生命周期、page/session 管理、CDP command/event 转发
          │ CDP WebSocket
          ▼
Chrome
  CDP command、页面 JavaScript、network 和 DOM
```

- `Runtime.evaluate`、`Runtime.callFunctionOn` 中的代码在 Chrome 执行。
- 不提供把任意 closure 发送到 holder 执行的接口。
- task 不需要感知 socket、request ID、subscription ID 或 CDP session ID。

## 公开 API

### 为什么核心是 `send`、`on`、`once`

这三个方法对应 CDP 本身仅有的两种交互形态：发送 command，以及接收 event；`once` 是最常见且最容易写出竞态的“一次性等待 event”的安全封装。

- `send` 覆盖所有 command，并返回 command result。
- `on` 覆盖持续或多次到达的 event，并显式返回清理函数。
- `once` 覆盖“先建立等待，再触发操作，等待一个 event”的常见流程，并内建 timeout 与自动清理。

它们不是任意挑选的三个 API。`emit`、`off`、`subscribe` 等不需要作为 task 公共 API：task 不向 Chrome 发送 event，而 unsubscribe 已由 `on` 的返回值表达。

### CDP scope

```ts
type CdpScope =
  | { type: "connection" }
  | { type: "browser" }
  | { type: "page"; pageId: string };
```

task 的正常入口和高级入口为：

```ts
page.cdp        // 正常入口，绑定当前运行页面的 CDP session
_cdp.connection // 高级入口，不带 sessionId 的 browser WebSocket connection
_cdp.browser    // 高级入口，Target.attachToBrowserTarget 得到的 browser session
```

`page.cdp` 是稳定、推荐的页面级接口。`_cdp` 是显式的高级 escape hatch：它提供足够完整的 CDP，避免排障、新 domain 或特殊 target 场景必须先修改 Core SDK。下划线表示它可能越过运行页面抽象、影响 browser-wide 状态或用户已有 target，不表示可以忽略 yodo 的业务约束。

正常 task 必须优先使用 `page.cdp`。只有页面 session 无法完成必要观察或操作时才使用 `_cdp`，并且仍禁止关闭用户 target、关闭 browser、detach holder session、修改 holder 的全局 attach/discover 状态，或留下跨 task 状态。重复出现且可定义稳定语义的 `_cdp` 用法应提升为 Core SDK 或 `lib` 能力。

### typed `send`

```ts
interface CdpSession {
  send<M extends keyof ProtocolMapping.Commands>(
    method: M,
    ...params: ProtocolMapping.Commands[M]["paramsType"]
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
}
```

使用示例：

```js
await page.cdp.send("Network.enable");

const result = await page.cdp.send("Runtime.evaluate", {
  expression: "document.title",
  returnByValue: true,
});
```

`method`、参数和返回值由 `devtools-protocol` 提供类型检查。

不提供 `sendRaw`。`page.cdp` 与 `_cdp` 都只允许当前 `devtools-protocol` 类型已经覆盖的 command；需要新 CDP command 时先更新 type dependency。

### typed `on`

```ts
interface CdpSession {
  on<E extends keyof ProtocolMapping.Events>(
    event: E,
    listener: (...params: ProtocolMapping.Events[E]) => void,
  ): Promise<() => Promise<void>>;
}
```

使用示例：

```js
await page.cdp.send("Network.enable");

const off = await page.cdp.on(
  "Network.requestWillBeSent",
  ({ request }) => console.log(request.url),
);

try {
  // 执行操作
} finally {
  await off();
}
```

`on` 返回 Promise，因为必须等待 holder 完成 subscription 后，调用方才能安全触发后续操作。unsubscribe 也是异步函数，返回后保证 holder 已移除 listener。

### typed `once`

```ts
interface CdpSession {
  once<E extends keyof ProtocolMapping.Events>(
    event: E,
    options?: { timeout?: number },
  ): Promise<ProtocolMapping.Events[E][0]>;
}
```

使用时先创建等待，再触发操作，避免 event race：

```js
const loaded = page.cdp.once("Page.loadEventFired", { timeout: 30_000 });
await page.cdp.send("Page.navigate", { url });
await loaded;
```

`once` 收到首个 event 或 timeout 后自动 unsubscribe。第一版不为 `once` 增加 predicate；需要筛选 event 时使用 `on`。

## 为什么不使用 Domains facade

不提供：

```js
const { Page, Runtime, Network } = page.cdp;
await Page.enable();
```

只提供：

```js
await page.cdp.send("Page.enable");
```

原因：

- 不需要 JavaScript `Proxy`。
- 不需要在 runtime 区分 command 和 event。
- 不需要生成或携带 protocol metadata。
- 调试时能直接看到完整 CDP method。
- `send`、`on`、`once` 已覆盖全部 command 和 event。
- `devtools-protocol` 仍可提供完整 autocomplete 和类型检查。
- Chrome 新增 API 时，只需更新 type dependency。

## `devtools-protocol`

使用官方 `devtools-protocol` package 作为 type dependency，不作为 runtime CDP client：

```ts
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
```

要求：

- runtime 不读取完整 protocol JSON。
- 不生成 Domains facade。
- 不生成 command/event runtime wrapper。
- 更新 package 后通过 TypeScript check 验证现有调用。
- 发布产物包含 task 获得类型提示所需的 `.d.ts`。

### `.js` task 如何获得类型

task 继续使用 `.js`。类型对 JavaScript 仍然有用，但默认主要表现为编辑器补全和悬浮提示；要让 `npm run check` 检查 task，需要为目标文件启用 `// @ts-check`，并由 `lib/index.js` 或相邻 `.d.ts` 暴露准确类型。JSDoc 也可用于标注 task 自己的参数与局部结构。

本次不把 task 改为 `.ts`，原因不是 TypeScript 没有收益，而是当前运行时契约、能力发现、候选晋升和执行命令都以 `~/.yodo/{task,temp}/*.js` 为准。改为 `.ts` 会同时要求解决：

- Node 24 strip types 对可用 TypeScript 语法的限制；
- task 与 `lib` 的模块解析和类型声明；
- skill 中只搜索、运行和移动 `.js` 的规则；
- 用户已有 task 的迁移与编辑器体验。

如果未来单独迁移 task 到 `.ts`，主要收益是 task 本身也能在 CI/安装前获得参数、返回值和 event payload 的严格检查；运行性能和 RPC 能力不会因此改善。当前优先方案是保留可直接执行的 `.js`，通过 `.d.ts`、JSDoc 和可选 `// @ts-check` 获得大部分类型收益。

## RPC protocol

### Wire format

采用 JSON-RPC 2.0 message 结构，继续使用当前 Unix socket 和逐行 JSON framing。

第一阶段不引入 `json-rpc-2.0` dependency。接入它的代码代价不大，但架构收益也有限：它可以帮助校验 JSON-RPC envelope、分发 method、匹配 response 和生成标准 error，却不能替代 Unix socket framing、CDP scope、event subscription、连接级资源清理、超时策略和 backpressure。当前复杂度主要在后者。

若后续引入，应该只让它负责 protocol engine，不让它接管 transport；先用 adapter 把逐行 JSON message 喂给 library，再把 library 产出的 message 交给现有有界写队列。不要为了使用 dependency 改成另一套 socket 或 stream 模型。

请求：

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "method": "cdp.send",
  "params": {
    "scope": { "type": "page", "pageId": "target-id" },
    "method": "Runtime.evaluate",
    "params": {
      "expression": "document.title",
      "returnByValue": true
    }
  }
}
```

成功响应：

```json
{ "jsonrpc": "2.0", "id": "request-id", "result": {} }
```

失败响应：

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "error": {
    "code": -32001,
    "message": "page 不存在或已关闭",
    "data": { "pageId": "target-id" }
  }
}
```

event notification：

```json
{
  "jsonrpc": "2.0",
  "method": "cdp.event",
  "params": {
    "subscriptionId": "subscription-id",
    "event": "Network.requestWillBeSent",
    "value": {}
  }
}
```

### RPC method

CDP 只增加三个通用 RPC method：

```ts
type CdpRpcMethods = {
  "cdp.send": {
    scope: CdpScope;
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  };
  "cdp.subscribe": {
    subscriptionId: string;
    scope: CdpScope;
    event: string;
  };
  "cdp.unsubscribe": {
    subscriptionId: string;
  };
};
```

现有 `run.begin`、`run.end` 和 record operation 可以先保留，不为了协议外形一次性重写无关功能。取得运行页面是 `run.begin` 的一部分，不再保留单独的公开 `context.new-page` operation。

### holder dispatch

holder 根据 scope 解析 `sessionId`：

```ts
function resolveCdpSessionId(scope: CdpScope): string | undefined {
  if (scope.type === "connection") return undefined;
  if (scope.type === "browser") return browser.raw.browserSessionId;
  return pageById(scope.pageId).sessionId;
}
```

`cdp.send` 直接调用现有底层能力：

```ts
browser.raw.send(method, params, sessionId, timeoutMs);
```

需要把 `RawCdpConnection.send` 的公开类型补上已有实现支持的 `timeoutMs` 参数。

## Event subscription 生命周期

CDP event 是 WebSocket 上主动到达的 notification，不像 command response 那样能由 request ID 自动找到唯一等待者。因此 RPC 层必须建立 subscription，把“某条 connection 上、某个 scope、某个 event”映射到 CLI 中的 callback。

unsubscribe 同样必要：CDP domain 通常持续产生 event；如果 task 已不再关心却不解绑，holder 会继续转发，造成重复 callback、跨步骤误触发和无界内存/队列增长。即使 client 最终断线会兜底清理，也不能把整个 run 的结束当作唯一清理机制。公开 API 不直接暴露 `subscribe()` / `unsubscribe()`，而是由 `on()` 返回 `off()`，`once()` 自动完成解绑；它们只是 wire protocol 的内部 method。

每条 CLI connection 单独保存 subscription：

```ts
type ConnState = {
  runActive: boolean;
  subscriptions: Map<string, {
    scope: CdpScope;
    event: string;
    off: () => void;
  }>;
};
```

处理流程：

1. CLI 生成 `subscriptionId` 并发送 `cdp.subscribe`。
2. holder 调用 `browser.raw.on(event, listener)`。
3. listener 根据 scope 检查收到的 `sessionId`。
4. holder 发送 `cdp.event` notification，不等待 CLI callback。
5. CLI 根据 `subscriptionId` 执行 task 中的 callback。
6. unsubscribe function 发送 `cdp.unsubscribe`。
7. `once` 在首个 event 或 timeout 后 unsubscribe。
8. `run.end`、page 关闭、socket 关闭时清理对应 subscription。

callback 抛错只影响 CLI task，不进入 holder。

## Socket framing 与 backpressure

Unix socket 是 byte stream，继续使用一行一个 JSON message，但必须处理 partial message、单次读取多个 message、bad JSON、最大 message size，以及 socket close 时 reject 全部 pending request。

加入 CDP event 后，还必须处理 `Network.dataReceived`、`Tracing.dataCollected`、`HeapProfiler.addHeapSnapshotChunk`、`Debugger.scriptParsed` 等高频数据。

第一版要求：

1. 每条 connection 维护有字节上限的 outbound queue。
2. response 优先于 notification，且不能丢失。
3. `socket.write()` 返回 `false` 后等待 `drain`。
4. 超过队列上限时终止当前 run 并返回明确错误，不静默丢 event。
5. 设置单条 JSON message 大小上限，错误包含 event 或 command 名。

第一版不增加 binary framing、临时文件或通用 stream RPC。出现实际瓶颈后，再单独设计 screenshot、PDF、Tracing 和 HeapProfiler 的大数据传输。

### 是否引入 socket/RPC library

不建议为了这次改造更换 Unix socket 库；Node `net.Socket` 已经提供连接、半关闭、`drain` 和错误事件，真正需要补的是明确的 connection state machine 与有界队列。可以引入一个小型 JSON-RPC engine 减少 envelope/dispatch 样板，但没有成熟库能自动解决本项目最关键的资源所有权和 CDP 高频 event 策略。

健壮性优先通过以下可测试组件获得：

1. 独立的 newline decoder，处理 partial/multiple frame、UTF-8 和 message size limit。
2. 独立的 RPC peer，管理 request ID、pending、timeout、迟到 response 和 notification dispatch。
3. 独立的 prioritized writer，保证 response 优先、有界排队并正确等待 `drain`。
4. connection-owned run/subscription registry，在 close/error 时幂等清理。

如果这些组件实现后仍有大量 JSON-RPC 样板，再评估 `json-rpc-2.0`；不要引入 WebSocket RPC、gRPC 或 Socket.IO，它们会增加 transport 和部署复杂度，却不能改善 holder 到 Chrome 这一侧的 CDP 语义。

## Error 与数据保真

- 保留 CDP error 的 `code`、`message` 和 `data`。
- `Target.SessionID`、`Runtime.RemoteObjectId` 等 opaque ID 原样返回。
- typed `send("Runtime.evaluate", ...)` 返回原生 `RemoteObject`。
- `lib` 的 `evaluate(page, ...)` 负责 `returnByValue`、`awaitPromise`、异常处理和结果解包。
- JSON parse 失败、未知 RPC method、无效 scope、已关闭 page 和未知 subscription 使用稳定 error code。
- CLI socket 断开时 reject 全部 pending request，并清理本地 listener。
- timeout 后忽略迟到 response；第一版不实现通用 RPC cancellation。

## Core SDK

Task Core SDK 只公开 `yodo.run()`。run callback 提供正常使用的 `page`，以及带下划线的高级 `_cdp`：

```ts
yodo.run()

page._targetId
page.cdp.send()
page.cdp.on()
page.cdp.once()

_cdp.connection.send()
_cdp.connection.on()
_cdp.connection.once()

_cdp.browser.send()
_cdp.browser.on()
_cdp.browser.once()
```

`page._targetId` 只供 `_cdp` 排障和 target 关联使用；不公开 `sessionId`。完整公共形态为：

```ts
yodo.run(async ({ page, _cdp }) => {
  await page.cdp.send(...);
});
```

`yodo.start()`、`yodo.stop()`、`yodo.init()`、`yodo.doctor()` 和 `yodo.record.*` 不属于 Task Core SDK。它们移动到 Control 层，供 `src/bin/*.js` 等管理入口调用；`~/.yodo/task/lib/index.js` 只向 task 导出包含 `run()` 的 `yodo`。

`run` 不接收或转发 `args`。task 在调用 `yodo.run()` 前直接解析 `process.argv`，再通过普通 JavaScript closure 使用参数。`run` 只管理执行生命周期，不承担业务参数传递。

`ProxyPage` 和 `ProxyContext` class 不再作为公开抽象。`yodo.run()` 直接向 task 提供普通 `PageHandle`。

`yodo.run(async ({ page, _cdp }) => ...)` 中的 `page` 是当前 task 独占使用的运行页面。它与用户已有页面隔离，并由 `run` 负责准备、复位和异常清理。当前 `run.end` 不关闭这个 tab：它关闭意外产生的额外 tab，将运行 tab 复位为 `about:blank`，并保留后台运行窗口；holder 停止时才关闭整扇窗口。

保留唯一运行页面是业务约束，不是偶然实现：

- yodo 的运行必须与用户已有窗口和 tab 隔离。
- run 不应抢用户前台。
- 一个 task 需要一个稳定、可清理、不会误连用户页面的页面上下文。
- 一次只允许运行一个 task；如果多个操作需要作为一个批次原子完成，应写成一个新的 task，在同一次 `yodo.run()` 中顺序执行。

因此第一版不公开 `browserContext`、`newPage()` 或 `pages()`，也不支持一个 task 创建多个任意 tab。网站操作产生 popup 时，可通过原生 Target event 观察；是否把 popup 纳入运行页面模型需要另行设计，不能把它隐式当作第二个普通 page。

### `run.begin` 与 `run.end`

`run.begin` 开始一次 task run：保证同一时间只有一个 task，禁止与 recording 冲突，取得隔离于用户页面的运行页，并把本次 task 使用的页面和 event 资源绑定到当前连接。

`run.end` 结束这次 task run：清理本次 task 的 event 和页面状态，将运行页复位，释放独占权，但保留下一次运行所需的 holder、Chrome 授权和后台运行窗口。task 异常退出或连接断开时也必须得到同样的清理结果。

因此二者不是普通 CDP command，也不应被 `cdp.send` 取代；它们保证的是业务运行边界：单 task 独占、与用户页面隔离、失败后可恢复、不同 task 不共享残留状态。

task 不公开关闭运行页或将其带到前台的能力。运行页由 `run.end` 统一复位，且 yodo 不应抢用户前台。

## task `lib` 标准库

### 为什么需要 `lib`

Core SDK 与 `lib` 分别解决不同问题：

| 层级 | 负责什么 | 示例 |
|---|---|---|
| Core SDK | task 生命周期、运行页面和原生 CDP command/event | `yodo.run`、`page.cdp.send` |
| `lib` | 可复用且带完整行为保证的浏览器操作 | `goto`、`evaluate`、`click`、`fill` |
| task | 某个网站的业务流程、参数和成功判断 | 搜索、提交、点赞、批量处理 |

`lib` 不是为了缩短语法，也不是另一层浏览器框架。它封装的是容易重复写错、需要多个 CDP command/event 配合、并且所有 task 应保持一致语义的操作。这样 core 可以保持接近原生 CDP，task 又不必反复实现导航等待、脚本异常解包、元素定位和输入验证。`lib` 是正常、推荐使用的公开标准库，因此不使用表示内部实现的下划线命名。

网站特有的 URL、selector、请求结构、流程分支和业务成功判断不得放入 `lib`。

高层工具的仓库 source of truth：

```text
skills/yodo/src/templates/task-lib/
├── index.js
├── url.js
├── page.js
└── dom.js
```

安装后位于：

```text
~/.yodo/task/lib/
├── index.js
├── url.js
├── page.js
└── dom.js
```

`~/.yodo/task/lib` 是安装结果，不作为脱离仓库维护的 source of truth。它位于子目录中，不会被顶层 `~/.yodo/task/*.js` capability 扫描误识别。`setup.js` / `yodo init` 沿用现有 template 同步方式。

统一入口：

```js
export { yodo } from "../../src/sdk.ts";
export { parseUrl, serializeUrl } from "./url.js";
export { goto, evaluate } from "./page.js";
export { click, fill, press, scroll, check, select, wait } from "./dom.js";
```

task 示例：

```js
import {
  yodo,
  goto,
  evaluate,
  fill,
  click,
} from "../task/lib/index.js";

await yodo.run(async ({ page }) => {
  await goto(page, "https://example.com");
  await fill(page, "#query", "hello");
  await click(page, "#submit");
  return evaluate(page, () => document.title);
});
```

第一批工具函数：

```ts
goto(page, url, options?)
evaluate(page, fnOrString, ...args)
click(page, selector)
fill(page, selector, value)
press(page, selector, key)
scroll(page, selector, options)
check(page, selector, checked)
select(page, selector, value)
wait(page, selector, options?)
```

### DOM helper 是否必要

必要，但只保留最小且可验证的一组。yodo 的 DOM implementation 需要稳定执行 click、fill、press、scroll、check、select 和 wait；直接用原生 CDP 完成这些操作通常需要元素查询、可见性判断、坐标计算、hit test、Input event 和操作后验证。让每个生成 task 重写这些步骤，会产生大量不一致且难以审查的代码。

DOM helper 不应扩展成完整自动化框架。第一版不加入 locator 链、自动重试体系、通用断言 DSL、自动等待所有页面状态或 action/network 因果推断。只有满足以下条件的操作才进入 `lib`：

1. 多个 task 会重复使用。
2. 正确实现需要多个 CDP 步骤或可靠清理。
3. 可以定义稳定、与网站无关的成功语义。
4. 能通过独立 self-check 验证。

### 何时使用 `lib`，何时直接使用 CDP

| 情况 | 选择 | 原因 |
|---|---|---|
| 已有 `lib` helper 能完整表达操作 | 必须使用 `lib` | 复用统一的等待、错误、清理和验证语义 |
| 导航、执行并解包页面函数、通用 DOM 输入操作 | 必须使用 `lib` | 这些不是单条 CDP command，手写容易遗漏必要步骤 |
| 监听 Network、Page、Runtime 等原生 event | 直接使用 `page.cdp.on/once` | event 名、payload 和关联 ID 本身就是业务所需数据 |
| 调用没有对应 helper 的单个 CDP command | 可以直接使用 typed `send` | 无需为了薄转发新增 helper |
| 网站特有流程或成功判断 | 写在 task 中，可组合 helper 与 CDP | 不应污染通用层 |
| page scope 无法提供必要观察或操作 | 可以使用 `_cdp` | 这是高级 escape hatch，必须遵守用户页面和 holder 生命周期边界 |
| 只是为了绕过现有 helper 的错误或验证 | 不得直接改用 CDP | 应修复 `lib`，否则不同 task 会产生不同语义 |
| 某种多步 CDP 模式在多个 task 中重复出现 | 先在 candidate 验证，再评估加入 `lib` | 避免过早扩张公共工具面 |

原生 CDP 是扩展面，不是默认逃生通道。已有 helper 时必须使用 helper；没有 helper，且操作天然对应原生 command/event 时，直接使用 `page.cdp`；只有 page scope 不足时才使用 `_cdp`。当手写逻辑开始重复承担通用等待、清理或验证时，应上移到 `lib`。

工具优先只依赖公开的 `page.cdp`。只有确实需要 target 关联时才读取 `page._targetId` 或使用 `_cdp`；涉及 holder registry 或其他生命周期状态时，可以调用 internal RPC，但不能重新暴露为普通 `page.*` method。

工具迁移不能降低现有行为：

- `goto` 保留 navigation 前订阅 event、检查 `errorText` 和 timeout。
- `evaluate` 保留 function/参数序列化、`awaitPromise`、`returnByValue` 和 `exceptionDetails` 处理。
- `click` 保留元素存在、可见和 hit test 检查，再发送 mouse event。
- `fill` 保留 focus、全选、删除、输入和最终值检查。
- `check`、`select` 保留操作后的状态检查。
- `wait` 保留明确 timeout。

第一版不增加 `waitForRequest`、`waitForResponse` 或 action/request 自动关联等 Network 高层 helper。

## Breaking change

本次升级不提供旧 API 的兼容层或 deprecated alias。

旧 API 到新工具的映射：

| 旧写法 | 新写法 |
|---|---|
| `page.goto(url, options)` | `goto(page, url, options)` |
| `page.evaluate(fn, ...args)` | `evaluate(page, fn, ...args)` |
| `page.title()` | `evaluate(page, () => document.title)` |
| `page.bringToFront()` | 删除；task 不应抢用户前台 |
| `page.close()` | 删除；运行页由 `run.end` 统一复位 |
| `page.dom.click(selector)` | `click(page, selector)` |
| `page.dom.fill(selector, value)` | `fill(page, selector, value)` |
| `page.dom.press(selector, key)` | `press(page, selector, key)` |
| `page.dom.scroll(selector, options)` | `scroll(page, selector, options)` |
| `page.dom.check(selector, checked)` | `check(page, selector, checked)` |
| `page.dom.select(selector, value)` | `select(page, selector, value)` |
| `page.dom.wait(selector, options)` | `waitForSelector(page, selector, options)` |

升级时删除 `ProxyPage` 上的旧高层 method 和公开类型，删除无调用方的旧专用 operation，并改写仓库中的 task、示例、self-check 和文档。工具仍需专用 operation 时，将其保留为 internal RPC。setup 不自动改写用户 task。

## DOM 与 Network 验证

Network event 不普遍替代 DOM 验证：

- DOM 或页面状态用于确认用户操作命中正确对象，以及用户最终看到的状态。
- Network 用于确认是否触发目标 request、HTTP response 是否成功，以及后端返回的业务数据。

HTTP 200 不代表前端正确处理，也不一定代表业务成功；DOM 显示成功也不一定证明后端最终成功。根据风险选择验证层级：

1. 普通交互可依赖 DOM 状态或后续步骤的自然失败。
2. 保存、提交、删除、上传等业务操作可监听对应 request、response、`loadingFinished` 或 `loadingFailed`。
3. 付款、发布、删除等关键操作应同时确认 Network 结果和最终 DOM 状态。

task 可以直接使用原生 Network event，并通过 `requestId` 关联 request 与 response：

```js
await page.cdp.send("Network.enable");

const requests = new Map();
const offRequest = await page.cdp.on("Network.requestWillBeSent", (event) => {
  requests.set(event.requestId, {
    method: event.request.method,
    url: event.request.url,
    postData: event.request.postData,
  });
});

const offResponse = await page.cdp.on("Network.responseReceived", (event) => {
  const request = requests.get(event.requestId);
  if (!request) return;
  request.status = event.response.status;
  request.mimeType = event.response.mimeType;
});

try {
  await click(page, "button[type=submit]");
} finally {
  await offResponse();
  await offRequest();
}
```

Network 数据可用于分析 DOM 操作触发的 endpoint、request 参数、server response 和页面变化，但不能只凭时间接近自动认定因果关系。应保留 timestamp、initiator、frame、resource type、URL、method、body、navigation、redirect、cache 和 service worker 信息。

Network 数据可能包含 cookie、authorization header、token、表单内容和 response body。task、日志和输出不得默认打印或持久化完整敏感数据。

## 独立更新文档

新增独立文档：

```text
skills/yodo/update.md
```

`install.md` 必须在更新流程开始处和验收部分引用：

```md
[更新说明](./update.md)
```

`update.md` 至少包含：

1. breaking change 的适用版本和影响范围。
2. 更新前备份 `~/.yodo/task` 的要求。
3. 旧 API 到新工具函数的完整映射。
4. `page.cdp`、`page._targetId` 和高级 `_cdp` 的定位、风险与禁止行为。
5. typed `send/on/once` 的使用说明。
6. `Page.navigate` 与 `goto(page, ...)` 的语义差异。
7. `Runtime.evaluate` 与 `evaluate(page, ...)` 的返回值和异常差异。
8. event 的 domain enable、先订阅后操作和异步 unsubscribe 规则。
9. 一个普通 DOM task 和一个 Network task 的完整迁移示例。
10. 使用 `rg` 检查未迁移调用的命令。
11. 迁移后的运行和验收步骤。

发布前扫描仓库示例和本机已有 task，列出仍使用旧 API 的文件。安装说明要求用户在运行 setup 前备份并迁移已有 task。

## 实施顺序

### 1. RPC envelope

- 定义 JSON-RPC request、response、error 和 notification 类型。
- 让 CLI connection 同时处理 response 和 notification。
- 现有 run、record 和 handshake 暂时沿用现有 operation，避免扩大改动范围。
- 增加 self-check：并发 request、乱序 response、notification 和断线 reject。

### 2. 全量 command

- 增加 connection、browser 和 page scope，以及通用 `cdp.send`。
- holder 将任意 method 和 params 转给 `RawCdpConnection.send`。
- 暴露 typed `page.cdp.send`，并通过 `_cdp.connection`、`_cdp.browser` 提供高级入口。
- 验证三个 scope 各至少一个 command，并验证 `_cdp` 的禁止行为不会破坏用户页面和 holder 生命周期。

### 3. 全量 event

- 增加 `cdp.subscribe`、`cdp.unsubscribe` 和 `cdp.event` notification。
- subscription 绑定 CLI connection，并按 session scope 过滤。
- 实现 typed `on`、`once`、timeout 和全部清理路径。
- 验证多个 event、unsubscribe、run end 和 socket close。

### 4. 类型

- 增加 `devtools-protocol` type dependency。
- 为 `send/on/once` 接入 `ProtocolMapping`。
- 验证 command 参数、返回值和 event payload 的 TypeScript inference。
- 不生成 Domains facade 或 runtime protocol metadata。

### 5. task 工具迁移

- 新增 `templates/task-lib/page.js` 和 `dom.js`。
- 更新 `templates/task-lib/index.js` 的 re-export。
- 工具优先基于公开 CDP；必要时调用 internal lifecycle RPC。
- 为 `goto`、`evaluate` 和非简单 DOM 操作分别增加最小 runnable self-check。
- 删除 `ProxyPage`、`ProxyContext` 和旧公开高层 method。
- 删除无调用方的旧专用 operation。
- 改写仓库内所有 task、示例、self-check 和文档中的旧调用。

### 6. backpressure 与限制

- 增加 outbound queue 和 message size 限制。
- 使用高频 Network event 做 runnable self-check。
- 验证队列超限时明确失败，response 不被 event 阻塞或丢失。

### 7. 更新文档与安装提示

- 新增 `skills/yodo/update.md`，作为安装文档之外独立维护的 breaking change 与迁移说明。
- 在 `install.md` 更新流程开始处链接 `update.md` 并标记 breaking change。
- 在 `install.md` 验收清单中增加旧 task 已迁移检查。
- 文档示例优先使用 `lib` 工具和 `page.cdp.send/on/once`，高级场景显式使用 `_cdp`。

## 最小验收标准

- task 始终在 CLI 进程。
- holder 始终持有唯一的共享 CDP connection。
- 当前 protocol types 中的 CDP command 可通过对应 scope 的 typed `send` 调用，无需新增专用 `SessionOp`。
- 当前 protocol types 中的 CDP event 可通过对应 scope 的 typed `on` 或 `once` 接收。
- 正常 task 使用 `page.cdp`；`_cdp` 明确标记为高级入口，并阻止关闭用户 target、关闭 browser、detach holder session 和修改 holder 全局 attach/discover 状态。
- 不存在 Domains facade、JavaScript `Proxy` 或 runtime protocol metadata。
- TypeScript 能检查 command 参数、返回值和 event payload。
- `run.end` 和 socket close 后没有残留 subscription。
- CLI 异常退出后 holder 能清理该 run。
- 高频 event 不会导致无限内存增长或静默丢失数据。
- 旧 `page.goto()`、`page.evaluate()`、`page.dom.*` 和 `page.close()` 不再存在于公开 API、仓库 task、示例和测试中。
- `install.md` 已链接独立 `update.md`，其中包含完整 API 映射和迁移验收步骤。

## 暂不做

- 不让 task 在 holder 主进程执行。
- 不序列化或 `eval` task closure。
- 不提供 Domains facade，例如 `page.cdp.Page.enable()`。
- 不使用 JavaScript `Proxy` 生成 CDP API。
- 不生成每个 CDP command/event 的 runtime wrapper。
- 不引入新的 RPC framework dependency。
- 不在第一版实现 binary transport、临时文件或通用 stream RPC。
- 不提供旧高层 `page.*` API 的兼容层或 deprecated alias。
- 不在第一版增加 `waitForRequest`、`waitForResponse` 等 Network 高层 helper。
- 不在第一版自动判断某个 request 由哪次 DOM action 触发。
- 不直接手工维护 `~/.yodo/task/lib`；修改仓库 template 后通过安装流程部署。
- 不由 setup 自动改写用户已有 task。
