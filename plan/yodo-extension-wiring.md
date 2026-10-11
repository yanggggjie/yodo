# yodo 扩展化方案（最简版）

## 目标

- 用 yodo 自己的 Chrome 扩展（MV3）替代 `DevToolsActivePort` 连接方式。
- 保持 yodo 的功能不变：CLI 命令、SKILL.md 协议、录制（含 network material 与响应体）、run 行为不变。
- 架构尽量简单，代码量最少。

## 非目标

- 不做 chrome-use 的多 session、OOPIF、download manager、stealth、MCP、HTTP API。
- 不做远程多机模式。
- 不支持跨域 iframe（OOPIF）的独立录制。`chrome.debugger` 只附加到 tab 顶层文档；跨域 iframe 不单独采集（已确认妥协）。
- 第一版只支持一个 Chrome profile。
- 不做 `chrome.debugger` 空闲释放，提示条在 attach 期间常驻。
- 不使用 `--silent-debugger-extension-api`。

## 架构

```
yodo CLI（基本不变）
  └─ Unix socket（现有 RPC 协议）
       └─ holder = yodo native messaging host（Chrome 拉起，Node）
            ├─ 录制、run、@ref、脚本引擎（现有代码）
            └─ stdio（4 字节长度前缀 + JSON）
                 └─ 扩展 background.js（薄层 CDP 代理）
                      ├─ tab/window 操作（6 个）
                      └─ chrome.debugger：attach / detach / sendCommand / 事件转发
```

- 没有中继、WebSocket、`relay-cdp-url`、GUID、`Origin` 检查、虚拟 browser 会话。
- holder 由 Chrome 拉起：扩展连上时启动，Chrome 退出（stdin 关闭）时退出。
- CLI 不拉起 holder。socket 不存在即表示扩展未连接。

## 步骤

### 步骤 1：扩展（`skills/yodo/src/chrome-extension/`）

- `manifest.json`：固定 `key`；权限 `debugger`、`tabs`、`nativeMessaging`、`storage`、`alarms`；不声明 `<all_urls>`。
- `background.js` 只做两件事：

**A. 连接**

- `connectNative("com.yodo.connect")`。触发点：`onStartup`、`onInstalled`、`alarms`（30 秒，兜底）、`onDisconnect`（退避重连）。
- 握手：扩展发 `hello`，带协议版本号。

**B. 操作与转发**

| 操作 | 实现 |
|---|---|
| `openWindow({focused})` | `chrome.windows.create` |
| `openTab({windowId, url, active})` | `chrome.tabs.create` |
| `closeTab(tabId)` | `chrome.tabs.remove` |
| `closeWindow(windowId)` | `chrome.windows.remove` |
| `windowOf(tabId)` | `chrome.tabs.get`，返回 windowId 与 state |
| `attach(tabId)` / `detach(tabId)` | `chrome.debugger.attach({tabId}, "1.3")` / `detach` |
| `send(tabId, method, params)` | `chrome.debugger.sendCommand({tabId}, method, params)` |

- 事件：`chrome.debugger.onEvent` 原样转发，`sessionId` 字段 = `tabId` 的字符串形式；`chrome.debugger.onDetach` 转发（带 reason）；`chrome.tabs.onRemoved` 转发。
- 防护：扩展只接受 holder 通过 `openWindow` / `openTab` 创建过的 id，以及由这些 tab 打开的新 tab（opener 匹配）。其他 id 直接报错。登记放在 `chrome.storage.session`。holder 也维护同一份登记，用于 `listOwned`。

### 步骤 2：holder 作为 native host（`skills/yodo/src/native-messaging-host/`）

- 入口：`nm-host.sh` 用绝对 Node 路径（`~/.yodo/node-path`，由 `yodo install` 写入）调用 holder 入口。
- 启动流程：
  1. 按 native messaging 帧读写 stdio。
  2. 创建现有 `SESSION_SOCK`，RPC 协议不变。
     - posix：Unix socket 文件，权限 0600。
     - win32：named pipe（`constants.ts:13` 已有分支），同样只允许当前用户连接。
     - 单例：启动前尝试连接已有 socket。若能连通，说明已有活的 holder，新 holder 直接退出，不覆盖。若连不通，视为残留，删除后重建。
  3. 收到扩展 `hello`，校验协议版本；不符则返回错误并退出。
