# 统一概念

只保留「磁盘上有、CLI 里有、stdout 里有」的词。不新造阶段名。

不做兼容：不留旧 flag、双格式、双字段、先停教再删。这一版长什么样，CLI 就只收什么；多出来的直接失败。旧 skill 跟不上就再 `init`。磁盘上已有的抓包不迁、不双读。

「查找能力」不是独立对象，就是扫 `~/.yodo/task/*.js`。改称查找 task。

用户要做的事不给产品名词，也不叫 `task`。对人说「这件事」。

---

## 保留

| 词 | 是什么 | 不是什么 |
|---|---|---|
| `task` | `~/.yodo/task/*.js`，`yodo run` 成功过才允许放进来的脚本 | 用户口头说的「帮我做件事」；不要单独译成「任务」 |
| `tmp` | 未验证脚本，唯一能随便写的地方 | 「演练场」 |
| `record` | `yodo record start/stop/abort` + `~/.yodo/record/` 抓包 | 「录音」；和「学习」不是两件事 |
| `run` | `yodo run <file>`，task 和 tmp 都走它 | 生命周期阶段名 |
| `init` | 建目录、装 skill | 业务流程的一步 |
| `status` | stdout 的机器状态（字符串枚举） | sidecar 里的 HTTP 数字（那个也叫 `status`，是 HTTP 自己的词） |
| `guide` | 转述给人、等人回「好了」。只在要等人时出现 | Agent 下一步 |
| 「好了」 | 人做完后的唯一继续口令 | 状态值 |

对人：这件事、Chrome、`guide` 原文、「好了」。

对 Agent：`task`、`tmp`、`record`、`run`、`status`、`guide`、最多 5 次、`mv`。

---

## 删除

| 删 | 改写成 |
|---|---|
| 查找能力 / 无能力 / 能力资产 | 查找 task / 没有可跑的 task / `task/` |
| 生产库、演练场、录制归档、会话管理 | 旁注只写：已验证脚本 / 未验证脚本 / 抓包 / CDP 连接的 pid·sock·log |
| Find & Compose、Learn、Probe Budget（作专名）、晋级、演练 | 查 `task/` → 没有就 `record` → 读抓包 → 在 `tmp/` 里 `run`（最多 5 次）→ 通了 `mv` 到 `task/` |
| `probe` 当名词 | 文件就是 tmp 脚本；次数就说「最多 5 次」；没抓包不要先写脚本 |
| `website-handbook`、`segment`、旧「学习 session」 | 不当权威；bench 另改 |
| skill 主流程里的 `holder`、`handshake`、`connect` | Agent 读 `status` + `guide`。占死了杀 `~/.yodo/session/pid`。实现只留 `AGENTS.md` |
| `yodo-browser-skill` | 源只留 `skills/yodo/SKILL.md`。`init` 卸掉旧包，不留双 skill |
| `phase` | 删。Agent 知道自己刚跑了哪条命令 |
| `hint` | 删字段。下一步写在 skill |
| `--goal` | 删参数、删 RPC、删 `ActiveRecordStore.goal`。标注靠 `[name]` |
| `--filename` | 删。只有 `yodo run <file>` |
| stdout 的 `script` / `timelineFile` / `requestsCount` | 删。路径调用方自己有；抓包看 `recordDir` |
| `interrupted` | 并进 `aborted`（断线且没写成抓包 = 没有可用目录） |
| task JSDoc / skill 里的 `api.browser`、`CdpBrowser` | 脚本只用 `browserContext` + `pageForOrigin` |
| skill 里的 CDP `document` | timeline：`mainDoc` \| `doc` \| `fetch` \| `xhr` |
| README 的 `audit.log` | 代码不再写 |
| package.json / skill 简介里的 capabilities、「真实网站任务」 | 简介改白话，不要用 task / 任务指用户那件事 |
| `page.goto` 的 `waitUntil` | 删参数。不按 Playwright 语义实现 |
| `RequestKind` 的 `"other"` | 从不产生，删 |
| `HARD_PROBE_MS` 这个名字 | 改内部名。与「最多 5 次」无关 |

