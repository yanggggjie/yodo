# 录制 DOM 操作，task 自己写页面操作

## 目标

录制存下来的是对某个元素的一次 DOM 操作，不再是 `click`、`input`、`change`、`keydown`、`submit` 这些事件名。

task 用 `evaluate` 按这条操作写该页面自己的代码。`lib` 不再提供 `click`、`fill`、`press`、`scroll`、`check`、`select`。

本 plan 取代 `plan/dom-fallback-improve.md`。那边要保留这些 helper、只把内部从 CDP `Input` 改成 DOM 调用。那个做法仍然把不同控件收成同一种操作，不采用。也取代 `plan/cdp-rpc.md` 里「task 必须使用 `click` / `fill` 等 helper」的要求。`goto`、`evaluate`、Network 监听和 `page.cdp.send` 不变。

## 录制

采集仍然监听可信的原生事件，并继续丢掉脚本派发出的事件。监听只用来发现人做了什么。写入 `DOMTimeline.jsonl` 的每条记录是操作和当时的元素，不是事件本身。

点在内部图标上时，先从事件目标向上找到真正的控件，再描述这个控件。控件包括按钮、链接、`input`、`textarea`、`select`、`label`、`summary`，以及带 `role="button"` 的元素。找不到时，沿用现在的 role 和 name 向上查找。存下来的 `target` 是这个控件。

| 观察到的结果 | 存下的操作 | 附带状态 |
|---|---|---|
| 点了按钮或链接 | `click` | 控件元素 |
| 输入框、文本域、`contenteditable` 的文本变了 | `value` | 控件元素，以及最终文本。同一次连续修改只留最后一条 |
| 勾选状态变了 | `checked` | 控件元素，以及 `checked` |
| 原生 `<select>` 的值变了 | `value` | 控件元素，以及 value |
| 滚动位置变了 | `scroll` | 滚动元素，以及 `scrollTop`、`scrollLeft` |

同一控件上的 `click` 若随后被 `checked` 或 `<select>` 的 `value` 说明，只留属性那一条。打开下拉框又关掉、值没有变，则不记录。

不记录：

- `submit`。提交按钮的 `click`，以及随后的 navigation 或请求，已经说明这次提交。`form.submit()` 会跳过校验，不能当作要重放的操作。
- `keydown`，包括 Enter、Escape、方向键和带修饰键的组合。有属性变化时记属性；没有对应的 DOM 属性变化时不记操作。
- 指针坐标、`pointerdown`、滚轮位移。`scroll` 只记停下后的位置。小于 20px 的滚动仍丢弃。

`navigation` 和 `final-state` 保留。敏感字段仍只记 `valueRedacted`，不记原始值。

根目录 `timeline.jsonl` 的简化行使用同样的操作名。简化行仍然只有 `eventId`、操作、role、name；`value` 的文本、`checked` 和滚动位置只出现在 `DOM/DOMTimeline.jsonl`。

selector 不在录制时生成。现有的候选 selector、id、class、attribute、父元素和子元素继续放在元素描述里，供写 task 时选择。

## task

`lib` 只保留与控件无关的部分：

- `goto`
- `evaluate`（继续带 `userGesture: true`）
- `waitForSelector`

从模板导出中删除 `click`、`fill`、`press`、`scroll`、`check`、`select`。分支上已把前四个改成页面内 DOM 调用的实现一并删除，不保留为可选捷径。

写 DOM task 时，按 timeline 里的操作，从下面的对照里选择会改变页面状态的写法，在 `evaluate` 中写这个页面的代码。派发事件只通知监听器，不代替那次操作。