- 退出：stdin 关闭 → 现有 `shutdown()`：`finishRecord("disconnect")`、关闭 run 窗口、删除 socket、退出。
- 不做空闲退出，不做 idle-detach。

### 步骤 3：yodo 源码适配（功能不变）

**3.1 browser 级调用改为扩展操作**

- `browser/session.ts`：
  - 删除 `Target.attachToBrowserTarget`、`setAutoAttach`、`setDiscoverTargets`。
  - `createTarget` → `openWindow` / `openTab`；`closeTarget` → `closeTab`；`getTargets` → holder 的 `listOwned`；`attachToTarget` / `detachFromTarget` → `attach` / `detach`；`getWindowForTarget` → `windowOf`。
  - `Browser.getVersion`：对任一已附加 tab 发送。
  - `Target.*` 事件监听 → 扩展事件。
  - `Security.setIgnoreCertificateErrors`：原来是 browser 级（`holder.ts:83、108、147`，`record/index.ts:126、147`）。改为对每个被 attach 的 tab 发送；新 tab attach 时同样发送；录制开始设为 true，结束设为 false。
- `record/collect.ts`：窗口追踪用 `windowOf`；`attachedToTarget`、`targetCreated` 等事件用扩展事件。`RecordWindowTracker` 与 popup 归属规则不变。
- 页面级代码（`Page`、`Runtime`、`Network`、`DOM`、`Input`）不变，包括 `injectRecorder` 与 `networkRecorder`。

**3.2 连接层**

- `browser/connect.ts`：删除 `DevToolsActivePort` 读取，以及 `need-remote-debugging`、`need-file-access`。
- `browser/session.ts`：删除 `connectRawCdp(wsUrl)`。`RawCdpConnection` 的 `send(method, params, sessionId)` 形态保留，底层改为"发给 holder 内的扩展通道"。

**3.3 CLI 与 holder**

- socket 路径只依赖 `os.homedir()`，不依赖 `XDG_RUNTIME_DIR` 或 shell 环境。CLI 与 Chrome 拉起的 holder 算出的路径必须完全一致。
- `cli/spawn.ts`：`ensureHolder` 不再拉起 holder。socket 不存在时返回 `need-extension`；Chrome 未运行时返回 `need-chrome`。
- `holder.ts`：启动改为等待扩展 `hello`；`browser.on("disconnected")` 改为 stdin 关闭。

**3.4 不改的部分**

- CLI 命令、RPC 方法名与参数、`task` / `record` 目录结构、录制输出格式、`@ref`、脚本引擎、`SKILL.md` 协议。

### 步骤 4：安装与 manifest

- `yodo install`：写 `com.yodo.connect.json`，`path` 指向 `~/.yodo/src/native-messaging-host/nm-host.sh`，`allowed_origins` 写固定扩展 ID。
- 路径：
  - macOS：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Linux：`~/.config/google-chrome/NativeMessagingHosts/`
  - Windows：写 manifest 文件，并在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.yodo.connect` 写默认值。
  - 只写 Google Chrome。
- `yodo doctor` 只读：检查 manifest、`path`、扩展 ID、socket，给出修复命令。
- `setup.js` 把 `src/` 拷到 `~/.yodo/src/`。扩展的 Load unpacked 目录和 manifest `path` 都指向这个稳定位置。

### 步骤 5：握手状态

| 状态 | 含义 | 用户处理 |
|---|---|---|
| `need-install` | 扩展或 manifest 缺失 | agent 运行 `yodo install`，用户在 `chrome://extensions` 加载扩展 |
| `need-chrome` | Chrome 未运行 | 启动 Chrome |
| `need-extension` | Chrome 运行中，扩展未连接（socket 不存在） | 见 `protocol.ts` 文案：确认扩展开启，点 service worker 或工具栏图标 |

- 删除 `need-remote-debugging`、`need-file-access`、`need-allow`、`need-extension`（改名为 `need-extension`，因为已经没有 relay）。
- 同步 `protocol.ts` 与 `SKILL.md` §3.1。

### 步骤 6：测试

