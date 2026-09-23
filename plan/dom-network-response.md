# DOM 触发后读取 Network response

## 目标

细化 `DOM implementation`：DOM 操作负责触发页面行为；如果该操作会产生已知 request，则优先从本次 response 取得 `result` 并判断是否成功。

本 plan 只修改 `DOM implementation` 的学习和验证规则。

## 原则

进入 DOM 阶段后，同时使用两类材料：

- `DOM material`：确定页面入口、selector 和操作顺序。
- `network material`：确定目标 request、成功 response 和需要返回的字段。

如果 response 能完整表达结果，就不再额外解析结果 DOM。例如搜索可以通过 DOM 提交关键词，再从搜索 response 返回结构化结果。

如果没有稳定 response，或者 task 目标本身是页面状态，则继续读取 DOM。高风险或异步操作在 response 之外仍需查询最终业务状态。

recording 中保存的 response 只用于编写 candidate；只有 candidate 本次运行捕获的 response 才能作为本次结果。

## DOM candidate 流程

1. 从 `DOM material` 确定如何操作页面。
2. 从 `network material` 确定该操作对应的 request 和 response 特征。
3. 在 DOM 操作前监听 Network event。
4. 执行 DOM 操作。
5. 匹配本次参数对应的 request，并通过 `requestId` 等待 response 完成。
6. 读取 response body，验证业务字段并返回结构化 `result`。
7. response 不足以确认最终结果时，再读取 DOM 或查询业务状态。

`Network.requestWillBeSent`、HTTP 2xx、navigation、toast 或 click 未报错均不能单独作为成功依据。

## 修改范围

### `skills/yodo/SKILL.md`

- 明确 DOM 阶段可以继续使用当前 task 的 `network material`。
- 明确 DOM 操作用于触发，response 可以用于取得 `result` 和验证成功。
- 明确 recording response 不能代替本次运行。
- 将操作后的业务状态查询改为按需执行，不再要求所有 DOM candidate 都查询。
- 增加一个搜索示例和一个提交示例。

### Runtime

先使用现有 `page.cdp.send()` 和 `page.cdp.on()`，不新增公共 helper。

实现时检查 recording 是否已经保留生成 candidate 所需的 request、response 和 DOM event 关联信息。只有确认缺少必要字段时才修改 recorder。

## 验证

保留最小 runnable checks：

1. listener 在 DOM 操作前注册，不丢失立即发出的 request。
2. 能从同时发生的 request 中匹配本次参数对应的目标 request。
3. 能通过同一个 `requestId` 取得 response body。
4. timeout、`loadingFailed` 和业务失败 response 返回 failure。
5. success 和 failure 后都会清理 listener。
6. 没有合适 response 的 DOM task 仍可读取 DOM。

完成后运行：

```bash
npm run check
npm test
npm run verify:pack
```

## 实施顺序

1. 更新 `skills/yodo/SKILL.md`。
2. 增加搜索和提交示例。
3. 检查 recording material 是否够用。
4. 补最小 self-check。
5. 用一个查询型 task 和一个提交型 task 验证完整流程。

## 完成条件

- DOM candidate 能复用 `network material` 匹配本次 request。
- 查询型 task 能从本次 response 返回结构化 `result`。
- 提交型 task 能用本次 response 判断成功，必要时再查询最终状态。
- 没有稳定 response 的 task 不受影响。
- 没有增加新的 `implementation` 或未经验证的公共 helper。
