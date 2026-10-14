---
name: yodo
description: >-
  触发词 yodo；用用户本机已登录的 Google Chrome 完成真实网站任务。
---

# yodo

yodo 用用户已登录的 Chrome 完成网站任务。每个可复用的流程是一个 task（`~/.yodo/task/<name>.js`）。没有可用 task 时，先录制一次用户演示，再写 task。

## 1. 流程

1. `yodo run` 列出 task 摘要。有能完成当前目标的 task，直接运行。
2. 没有可用 task：`yodo record start`，告诉用户切换到标题为 `yodo record` 的窗口演示一遍（窗口在后台打开，不会自动跳到前台），用户回复后 `yodo record stop`。
3. 读取 stop 返回的 `timeline` 与 `recordDir` 下的响应文件，写一个新 task。
4. `yodo run <task> <参数>`。`status: success` 才算完成。通过后把文件头的 `@status` 改为 `verified`。

## 2. 命令

命令入口是 `~/.yodo/bin/yodo`。在 PATH 中时直接用 `yodo`，否则用绝对路径。

| 命令 | 作用 |
|---|---|
| `yodo run` | 列出 task 摘要（名称、`@status`、`@summary`、参数） |
| `yodo run <task> [args...]` | 运行 task，stdout 输出 JSON |
| `yodo eval '<代码>'` | 顺序组合多个 task，stdout 输出 JSON（见第 5.1 节） |
| `yodo record start [name]` | 开始录制，在后台打开标题为 `yodo record` 的窗口 |
| `yodo record stop` | 结束录制，输出 `recordDir` 与 `timeline` |
| `yodo record abort` | 放弃录制 |
| `yodo doctor [--json]` | 只读检查安装与连接状态；`--json` 输出 `{ ok, checks }`，失败项带 `fix` |

## 3. 结果与错误

- `yodo run` 与 `yodo eval` 的 stdout 是 JSON：`status` 与 `result`。结果总是完整输出在 stdout，不会因为太大而改成文件路径。
- 每次运行的输入与输出也会保存到 `~/.yodo/run/<task>/`（`eval` 保存到 `run/compose/`），每个 task 保留最近 20 份。只用于排查问题，不影响 stdout。
- 以 `status` 为准：`success` 退出码为 0；`failure` 和 `need-*` 退出码都非零。任何命令失败时，stdout 都是 `{ "status": "failure", "error": "..." }`。是否重试、是否修改 task，由你根据错误信息决定。
- 同一时间只能运行一个 task。另一个 task 正在运行时，会自动等待最多 30 秒再开始；仍被占用则失败，稍后重试同一条命令。不要并行发起多个 `yodo run` 或 `yodo eval`，按顺序一个接一个运行。录制进行中不能运行 task，需先 `yodo record stop` 或 `yodo record abort`。
- 超时分两层：单个步骤（`evaluate`、`goto`、`waitForSelector`、`expectRequest`）默认最长 30 秒；整个 task 默认最长 90 秒。超时会被终止并按失败返回，错误里会说明是哪一层。`yodo eval` 对每个内层 task 单独计时。
- `yodo eval` 中某个内层 task 失败时，还会带 `failedTask`，值为该 task 名。
- task 里 `console.log` 等输出会出现在 stderr，不影响 stdout 的 JSON 和退出码。不要大量打印，stderr 的内容也会进入你的上下文。
- 输出 `need-install`、`need-chrome` 或 `need-extension` 时，把 `guide` 原样告诉用户，等待用户回复「好了」，然后重新运行同一条命令。不要改写 `guide`，不要轮询。
- `result` 只包含用户要求的内容。原始接口响应、整段 HTML、完整列表只能在 task 内部用于取值。

## 4. 录制与学习

- 录制窗口的标题是 `yodo record`。请用户只在这个窗口里演示；用户在这个窗口里自己新开的标签页也会被记录。录制期间遇到的网页对话框（确认框等）由用户自己选择，不会被自动确认。
- `timeline.jsonl` 按时间排序，包含 request 行（有 `file` 指向请求文件）和 action 行。action 行的 `actionType` 和字段：
  - `click`：`selector`、`role`、`name`。
  - `value`：输入后的 `value`（密码等敏感字段只有 `valueRedacted: true`）；下拉框另有 `option`（选中项的文字）。
  - `checked`：勾选后的 `checked`。
  - `scroll`：`deltaY`（向下为正）、`deltaX`，滚到底时有 `nearEnd: true`；容器内滚动带 `selector`，整页滚动没有。
  - `navigation`：`url`，包含页面内路由变化；iframe 里的导航不记录。
  - 公共字段：`selector` 是页面里尽量稳定且唯一的 CSS 选择器（shadow DOM 里的元素用它所在宿主的选择器）；有多个标签页时带 `tab`（第几个），在 iframe 里的操作带 `frame`（iframe 的地址）。
  - `selector` 用于写 `click`、`fill` 等，但页面改版后可能失效，写 task 后要运行验证。键盘按键不记录，用回车提交的搜索只能从后面的请求和导航推断。