- 单元：native messaging 帧编解码（4 字节小端）往返；holder 的 owned 登记规则；单例判断（活 socket 拒绝启动，残留 socket 被清理）。
- 适配后的 selfcheck：`session.selfcheck.ts`、`collect.selfcheck.ts` 改为用内存假扩展通道。
- 删除：`connect.selfcheck.ts` 中 `DevToolsActivePort` 相关测试。
- 功能不变对比（核心）：基线为当前分支（改造前的代码）。同一组命令（open、snapshot、click、record start/stop、run）在基线与改造后各跑一次，对比输出结构和录制文件。改造在新分支上进行，基线分支保留不动。
- 手动：Chrome 重启后无需操作即可连上；Chrome 退出后 socket 已删除。录制中强制退出 Chrome 时数据可能丢失，不作为验收项，也不额外兜底。

## 生命周期

- Chrome 启动：`onStartup` → `connectNative` → Chrome 拉起 holder。
- 安装或更新：`onInstalled` → `connectNative`。
- 兜底：`alarms` 30 秒（Chromium IDL 当前最小值，实际可能延后），port 不存在则重连。
- 禁用后再启用：不一定触发 `onInstalled`，靠 alarm 兜底，或点击扩展图标唤醒（需实测）。
- holder 崩溃：扩展 `onDisconnect` 后退避重连。
- Chrome 退出：holder 尽力保存录制后退出，socket 被删除。强制退出时录制数据可能丢失，接受。

## 窗口与焦点

### 原有行为（以 yodo 源码为准）

- `record.start` 调用 `openRecordWindow()`（`browser/session.ts:660`）：`newWindow: true, background: true, focus: false`，标题为 `RECORD_WINDOW_TITLE`。录制窗与 run window 是两个窗口。
- 录制窗登记在 `RecordWindowTracker`（`record/collect.ts:27`）。
- `record.stop` / `record.abort` / 断开时，`closeRecordWindows()` 只关闭登记过的录制窗（`record/collect.ts:99`）。关完没有窗口时开一个普通窗口，不调用 `Browser.close`。
- run window 只在 holder 退出时关闭。

### 决策

- 录制窗：`focused: true`（演示窗口）。原来是 `focus: false`，这是唯一的行为改动。
- 其他窗口（run window、后台任务、窗口重建）：`focused: false`。
- 录制结束：录制窗关闭，与原来一致；用户窗口不关。

### 映射

- `openRecordWindow` → `openWindow({focused: true})` + `openTab`。
- `background: true` → `openTab({active: false})`。
- run：在 run window 内 `openTab`，结束时 `closeTab`。

## 可见范围

- 只有 holder 通过 `openWindow` / `openTab` 创建的窗口与 tab，以及由它们打开的新 tab，才会被扩展接受。
- 用户自己的 tab 永远不 attach，不出现 yodo 的提示条。

## 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 提示条常驻 | `chrome.debugger` attach 时显示，无法关闭 | 已接受；演示时用户可见，属于设计内容 |
| `Runtime.enable` 暴露 CDP | yodo 默认调用，chrome-use 默认关闭 | 保留，记录为已知风险 |
| 扩展与 holder 版本不一致 | skill 更新后 holder 变，扩展是 Load unpacked 的旧代码 | `hello` 带协议版本，不符则报明确错误，提示用户刷新扩展 |
| attach 冲突 | DevTools 打开，或其他调试扩展已附加同一 tab | `attach` 报错，映射为明确错误 |
| 用户点击提示条 Cancel | 触发 `onDetach` | 转发给 holder；holder 按需要重新 attach |
| holder 退出时录制未保存 | Chrome 直接退出，stdin 关闭 | 接受丢失；正常退出时尽力 `finishRecord("disconnect")` |
| Node 路径变化 | 升级或切换 Node 后 manifest 指向失效 | `~/.yodo/node-path` 由 install 写入，doctor 检查 |
| 禁用后再启用无事件 | 可能不触发 `onInstalled` | alarm 兜底，需实测 |
| 跨域 iframe 不录制 | `chrome.debugger` 不附加 OOPIF | 已妥协，不做 |
| holder 重复拉起 | 扩展重连或旧进程未退出 | 单例判断：活 socket 拒绝启动，残留 socket 清理 |
| socket 可被本机同用户进程连接 | 任何以当前用户运行的程序都能操控 Chrome 标签页，与 CDP 端口风险类似 | 权限 0600，只在文档中说明，不做额外认证 |

## 已确定的决策

