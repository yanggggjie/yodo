# native host 拆分为 relay 与 daemon

## 问题

- holder 同时承担两件事：接收 Chrome 的 native messaging 消息，以及持有状态（socket、run 窗、录制、CDP 连接）。
- 前一件的生命周期由 Chrome 决定：扩展刷新、service worker 重启、port 断开都会让 holder 的 stdin 结束并退出。
- 后一件的生命周期应由 yodo 决定。把两者绑在一个进程里，导致：
  1. 每次刷新都丢失状态（socket、run 窗、正在进行的录制）。
  2. 重启时竞态：旧 holder 的异步收尾尚未完成，socket 文件仍在，新 holder 的单例检查把自己挡住并退出，扩展再次重连，循环重启。
  3. 写 stdout 的旧进程在 port 已断开后仍在写，触发 `EPIPE` 未捕获异常。
  4. 关窗指令需要通过扩展 port 发出，port 已断开时窗口留下，窗口数量随刷新增加。

## 目标

- 把 Chrome 拉起的进程变成无状态的 relay，只做字节转发。
- 把状态放进 daemon，daemon 不随扩展断开而退出。
- 重启扩展或 Chrome 时，只需要 relay 重连，daemon 与其持有的窗口、录制保持不变。

## 架构

```text
Chrome ──拉起──> relay（native host，无状态）
                    │ Unix socket: daemon-ext.sock（逐帧原样转发）
                    ▼
                 daemon（常驻，持有状态）
                    ▲
                    │ Unix socket: daemon.sock（CLI / SDK，协议不变）
                 yodo CLI
```

## 组件

### relay（`src/native-messaging-host/relay.ts`）

- 启动：连接 `daemon-ext.sock`。失败时用 detached 方式拉起 daemon，轮询等待 socket 出现后再连接。
- 转发：从 stdin 读取的每一帧原样写入 daemon；从 daemon 收到的每一帧原样写入 stdout。relay 不解析 JSON。
- 退出：任一端断开，relay 直接退出，不做收尾。Chrome 在下次连接时重新拉起它。
- 日志：只记录连接、断开和拉起 daemon 的事件，不写状态文件。

### daemon（由 `holder.ts` 拆出）

- 去掉 stdio 相关代码，保留状态和 `daemon.sock` 的 CLI 协议（`run`、`cdp.send`、`record.*`、`ping`）。
- 新增 `daemon-ext.sock`：接受 relay 连接。同一时间只接受一个 relay；新的 relay 连接时，旧连接先被替换。
- 扩展链路（`ExtensionLink`）的 `write` 指向当前 relay 的 socket。
  - relay 断开：链路置空，等待中的请求全部报错，daemon 继续运行。
  - relay 重连：daemon 重新接收扩展的 `hello`，恢复链路。
- 窗口与录制由 daemon 持有。扩展断开不需要关窗；扩展重连后直接沿用原窗口。
- 空闲退出：没有 relay 连接超过 10 分钟，并且没有 run 或录制进行时，daemon 退出。退出前若扩展仍连接，关闭其持有的窗口。

### 单例与启动竞态

- daemon 启动时尝试连接 `daemon.sock`：
  - 连得上：已有 daemon，本进程退出。
  - 连接被拒（`ECONNREFUSED`）：视为残留 socket，删除后 `listen`。
- 两个 relay 同时拉起 daemon 时，只有一个能 `listen` 成功，另一个 daemon 因单例检查退出；两个 relay 都连接 `daemon-ext.sock`，结果一致。
- `EADDRINUSE` 不再作为致命错误处理，改为检查 socket 是否可连接。

### 收尾与错误处理

- relay 不做收尾，没有状态。
- daemon 的收尾只在 daemon 自己退出时发生。
- relay 对 stdout 的写入出错（`EPIPE`）时直接退出，不抛出未捕获异常。

### 扩展的变化

- 删除 `closeLeftoverWindows`，窗口清理由 daemon 负责。
- 协议不变：`hello`、`tab` 操作、`cdp` 操作、事件推送保持原样。

## 对计划决定的修改

- 原决定"holder 重启时不恢复旧窗口"改为：daemon 不随扩展重启，窗口直接复用；daemon 退出时才关闭窗口。
- 原决定"holder 退出时关闭 run 窗"改为：daemon 退出时关闭窗口。

## 安装与升级

- 扩展代码有改动时，仍需在 `chrome://extensions` 刷新扩展。
- 只改 daemon 代码时，不需要刷新扩展：daemon 空闲退出后，下一次 relay 连接会拉起新代码。
- 只改 relay 代码时，需要刷新扩展，因为 relay 由 Chrome 拉起。
- 不需要重启 Chrome，也不需要手动 `kill`。

## 测试

1. 刷新扩展后，daemon 的 pid 不变，run 窗数量不增加，正在进行的录制不丢。
2. 手动结束 relay，daemon 仍在运行；扩展重连后链路自动恢复。
3. 同时启动两个 relay，最终只有一个 daemon 存活。
4. 日志中不出现 `EPIPE`，也不出现"已有 holder 在运行"的循环退出。
5. daemon 空闲 10 分钟后退出，退出时窗口被关闭。
6. 现有 e2e（`holder.e2e.selfcheck.mjs`）改为通过 relay 与 daemon 运行，全部通过。

## 风险

- 多一个常驻进程，需要处理它的启动、崩溃后重启和 pid 管理。
- relay 与 daemon 之间的 socket 协议需要保持帧边界，避免粘包。这一点用长度前缀帧解决，与现在的 native messaging 帧格式一致。
- daemon 的空闲退出时间（10 分钟）是经验值，需要根据实际使用调整。

## 与现有 plan 的关系

本文件取代 `yodo-simplification-refactor.md` 中关于 holder 生命周期和窗口恢复的决定；其它决定（命令入口、录制、task API、存储）保持不变。
