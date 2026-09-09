# capability

按「经常一起做、共享同一组材料」归类。只覆盖用户任务；立 `.yodo` / Node / Chrome 安装不在这里。

## 跑脚本
`task/*.js` 和 `tmp/` 组合都读同一套已验证脚本、同一套 stdout（`success` / `failure` / `need-*`），并对人报告 `result` / `resultFile`。检验 URL 都由 agent 看 task 脚本现拼，不从脚本 return 里取。

覆盖：跑已有 task、组合现有 task

## 录抓包
开录、等人、停录、放弃都只动 `src/bin/record-*.js` 和归档后的 `record/<name>/`，共享同一套 stdout（`recording` / `stopped` / `aborted` / `idle`）。

覆盖：录用户操作

## 写重放
写脚本只认这份抓包和 `_common/yodo.js` 暴露的 API，只重放抓到的请求；试跑仍落在 `tmp/`，成功才进 `task/`。

覆盖：对着抓包写出脚本
