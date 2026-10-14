# run 的几处问题与修复

来自对 run 全链路（`holder.ts`、`sdk.ts`、`cli/rpc.ts`、`browser/session.ts`、`templates/task-lib/page.js`）的复查。

## 做了

| 问题 | 怎么发现的 | 处理 |
|---|---|---|
| socket 按块 `toString()` 拼接，汉字被拆在两个数据块里会变成替换字符，JSON 照样能解析，数据被悄悄改了 | 读代码，加内存实验：一条全是汉字的 90 KB 响应，切在 64 KB 处，多出 3 个替换字符；`StringDecoder` 则完全一致 | 两端都 `setEncoding("utf8")`；自检让假 daemon 把一条响应拆在汉字中间发，去掉修复就失败 |
| `goto` 在导航提交时就返回，页面还在 `loading` | 真实 Chrome 里用"边传边卡"的本地页面：旧代码 19 毫秒返回，`readyState` 是 `loading`，后半段内容还没出现；新代码 1518 毫秒，`readyState` 是 `interactive`，内容已在 | 默认等 DOMContentLoaded，只认提交之后的事件，加 `until: "commit" \| "domcontentloaded" \| "load"` |
| 只改 hash 的跳转白等满超时 | 同上：安静 1.5 秒后旧代码等满 3000 毫秒超时；新代码 17 毫秒 | 监听 `navigatedWithinDocument`，提交之后出现的不算 |
| 上一个页面没发完的加载事件让下一次 `goto` 提前结束 | 同上：旧代码里第二次 `goto` 38 毫秒就返回 | 只认提交之后的事件 |
| 每次 `evaluate` 都先发 `Runtime.enable` | 读代码 | 删掉，`Runtime.evaluate` 不需要它 |
| run 期间点开的 `target=_blank` 标签页，run 结束后还留在 run 窗口里 | 真实 Chrome：旧代码 run 结束后窗口里是锚点加 `popup`；新代码连跑 3 次只剩锚点 | `endRunTab` 里关掉 run 窗口里除锚点外的 tab；`runEnd` 清理完才释放模式 |
| daemon 写队列超限时 client 只看到"连接已关闭" | 读代码 | 断开前先写一行没有 id 的错误说明原因，client 作为失败原因 |
| 监听函数里抛错变成进程的未捕获异常；`cdp.once` 没有默认超时；连接断开时等事件的 task 一直挂着 | 读代码 | `RpcPeer.failure`，`yodo.run` 把它和 task 函数赛跑；`once` 默认 30 秒 |

## 没做

- **请求超时**（`RpcPeer.request` 没有超时）：可以接受，task 有整体 90 秒的上限。
- **事件按需订阅**（task 没监听的页面事件仍然会流过 socket）：队列超限现在有了明确的报错，真遇到再做。
- **`commandTimeoutMs` 是 daemon 上的全局变量、`cdp.send` 不传 `timeoutMs`**：属于并发和超时设计，保持串行就不用动。
- **`window.open` 带窗口特征弹出的独立窗口**：不关。daemon 只关带 yodo 标题的窗口，从不按 id 关用户的窗口，这条规则有自检保护。

## 验证中的一个插曲

安装后第一次复测弹窗探针时，run 挂住 90 秒被终止。原因是探针自己：它在同一个进程里起了 HTTP 服务，Chrome 留下 2 个空闲连接，`server.close()` 关不掉，进程要等 Node 的 `headersTimeout` 才退出。`yodo.run` 本身已经正常返回。改用 `closeAllConnections()` 后 3 秒完成，之前几次"成功"只是侥幸。不是 yodo 的问题。
