---
name: yodo
description: >-
  yodo：真实网站任务。record → 读抓包 → run。
  触发：yodo、好了。
---

用 `yodo` 操作用户本机 Chrome（复用已登录态）。需要浏览器的命令会自行连接。
对人动作的继续前提：**只认用户回「好了」**（Chrome 打开、remote-debugging 开关、会话弹窗允许、演示结束等）。

## 一、全局铁律与目录契约

### 1. 四条不可逾越的红线 (Zero-tolerance Redlines)
1. **No Record, No Code（未录制严禁盲写）**：查无可用 task 且无法组合现有代码时，**必须且只能要求用户演示**（`yodo record start`），严禁在录制前自己写脚本探接口（盲猜 probe）。
2. **No DOM Manipulation（严禁任何 DOM 操作）**：严禁使用选择器进行点击（click）、填充（fill）、键盘输入等 DOM/UI 操作。自动化执行必须通过 `page.evaluate()` 触发原生网络请求。
3. **Probe Budget = 5（5 次试跑预算硬上限）**：单接口在 `tmp/` 下的试跑修改上限为 5 次。遇到风控/签名问题若 5 次仍无法跑通，**必须立即停止死磕并向用户输出不可重放报告**。
4. **Verified-Only in Task（`task/` 必须且只能是已验证脚本）**：严禁直接在 `task/` 下新建或修改脚本。组合现有任务或编写新脚本必须在 `tmp/` 下演练；**只有试跑成功（status: success）后，才允许 `mv` 晋级到 `task/`**。

### 2. 数据目录与权限 (`~/.yodo/`)
```text
~/.yodo/
├── task/          # [生产库] 100% 已验证跑通的单文件 ESM（含 _common/ 辅助模块，只读/仅通过 mv 晋级）
├── tmp/           # [演练场] Agent 编写新脚本、组合多 task 的试跑起草地（唯一自由编写区）
├── record/        # [录制归档] 录制生成的 timeline.jsonl 与扁平抓包 JSON（只读分析）
└── session/       # [系统内部] sock / pid / log.jsonl（连接失败与排错）
```
- **权限与流转**：
  - 新写或组合一律在 `tmp/`。
  - `yodo run` 验证成功后，补齐 JSDoc，执行 `mv ~/.yodo/tmp/<probe>.js ~/.yodo/task/<name>.js`。
  - 严禁未经用户同意删除 `task/` 或 `record/`。

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

### 1. 查找与组合 (Find & Compose)
1. 用 `Glob` 扫描 `~/.yodo/task/*.js`。
2. 用 `Grep` 或 `Read` 检索 task 的标准 JSDoc（功能与入参）。
3. **匹配**：直接执行 `yodo run ~/.yodo/task/<name>.js`。
4. **组合**：严禁修改原 task；在 `tmp/` 下新建脚本提取逻辑，验证成功后 `mv` 晋级为新 task。
5. **无能力**：进入录制阶段。

### 2. 录制 (Record)
1. 执行 `yodo record start [name] [--goal="..."]` 打开专属录制新窗口（空白后再导航；捕获该窗口全部 tab 及 popup 的 document/xhr/fetch 与 click/submit/scroll 手势）。用户已有的窗不录。偶发缺第一发 HTML 不影响学接口。
2. 用户在新窗口演示完毕回「好了」➔ 执行 `yodo record stop`。stop / abort / 超过 5 分钟会关掉这扇录制窗（不关用户的窗）。超过 5 分钟按 `stop` 归档。
3. 产物落盘至 `~/.yodo/record/<name>/`：
   - `timeline.jsonl`：按时序记录的事件概览（不含 `frameUrl`）。
   - `<seq>_<METHOD>_<host>_<path>.json`：sidecar，含 `frameUrl`、headers、body、`status`。

### 3. 学习与演练 (Learn & 5-Probe Budget)
1. 读 `timeline.jsonl` 定位业务接口，打开对应 `<seq>_<METHOD>_*.json` 获取结构（忽略无关打点）。
2. 在 `~/.yodo/tmp/<probe>.js` 编写脚本，严格遵循 5 步试跑预算排查：
   - **Attempt 1（基线页内 fetch）**：`page.evaluate(fetch, url, options)`，按抓包结构重放。
   - **Attempt 2（改用页内 XHR）**：若报 403 / 缺签名，改用 `page.evaluate` + `new XMLHttpRequest()`（利用站点 monkey-patch 自动计算 `a_bogus` / `bdms` 等签名）。
   - **Attempt 3（排查全局 SDK）**：检查 `window` 上的全局对象（`byted_acrawler`, `secsdk`, `bdms` 等）是否有主动签名方法。
   - **Attempt 4（对齐上下文与时机）**：检查 page URL 是否与 `frameUrl` 严格一致，是否需等待页面 SDK 加载。
   - **Attempt 5（最终校验）**：调整 Cookie / Header 完整性做最后验证。
   - **> 5 次**：判定不可重放，立即停止死磕，输出不可重放报告。
