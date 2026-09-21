# 在 CLI task 中通过 RPC 暴露完整 CDP

## 决策

本次改造采用以下方案：

- `task.js` 始终在 CLI Node 进程执行。
- holder 持有唯一的共享 CDP WebSocket connection。
- task 通过 RPC 调用 holder 中的 CDP。
- 只公开显式的 typed `send`、`on`、`once`。
- 不提供 `cdp.Page.enable()` 形式的 Domains facade。
- 不使用 JavaScript `Proxy` 动态生成 domain 和 method。
- 不为每个 CDP command 手写 RPC operation。
- 不保留旧 `page.*` 高层 API；这是 breaking change。
- 常见高层操作迁移到 `~/.yodo/task/_common` 工具函数。

目标写法：

```js
await yodo.run(async ({ browserContext, cdp }) => {
  const version = await cdp.root.send("Browser.getVersion");
  const page = await browserContext.newPage();

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
    browser: version.product,
    title: title.result.value,
    urls,
  };
});
```

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

### CDP scope

```ts
type CdpScope =
  | { type: "root" }
  | { type: "browser" }
  | { type: "page"; pageId: string };
```

task 使用三个明确入口：

```ts
cdp.root      // 不带 sessionId 的 CDP root connection
cdp.browser   // Target.attachToBrowserTarget 得到的 browser session
page.cdp      // 绑定当前 page.sessionId
```

不自动猜测 scope，也不把 root 与 browser session 合并。实施时必须验证常用 `Browser.*` 和 `Target.*` command 应发送到 root 还是 browser session，并写入使用文档。

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

保留显式的 untyped escape hatch，供 Chrome 已支持但当前 protocol types 尚未覆盖的 experimental command 使用：

```ts
interface CdpSession {
  sendRaw(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}
```

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

## RPC protocol

### Wire format

采用 JSON-RPC 2.0 message 结构，继续使用当前 Unix socket 和逐行 JSON framing。

第一阶段不引入 `json-rpc-2.0` dependency。当前代码已有 socket transport、request ID 和 pending Promise；dependency 不能替代 CDP scope、event subscription、清理和 backpressure。

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

现有 `run.begin`、`run.end`、`context.new-page` 和 record operation 可以先保留，不为了协议外形一次性重写无关功能。

### holder dispatch

holder 根据 scope 解析 `sessionId`：

```ts
function resolveCdpSessionId(scope: CdpScope): string | undefined {
  if (scope.type === "root") return undefined;
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

## Error 与数据保真

- 保留 CDP error 的 `code`、`message` 和 `data`。
- `Target.SessionID`、`Runtime.RemoteObjectId` 等 opaque ID 原样返回。
- typed `send("Runtime.evaluate", ...)` 返回原生 `RemoteObject`。
- `_common` 的 `evaluate(page, ...)` 负责 `returnByValue`、`awaitPromise`、异常处理和结果解包。
- JSON parse 失败、未知 RPC method、无效 scope、已关闭 page 和未知 subscription 使用稳定 error code。
- CLI socket 断开时 reject 全部 pending request，并清理本地 listener。
- timeout 后忽略迟到 response；第一版不实现通用 RPC cancellation。

## Core SDK

Core SDK 只保留 transport、CDP client 和 holder 资源生命周期：

```ts
yodo.run()
browserContext.newPage()
browserContext.pages()

page.targetId
page.cdp.send()
page.cdp.sendRaw()
page.cdp.on()
page.cdp.once()

cdp.root.send()
cdp.root.sendRaw()
cdp.root.on()
cdp.root.once()

cdp.browser.send()
cdp.browser.sendRaw()
cdp.browser.on()
cdp.browser.once()
```

`ProxyPage` 和 `ProxyContext` class 不再作为公开抽象。使用普通 `PageHandle` 和 `BrowserContext` object。

`browserContext.newPage()` 保留在 core，因为它负责创建和 attach target、将 page 纳入当前 run、更新 holder registry，并在 `run.end` 时清理资源。

page 关闭统一使用 `_common` 的 `close(page)`。该工具调用内部生命周期 RPC，确保 holder 同步清理 target、registry 和 subscription。

## task `_common` 工具

高层工具的仓库 source of truth：

```text
skills/yodo/src/templates/task-common/
├── yodo.js
├── url.js
├── page.js
└── dom.js
```

安装后位于：

```text
~/.yodo/task/_common/
├── yodo.js
├── url.js
├── page.js
└── dom.js
```

`~/.yodo/task/_common` 是安装结果，不作为脱离仓库维护的 source of truth。`setup.js` / `yodo init` 沿用现有 template 同步方式。

统一入口：

```js
export { yodo } from "../../src/sdk.ts";
export { parseUrl, serializeUrl } from "./url.js";
export { goto, evaluate, title, bringToFront, close } from "./page.js";
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
} from "../task/_common/yodo.js";

