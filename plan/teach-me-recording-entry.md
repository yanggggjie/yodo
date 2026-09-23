# “我教你” recording 入口计划

## 1. 目标

用户明确使用“我教你”表达教学意图时，yodo 直接开始一次 `recording`，不先拆分 `user goal`，也不搜索或匹配 `capability`。

用户完成演示并说明要学习的具体操作后，再回到现有流程：拆分 `task`、匹配 `capability`，并只对未匹配的 `task` 使用本次 `record`。

示例：

```text
用户：yodo 我教你用苹果官网
yodo：直接开始 recording
用户：好了，学习查看 iPad 价格
yodo：停止 recording，将“查看 iPad 价格”作为 user goal，进入现有学习流程
```

## 2. 触发条件

只在用户明确表达自己要教 yodo 时触发，例如：

- `yodo 我教你用苹果官网`
- `yodo 我来教你怎么查看订单`

以下情况不触发：

- `yodo 教我怎么查看订单`
- 普通请求中偶然出现“教”字
- 用户只是询问 yodo 如何学习

“我教你”之后的网站、产品或范围只用于生成 `recording` label 和向用户复述演示范围，不作为 `task`。

## 3. 开始 recording

触发后：

1. 不拆分 `user goal`。
2. 不读取、搜索或匹配 `~/.yodo/task/*.js`。
3. 不读取 `~/.yodo/temp`。
4. 从用户给出的范围生成简短 label；无法确定时使用通用 label。
5. 运行 `record-start.js`。
6. 请用户只在标题为 `yodo record` 的窗口中完整演示。
7. 提示用户完成后回复：`好了，学习<具体操作>`；取消时回复“取消”。

此时不要求给出缺失操作清单，因为具体 `task` 尚未确定。

## 4. 结束 recording

### 4.1 用户同时说明具体操作

用户回复 `好了，学习<具体操作>` 或其它等价表达时：

1. 运行 `record-stop.js`。
2. 使用用户在“好了”之后给出的具体操作作为新的 `user goal`。
3. 按现有规则拆分 `task`。
4. 此时才搜索和匹配 `capability`。
5. 已有 `capability` 能直接完成的 `task` 继续复用，不重复学习。
6. 未匹配的 `task` 使用刚停止的 `record`，按现有 network、DOM 和验证规则学习。

### 4.2 用户只回复“好了”

1. 运行 `record-stop.js` 并保留返回的 record name。
2. 请用户说明要从本次演示中学习的具体操作。
3. 收到具体操作前，不读取 `record material`，不创建 `candidate`。
4. 用户随后说明具体操作时，按 4.1 的第 2 步继续。

第一版只支持在当前 conversation 中继续使用最近一次尚未处理的 `record`，不增加跨 conversation 状态文件，也不管理多个待处理 `record`。

### 4.3 用户取消

用户回复“取消”时运行 `record-abort.js`，不创建 `task` 或 `candidate`。

## 5. 与现有流程的关系

普通 yodo 请求完全保持现状：

```text
拆分 user goal
→ 匹配 capability
→ 缺少 capability 时 recording
→ 学习并验证
```

“我教你”只增加一个优先入口：

```text
明确的“我教你”
→ 直接 recording
→ 用户说明具体操作
→ 回到拆分 user goal
→ 匹配 capability
→ 未匹配 task 使用本次 record
```

它不表示强制覆盖已有 `capability`。具体 `task` 明确后，如果已有 `capability` 能直接完成，仍按现有规则复用。

## 6. 修改范围

只修改 `skills/yodo/SKILL.md`：

1. 在总体流程图增加“我教你”优先分支，并在同一张图中保留 network、DOM fallback 和保存 `capability` 的学习路径。
2. 在“拆分与匹配”中说明，该入口在取得具体操作前不拆分 `task`、不匹配 `capability`。
3. 在 Recording 一节加入开始、结束、只回复“好了”和取消的处理规则。
4. 在用户侧提示中加入推荐回复格式：`好了，学习<具体操作>`。

不修改：

- Runtime 和 command；
- `record` 目录与文件格式；
- network learning；
- DOM learning；
- `candidate` 验证；
- `capability` 存储与修改规则；
- 副作用保护。

## 7. 检查用例

1. `yodo 我教你用苹果官网`
   - 直接运行 `record-start.js`。
   - 不搜索 `~/.yodo/task`。
2. `好了，学习查看 iPad 价格`
   - 先停止 recording。
   - 将“查看 iPad 价格”作为 `user goal`。
   - 再匹配 `capability`。
3. 用户只回复“好了”
   - 停止 recording。
   - 等待具体操作，不读取材料。
4. 用户回复“取消”
   - abort recording，不学习。
5. `yodo 教我查看 iPad 价格`
   - 不触发教学入口，走普通流程。
6. 具体操作已有匹配 `capability`
   - 使用已有 `capability`，不因本次 recording 重复创建。

## 8. 完成条件

- “我教你”可以在没有具体 `task` 时直接开始 recording。
- 开始 recording 前不会读取或匹配 `capability`。
- recording 结束并取得具体操作后，能无缝回到现有学习流程。
- 普通 yodo 请求行为不变。
- 不新增 Runtime 状态、command 或持久化文件。
