# AGENTS

## 开发安装

改 `src/`、`skills/`、`templates/` 或 init 后执行：

```bash
npm run dev:install
```

它 build 后执行本地 `yodo init --local`。开发时不要用线上 `@latest`。

---

## 一、全局铁律与目录契约

### 1. 四条不可逾越的红线 (Zero-tolerance Redlines)
1. **No Record, No Code（未录制严禁盲写）**：查无可用 `task/*.js` 且无法组合现有代码时，**必须且只能要求用户演示**（`yodo record start`），严禁在录制前自己写脚本探接口（盲猜 probe）。
2. **No DOM Manipulation（严禁任何 DOM 操作）**：严禁使用选择器进行点击（click）、填充（fill）、键盘输入等 DOM/UI 操作。自动化执行必须通过 `page.evaluate()` 触发原生网络请求。
3. **Probe Budget = 5（5 次试跑预算硬上限）**：单接口在 `tmp/` 下的试跑修改上限为 5 次。遇到风控/签名问题若 5 次仍无法跑通，**必须立即停止死磕并向用户输出不可重放报告**。
4. **Verified-Only in Task（`task/` 必须且只能是已验证脚本）**：严禁直接在 `task/` 下新建或修改脚本。组合现有任务或编写新脚本必须在 `tmp/` 下演练；**只有试跑成功（status: success）后，才允许 `mv` 晋级到 `task/`**。

### 2. 目录规范与流转 (`~/.yodo/`)
```text
~/.yodo/
├── task/          # [生产库] 100% 已验证跑通的单文件 ESM（含 _common/ 辅助模块，只读/仅通过 mv 晋级）
├── tmp/           # [演练场] Agent 编写新脚本、组合多 task 的试跑起草地（唯一自由编写区）
├── record/        # [录制归档] 录制生成的 timeline.jsonl 与扁平抓包 JSON（只读分析）
└── session/       # [系统内部] sock / pid / log.jsonl（连接失败与排错）
```
- 新写与组合一律在 `tmp/` 演练。
- `yodo run` 验证成功后，补齐 JSDoc，执行 `mv ~/.yodo/tmp/<probe>.js ~/.yodo/task/<name>.js`。
- 删除 task 或 record 前必须得到用户同意。禁止 `rm -rf ~/.yodo`，禁止删除 `record/.active/`。

---

## 二、任务生命周期操作流 (Lifecycle)

```text
查找现有能力 (Glob/Grep/Read ~/.yodo/task/) ──[匹配]──> 运行 (yodo run)
                     │
                  [可组合]
                     ↓
        在 tmp/ 演练组合 ──[验证成功]──> mv 晋级 task/ ──> 运行 (yodo run)
                     │
                  [无能力]
                     ↓
             录制 (yodo record start) ──> 用户演示 ──> 好了 ──> record stop
                     ↓
        学习 (读抓包，tmp/ 试跑 <= 5 次) ──[验证成功]──> mv 晋级 task/ ──> 运行 (yodo run)
                     │
                 [5 次失败]
                     ↓
             输出结构化诊断报告，优雅退出
```

1. **Find & Compose（查找与组合）**：
   - 用 `Glob` 扫描 `~/.yodo/task/*.js`，用 `Grep`/`Read` 查阅 JSDoc。
   - 匹配则直接跑 `yodo run`；可组合则在 `tmp/` 新建脚本提取组合（严禁修改原 task）；无能力进入 `record`。
2. **Record（录制）**：
   - 执行 `yodo record start [name] [--goal="..."]` 打开专属录制新窗口。
   - 用户演示完毕回「好了」➔ 执行 `yodo record stop`。
3. **Learn（学习与 5 步试跑预算）**：
   - 读 `timeline.jsonl` 定位接口，读 `<seq>_<METHOD>_*.json` 获取结构。
   - 在 `~/.yodo/tmp/<probe>.js` 编写脚本试跑，按顺序最多排查 5 次：
     - **Attempt 1**: 基线页内 `fetch`。
     - **Attempt 2**: 改用页内 `XMLHttpRequest`（借用站点 SDK monkey-patch 自动计算 `a_bogus` / `bdms` 签名）。
     - **Attempt 3**: 排查 `window` 全局签名对象（如 `byted_acrawler`, `secsdk`）。
     - **Attempt 4**: 对齐 `frameUrl` 上下文与页面就绪时机。
     - **Attempt 5**: Cookie / Header 完整性最终校验。
     - **> 5 次**: 判定不可重放，向用户输出结构化报告优雅退出。
   - 验证通过后补全 JSDoc，执行 `mv` 移入 `task/<name>.js`。
4. **Run（运行）**：
   - 执行 `yodo run <file> [--args='<json>' | --args-file=<path>] [--timeout=<15-60>]`（亦兼容 `--filename=<path>`）。
   - 脚本必须导出 `export default async ({ browser, browserContext, args }) => { ... }`。
   - 原生 `fetch`/`XHR` 在 `page.evaluate` 中执行；`pageForOrigin` 用于复用/开页面。
   - 数据量 <= 8KB stdout 直出，> 8KB 自动落盘 `output.json`。
   - `--timeout` 只防 runaway（死循环、holder 占死），默认 15 秒、上限 60。页内请求大约 15s 没返回就减小数据量，不要为了大查询加超时。
5. **无 CDP / 连接中断**：
   - 读 stdout `status`（`need-install` / `need-chrome` / `need-remote-debugging` / `need-allow`）。
   - 将 `guide` 文案原样告知用户，停；用户回「好了」再继续重试。严禁轮询。
   - handshake 失败时 holder 已退。「好了」后再跑是新 connect。
   - 失败先看这次 stdout JSON；不够再 Grep `~/.yodo/session/log.jsonl`。holder 占死时杀 `~/.yodo/session/pid`（断 CDP，不杀 Chrome）。没有 abort 子命令。

---

## 三、底层录制与过滤规范

- **网络 Capture**：录制期间 **不要** browser 级 `Target.setAutoAttach`。只 `attachToTarget` 录制窗里的 page；popup 靠该 page session 上 related `setAutoAttach`（`waitForDebuggerOnStart: false`，`filter: [{ type: "page" }]`）。sibling 新 tab 用 `Target.setDiscoverTargets` 通知后再按 `windowId` 决定是否 attach。别人窗零 CDP。`chrome://` / `devtools://` 不 attach。idle holder 只留 CDP WebSocket，`autoAttach: false`，`discover: false`。`yodo run` 按 origin 只挂一个 page，不全量 attach。
- **收尾**：`stop` / `abort` / 5 分钟到 / 断线会关 discover、detach 自己挂过的 page、关录制窗。漏掉的第一发 document 可补 `late` 的当前 `outerHTML`；学接口不依赖它。`shutdown` 在断 WS 前走同一套 idle 收尾。
- **成功过滤**：仅保留 2xx 成功请求；不保留 301/302 中间跳转；不设 `navigateTimeWindowMs` / `eventTimeWindowAfterMs`。
- **timeline**：行不写 `frameUrl`。`mainDoc` 是页面上下文锚点；sidecar / Raw 仍带 `frameUrl`，供 `pageForOrigin`。
- **Adblock 过滤**：`@ghostery/adblocker` 过滤第三方无关打点，`document` 始终保留。
- **去重**：`document` 不去重；同 site 第一方 xhr/fetch 全留；第三方同 `method+bareUrl` 只留最后一次。
- **脱敏**：敏感字段与密码必须在落盘前统一脱敏为稳定 alias。