「可组合」留一句：「现有 task 拼得起来，就在 `tmp/` 写新脚本，不要改原文件。」不成节点。

---

## stdout 的 `status`

这一套枚举，只出现在 CLI stdout。不要第四套阶段名。

| 来源 | 值 | 含义 |
|---|---|---|
| 连不上 Chrome | `need-install` / `need-chrome` / `need-remote-debugging` / `need-allow` | 有 `guide`，等人 |
| record | `recording` | 有 `guide`，等人 |
| record | `stopped` | 有 `recordDir`，去读 |
| record | `aborted` / `idle` | 没有可用抓包 |
| run | `success` | `result` 或 `resultFile`。tmp 且要留下 → `mv` 到 `task/` |
| run | `failure` | 脚本**已经执行**并抛错。不到 5 次就改 tmp 再 `run` |

脚本没启动（找不到文件、坏 JSON、`run` 与 `record` 互斥、未知参数）：JSON `{ "error": "…" }`，**没有** `status`。不要标 `failure`，免得算进 5 次。

Agent：有 `status` 按上表；只有 `error` 就停，不要当试跑失败。

有 `guide` ⟺ 原样念出，停，等「好了」。原文只来自 `HANDSHAKE_GUIDES` 和 `record start` 那一句。skill 不复述各条 `need-*`。

`record stop` / `abort` 时没在录：一律 `{"status":"idle"}`。不要 `record: idle` 纯文本。其它失败也不要 `error: …` 纯文本。

---

## 不要合并

| 甲 | 乙 | 为什么分开 |
|---|---|---|
| `--args` | `--args-file` | 同一份 `args` 的两种喂法 |
| `--timeout` | record 5 分钟 | 一个防 `run` 死循环，一个是 record 上限 |
| `url` | `frameUrl` | 请求打到哪 vs 从哪个页面发出 |
| sidecar 的 `bareUrl` + `query` | timeline 行上的 `url` 字符串 | 行上已是 `bareUrl`；query 在编号 json |
| timeline `type` | `requestType` / `actionType` | 先问是不是请求，再问哪种 |
| `stop` / `abort` / `idle` | | 归档 / 扔掉 / 当时没在录 |
| `result` / `resultFile` | | 同一份返回值，大小分流 |
| record 的 `name` | action 的 `name` | 碰巧同字段。看 `type` |
| stdout 的 `status` | sidecar 的 `status` | 枚举 vs HTTP 码。sidecar 键不改，因为那就是 HTTP 的词 |
| `~/.yodo/session/` | CDP `sessionId` | 对外只说杀 `pid`、看 `log.jsonl` |

`RequestKind`、`YodoUrl`、`CdpPage`、`holder`、`timeoutMs` 留 `src/` / `AGENTS.md`。

手势继续采集，不当产品词。skill 主流程找 `type: "request"`。

---

## 对外最小面

**CLI**（只收这些；多一个 flag 就失败）

```text
yodo init [--local]
yodo record start [name]
yodo record stop
yodo record abort
yodo run <file> [--args=… | --args-file=…] [--timeout=15-60]
```

`init --local` 只写进 `AGENTS.md`。

**task 脚本**

```javascript
export default async ({ browserContext, args }) => {
  const page = await pageForOrigin(browserContext, origin);
  return page.evaluate(async () => { /* fetch / XHR */ });
}
```

查找靠文件名 + `@summary` + `@param api.args.*`。`args` 可缺省。教 `import` `_common/page-for-origin.js`。`goto` 没有 `waitUntil`。

**录制产物**

```text
recordDir/
  timeline.jsonl                 # t, type, requestType|actionType, method, url, file
  01_GET_host_path.json          # method, url{bareUrl,query}, frameUrl, headers, body, HTTP status
  01_GET_host_path.response.html # 大 HTML 时才有
```

