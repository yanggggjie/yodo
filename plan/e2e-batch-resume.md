# 端到端批量测试：恢复说明

本文件记录暂停时的状态，方便下次恢复。测试规则、结果和问题见 [e2e-batch-issues.md](e2e-batch-issues.md)。测试只记录问题，不修复。

## 测试规则（用户定）

- 测试对象：现有的第三方站点 task，不含 iwiki、lite、gongfeng 等内网站点，也不含腾讯文档（用户明确跳过）。
- 允许有副作用（点赞、搜索等），使用用户已登录的账号。
- 每个站点：探测页面结构（只读）→ dev 驱动录制演示（DOM 操作，不用 `Input.*`，不用 `isTrusted`）→ 停止录制 → 只依据录制材料学习写 draft task → 与现有 verified task 同参数结果对比 → 记录问题。
- 学习这一步由 agent 自己判断，不做自动转换。

## 已完成

| 站点 | 结果 |
|---|---|
| 苹果中国 iPad 价格 | 与现有 task 一致（学习时读过现有代码，独立性打折） |
| IT 之家搜索 | 与现有 task 一致（修正一次） |
| IT 之家评论 | 与现有 task 一致（修正一次） |
| X 搜索 | 前 3 条推文 ID 一致 |
| X 正在关注 | 不一致（交集 0，原因未定位） |
| B 站动态列表 | 部分一致（3 条中 2 条正文一致，1 条正文缺失） |
| 小米台湾手机 | 学习版通过，现有 task 已失效（恒返回空数组） |
| 知乎搜索（只读） | 学习版通过，但与现有 task 不可比 |

## 未完成

- **淘宝搜索**：阻塞。录制中途触发风控（验证码相关请求），商品列表没有加载。需要人工处理验证码后重录，或接受该站点在自动化下不可测。
- **Google AI 搜索**：未开始（现有 task 有三份，`google-ai-search` 与 `-llmrender`、`-from-temp` 重复）。
- **抖音搜索点赞**（两个 task）：未开始，有副作用。
- **B 站动态点赞**（`bilibili-dynamic-like`）：未开始，有副作用。
- **知乎搜索点赞分支**：只测了只读部分，点赞分支未测。

## 恢复时的第一步

1. 确认 daemon 与安装是最新的：`npm run dev:install`，再到 `~/.agents/skills/yodo` 下运行 `node setup.js`。
2. dev 开关目前是开着的（`~/.yodo/session/dev` 存在）。测试结束后用 `rm ~/.yodo/session/dev` 关掉。
3. 淘宝需要先确认登录状态，并处理风控。
4. 录制前先在 `e2e-batch/` 下用 `probe.mjs` 探测页面；录制用 `record-run.mjs <录制名> <场景.mjs>`。

## 文件位置

- 测试脚本（已复制进仓库）：`plan/e2e-batch/`（`record-run.mjs`、`human.mjs`、`probe*.mjs`、`scenarios/*.mjs`）。
- 学习出的 draft task：`~/.yodo/task/e2e-*.js`（8 个）。它们是测试产物，不属于产品。测试结束后需要决定保留还是删除。
- 录制记录：`~/.yodo/record/` 下有本批测试产生的录制（约 22 个，含探测残留已删）。原有 21 个录制已备份在 `~/.yodo/record-backup-20261014/`，未删除。
- 结果与问题：`plan/e2e-batch-issues.md`。

## 未提交的改动

本批改动还没有提交，`git status` 约 15 个文件，主要是：

- 驱动重写（`dev/driver.ts`，全部 DOM 操作）。
- 移除 `isTrusted` 与 `Input.*`（`record/inject.js`、`templates/task-lib/dom.js`、`task-lib.selfcheck.ts`、`collect.selfcheck.ts`、AGENTS.md、夹具描述）。
- 静态检查 `guard.selfcheck.mjs`。
- 录制时长 `RECORD_MAX_MS` 改为 10 分钟。
- 计划文件：`plan/record-untrusted-and-dom-driver.md`、`plan/e2e-batch-issues.md`、`plan/e2e-batch-resume.md`、`plan/e2e-batch/`。

## 已发现、待决定的事

- 产品决策待定：现有 task 的失效（小米）要不要修，还是只记录。
- 定位库的空白规范化（X 的 "Following "）、`expectRequest` 返回类型的不一致（C3、C4）。
- 驱动的首页搜索提交无效（T2）。
- 知乎的对照标准（Z1）需要统一输出字段。