| 手动操作 | DOM 代码 |
|---|---|
| 单击按钮或链接 | `element.click()`。触发 `click`，并执行跳转、提交这类默认行为。不会先发生 `mousedown` 和 `mouseup` |
| 勾选复选框或单选框 | `element.click()` 会切换 `checked`，并触发 `click`、`input`、`change`。`element.checked = true` 只改状态 |
| 按下或抬起鼠标 | 没有对应方法。`dispatchEvent(new MouseEvent('mousedown'))` 或 `mouseup` 只通知监听器，不会开始选字或拖拽 |
| 右键 | 没有对应方法。派发 `contextmenu` 只通知监听器，不会打开浏览器菜单 |
| 双击 | 没有对应方法。派发 `dblclick` 只通知监听器，不会按双击选中单词 |
| 悬停或移出 | 没有对应方法。派发 `mouseenter`、`mouseover`、`mouseleave`、`mouseout` 只通知监听器，不会让元素进入 `:hover` |
| 滚动 | `scrollTo()`、`scrollBy()`、设置 `scrollTop`，或 `scrollIntoView()`。位置会变，浏览器接着触发 `scroll`。派发 `wheel` 或 `scroll` 不会移动滚动位置 |
| 按键 | 没有对应方法。派发 `KeyboardEvent` 只通知监听器，不会把字符写进输入框，也不会执行浏览器快捷键 |
| 在输入框里打字或删字 | `input.value = '...'` 只改文字，不触发 `input` 和 `change`。`input.setRangeText('...')` 会改文字并触发 `input` |
| 复制、剪切、粘贴 | 没有对应的 DOM 快捷方法。派发 `copy`、`cut`、`paste` 只通知监听器。读写剪贴板用 `navigator.clipboard` |
| 焦点进入或离开 | `element.focus()`、`element.blur()`。会触发 `focus`、`focusin` 或 `blur`、`focusout` |
| 改下拉框选中项 | `select.value = 'opt2'` 会改选中项，不触发 `input` 和 `change`。要通知监听器需再派发这两个事件。不会打开下拉列表 |
| 提交表单 | `form.requestSubmit()` 会校验并触发 `submit`。`form.submit()` 直接提交，不校验，也不触发 `submit`。`submitButton.click()` 先走按钮的 `click`，再触发 `submit` |
| 触摸或滑动 | 没有可靠的 DOM 方法。`TouchEvent` 在 Chrome 里经常构造失败，派发出去也不会连带产生 `click` |
| 改变浏览器窗口大小 | 页面脚本做不到。`window.resizeTo()` 对普通标签页无效 |

timeline 里的四种操作对应这张表里会留下状态的行：

- `click`：对记录的控件调用 `element.click()`。
- `value`：原生输入框和文本域用 `setRangeText`，或用原型上的 value setter 写入后再派发 `input`。不要只写 `element.value = ...`。
- `checked`：写成记录中的 `checked`。页面监听 `change` 时再派发 `input` 和 `change`。不用 `click()` 翻转，记录里已经是目标状态。
- `scroll`：把该元素设到记录的 `scrollTop` 和 `scrollLeft`。
- 控件有自己的文档对象时，调用那个对象，不按原生控件写。timeline 只说明点了哪个元素、文本最后是什么，不能据此生成编辑器内部调用。

操作没有改变可记录的属性，而运行时 `element.click()` 又不能完成该步骤时，依据运行错误和当前页面改 task。不要加回固定 helper，也不要改回 CDP `Input`。

## 修改范围

- `skills/yodo/src/record/collect.ts`：监听后写成上面的操作；合并同一控件上被属性说明的点击。
- `skills/yodo/src/record/types.ts`：操作类型改为 `click`、`value`、`checked`、`scroll`、`navigation`、`final-state`。去掉 `fill`、`change`、`submit`、`keydown`。
- `skills/yodo/src/record/dom.ts`：连续 `value` 仍只留最后一条。简化 timeline 使用新操作名。
- `skills/yodo/src/record/dom.selfcheck.ts`、`skills/yodo/src/record/collect.selfcheck.ts`：按新操作和去重规则断言。
- `skills/yodo/src/templates/task-lib/dom.js`、`dom.d.ts`、`index.js`、`index.d.ts`：删除六个操作 helper，保留 `waitForSelector`。
- `skills/yodo/src/task-lib.selfcheck.ts`：去掉对已删除 helper 的断言。
- `skills/yodo/SKILL.md`：DOM 材料、示例和「优先使用 lib」改为上述操作和 `evaluate`。不再把 `fill`、`press`、`click` 列为通用操作。

不改 `~/.yodo/task` 里已有的 capability。若其中有文件 import 了将被删除的 helper，安装同步模板时会无法运行；那些文件另行改为自己的 `evaluate`，不在本 plan 里批量改写。已有 `record` 不迁移。