`late` 的 `mainDoc` 是页面快照：不写 `method: GET`，不写 HTTP `status`。附录：有 `late` 不当请求 replay。

**stdout**

| `status` | 字段 |
|---|---|
| `need-*` / `recording` | `guide` |
| `stopped` | `recordDir`（`name` 可有） |
| `success` | `result` 或 `resultFile` |
| `failure` | `error` |
| `idle` / `aborted` | 可有 `name` |
| （无 `status`） | `error`：命令没跑起来 |

红线跟目录对齐，不另起英文品牌名：

- 没有可用 task、又拼不出来，就 `record`；没抓包不要先写脚本
- 不要 DOM 点击 / 填充；`page.evaluate` 里发请求
- 同一接口在 `tmp/` 里最多改 5 次再 `run`
- 没出现 `status: success` 的脚本不准进 `task/`

`mv` 就是 `mv`。`run` 没有 abort；卡住了杀 `~/.yodo/session/pid`。

---

## 实现里一并改掉

- RPC：删 `phase` / `goal` / `filename`（改成和 CLI 一样的 `file` 即可）。`SessionResponse.status` 按 stdout 那套枚举写，不要只标 handshake
- holder `ok` 仍表示「这条 op 跑完了」；业务结果只看 stdout 的 `status`
- `late` 不装成 HTTP 200
- `pageForOrigin` 找不到就打开。注释写清
- `LaunchPlan` 拆开：等人的 `need-*` vs 内部的 launch / connect
- ping 的 `pid` / `pages` / `chrome` / `record` 不进 stdout
- `_common/url.js` 注释改为 `src/utils/url.ts`

---

## 统一落点

| 文本 | 只写 |
|---|---|
| CLI stdout | 上表那些字段 |
| `skills/yodo/SKILL.md` | 查 task → record → tmp → run → `mv`；读 `status`；念 `guide`；最多 5 次 |
| `AGENTS.md` | holder、CDP attach、过滤；流程指向 skill |
| README | 安装 + 上面那些命令 + 目录；流程图同一套词 |

```text
查 task/ ──有──> yodo run
      └──没有──> yodo record → 读抓包 → tmp/ 里 yodo run
                    └──通了──> mv 到 task/ → yodo run
                    └──5 次未通──> 停，写原因
```

---

## 改哪些文件

1. **CLI / stdout**
   - `src/protocol.ts`：删 `phase`、`goal`；`filename` → `file`（及 selfcheck）
   - `src/record/write.ts`：删 `hint`、`timelineFile`、`requestsCount`；`idle` 只有 JSON
   - `src/record/index.ts`：删 `goal`；`interrupted` → `aborted`
   - `src/record/collect.ts`：`late` 不写假 HTTP 字段
   - `src/record/types.ts`：删 `"other"`
   - `src/exec/index.ts`：删 `hint`、`script`
   - `src/cli/index.ts`：全部失败走 JSON；help 与最小面一致；未知 flag 失败
   - `src/cli/run-input.ts`：删 `--filename`
   - `src/holder.ts`：RPC 跟 protocol
   - `src/browser/session.ts`：`goto` 去掉 `waitUntil`
   - `src/browser/connect.ts`：拆 `LaunchPlan`
   - `src/utils/constants.ts`：短超时改名
2. **skill**：`skills/yodo/SKILL.md`。模板只有 `browserContext` + `args`。附录：sidecar `status` 是 HTTP；`late` 不当请求。简介不用「任务」指这件事
3. **`AGENTS.md`**：只留实现
4. **README**：流程图、目录；删 `audit.log`、`--goal`、`--filename`
5. **package.json**：description 去掉 capabilities
6. **templates/task-common/url.js**：注释路径
7. **bench**：旧「学习」另议

`~/.claude/skills/yodo/SKILL.md` 不手改，`npm run dev:install` 覆盖。
