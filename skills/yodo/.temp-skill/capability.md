# capability

按「经常一起做、共享同一组材料」归类。只覆盖用户任务；立 `.yodo` / Node / Chrome 安装不在这里。

## 跑脚本
只有 `task/` 是已验证能力。按切开后的这一份带参数跑，读同一套 stdout（`success` / `failure` / `need-*`），并对人报告 `result` / `resultFile`。检验 URL 由 agent 看刚跑的那份脚本现拼。找对得上只看 `task/`。

覆盖：跑已有 task

## 录抓包
开录、等人、停录、放弃都只动 `src/bin/record-*.js` 和归档后的 `record/<name>/`，共享同一套 stdout（`recording` / `stopped` / `aborted` / `idle`）。同一句 prompt 里缺的操作一次录完；对人只说操作，不念拆分点。录制窗后台，空白 tab 标题 `yodo record`。recording 不印 `guide`。

覆盖：录用户操作

## 写重放
缺的每一份写成 `tmp/<name>.js`，对着同一份 `recordDir`，带参数试跑。试跑落在 `tmp/`，成功才进 `task/`。一次录不收成一份做完整句 prompt 的脚本。`tmp/` 是废料，不算能力。

覆盖：写出脚本
