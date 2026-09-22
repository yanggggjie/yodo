# 更新 yodo

## 1. Agent 更新指南

### 1.1 完成更新

`~/.yodo` 已存在时，按以下步骤更新：

1. 确认没有正在运行的 `task` 或 `recording`。
2. 阅读“版本记录”，检查现有 `~/.yodo`。
3. 修改重要数据前先备份。
4. 安装新版本并运行 `setup.js`。
5. 根据最新版 `SKILL.md` 和 Runtime 更新不兼容的数据。
6. 逐个验证受影响的 `task`，再运行 `doctor`。
7. 确认 `~/.yodo` 符合最新版要求。
8. 向用户简要报告新增功能、迁移内容和最终状态。

首次安装不执行历史迁移。更新时不机械复现旧版本的安装步骤；检查现有数据，完成所有仍适用的迁移即可。

### 1.2 保护用户数据

| 路径 | 默认处理 |
|---|---|
| `~/.yodo/task` | 重要数据，保留；受影响时先备份，再迁移并逐个验证。 |
| `~/.yodo/record` | 保留原数据，不修改或迁移历史 `record`。 |
| `~/.yodo/temp` | 不重要，不迁移，也不保证兼容。 |
| `~/.yodo/src` | 可重建，由新版本覆盖。 |
| `~/.yodo/session` | 可重建，停止旧 holder 后清理并重新建立。 |

## 2. 版本记录

版本按新到旧排列。每个版本只描述相对上一个发布版本的变化，并保留“用户可见变化”和“用户数据变化”两部分。“用户可见变化”只写用户能感知的功能和体验，不写 API、内部架构或实现方式。

### 2.1 待发布

**用户可见变化**

- 已学会的网站操作运行更稳定，并能覆盖更多页面交互。
- 页面操作可以更准确地取得查询结果，并确认提交是否成功。

**用户数据变化**

| 路径 | 本次变化 | Agent 操作 |
|---|---|---|
| `~/.yodo/task` | Task API 不兼容旧写法 | 先备份，再逐个迁移并验证；未迁移的 task 不能继续使用。 |
| `~/.yodo/record` | 无 | 保留，不修改。 |
| `~/.yodo/temp` | 不保证兼容 | 不处理。 |
| `~/.yodo/src` | Runtime 更新 | 由 setup 覆盖。 |
| `~/.yodo/session` | Runtime 状态更新 | 由 setup 停止旧 holder 后重建。 |

迁移 `~/.yodo/task` 前备份：

```bash
cp -R ~/.yodo/task ~/.yodo/task.backup
```

逐个检查并修正 `~/.yodo/task/*.js`：

- 导入路径改为 `../task/lib/index.js`。
- `yodo.run(async ({ browserContext }) => ...)` 改为 `yodo.run(async ({ page }) => ...)`。
- 删除 `browserContext.newPage()`。
- `page.goto`、`page.evaluate`、`page.dom.*` 改用 `lib` 中的 `goto`、`evaluate`、`click`、`fill`、`press`、`scroll`、`check`、`select`、`waitForSelector`。
- 原生 CDP 使用 `page.cdp.send/on/once`；只有 page scope 不足时才使用 `_cdp`。
- `yodo.run` 不再接收 `args`，task 直接读取 `process.argv`。

迁移并验证所有 task 后再完成更新。

### 2.2 v1.0.0

首次发布。

**用户可见变化**

- 支持通过一次用户演示学习需要登录态的网站操作，并在后续任务中复用。
- 支持组合运行多个已学会的网站操作。

**用户数据变化**

| 路径 | 本次变化 | Agent 操作 |
|---|---|---|
| `~/.yodo/task` | 首次创建 | 无需迁移。 |
| `~/.yodo/record` | 首次创建 | 无需迁移。 |
| `~/.yodo/temp` | 首次创建 | 无需迁移。 |
| `~/.yodo/src` | 首次创建 | 由 setup 部署。 |
| `~/.yodo/session` | 首次创建 | 由 setup 创建。 |
