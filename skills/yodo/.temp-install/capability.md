# capability

按「经常一起做、共享同一组材料」归类。只写为什么收在一组，不写谁先谁后。

## 拉 skill
只动本机已装的 skill 目录，共用 Skills CLI，不进 `.yodo`，也不查 Chrome / Node。

覆盖：跑 skills add

## 环境
Chrome 和 Node 都是跑 `setup.js` 之前的本机条件，材料都是「有没有 / 版本够不够」，不进 `.yodo`。缺了怎么补不一样：Chrome 只请用户自己装；Node 由 agent 安装或升级。装好 Chrome 但还没打开、还没开远程调试、还没点 Allow，不是这一组的失败。

覆盖：确认 Chrome 已装、确认 Node ≥ 24

## setup
`setup.js` / `init.js` / `doctor.js` 都只动 `.yodo` 布局和依赖，共用同一套完成条件（五个目录 + `_common`）。首次和再跑收在这里，不把「更新」拆出去。

覆盖：跑 setup.js、验收目录、doctor 看一眼
