# 发布流程与更新指南

## 1. 目标

统一 yodo 的安装、更新和发布流程：

- 在线安装、本地安装和更新执行同一份 `install.md`，唯一差异是 skill 来源。
- `skills/yodo/update.md` 同时提供 agent 更新指南和完整版本记录。
- 每个版本只记录相对上一个版本的变化。
- agent 更新时检查相关版本的变化，最终让现有 `~/.yodo` 符合最新版要求。
- 开发可以发生在任意 branch；准备发布时创建 release branch，根据它与 `main` 的实际 diff 编写发布内容。
- 只有用户明确要求“发布到 main”后，才将 release branch squash 为一个 commit 并合入 `main`。
- README 在“安装与更新”章节中链接 `update.md`。

## 2. `update.md`

### 2.1 Agent 更新指南

文件开头保留稳定的更新规则：

1. `~/.yodo` 不存在时按首次安装处理，不执行历史迁移。
2. `~/.yodo` 已存在时，检查现有数据和 `update.md` 中相关版本的变化。
3. 在修改重要数据前创建备份。
4. 安装新版本并运行 `setup.js`。
5. 根据最新版 `SKILL.md`、Runtime 和版本记录更新用户已有数据。
6. 验证受影响的 `task`，再运行 `doctor`。
7. 最终确认 `~/.yodo` 符合最新版要求。
8. 向用户简要报告新增功能、迁移内容和最终状态。

agent 不需要机械复现旧版本的安装流程。版本记录用于说明每次变化；实际更新以当前 `~/.yodo` 状态和最新版要求为准，补齐所有仍适用的迁移。

### 2.2 用户数据总则

| 路径 | 默认处理 |
|---|---|
| `~/.yodo/task` | 重要数据，保留；受影响时先备份，再迁移并逐个验证。 |
| `~/.yodo/record` | 保留原数据，不修改或迁移历史 `record`。 |
| `~/.yodo/temp` | 不重要，不迁移，也不保证兼容。 |
| `~/.yodo/src` | 可重建，由新版本覆盖。 |
| `~/.yodo/session` | 可重建，停止旧 holder 后清理并重新建立。 |

每个版本仍需单独说明这些路径在该版本中是否受影响，不能只依赖总则。

### 2.3 版本记录

所有版本放在同一份 `update.md` 后部，按新版本在前的顺序持续保留。开发中的变化放在顶部“待发布”；创建 release branch 时将其改为正式版本号，发布后继续开发时再新增“待发布”。

每个版本只描述从上一个版本升级到该版本的变化，包含两部分：

1. **用户可见变化**：只说明用户能感知的功能、优化和行为变化，不写 API、内部架构或实现方式。
2. **用户数据变化**：用表格说明 `~/.yodo` 各路径相对上一版本的变化和 agent 操作。

推荐格式：

```markdown
## 2. 版本记录

### 2.1 待发布

...

### 2.2 v1.1.0

从 `v1.0.0` 更新到 `v1.1.0`。

**用户可见变化**

- 简要说明功能或体验变化。

**用户数据变化**

| 路径 | 本次变化 | Agent 操作 |
|---|---|---|
| `~/.yodo/task` | Task API 有变化 | 备份，按最新版 skill 修改并逐个验证。 |
| `~/.yodo/record` | 无 | 保留，不修改。 |
| `~/.yodo/temp` | 不保证兼容 | 不处理。 |
| `~/.yodo/src` | Runtime 更新 | 由 setup 覆盖。 |
| `~/.yodo/session` | Runtime 状态更新 | 由 setup 重建。 |
```

确有迁移操作时，在该版本内补充必要命令和步骤。没有迁移时不重复安装流程。

### 2.4 跨版本更新

用户可能跨过多个版本更新。agent 应：

1. 检查当前 `~/.yodo` 的实际状态。
2. 阅读可能相关的版本记录。
3. 汇总仍适用于当前数据的迁移要求。
4. 跳过已经满足最新版要求的项目。
5. 完成剩余迁移并逐项验证。

最终标准只有一个：现有 `~/.yodo` 符合最新版 skill 和 Runtime 的要求。无需新增安装版本状态文件。

## 3. 安装与更新

### 3.1 统一入口

在线安装和更新继续使用同一个 prompt；本地开发从 repository 中读取同一份 `install.md`。两者只有 skill 来源不同：

- 在线使用 GitHub 默认分支 `main`。
- 本地使用当前 repository。

后续都由 `install.md` 判断：

1. `~/.yodo` 不存在时，按首次安装处理。
2. `~/.yodo` 已存在时，先读取 `update.md`。
3. 根据更新指南和历史版本检查、备份受影响的数据。
4. 安装 skill 并运行 `setup.js`。
5. 根据最新版要求迁移用户已有数据。
6. 验证受影响的 `task`，再运行 `doctor`。
7. 向用户简单报告本次更新和数据处理结果。

