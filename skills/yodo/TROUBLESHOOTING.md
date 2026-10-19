# 故障排查

yodo 完全以原始源码分发：`~/.yodo` 是 skill 目录的原样镜像（源码 `src/`、开发脚本 `scripts/dev/`、文档），架构见 `ARCHITECTURE.md`，开发约定见 `AGENTS.md`。下面的问题都可以读源码定位，并直接修复。直接改 `~/.yodo/src` 或 `~/.yodo/scripts` 是临时修复，下次升级会覆盖；改完可以在 `~/.yodo/src` 里 `npm install && npm test` 验证。

先运行 `~/.yodo/bin/yodo doctor`（加 `--json` 得到机器可读结果），失败项会带修复命令。

## 1. 安装

| 现象 | 处理 |
|---|---|
| Node 版本低于 24 | 用 fnm、nvm、Homebrew 或官方安装升级后重跑 `setup.js` |
| `npm install` 失败 | 看 npm 的报错（网络、权限、registry）；解决后重跑 `setup.js`，它可重复执行 |
| `doctor` 的 `home`、`src`、`deps`、`native-host`、`launcher` 失败 | 重跑 `node <skill 安装目录>/setup.js`（`npx skills ls -g` 找安装目录） |
| `npx skills add` 失败 | clone 仓库，在仓库根目录运行 `npm run dev:install`（按 git 认的文件导出再安装，内容与在线安装相同） |
| 找不到 `yodo` 命令 | 命令是 `~/.yodo/bin/yodo`，用绝对路径，或把 `~/.yodo/bin` 加入 PATH |

## 2. 扩展与连接

| 现象 | 处理 |
|---|---|
| `need-extension`，且从没加载过扩展（v1 升级上来的也算） | 打开 `chrome://extensions`，开启「开发者模式」，「加载已解压的扩展程序」，选择 `~/.yodo/src/chrome-extension` |
| `need-extension`，扩展已加载 | 在 `chrome://extensions` 确认 yodo 开着，点一下它的工具栏图标 |
| `extension-build` 提示版本不同 | 在 `chrome://extensions` 里刷新 yodo（扩展代码不能自动更新） |
| `extension-id` 失败 | 重跑 `setup.js` 重写 native host manifest；扩展 ID 由 `manifest.json` 里的 key 固定 |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，Chrome 会重新拉起；等几秒，仍不行就重启 Chrome |

## 3. 升级与迁移

| 现象 | 处理 |
|---|---|
| `yodo daemon restart` 提示正忙 | 有 run 或录制在进行，结束后再运行 |
| 升级后旧 daemon 还在跑 | `setup.js` 会提示；运行 `yodo daemon restart` |
| 从 v1 升级：`yodo run` 报「位置参数」或「没有这些参数」 | v2 参数一律具名。在 task 文件头加 `@param 名字 说明`（可选参数写 `名字?`），代码里把 `process.argv` 换成 `yodo.params.名字`（值都是字符串）。调用时写 `--名字 值`。详见 `SKILL.md` |
| 升级后留下的 `~/.yodo/temp`、`~/.yodo/backup`，旧名字的 skill | 处理方式见 `install.md`「清理 v1 遗留」，里面可能有用户想保留的内容，不要直接删 |
| task 文件在哪 | `~/.yodo/task/<name>.js`，直接改它；升级不会碰 `task/`，但会重写 `task/lib/` |

## 4. 运行

| 现象 | 处理 |
|---|---|
| 登录失效（401/403、跳到登录页、超时前停在登录页） | 请用户在 Chrome 里重新登录该网站后重试一次；不要改 task |
| 提示 busy / 正忙 | 同时只能一个 run；run 与录制互斥。等待或结束录制 |
| task 超时 | 单步骤 30 秒、整个 task 默认 90 秒，可在 task 头部写 `@timeout <秒>`；先确认不是登录失效 |
| 残留 `yodo run` / `yodo record` 窗口 | 刷新扩展或重启 daemon 时会按标题对账清理；只关标题确认的窗口 |
| 运行历史、录制在哪 | `~/.yodo/run/<task>/`、`~/.yodo/record/` |

## 5. 取日志与现场

- 运行时日志：`~/.yodo/session/log.jsonl`
- daemon 状态：`yodo doctor --json`，其中 `holder` 项会 ping daemon（含 `build`、`mode`、`extensionBuild`）
- 进入运行中的 daemon：`kill -USR1 <holder pid>` 用 Node inspector 连入
- 仍无法解决：把 `doctor --json` 的输出和日志末尾给用户，说明需要用户做的一件事

## 6. 开发脚本

- `~/.yodo/scripts/dev/` 随源码分发：`record.mjs` 起夹具、录制、模拟演示；`replay.mjs` 用 dev 模式保存的原始事件离线重放流水线（不需要 Chrome）。用法见 `AGENTS.md` 2.3。需要先 `touch ~/.yodo/session/dev` 开启 dev，用完 `rm ~/.yodo/session/dev`。
- dev 模式保存的原始事件是脱敏**之前**的数据，可能含密码和 token，只写在 `~/.yodo/dev/`。用完 `rm -rf ~/.yodo/dev`，不要发给别人，也不要放进 `~/.yodo/record`。
- 仓库根目录的 `tools/`（`verify-pack`、`dev-install`）和 `README.md`、`brand/`、`bench/` 不分发；需要它们请 clone 仓库。
