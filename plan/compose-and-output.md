# 输出格式、运行历史与任务组合

## 决定一览

| 问题 | 决定 |
|---|---|
| record start 握手失败退出码 | 非零（已完成） |
| doctor 输出格式 | 默认文字，`doctor --json` 输出 JSON |
| 大结果 `output.json` | 删除。stdout 始终输出完整 JSON |
| 运行历史 | runner 写 `~/.yodo/run/<task>/<时间戳>.json`，每个 task 保留最近 20 份 |
| 任务组合入口 | 新增子命令 `yodo eval "<代码>"`；不用 `run -e` |
| 组合中调用 task | `task(name, ...args)`，顺序执行 |
| 草稿 task | 组合中默认拒绝 `@status: draft` |
| 组合中的页面访问 | 不允许，只能通过 `task()` |
| 单 task 过滤 | 不用 eval，由 agent 直接处理 JSON |
| 管道 stdin | 本版不做，有真实需求再加 |

## 1. 退出码

- 握手失败（`need-install` / `need-chrome` / `need-extension`）退出码为 1。
- 其它错误退出码为 1。
- 成功退出码为 0。
- 状态：已完成，见 `skills/yodo/src/cli/yodo.ts` 的 `recordCall`。

## 2. doctor 输出

- 默认文字，给人看。
- `yodo doctor --json` 输出：

```json
{ "ok": true, "checks": [ { "name": "holder", "ok": true, "detail": "alive pid=51161" } ] }
```

- 失败项带 `fix` 字段，内容与文字版的修复命令一致。
- SKILL 中 agent 使用 `--json`。

## 3. 输出与历史

- stdout 始终是完整 JSON，不再按大小切换。
- 删除 `resultFile` 与 `output.json` 逻辑。
- runner 在每次 `run` 结束后写 `~/.yodo/run/<task>/<时间戳>.json`，保存输入参数、status、result。
- 每个 task 只保留最近 20 份，超出的按时间删除。
- 大结果的约束在 task 设计中解决：task 只返回用户需要的内容。

## 4. 组合：`yodo eval`

用法：

```bash
yodo eval '
const list = await task("x-search-recent", "claude", 3);
return list.result.map((t) => t.text);
'
```

- 代码体运行在 async 函数中，可以直接 `await`，`return` 的值作为结果。
- 运行方式：代码写入 `~/.yodo/session/compose/<时间戳>.mjs`，用 Node 执行，结束后删除（异常时也删除）。
- 注入的 `task(name, ...args)`：
  1. 检查 task 存在，并读取 `@status`；`draft` 直接抛错，错误信息说明原因。
  2. 用 `node <task>.js <args>` 启动子进程，捕获 stdout，取最后一段 JSON。
  3. `status` 为 `success` 时返回 `result`；否则抛出错误，错误信息带上 task 名。
- 输出：成功时 `{ "status": "success", "result": ... }`。
- 失败时：

```json
{ "status": "failure", "error": "[zhihu-search-like-first] Error: ...", "failedTask": "zhihu-search-like-first" }
```

  组合代码自身的异常没有 `failedTask` 字段。
- 历史：每个内层 task 按第 3 节写自己的历史；组合运行记为 `compose`，保存代码与结果。
- 组合代码的 `console.log` 走 stderr，不污染 stdout。

## 5. 约束

- 组合只能顺序执行。daemon 同一时间只允许一个 run，并行会得到 `RUN_BUSY`。
- 组合代码不调用 `run.begin`，也不访问页面。页面操作只在 task 内完成。
- 组合不计入任何 task，不能被复用。需要复用的逻辑应写成 task。
- 单 task 的过滤和加工由 agent 处理，不用 `eval`。
- stdin 不做。不需要时不加，避免第二条输入路径。

## 6. 实现顺序

1. `task()` 与 `eval` 子命令，加自检：组合两个 task、一个内层失败、一个草稿被拒绝。
2. stdout 去掉大小切换，删除 `output.json`，加 `run/<task>` 历史与保留 20 份的清理。
3. `doctor --json`，加自检。
4. 更新 SKILL.md：第 2 节命令表增加 `yodo eval`，第 3 节增加 `failedTask`，第 5 节增加组合规则，`doctor --json` 替换 `doctor` 的用法。
5. 更新 install.md 中的 doctor 验收（如有需要）。
6. 本机重新安装，验证 `eval` 与 `doctor --json`。

## 7. 验收

- `npm run check`、`npm test`、`npm run verify:pack` 全部通过。
- `yodo eval` 能组合两个只读 task（如 `apple-ipad-prices` 与 `bilibili-dynamic-list`）并返回正确 JSON。
- 草稿 task 被 `eval` 拒绝，错误信息可读。
- `run/<task>/` 历史在 21 次运行后只保留 20 份。
- `doctor --json` 可以被 JSON 解析，失败项有 `fix`。
