# `capability`

## `task` 管理

运行和查询都以 `~/.yodo/task` 中的 `capability` 为准，共用相同的拆分、`capability` 匹配、参数传递和 `result` 规则。

覆盖：运行已有能力、修改已有能力、查询已有能力

## 一次录制学习

`network implementation` 与 `DOM implementation` 共享同一次用户演示、同一组未匹配 `task` 和同一个 `candidate` 文件，但使用彼此隔离的 `record material` 和失败处理规则。

覆盖：从 network 材料学习新能力、从 DOM 材料学习新能力

## 受材料约束的停止

两种 `implementation` 都只能从 `record material` 开始；当允许使用的 material 无法提供下一步依据时，需要停止并准确报告，不能通过重新 `recording` 或自行探索扩大范围。

覆盖：报告当前无法学习
