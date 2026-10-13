# 死代码清理计划

## 检查方法与结果

| 工具 | 范围 | 结果 |
|---|---|---|
| `tsc --noUnusedLocals --noUnusedParameters`（用 `npx -p typescript@^5.8.3`，沿用 `npm run check` 的版本） | `skills/yodo/src` 全部 `.ts`，含 selfcheck | 0 个错误。用一个带未使用变量的探针文件确认过这两个选项会报错，不是命令没生效 |
| 同上，加 `--allowJs --checkJs` | `background.js`、`task-lib/*.js`、`setup.js` | 0 个未使用声明 |
| Knip（临时配置，不进仓库，不写入 `package.json`） | entry：`cli/yodo.ts`、`holder.ts`、`relay.ts`、`sdk.ts`、`task-lib/index.js`、`background.js`、全部 selfcheck、`setup.js` | 见下 |

结论：没有未使用的局部变量和参数；真正的死代码很少，主要是几处孤立的文件、常量和过度导出。

## A. 确认是死代码，建议删除

| # | 位置 | 依据 | 处理 |
|---|---|---|---|
| A1 | `src/store/index.ts`（2 行 barrel） | Knip 标为未使用文件；全仓库 0 处 import | 删除文件 |
| A2 | `protocol.ts` 的 `RPC_ERRORS.FORBIDDEN_CDP`、`RPC_ERRORS.QUEUE_OVERFLOW` | 全仓库只出现在定义处 | 从常量里删除这两项 |
| A3 | `browser/index.ts` 对 `requireActiveLink`、`PROTOCOL_VERSION` 的 re-export | Knip 标为未使用；调用方都直接从 `extension.ts` import | 删除这两项 re-export，保留 `extension.ts` 里的定义 |
| A4 | `run-report.ts:3` 注释「从旧 exec/index.ts 迁来」 | 引用已不存在的旧结构 | 删除这句注释 |
| A5 | `src/templates/task-package.json`（内容 `{"type":"module"}`） | 全仓库 0 处引用；`layout.ts` 只同步 `templates/task-lib` | 先验证，再删除（见验证项 V1） |

## B. 过度导出（可选，价值低）

Knip 标为「未使用导出」，但在自己的文件里仍被使用，所以不是死代码，只是 `export` 多余。去掉 `export` 可以缩小公开面，但不会减少代码行数，优先级低，可以不做。

- `cli/compose.ts`：`runCompose`、`composeSource`
- `cli/session.ts`：`missingStatus`
- `native-messaging-host/install.ts`：`NATIVE_HOST_NAME`、`DEPLOYED_SRC`
- `record/collect.ts`：`GESTURE_CORRELATION_WINDOW_MS`、`GESTURE_INJECT_SOURCE`
- `record/pipeline.ts`：`sanitizeEvent`、`filterSuccessOnly`、`filterAdblock`
- `record/write.ts`：`sanitizeFileNamePart`、`semanticRequestBaseName`、`cleanRequestJson`、`writeSemanticRequestFile`
- `run-report.ts`：`formatStack`
- `utils/fs.ts`：`ensureDir`
- `record/types.ts`：类型 `YodoUrl`、`TimelineRequestType`、`DomEventType`、`TimelineActionType`、`DomElement`

处理方式：不单独改。以后碰到这些文件时顺手去掉 `export`。

## C. Knip 的误报，不要动

| 报告 | 实际情况 |
|---|---|
| 未使用文件 `cli/shim.ts` | 被 `skills/yodo/setup.js` import（setup.js 在 `src/` 之外，Knip 配置没覆盖到） |
| 未使用导出 `EXTENSION_DIR`、`installNativeHost` | 同上，被 `setup.js` 使用 |
| 无法解析的 import `templates/task-lib/index.*` 里的 `../../src/sdk.ts` | 路径按部署后的目录结构（`~/.yodo/task/lib` → `~/.yodo/src/sdk.ts`）写的，源码目录里解析不到是正常的 |
| 未列出的二进制 `pgrep`、`tasklist`、`reg`、`read` | 系统命令，不是依赖 |
| 配置提示 `@types/node`、`devtools-protocol` 可以移出 ignoreDependencies | 只是临时配置的问题，与项目无关 |

## D. 工具没覆盖，需要人工判断

- `plan/` 里的文档：`yodo-simplification-refactor.md` 中关于 holder 生命周期和窗口恢复的部分已被 `native-host-relay-daemon.md` 取代；`compose-and-output.md` 中的决定已经实现。这些是文档，不是代码，是否合并或标注「已完成」由你决定。我没有逐条核对。
- `bench/`（含 `charts.py`、结果文件）：与运行时无关，我没有检查它是否还在使用。

## 验证项

- V1：在一个全新的临时 HOME 里运行 `setup.js`，不依赖 `~/.yodo/task/package.json`，写一个只含 `import` 的最小 task 并运行。通过则删除 A5。依据：Node 24 默认可以识别 ESM 语法。这一点我没有实测，所以 A5 先列为待验证。注意：现有 `~/.yodo/task/package.json` 是旧版本留下的，当前代码并不创建它。

## 执行步骤

1. 做 A1–A4。
2. 做 V1；通过后做 A5。
3. 在 `tsconfig.json` 加 `"noUnusedLocals": true, "noUnusedParameters": true`。当前已是 0 个错误，加上后不增加任何成本，可以防止以后再引入死代码。
4. 运行 `npm run check`、`npm test`、`npm run verify:pack`。
5. 不把 Knip 加入 `package.json`。需要时用 `npx -y knip` 手动跑一次即可，避免多一个依赖。

## 验收

- `npm run check`、`npm test`、`npm run verify:pack` 全部通过。
- 重新运行同样的 `tsc` 和 Knip，A 类问题消失，C 类误报不变。

## 执行结果

- A1–A5 已完成。V1 在全新的临时 HOME 中验证：没有 `package.json`，ESM 的 task 可以导入 task-lib 并正常运行，因此删除了 `templates/task-package.json`。
- `tsconfig.json` 已启用 `noUnusedLocals`、`noUnusedParameters`。
- `npm run check`、`npm test`、`npm run verify:pack` 全部通过。
- Knip 重新运行：「未使用文件」只剩误报的 `cli/shim.ts`；「未使用导出」从 20 个降到 18 个，剩下的都是 B 类（过度导出）和 C 类（误报）。B 类按计划不单独处理。
