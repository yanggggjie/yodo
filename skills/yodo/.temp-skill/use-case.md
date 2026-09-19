# use case

## 运行已有能力
目标：使用 `capability` 完成用户指定的 `user goal`
操作：
- 把 `user goal` 拆成独立 `task`
- 从 `~/.yodo/task` 匹配 `capability` 并按顺序运行 `task`
- 读取每个 `task` 的 `result` 并传给下一项
可观察结果：所有 `task` 输出 `status: success`，用户收到 `user goal` 的最终结果

## 修改已有能力
目标：在流程范围不变、但现有 `capability` 不能直接完成时，安全更新对应 `task`
操作：
- 保留原 `capability`，复制到 `~/.yodo/temp` 作为 `candidate`
- 优先依据代码、错误和已有来源 `record` 做最小修改；依据不足时进行新 `recording`
- 按当前 `implementation` 验证，必要时在 2 次 `network attempt` 后改用 `DOM implementation`
- 只有 `candidate` 输出 `status: success` 后才替换原 `capability`
可观察结果：原 `capability` 在新版本验证成功前保持不变；成功后由已验证的新版本替换，并产生当前 `user goal` 所需的 `result`

## 从 `network material` 学习新能力
目标：为没有匹配 `capability` 的部分生成使用 `network implementation` 的 `task`
操作：
- 让用户一次演示所有缺失操作
- 只读 network timeline 和关联 request 文件
- 编写同一份 `candidate`，并使用正式参数最多运行 2 次
- 每次修改只依据 `record` 中的 `network material`
可观察结果：`candidate` 在 2 次以内输出 `status: success` 并移入 `~/.yodo/task`

## 从 `DOM material` 学习新能力
目标：`candidate` 连续产生 2 次 `network attempt` 后，把同一个 `task` 改用 `DOM implementation`
操作：
- 只在当前 `task` 已有 2 次 `network attempt` 后读取 `DOM/DOMTimeline.jsonl`
- 根据同一个 `record` 的 DOM event 和当前页面 DOM 改写同一份 `candidate`
- 运行并修正使用 `DOM implementation` 的 `candidate`
可观察结果：`candidate` 输出 `status: success` 并移入 `~/.yodo/task`

## 报告当前无法学习
目标：在 `record material` 无法支持稳定实现时及时停止
操作：
- 确认 network 已运行 2 次且失败
- 检查 `DOM material` 与当前页面是否还能提供明确依据
- 没有依据时停止，不重新录制、不自行探索网站
可观察结果：用户收到当前无法学会的明确说明，`candidate` 不进入 `~/.yodo/task`

## 查询已有能力
目标：告诉用户 yodo 当前有哪些 `capability`
操作：
- 只读 `~/.yodo/task` 中的说明和固定常量
- 不读取 `temp`，不运行 `task`，不开始 `recording`
可观察结果：用户看到 `capability` 列表，`candidate` 不会被列出
