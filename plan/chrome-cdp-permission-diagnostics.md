# Chrome CDP port 配置计划

## 1. 目标

yodo 不读取 Chrome user data directory，不扫描 port，也不修改已安装源码。

Connection 只使用一个明确 port：

1. 优先读取 environment variable `YODO_CDP_PORT`。
2. 否则读取 `~/.yodo/session/config.env` 中的 `YODO_CDP_PORT`。
3. 没有配置时使用默认值 `9222`。
4. 当前 port 无法连接时，打开 `chrome://inspect/#remote-debugging` 并让用户提供页面显示的 port。
5. Agent 将 port 写入 `~/.yodo/session/config.env`，停止旧 holder，再重跑原命令。

## 2. 配置文件

文件：

```text
~/.yodo/session/config.env
```

当前只支持：

```dotenv
YODO_CDP_PORT=54321
```

约束：

- 只接受十进制整数 `1–65535`。
- Runtime 只读取 `YODO_CDP_PORT`，不把整个文件加载到 `process.env`。
- 不支持 shell expansion、command substitution、`export`、多行值或其它 `.env` 语法。
- Agent 写文件时使用 `0600`。
- `process.env.YODO_CDP_PORT` 的优先级高于配置文件。
- `session` 可重建；setup 清理后恢复默认 `9222`。

## 3. Connection 流程

1. 检查 Chrome 是否安装；未安装返回 `need-install`。
2. 直接启动或激活 Chrome。
3. 解析当前 CDP port。
4. 在约 2 秒窗口内每 200ms 尝试当前 port。
5. `/json/version` 返回有效 `webSocketDebuggerUrl` 时连接。
6. HTTP 403 时返回 `need-allow`。
7. 当前 port 始终不可用时，打开 remote debugging 页面并返回 `need-cdp-port`。

不再尝试 `9223`、`9224`，也不读取 `SingletonLock`、`Local State` 或 `DevToolsActivePort`。

## 4. Protocol

新增：

```text
need-cdp-port
```

提示包含当前尝试的 port，并要求用户回复页面显示的 port 数字。

保留：

- `need-install`
- `need-chrome`
- `need-allow`

删除 `need-remote-debugging`：当前失败后的具体动作已经是提供实际 port，不再让用户只回复“已勾选”。

## 5. Agent 行为

收到 `need-cdp-port` 后：

1. 将 `guide` 原样告诉用户。
2. 等待用户提供 port。
3. 只接受 `1–65535` 的十进制整数。
4. 创建 `~/.yodo/session`。
5. 将 `YODO_CDP_PORT=<port>` 写入 `~/.yodo/session/config.env`，mode 为 `0600`。
6. 停止旧 holder。
7. 重跑原命令。

用户没有提供合法 port 时，不写配置。

## 6. Runtime 修改

- `utils/constants.ts`：新增 `SESSION_CONFIG_FILE`。
- `browser/connect.ts`：新增 port 解析与配置读取，只连接一个 port。
- `protocol.ts`：加入 `need-cdp-port`，移除 `need-remote-debugging`。
- 更新对应 self-check。
- `SKILL.md`：加入 agent 写配置和重跑规则。

不新增 dependency。

## 7. 验证

- 没有配置时使用 `9222`。
- environment variable 覆盖配置文件。
- 配置文件中的合法 port 生效。
- 非数字、越界和复杂 `.env` 内容不生效并回退 `9222`。
- 当前 port 成功时返回 endpoint。
- HTTP 403 返回 `need-allow`。
- 当前 port 失败时返回 `need-cdp-port` 并打开设置页面。
- 全部现有检查通过。

## 8. 完成条件

- Runtime 不读取 Chrome user data directory。
- Port 可通过 `~/.yodo/session/config.env` 配置。
- Agent 不修改 Runtime 源码。
- 不扫描或结束任何 process。
- 用户提供新 port 后可以重启 holder 并重连。
