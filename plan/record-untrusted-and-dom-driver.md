# 录制不限定可信事件，dev 驱动直接操作 DOM

产品决策（用户定）：录制器不再只录 `isTrusted` 的事件；dev 驱动不再通过 CDP `Input.*` 模拟输入，直接操作 DOM。

## 原因

- 只录可信事件，会漏掉页面脚本、框架内部触发的操作，以及 dev 驱动本身的操作，导致录制与真实使用不一致。
- dev 驱动用 `Input.*` 时，很多操作依赖坐标、焦点和隐藏元素的可见性，每一步都容易因为元素被挡住、不在视口而失败（批量测试中已经遇到多次），这些问题与"学习是否正确"无关。

## 第 1 步：紧急修复（已完成）

- `record/inject.js`：删除 click、input、change 三处 `if (!e.isTrusted) return;`。scroll 监听本来就没有这个判断。
- 验证：`collect.selfcheck.ts` 通过；在真实页面里用 `el.click()` 和 `dispatchEvent(new Event('input'))` 制造的不可信事件，录制得到 `value=untrusted` 和 `click`。
- 尚未做：录制侧的噪声评估（见风险），以及驱动改写。

## 决定（用户定）：完全移除 isTrusted 与 Input.*

- **概念上**：yodo 的体系中不再有"可信事件"的概念。代码、注释、文档、夹具描述、测试断言都不再提 trusted、可信、isTrusted。
- **实现上**：任何模块都不再调用 `Input.*`（包括 dev 驱动、task-lib、录制、自检）。页面操作一律通过页面内的 DOM 操作完成。
- 仍然允许的 CDP 调用：`Runtime.evaluate` / `callFunctionOn`（执行页面脚本）、`Page.navigate`（导航）、`Page.handleJavaScriptDialog`（处理对话框）、`Accessibility.*` 与 `DOM.*`（只读的定位与查询）。

### 需要移除的位置（已用全仓库搜索核对）

代码（必须改）：

| 位置 | 处理 |
|---|---|
| `skills/yodo/src/dev/driver.ts` | 整个驱动改写为 DOM 操作，删除 `Input.*` 与文件头里关于 isTrusted 的注释 |
| `skills/yodo/src/record/inject.js` 第 2 行注释 | "监听可信的 click、input、change" 改为不提可信 |
| `skills/yodo/src/templates/task-lib/dom.js` 第 4 行注释 | "events from these helpers are untrusted" 改为描述实际行为（合成事件、无坐标），不提 trusted |
| `skills/yodo/src/task-lib.selfcheck.ts` 第 68 行 | 删除"不用可信输入"断言，改由下面的全仓库静态检查覆盖 |
| `skills/yodo/src/record/collect.selfcheck.ts` 第 264 行注释 | 改注释 |

数据与文档（必须改）：

| 位置 | 处理 |
|---|---|
| `skills/yodo/src/record/fixtures/dom-events.json` 的 `description` | 改描述；数据本身不改 |
| `AGENTS.md` 第 63 行（驱动用 `Input.*`） | 改为 DOM 驱动 |
| `AGENTS.md` 第 195 行（"可信的鼠标、键盘输入"） | 改描述 |
| `AGENTS.md` 2.3 dev 说明 | 删除"录制器只认 isTrusted"类表述，写明驱动只做 DOM 操作 |

历史计划（不改内容，文件开头加一行"已被 plan/record-untrusted-and-dom-driver.md 取代"）：

- `plan/dev-tools.md` 第 22 行（驱动只用 `Input.*`，录制器有 isTrusted）
- `plan/yodo-simplification-refactor.md` 第 11、15、91、282 行（可信输入相关决定）
- `plan/record-dom.md` 第 21 行（验证方式中的"可信的鼠标键盘输入"）

不改：`skills/yodo/src/chrome-extension/background.js` 第 15 行的"可信"指的是 storage 里 id 是否可信，和事件无关。

### 防回潮的自检（新增）

- 在 `npm test` 里加一个全仓库的静态检查：扫描 `skills/yodo/src`（排除 node_modules 和 fixtures 数据），断言不出现 `isTrusted`、`Input.dispatch`、`Input.insert`；不出现"可信"两个字（`background.js` 的 storage 注释加白名单）。以后不会悄悄带回来。

### 驱动改写的具体约束（替代下面第 2 步中相关的说法）