`install.md` 负责固定执行流程；`update.md` 负责说明版本变化和数据处理要求。

`npm run dev:install` 只同步本地 skill，不直接运行 repository 中的 `setup.js`。同步后必须从实际安装目录继续执行 setup、迁移和验收。

如果某项迁移必须在 setup 覆盖 Runtime 前完成，对应版本记录必须明确写出顺序。

## 4. Release branch

### 4.1 “发布分支”

用户明确要求“发布分支”时：

1. 确认工作区状态和当前 branch。
2. 创建 `release/vX.Y.Z` branch；版本号不明确时先询问用户。
3. 使用 `git diff main...HEAD` 审计待发布代码相对 `main` 的完整变化。
4. 根据实际 diff 更新版本号和 lockfile。
5. 将 `skills/yodo/update.md` 版本记录顶部的“待发布”改为本次版本号：
   - 只描述相对当前 `main` 发布版本的变化；
   - 写用户可见变化；
   - 写 `~/.yodo` 数据变化表；
   - 写必要迁移步骤。
6. 检查文件开头的 agent 更新指南是否仍能覆盖本次更新。
7. 检查 `install.md` 能否按 `update.md` 完成更新。
8. 运行完整检查。
9. 将 release 准备内容提交并 push 到 release branch。
10. 等待用户审核，不修改 `main`。

版本内容只记录 `main...HEAD` 中实际存在的变化，不写尚未实现的计划。

### 4.2 “发布到 main”

只有用户明确要求“发布到 main”时：

1. 确认 release branch 已通过审核，工作区干净且测试通过。
2. 拉取最新 `main`，确认 release diff 仍然准确；有新增差异时重新完成发布审计。
3. 将 release branch 相对 `main` 的全部提交 squash 为一个 release commit。
4. 将该 commit 合入 `main` 并 push。
5. 用户要求或发布规则需要时，创建并 push `vX.Y.Z` tag。
6. 报告版本号、commit、测试结果和主要更新内容。

不得在“发布分支”阶段提前 merge 或 push `main`。

## 5. README 入口

在 README 的“安装与更新”章节末尾、“使用”章节之前增加：

```markdown
### 查看更新

查看 [更新指南与历史版本](skills/yodo/update.md)。
```

现有“安装与更新”章节继续保留 `install.md` 的使用 prompt。

## 6. 仓库规则

更新 `AGENTS.md`：

- 将“发布前更新审计”扩展为 release branch 流程。
- 统一使用默认分支名 `main`。
- 定义“发布分支”和“发布到 main”的行为边界。
- 规定新版本记录必须根据 `git diff main...HEAD` 编写。
- 规定 `update.md` 的 agent 更新指南保持稳定，版本记录按新到旧保留全部版本。
- 规定每个版本只描述相对上一个发布版本的变化。
- 规定每个版本都包含用户可见变化和 `~/.yodo` 数据变化表；用户可见变化不写 API、内部架构或实现方式。
- 规定未收到“发布到 main”时不得修改或 push `main`。

## 7. 验证

至少检查：

1. 首次安装不会执行历史迁移。
2. 更新时 `install.md` 会先要求读取 `update.md`。
3. agent 能根据现有数据和版本记录将 `~/.yodo` 更新到最新版要求。
4. `~/.yodo/task` 和 `~/.yodo/record` 不会被 setup 删除。
5. 最新版本记录只描述 `main...HEAD` 相对上一发布版本的变化。
6. 每个版本都有用户可见变化和 `~/.yodo` 数据变化表。
7. README 能链接到 `skills/yodo/update.md`。
8. 根 package、Runtime package、lockfile 和发布版本一致。

完成后运行：

```bash
npm run check
npm test
npm run verify:pack
```

## 8. 实施顺序

1. 重构 `skills/yodo/update.md`，加入稳定的 agent 更新指南和历史版本结构。
2. 修改 `skills/yodo/install.md`，统一在线与本地安装流程，并在更新时读取 `update.md`。
3. 修改 `AGENTS.md`，加入 release branch、版本记录和 squash merge 规则。
4. 修改 README，在“安装与更新”章节中链接 `update.md`。
5. 增加文档链接、数据保留和版本一致性检查。
6. 运行完整检查。

## 9. 完成条件

- `update.md` 同时包含稳定的 agent 更新指南和按新到旧排列的完整版本记录。
- 每个版本只描述相对上一个发布版本的变化。
- agent 不依赖安装版本状态文件，最终将现有 `~/.yodo` 更新到最新版要求。
- 在线与本地安装遵循同一流程，唯一差异是 skill 来源。
- release branch 的版本记录只来自 `main...HEAD` 的实际 diff。
- “发布分支”不会修改 `main`；“发布到 main”会 squash 为一个 commit 后合入并 push。
- README 在“安装与更新”章节中链接 `skills/yodo/update.md`。
- 更新不会删除已有 `task` 和 `record`。