- `record stop` 的输出里有 `warnings` 时，说明某些页面的点击、输入、滚动没有录到（只有网络请求）。把 `warnings` 的内容告诉用户，请用户重新演示这一步，不要根据缺失的动作推断。
- 响应体存为 `recordDir` 下的文件。需要看响应时直接读取文件。

## 5. 写 task

文件头：

```javascript
/**
 * @summary 按关键词搜索
 * @status: draft
 * @record <record name>
 * @param argv[2] 搜索词
 */
```

- `@status`：`draft` 或 `verified`。
- `@record`：写 task 时使用的录制名。
- `@timeout`：可选，整个 task 的最长运行秒数，默认 90。只有确实需要更久时才写，例如 `@timeout 180`；步骤超时之和应小于它，这样出错时能看到具体是哪一步。
- `@param`：每个参数的含义。
- 脚本通过 `process.argv` 读取参数。

SDK：

```javascript
import { yodo, goto, evaluate, click, fill, press, toggle, expectRequest, serializeUrl } from "../task/lib/index.js";

await yodo.run(async ({ page }) => {
  await goto(page, serializeUrl({ bareUrl: "https://example.com/search", query: { q: process.argv[2] } }));
  return evaluate(page, () => document.title);
});
```

- `evaluate(page, fn, ...args)`：在页面内执行函数，参数必须可 JSON 序列化。注意 `page` 对象本身没有 `evaluate` 方法，必须用这个函数。
- `page.cdp.send(method, params)`：页面级 CDP 命令。
- `page.cdp.on(event, listener)`：监听页面事件。监听函数里抛出的错误会让这次 run 失败，错误信息就是你抛出的那个。
- `goto(page, url, { until, timeout })`：导航并等待。`until` 默认 `"domcontentloaded"`（页面解析完），也可以是 `"load"`，或 `"commit"`（只等导航提交，页面可能还在解析，用于页面脚本卡住、一直不触发 DOMContentLoaded 的网站，之后自己等需要的元素）。只改 hash 或 pushState 这类不换文档的跳转，页面内路由一变就算完成。
- `click`、`fill`、`press`、`check`、`select`、`toggle`：页面操作。第二个参数是定位：CSS 选择器字符串，或 `{ role, name }`（无障碍角色和名称，与录制里的 `role`、`name` 相同，优先用它）。`role`/`name` 必须唯一，有多个匹配会报错并给出数量，改用更具体的 name 或 CSS。动作会自动等待元素可见且可操作，默认 10 秒，`{ timeout }` 可改。
- `scroll`、`waitForSelector`：页面操作，只接受 CSS 选择器。
- `toggle(page, selector, { target: true | false })`：先读状态，已满足则返回 `already`，否则点击一次返回 `done`。有副作用的操作用它。
- `expectRequest(page, { method, path }, action)`：执行 action，并等待它触发的请求完成，返回 `{ status, body }`。会发请求的操作用它判断是否成功。没有对应请求说明操作没有生效。
- 不要在 task 里关闭用户已有的 tab，不要修改 holder 的状态。

### 写法

- 优先在页面内调用接口（`fetch`，带登录态）：快、稳定，响应可直接检查状态码和业务码。
- 接口依赖页面生成的签名、token，或接口无法完整表达操作时，再操作页面（`click`、`fill` 等）。
- 拿不准时先试接口，失败后改用页面操作。

### 成功判断

task 只有在确认结果正确时才能返回，否则必须抛出错误：

- 结果必须对应本次参数。页面地址、查询词或回答内容与参数不符时，抛出错误，不返回旧页面的内容。搜索类 task 要先导航到参数对应的地址，不能写死地址。
- 接口请求必须检查 HTTP 状态码。非 200 时抛出错误，并说明原因（如未登录、无权限）。
- 接口返回业务码的，必须检查业务码（如 `code !== 0`）。
- 有副作用的操作，成功判断依据是操作后的状态或响应，而不是点击没有报错。

### 5.1 组合

用 `yodo eval` 顺序调用已有 task，代码运行在 async 函数中，`return` 的值作为 `result`：

```bash
yodo eval 'const list = await task("x-search-recent", "claude", 3); return list.map((t) => t.text);'
```

- 组合中只能通过 `task(name, ...args)` 调用 task，不能访问页面。需要复用的逻辑写成 task。
- 组合代码里的 `console.log` 输出到 stderr，stdout 只有最终 JSON。
- `@status: draft` 的 task 不能在组合中调用。
- 单个 task 的过滤、加工由你直接处理 JSON，不用 `eval`。

## 6. 草稿与验证

- 新写或修改的 task 先标记 `@status: draft`，运行成功后改为 `verified`。
- `~/.yodo/task` 中没有 `@status` 的脚本视为 `verified`。
- 同一个 task 失败后没有新证据时，不要反复运行。

## 7. 对用户

- 只说明要做的操作、需要用户完成的步骤和最终结果。
- 需要用户演示或登录时，直接说明要做什么。
- 不向用户暴露 task 结构、文件路径或内部状态。
