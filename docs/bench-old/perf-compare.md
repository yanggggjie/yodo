# yodo vs browser-use vs agent-browser

同一个跨站任务，三条路径各跑一次，比墙钟耗时与美元花费。

| | 链接 |
|--|--|
| **yodo** | 本仓库 |
| **browser-use** | [browser-use/browser-use](https://github.com/browser-use/browser-use) |
| **agent-browser** | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |

原始 `/cost`、prompt、trace 在 [`results/`](./results/)。

---

## 结论

三家都完成了任务（知乎想法 + 即刻动态已发布，摘要后缀为对应工具名）。

**执行阶段**（手册已就绪、不再学习）：

| | 成功 | 时间（wall） | 费用（USD） |
|--|--|--|--|
| **yodo** | 是 | **2m 51s** | **$0.88** |
| agent-browser | 是 | 4m 19s | $1.17 |
| browser-use | 是 | 8m 15s | $1.26 |

相对 yodo：agent-browser 约 **1.5×** 时间 / **1.3×** 费用；browser-use 约 **2.9×** 时间 / **1.4×** 费用。

yodo 另有一次**学习**（人做一遍 → 写手册 → 顺带跑完同一任务）：5m 45s / $1.41。这是一次性成本；主表只比执行。

---

## 为什么会有差异

browser-use 与 agent-browser 都靠 UI 推进：看页面 → 点/填 → 页面变了 → 再看。步数一多，「看—点」循环就转得多，每一轮都要把页面状态重新喂给模型。

yodo 拆成两段：

1. **学习**：人在本机 Chrome 里按清单做一遍；从录到的流量里写出站点手册（`website-handbook`）。
2. **执行**：读手册，`open` + 页内 `fetch`（带登录态），不再走点击路径。

所以执行成本大致是「读手册 + 有限几次接口调用」，不随 UI 步数线性涨。代价是学习阶段的一次性投入。

| | browser-use | agent-browser | yodo（执行） |
|--|--|--|--|
| 感知 | 页面交互元素（可含截图） | accessibility snapshot + `@eN` | 薄手册 + 接口 JSON |
| 行动 | 框架内 click / type / navigate | 外层模型调 CLI | `open` + `eval`（`credentials: "include"`） |
| 循环 | 框架多轮 | 外层多轮；页面一变就要重新 snapshot | 基本不靠 UI 多轮 |

**适用边界**：本对比只对「有稳定接口」的站点公平。强依赖视觉、要过验证码、或已有成熟 MCP 的站点，不作为主证据。

---

## 任务

前置：X、知乎、即刻均已在本机 Chrome 登录。

```txt
使用 [yodo / browser-use / agent-browser]

1. 打开 X 关注流，取最近 3 条，总结成一段中文摘要，后缀带 from-[工具名]
2. 用这段摘要发一条知乎想法
3. 用这段摘要发一条即刻新动态
```

成功判定：知乎想法与即刻动态都能确认已发布，且摘要后缀为对应工具名。

yodo 执行场额外约束：`本次仅执行不用优化手册`，且不得再跑 `segment`。

---

## 方法

| 项 | 设定 |
|--|--|
| 环境 | Claude Code |
| 模型 | `claude-opus-5[1m]`（session 里偶发极少量 haiku，见 `/cost`） |
| 次数 | 每家 / 每阶段 1 次 |
| 计量 | 任务结束后同一 session 内 `/cost` |

规则：不用 MCP、不用站点官方 API key；每家从新 session（或 `/clear`）开始，只跑这一任务。

指标直接取自 `/cost`：

- **时间** ← `Total duration (wall)`
- **费用** ← `Total cost`

---

## 结果明细

### 执行（主对比）

| | 成功 | wall | cost | 原始文件 |
|--|--|--|--|--|
| yodo | 是 | 2m 51s | $0.88 | [`results/yodo/run/`](./results/yodo/run/) |
| agent-browser | 是 | 4m 19s | $1.17 | [`results/agent-browser/`](./results/agent-browser/) |
| browser-use | 是 | 8m 15s | $1.26 | [`results/browser-use/`](./results/browser-use/) |

备注（不影响成功判定）：

- **yodo**：知乎 pin 返回「待审核·仅自己可见」，接口已成功创建。
- **agent-browser**：默认测试版 Chrome 不便登录；改用独立 profile 的标准版 Chrome + CDP。知乎「发想法」按钮文案会变成「发布」。
- **browser-use**：即刻第一次输入因 Python 引号转义编译失败（未产生半截草稿），修正后重发。

### yodo 学习（一次性，不进主表）

| | 成功 | wall | cost | 原始文件 |
|--|--|--|--|--|
| yodo learn | 是（任务完成 + 三站手册落盘） | 5m 45s | $1.41 | [`results/yodo/learn/`](./results/yodo/learn/) |

学习 session 含：请人做一遍、`segment`、写 `website-handbook`，并在学完后直接跑完原任务。

---

## 附录：`/cost` 原文

### yodo（执行）

```text
Total cost:            $0.88
Total duration (API):  2m 20s
Total duration (wall): 2m 51s
Usage by model:
    claude-haiku-4-5:  389 input, 33 output, 0 cache read, 0 cache write ($0.0006)
   claude-opus-5[1m]:  50 input, 6.2k output, 1.1m cache read, 27.5k cache write ($0.88)
```

### agent-browser

```text
Total cost:            $1.17
Total duration (API):  3m 18s
Total duration (wall): 4m 19s
Usage by model:
    claude-haiku-4-5:  436 input, 29 output, 0 cache read, 0 cache write ($0.0006)
   claude-opus-5[1m]:  60 input, 9.4k output, 1.5m cache read, 31.7k cache write ($1.17)
```

### browser-use

```text
Total cost:            $1.26
Total duration (API):  4m 14s
Total duration (wall): 8m 15s
Usage by model:
    claude-haiku-4-5:  378 input, 28 output, 0 cache read, 0 cache write ($0.0005)
   claude-opus-5[1m]:  72 input, 11.6k output, 1.6m cache read, 29.7k cache write ($1.26)
```

### yodo（学习，参考）

```text
Total cost:            $1.41
Total duration (API):  4m 47s
Total duration (wall): 5m 45s
Usage by model:
    claude-haiku-4-5:  376 input, 31 output, 0 cache read, 0 cache write ($0.0005)
   claude-opus-5[1m]:  60 input, 16.4k output, 1.5m cache read, 39.6k cache write ($1.41)
```