1. 扩展分发：手动加载已解压目录（Load unpacked），`yodo install` 写 manifest。
2. 架构：holder 即 native messaging host，扩展为薄层 CDP 代理。
3. `Runtime.enable`：保留，记录为风险。
4. 提示条：常驻，不做空闲释放，不用静默参数。
5. profile：第一版只支持一个。
6. 宿主语言：Node。
7. 跨域 iframe：妥协，不录制 OOPIF。
8. 录制中强制退出 Chrome：数据可能丢失，不兜底。
9. 基线：当前分支，改造在新分支进行。
10. 状态名：`need-extension`。

## 与 yodo 代码的关系

- 改动：`browser/session.ts`、`record/collect.ts`、`browser/connect.ts`、`cli/spawn.ts`、`holder.ts`、`protocol.ts`、`SKILL.md` §3.1。
- 新增：`src/chrome-extension/`、`src/native-messaging-host/`。
- 不动：CLI 命令、RPC 协议、录制输出、`@ref`、脚本引擎、页面级 CDP 代码。
- 删除：`connect.selfcheck.ts` 中 `DevToolsActivePort` 相关测试。

## 整体验收标准

- 同一组 yodo 命令改造前后行为一致（输出结构、录制文件、run 结果）。
- CLI 与 SKILL.md 协议不变。
- 代码与文档中不再出现 `DevToolsActivePort`、`need-remote-debugging`、`need-file-access`、`need-allow`、`relay-cdp-url`。
- Chrome 重启后无需用户操作即可连上；Chrome 退出后录制已保存。

## 实现状态（分支 dom-fallback-improve，未提交）

已落地：

- 扩展：`skills/yodo/src/chrome-extension/`（manifest 固定 key，background.js，README）。
- native host：holder 直接作为 native messaging host，`browser/extension.ts` 负责分帧、请求应答匹配、事件分发、版本校验。
- yodo 源码：`browser/session.ts`（browser 级调用改为 `raw.ops`，页面级不变）、`record/collect.ts` 与 `record/index.ts`（发现改为 `tab.created` / `tab.updated`，附加改为 `ops.attach`）、`holder.ts`（启动等 hello、单例检查、证书设置按 tab）、`cli/spawn.ts`（不再拉起 holder）、`browser/connect.ts`（只剩本机状态检测）。
- 握手状态：`need-install`、`need-chrome`、`need-extension`；`protocol.ts` 与 `SKILL.md` §3.1 已同步。
- 安装：`native-messaging-host/install.ts` 写启动脚本与 manifest（macOS / Linux 写目录，Windows 写注册表）；`setup.js` 调用；`doctor` 只读检查。
- 测试：全部 selfcheck 通过；新增 `browser/extension.selfcheck.ts`（分帧、链路、版本、关闭）、`native-messaging-host/holder.e2e.selfcheck.mjs`（holder 作为 native host，模拟扩展，经 socket 跑 ping、单例、run、页面级 CDP、browser 级拒绝、record start/stop、断开清理）、`chrome-extension/background.selfcheck.mjs`（桩 chrome.* 的扩展冒烟）。`npm run check`（tsc）通过。

与原方案的偏差：

- 启动脚本直接写入安装时的 Node 绝对路径，没有单独的 `~/.yodo/node-path` 文件。doctor 检查启动脚本与 holder 入口是否存在。
- Windows 启动脚本为 `.bat`。Chrome 是否能直接以 `.bat` 作为 native host 的 path 未验证，需要在 Windows 上实测。
- `_cdp.connection` 与 `_cdp.browser` 不再能发送 browser 级命令（没有 tab 的命令会被拒绝）。这是功能上的变化，文档中的 `_cdp` 用法需要同步收窄。
- `yodo stop` 让 holder 退出，但扩展会在下一次 alarm（最多约 30 秒）或 Chrome 重启时重新拉起它。需要永久停止时，应在 `chrome://extensions` 关闭扩展。
- `tab.detached`（例如用户点了提示条的 Cancel）后，该页面不会自动重新附加，之后对它的命令报 PAGE_NOT_FOUND。

尚未验证（需要在真实 Chrome 上做）：

- 扩展加载后，`yodo` 命令能否连上；Chrome 重启后无需操作即可连上。
- 禁用后再启用，是否触发 `onInstalled`，以及 alarm 兜底的实际延迟。
- 录制中强制退出 Chrome 的行为（按约定不兜底，只需确认不会卡死）。
- DevTools 已打开时 `chrome.debugger.attach` 的报错是否能被正确映射。