3. 验证成功后，补齐 JSDoc，执行 `mv ~/.yodo/tmp/<probe>.js ~/.yodo/task/<name>.js`。

### 4. 执行与 I/O 契约 (Run)
Task 脚本标准模版：
```javascript
/**
 * @summary 任务简要描述
 * @param {object} api
 * @param {import('...').CdpBrowser} api.browser
 * @param {import('...').CdpContext} api.browserContext
 * @param {object} [api.args] - 运行时显式入参
 */
export default async ({ browser, browserContext, args }) => {
  // 通过 pageForOrigin 获取目标页面，在 evaluate 中发起原生 fetch / XHR
  // 返回结构化数据或结果
};
```
- **输入**：必须显式传参 `--args='{"key":"value"}'` 或 `--args-file=path/to/input.json`。
- **超时**：`--timeout=<15-60>` 只防 runaway，默认 15 秒。页内请求大约 15s 没返回就减小数据量（分页、缩短时间范围、少要字段），不要为了大查询加超时。
- **输出**：
  - 执行结果默认以 JSON 格式输出至 stdout。
  - 数据量 <= 8KB 时，直出在 `result` 字段。
  - 数据量 > 8KB 时，自动落盘至 `output.json`，stdout 返回 `resultFile` 文件路径。
  - `status: success` 后，对人必须给出可以检验结果的 URL。

---

## 三、深度排查与速查附录 (Appendix)

### 1. CDP 握手异常分层指引
无 CDP 连接时，读取 stdout `status`，将对应 `guide` 原样告知用户并停住，等用户回「好了」再继续（不要混用文案，不要轮询）。handshake 失败时 holder 已退，「好了」后再跑是新 connect。
- `need-install`：请安装 Google Chrome。好了告诉我。
- `need-chrome`：请打开 Google Chrome。好了告诉我。
- `need-remote-debugging`：请打开这个 Chrome 实例的 remote-debugging 开关。好了告诉我。
- `need-allow`：请在 Chrome 弹出的「允许远程调试」窗口中点击允许。好了告诉我。

### 2. 页内 SDK 借用排查原理
- **为什么页内 XHR 会自动签名，Node fetch 不会**：现代站点通常 monkey-patch 改写了 `XMLHttpRequest.prototype.open/send`，在出网前注入计算 `a_bogus` / `X-Bogus` / `bd-ticket-guard` 等字段。外部 HTTP 请求不会执行页面脚本，因此写接口必挂。
- **排查要点**：查 window 全局变量（过滤 `acrawler|secsdk|bogus|bdms|mssdk|frontier|ticket|guard`）；优先走页内 XHR 借用 SDK，比手写逆向算法更稳定。

### 3. 优雅退出报告模版
当 5 次试跑未通或遇到滑动验证码/人脸验证等硬风控时，输出结构化报告优雅退出：
```markdown
### 判定：该接口无法通过请求重放（Replay）自动化

- **目标接口**：`POST https://.../api/endpoint`
- **受阻原因**：接口受客户端安全 SDK（如 `byted_acrawler` / `bdms`）保护，尝试了页内 fetch 及 XHR 自动签名，但仍触发 403 / 签名校验失败。
- **尝试记录**：已完成 5 次页内调用探索（基线 fetch → 页内 XHR → 签名对象排查 → 上下文对齐 → 最终校验），均无法绕过风控。
- **结论**：本任务无法沉淀为纯请求 task，请在浏览器中手动操作或调整需求。
```

### 4. CLI 命令速查表
```text
yodo init [--local]
yodo record start [name] [--goal="..."]
yodo record stop
yodo record abort
yodo run <file> [--args='<json>' | --args-file=<path>] [--timeout=<15-60>]
```

失败先看这次命令的 stdout JSON；不够再 Grep `~/.yodo/session/log.jsonl`。holder 占死或同步死循环时，杀 `~/.yodo/session/pid`（会断 CDP，不杀 Chrome）。没有 abort 子命令。
