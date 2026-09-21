# 更新 yodo

本版本重做了 task API，不提供旧 API 兼容层。更新前必须处理 `~/.yodo` 中的用户数据。

| 数据 | 更新处理 |
|---|---|
| `~/.yodo/task` | 重要。先备份，再由 agent 逐个迁移现有 `*.js`；未迁移 task 不能继续使用。安装只刷新 `lib/` 和 package 元数据，不自动改写 capability。 |
| `~/.yodo/record` | 保留原数据，不修改、不迁移。 |
| `~/.yodo/temp` | 不重要，不保证兼容，也不要求迁移。 |
| `~/.yodo/src` | 由 setup 直接覆盖为新版本。 |
| `~/.yodo/session` | setup 停止旧 holder并删除整个目录；socket、pid、log 等运行状态由新版本重新建立。 |

## task 迁移

更新前备份：

```bash
cp -R ~/.yodo/task ~/.yodo/task.backup
```

让 agent 检查并修正每个 `~/.yodo/task/*.js`。主要变化：

- 导入路径改为 `../task/lib/index.js`。
- `yodo.run(async ({ browserContext }) => ...)` 改为 `yodo.run(async ({ page }) => ...)`。
- 删除 `browserContext.newPage()`。
- `page.goto`、`page.evaluate`、`page.dom.*` 改用 `lib` 中的 `goto`、`evaluate`、`click`、`fill`、`press`、`scroll`、`check`、`select`、`waitForSelector`。
- 原生 CDP 使用 `page.cdp.send/on/once`；只有 page scope 不足时才使用 `_cdp`。
- `yodo.run` 不再接收 `args`，task 直接读取 `process.argv`。

迁移并验证所有 task 后再完成更新。`record` 不需要改动。
