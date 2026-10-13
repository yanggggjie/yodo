# DOM 录制：让采集的东西真正交给 agent

## 问题（用 `~/.yodo/record` 里的真实录制核对过）

1. **晚 attach 时整页没有任何 DOM 动作**：注入脚本只用 `Page.addScriptToEvaluateOnNewDocument`，对已经加载完的文档不生效。`x-claude-search` 录制有 95 个请求（含搜索和点赞），却没有任何 click、value、scroll，也没有主文档行；单页应用不会再新建文档，脚本一直没机会运行。录制没有任何提示。
2. **采集的东西没有交给 agent**：脚本为每个事件算了选择器、祖先、子节点、输入值、滚动量，timeline 却只输出 `role` 和 `name`，其余只用来比较"是不是同一控件"。agent 写 `click(page, selector)` 没有选择器可用，单页应用的主文档 HTML 里也没有渲染后的 DOM。
3. **role / name 质量差**：沿祖先向上找"有 role 又有 name"的元素，name 取容器的 `innerText`。知乎搜索框被叫成旁边按钮的「直答」；内部平台的多个 click 的 name 是整个导航栏的文字；滚动行的 name 是整页文字开头，连续几条完全相同，没有位移。
4. 其他：滚动基准在第一个 scroll 事件里取，一次性跳转的位移被算成 0 而丢弃；复选框的 `input` 事件被当成值为 `"on"` 的 fill；文本框 fill 后失焦又 change，产生重复；iframe 里的导航（`about:blank`）混进时间线；单页应用的路由变化不记录。

## 做了什么

- **页面脚本直接产出输出字段**（`record/inject.js`）：`selector`、`role`、`name`、输入值、滚动量。选择器要求在文档里唯一，框架自动生成的 id、class 不用；命名顺序与浏览器接近（`aria-labelledby`、`aria-label`、`<label>`、`placeholder`、自己的文字）；点到按钮里的图标算点了按钮，点 label 算点了它控制的输入框；不再采集祖先和子节点。
- **补注入**：attach 时对已存在的 frame 立刻注入（`Page.createIsolatedWorld` + `Runtime.evaluate`），脚本自己能处理重复注入；宿主对同一动作的重复事件去重。
- **失败可见**：脚本加载后发 `ready`；`record stop` 的输出新增可选字段 `warnings`，列出有网络请求却没收到 `ready` 的页面，SKILL 要求 agent 告诉用户并重录。
- **timeline 字段**：`selector`、`value` / `valueRedacted`、`checked`、`option`、`deltaX` / `deltaY` / `nearEnd`、`tab`（多个标签页时）、`frame`（iframe 里时）。
- **规则**：判断同一控件只比较 `selector`；fill 与 change 值相同只留一条；iframe 里的导航不记录；单页应用的路由变化（`Page.navigatedWithinDocument`）记为 navigation。
- **滚动**：基准改为上一次停下来的位置，整页滚动不带 selector 和 name。

## 怎么验证

- 在真实 Chrome 里用本地页面（按钮里的图标、label、placeholder、`aria-label` 的密码框、复选框、`role=button` 的 div、容器、iframe、shadow DOM、pushState）和可信的鼠标键盘输入驱动，抓到页面事件存为 `record/fixtures/dom-events.json`。
- 同一个页面上读 Chrome 无障碍树（`Accessibility.getPartialAXTree`）作为 role 和 name 的标准答案：button、link、有 label 的文本框、只有 placeholder 的文本框、`aria-label` 的文本框、复选框、`role=button` 的 div 共 7 项，我们算的结果全部一致。
- `collect.selfcheck.ts` 回放这些事件并对照标准答案；补注入、`ready`、`warnings` 的判断也有自检。

## 没有做、或没有验证

- **用键盘改下拉框**：macOS 上方向键只会展开菜单，测试里没有触发 change，所以 `option` 字段只有单元测试，没有真实 Chrome 的事件。
- **键盘按键不记录**（之前有意删除）：用回车提交的搜索只能从后面的请求和导航推断。
- **shadow DOM** 里的元素只能用宿主的选择器，无法精确到内部元素。
- **输入值里可能有个人信息**：敏感字段（密码、验证码、银行卡等）只记 `valueRedacted`，普通文本框的值会写进 timeline。
- 真实 Chrome 里一次完整的人工录制（尤其是晚 attach 的单页应用）还需要你验证。
