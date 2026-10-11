---
name: yodo
description: >-
  触发词 yodo；用用户本机已登录的 Google Chrome 完成真实网站任务。
---

# yodo

yodo 用用户已登录的 Chrome 完成网站任务。每个可复用的流程是一个 task（`~/.yodo/task/<name>.js`）。没有可用 task 时，先录制一次用户演示，再写 task。

## 1. 流程

1. `yodo run` 列出 task 摘要。有能完成当前目标的 task，直接运行。
2. 没有可用 task：`yodo record start`，请用户在标题为 `yodo record` 的窗口里演示一遍，用户回复后 `yodo record stop`。
3. 读取 stop 返回的 `timeline` 与 `recordDir` 下的响应文件，写一个新 task。选择 network 还是 dom 由你依据材料判断。
4. `yodo run <task> <参数>`。`status: success` 才算完成。通过后把文件头的 `@status` 改为 `verified`。

## 2. 命令

命令入口是 `~/.yodo/bin/yodo`。在 PATH 中时直接用 `yodo`，否则用绝对路径。

| 命令 | 作用 |
|---|---|
| `yodo run` | 列出 task 摘要（名称、`@status`、`@summary`、参数） |
| `yodo run <task> [args...]` | 运行 task，stdout 输出 JSON |
| `yodo record start [name]` | 开始录制，打开标题为 `yodo record` 的窗口 |
| `yodo record stop` | 结束录制，输出 `recordDir` 与 `timeline` |
| `yodo record abort` | 放弃录制 |
| `yodo doctor` | 只读检查安装与连接状态 |

## 3. 结果与错误

- `yodo run` 的 stdout 是 JSON：`status` 与 `result`。
- 失败时错误输出到 stderr，退出码非零。是否重试、是否修改 task，由你根据错误信息决定。
- 输出 `need-install`、`need-chrome` 或 `need-extension` 时，把 `guide` 原样告诉用户，等待用户回复「好了」，然后重新运行同一条命令。不要改写 `guide`，不要轮询。
- `result` 只包含用户要求的内容。原始接口响应、整段 HTML、完整列表只能在 task 内部用于取值。

## 4. 录制与学习

- 录制窗口的标题是 `yodo record`。请用户只在这个窗口里演示。
- `timeline.jsonl` 按时间排序，包含 request 行（有 `file` 指向请求文件）和 action 行（`click`、`value`、`checked`、`scroll`、`navigation`，附带 `role` 与 `name`）。
- 响应体存为 `recordDir` 下的文件。需要看响应时直接读取文件。
- 选择 network 还是 dom：接口能完整表达操作且不需要页面生成的签名、token 时用 network；否则用 dom。拿不准时先用 network 试一次，失败后改用 dom。

## 5. 写 task

文件头：

```javascript
/**
 * @summary 按关键词搜索
 * @status: draft
 * @executor network
 * @record <record name>
 * @param argv[2] 搜索词
 */
```

- `@status`：`draft` 或 `verified`。
- `@executor`：`network` 或 `dom`。
- `@record`：写 task 时使用的录制名。
- `@param`：每个参数的含义。
- 脚本通过 `process.argv` 读取参数。

SDK：

```javascript
import { yodo, goto, click, fill, press, toggle, expectRequest, serializeUrl } from "../task/lib/index.js";

await yodo.run(async ({ page }) => {
  await goto(page, serializeUrl({ bareUrl: "https://example.com/search", query: { q: process.argv[2] } }));
  return page.evaluate(() => document.title);
});
```

- `page.evaluate(fn, ...args)`：在页面内执行函数，参数必须可 JSON 序列化。
- `page.cdp.send(method, params)`：页面级 CDP 命令。
- `page.cdp.on(event, listener)`：监听页面事件。
- `goto`、`click`、`fill`、`press`、`scroll`、`check`、`select`、`waitForSelector`：页面操作。
- `toggle(page, selector, { target: true | false })`：先读状态，已满足则返回 `already`，否则点击一次返回 `done`。有副作用的操作用它。
- `expectRequest(page, { method, path }, action)`：执行 action，并等待它触发的请求完成，返回 `{ status, body }`。会发请求的操作用它判断是否成功。没有对应请求说明操作没有生效。
- 不要在 task 里关闭用户已有的 tab，不要修改 holder 的状态。

### 成功判断

task 只有在确认结果正确时才能返回，否则必须抛出错误：

- 结果必须对应本次参数。页面地址、查询词或回答内容与参数不符时，抛出错误，不返回旧页面的内容。搜索类 task 要先导航到参数对应的地址，不能写死地址。
- 接口请求必须检查 HTTP 状态码。非 200 时抛出错误，并说明原因（如未登录、无权限）。
- 接口返回业务码的，必须检查业务码（如 `code !== 0`）。
- 有副作用的操作，成功判断依据是操作后的状态或响应，而不是点击没有报错。

## 6. 草稿与验证

- 新写或修改的 task 先标记 `@status: draft`，运行成功后改为 `verified`。
- `~/.yodo/task` 中没有 `@status` 的脚本视为 `verified`。
- 同一个 task 失败后没有新证据时，不要反复运行。

## 7. 对用户

- 只说明要做的操作、需要用户完成的步骤和最终结果。
- 需要用户演示或登录时，直接说明要做什么。
- 不向用户暴露 task 结构、文件路径或内部状态。