- `click`：`scrollIntoView` 后 `element.click()`。
- `type`：原生 setter 赋值，派发 `input`，结束时派发 `change`。不发键盘事件。
- `press`：在焦点元素上派发 `keydown`、`keyup`；`Enter` 在输入框所在表单上调用 `requestSubmit()`（合成键盘事件不会触发浏览器默认提交）。
- `scroll`：`scrollBy`。
- 对话框：驱动监听 `Page.javascriptDialogOpening`，用 `Page.handleJavaScriptDialog` 处理，避免 evaluate 挂起。

## 第 2 步：dev 驱动改为直接操作 DOM

`skills/yodo/src/dev/driver.ts` 的 `DevPage` 保持同样的方法名，内部改为 `Runtime.evaluate` 执行页面脚本：

- `click(selector)`：`element.click()`，先 `scrollIntoView`（这一步会产生一条可见的 scroll 录制，属于正常的人类行为，可以接受）。
- `type(selector, text)`：聚焦后逐字符更新值，派发 `input`，结束时派发 `change`（不再用键盘事件）。
- `press(key)`：
  - 在当前焦点元素上派发 `keydown`、`keyup`，让页面自己的键盘处理函数生效；
  - `Enter` 特殊处理：若焦点在表单输入框里且没有被页面拦截，调用所在表单的 `requestSubmit()`（合成的键盘事件不会触发浏览器的默认提交，这一点已在搜索场景里验证过：不处理则搜索不提交）。
- `scroll(deltaY)`：对滚动容器（默认页面）调用 `scrollBy`，然后等待录制器去抖（250ms）。
- `goto(url)`：保持现有的 `Page.navigate`（只读，不影响录制）。

约束调整：
- 删除"不用 `scrollIntoView`"的规则。
- 删除"只用 `Input.*`"的规则。
- 保留"不调用 `*.disable`"和"不越出 yodo 的页面"。

## 风险与待验证

1. **噪声**：页面脚本自己的 scroll、focus、input、click 也会被当作用户操作录下来。这是产品决策接受的代价，但需要量化：
   - 在几个真实站点上统计"非用户操作"产生的动作数量（比如打开页面后不做任何操作时，录制里有多少 action）。
   - 如果噪声很大，再考虑过滤，但过滤规则要基于可观察的信号，不要重新引入 `isTrusted`。
2. **阻塞式对话框**：`el.click()` 触发 `confirm` 时，页面 JS 同步阻塞，驱动的 `Runtime.evaluate` 会挂起。驱动要在调用前后用 `Page.handleJavaScriptDialog` 处理，或者在驱动内部对 `confirm/alert` 做可控的替换（只限 dev 驱动，不进产品代码）。
3. **框架感知的输入**：React 等框架对 `value` 的赋值需要原生 setter，驱动要沿用 task-lib 里 `fill` 的做法（`Object.getOwnPropertyDescriptor(...).set.call`）。
4. **测试的代表性下降**：直接操作 DOM 不再检验"可信输入下的页面行为"，批量测试要明确这一点：它验证的是录制与学习的流水线，不是站点对真人输入的反应。

## 第 3 步：文档与测试

- AGENTS.md 2.3 的 dev 说明：删除"录制器只认 isTrusted"和"输入全部走 Input.*"的表述，改为新规则。
- `driver.ts` 文件头注释同步更新。
- 录制：`collect.selfcheck.ts` 增加一条不可信事件的用例（已有 fixture 来自可信输入，仍然有效；新增的用例用合成事件）。
- 驱动：新增自检，用一个本地页面覆盖 click、type、press Enter 提交表单、scroll。

## 第 4 步：恢复批量端到端测试

批量测试的规则保持不变：
- 只用录制材料学习；学习这一步由 agent 自己判断，不做自动转换。
- 判断正确的标准：新 task 与现有的 verified task 在相同参数下结果逐项一致。
- 每个站点：探测页面结构（只读）→ 录制演示 → 停止 → 写 draft task → 运行并对比 → 通过后改为 verified。
- 已完成：`apple-ipad-prices`（一致，4 条）。已知的不足：学习时读过现有 task 的代码，独立性打了折扣，之后不再读实现，只读头部注释。
- 进行中：IT之家搜索（驱动的 Enter 问题已经定位，在改写驱动时一并解决）。
- 待做：其余第三方站点（B 站 2 个、抖音 2 个、X 2 个、知乎 1 个、淘宝、小米、Google 1 个、腾讯文档 1 个、IT之家文章评论）。

## 验收

- `npm run check`、`npm test`、`npm run verify:pack` 通过。
- 不可信事件（页面脚本制造的点击、输入）在录制中出现。
- 驱动的四个操作（click、type、press Enter 提交、scroll）在真实站点上可用。
- 批量测试每个站点都有明确的结论：通过（结果一致）、失败（原因是录制、学习还是运行）。