await yodo.run(async ({ browserContext }) => {
  const page = await browserContext.newPage();
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
title(page)
bringToFront(page)
close(page)

click(page, selector)
fill(page, selector, value)
press(page, selector, key)
scroll(page, selector, options)
check(page, selector, checked)
select(page, selector, value)
wait(page, selector, options?)
```

工具优先只依赖公开的 `page.cdp` 和 `page.targetId`。涉及 holder registry 或其他生命周期状态时，可以调用 internal RPC，但不能重新暴露为 `page.*` method。

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
| `page.title()` | `title(page)` |
| `page.bringToFront()` | `bringToFront(page)` |
| `page.close()` | `close(page)` |
| `page.dom.click(selector)` | `click(page, selector)` |
| `page.dom.fill(selector, value)` | `fill(page, selector, value)` |
| `page.dom.press(selector, key)` | `press(page, selector, key)` |
| `page.dom.scroll(selector, options)` | `scroll(page, selector, options)` |
| `page.dom.check(selector, checked)` | `check(page, selector, checked)` |
| `page.dom.select(selector, value)` | `select(page, selector, value)` |
| `page.dom.wait(selector, options)` | `wait(page, selector, options)` |

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

## 升级文档

新增独立文档：

```text
skills/yodo/upgrade-cdp-rpc.md
```

`install.md` 必须在更新流程开始处和验收部分引用：

```md
[CDP RPC 升级说明](./upgrade-cdp-rpc.md)
```

升级文档至少包含：

1. breaking change 的适用版本和影响范围。
2. 更新前备份 `~/.yodo/task` 的要求。
3. 旧 API 到新工具函数的完整映射。
4. `page.cdp`、`cdp.root`、`cdp.browser` 的 scope 说明。
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

- 增加 `CdpScope` 和 `cdp.send`。
- holder 将任意 method 和 params 转给 `RawCdpConnection.send`。
- 暴露 typed `cdp.root.send`、`cdp.browser.send` 和 `page.cdp.send`。
- 增加 `sendRaw` escape hatch。
- 验证 root、browser session 和 page session 各至少一个 command。

### 3. 全量 event

- 增加 `cdp.subscribe`、`cdp.unsubscribe` 和 `cdp.event` notification。
- subscription 绑定 CLI connection，并按 session scope 过滤。
- 实现 typed `on`、`once`、timeout 和全部清理路径。
- 验证多个 event、多个 page、unsubscribe、page close、run end 和 socket close。

### 4. 类型

- 增加 `devtools-protocol` type dependency。
- 为 `send/on/once` 接入 `ProtocolMapping`。
- 验证 command 参数、返回值和 event payload 的 TypeScript inference。
- 不生成 Domains facade 或 runtime protocol metadata。

### 5. task 工具迁移

- 新增 `templates/task-common/page.js` 和 `dom.js`。
- 更新 `templates/task-common/yodo.js` 的 re-export。
- 工具优先基于公开 CDP；必要时调用 internal lifecycle RPC。
- 为 `goto`、`evaluate` 和非简单 DOM 操作分别增加最小 runnable self-check。
- 删除 `ProxyPage`、`ProxyContext` 和旧公开高层 method。
- 删除无调用方的旧专用 operation。
- 改写仓库内所有 task、示例、self-check 和文档中的旧调用。

### 6. backpressure 与限制

- 增加 outbound queue 和 message size 限制。
- 使用高频 Network event 做 runnable self-check。
- 验证队列超限时明确失败，response 不被 event 阻塞或丢失。

### 7. 升级文档与安装提示

- 新增 `skills/yodo/upgrade-cdp-rpc.md`。
- 在 `install.md` 更新流程开始处链接升级文档并标记 breaking change。
- 在 `install.md` 验收清单中增加旧 task 已迁移检查。
- 文档示例只使用 `_common` 工具和显式 `send/on/once`。

## 最小验收标准

- task 始终在 CLI 进程。
- holder 始终持有唯一的共享 CDP connection。
- 任意受支持的 CDP command 可通过 typed `send` 调用，无需新增专用 `SessionOp`。
- 任意受支持的 CDP event 可通过 typed `on` 或 `once` 接收。
- 不存在 Domains facade、JavaScript `Proxy` 或 runtime protocol metadata。
- TypeScript 能检查 command 参数、返回值和 event payload。
- `run.end`、page close 和 socket close 后没有残留 subscription。
- CLI 异常退出后 holder 能清理该 run。
- 高频 event 不会导致无限内存增长或静默丢失数据。
- 旧 `page.goto()`、`page.evaluate()`、`page.dom.*` 和 `page.close()` 不再存在于公开 API、仓库 task、示例和测试中。
- `install.md` 已链接独立升级文档，升级文档包含完整 API 映射和迁移验收步骤。

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
- 不直接手工维护 `~/.yodo/task/_common`；修改仓库 template 后通过安装流程部署。
- 不由 setup 自动改写用户已有 task。
