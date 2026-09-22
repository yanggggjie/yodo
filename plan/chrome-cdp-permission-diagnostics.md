# Chrome CDP connection 重构计划

## 1. 目标

yodo 连接用户当前运行、保留登录状态的 Google Chrome。

默认读取 Chrome 写入的 `DevToolsActivePort`，不再要求用户提供 port，也不依赖固定 `9222`。

本次只重构 endpoint discovery 和错误分类：

- 不新增 dependency。
- 不修改 Chrome profile。
- 不关闭 Chrome 或用户已有 tab。
- 不扩展到 Chrome Canary、Edge、Brave 等其它 browser。

## 2. 默认 connection 流程

1. 检查 Google Chrome 是否安装；未安装返回 `need-install`。
2. 启动或激活 Google Chrome。
3. 读取当前平台默认 Chrome user data directory 下的 `DevToolsActivePort`。
4. 第一行解析 port，第二行解析 browser WebSocket path。
5. 先请求 `http://127.0.0.1:<port>/json/version`：
   - HTTP 200 且包含 `webSocketDebuggerUrl`：使用响应中的 endpoint。
   - HTTP 404：使用 `DevToolsActivePort` 中的 port 和 path 拼出 endpoint。
   - HTTP 403：返回 `need-allow`。
6. 使用得到的 WebSocket endpoint 建立 CDP connection。
7. WebSocket handshake 等待 Chrome 的 `Allow remote debugging?` popup，不因普通 timeout 自动建立第二条 connection。

`DevToolsActivePort` 是默认 discovery source；`/json/version` 只用于优先取得实时 endpoint，不能因为它返回 404 就否定文件中的 WebSocket path。

## 3. 文件位置

只支持 Google Chrome Stable：

- macOS：`~/Library/Application Support/Google/Chrome/DevToolsActivePort`
- Windows：`%LOCALAPPDATA%/Google/Chrome/User Data/DevToolsActivePort`
- Linux：`~/.config/google-chrome/DevToolsActivePort`

文件格式：

```text
<port>
/devtools/browser/<id>
```

只做必要校验：

- port 是 `1` 到 `65535` 的十进制整数。
- path 非空且以 `/` 开头。

## 4. 错误处理

### Chrome 未运行

启动或激活 Chrome，短暂等待 `DevToolsActivePort` 出现。Chrome 无法启动时返回 `need-chrome`。

### 文件不存在

打开 `chrome://inspect/#remote-debugging`，返回 `need-remote-debugging`，提示用户勾选 `Allow remote debugging for this browser instance`。

### 文件无法读取

遇到 `EACCES` 或 `EPERM` 时，返回专门的权限提示，不误报成 port 或 remote debugging 问题。提示用户：

- yodo 需要读取 Chrome 的 `DevToolsActivePort`，以取得 remote debugging 的 WebSocket endpoint。
- yodo 只读取该文件来建立 CDP connection，不修改 Chrome profile。
- 请在系统设置中为当前运行 yodo 的宿主应用打开访问该目录所需的权限，然后重新运行原操作。
- macOS 下给出 `System Settings > Privacy & Security` 的入口；具体应开启 `Files and Folders` 还是 `Full Disk Access`，以系统实际提供的选项为准。

提示中包含无法读取的文件路径，但不输出文件内容。其它系统错误保留原始错误信息和文件路径。

### 文件内容无效

报告 `DevToolsActivePort` 内容无效；不猜 port 或 WebSocket path。

### HTTP 404

使用文件中的 WebSocket path，这是新版 Chrome 使用默认 user data directory 时的正常兼容路径。

### HTTP 403 或 WebSocket 等待 approval

返回 `need-allow`，提示用户点击当前 `Allow remote debugging?` popup。

保持当前 WebSocket handshake；不要因 timeout 或重试创建新的 connection，避免连续产生 popup。

### WebSocket connection 被拒绝或返回 404

将 `DevToolsActivePort` 视为过期或对应 Chrome instance 已结束，重新读取一次文件；内容没有变化时停止并报告，不循环重试。

## 5. 显式配置

删除 `~/.yodo/session/config.env` 和 `YODO_CDP_PORT` 的默认流程。

本次不新增 `YODO_CDP_WS` 等配置。yodo 当前只需要可靠连接本机 Google Chrome，额外配置等出现实际需求后再加。

## 6. Protocol 与用户提示

保留：

- `need-install`
- `need-chrome`
- `need-allow`

恢复：

- `need-remote-debugging`
- `need-file-access`

删除：

- `need-cdp-port`

用户不再需要读取或回复 port。

## 7. Runtime 修改

- `browser/connect.ts`
  - 恢复默认 Chrome user data directory 定位。
  - 读取并解析 `DevToolsActivePort`。
  - `/json/version` 返回 404 时使用文件中的 WebSocket path。
  - 删除固定 port、配置文件和 port 询问逻辑。
  - 区分文件不存在、读取失败、内容无效和 Chrome approval。
- `protocol.ts`
  - 恢复 `need-remote-debugging`。
  - 删除 `need-cdp-port`。
- `utils/constants.ts`
  - 删除只为 `YODO_CDP_PORT` 增加的配置路径。
- `connect.selfcheck.ts`、`protocol.selfcheck.ts`
  - 更新对应检查。
- `SKILL.md`
  - 删除要求用户提供 port 和写入 `config.env` 的流程。
  - 改为提示用户开启 remote debugging 或批准当前 connection。

## 8. 最小检查

1. 正常解析 LF 和 CRLF 格式的 `DevToolsActivePort`。
2. 非法 port、缺少 path 时失败。
3. `/json/version` 成功时使用响应 endpoint。
4. `/json/version` 返回 404 时使用文件 endpoint。
5. HTTP 403 映射为 `need-allow`。
6. 文件不存在映射为 `need-remote-debugging`。
7. `EACCES`、`EPERM` 保留具体错误，不映射为 port 问题。
8. WebSocket approval 等待期间不创建第二条 connection。
9. 全部现有 self-check 通过。

## 9. 完成条件

- 开启 Chrome remote debugging 后，yodo 不需要用户提供 port 即可连接。
- Chrome `/json/version` 返回 404 时，仍能通过 `DevToolsActivePort` 连接。
- Chrome 要求 approval 时，只保留一条等待中的 connection。
- 错误提示能区分 remote debugging 未开启、Chrome approval 和文件读取失败。
- 不新增 dependency，不增加与当前目标无关的 browser support。
