# 安装与升级 yodo

安装和升级使用同一套流程。以下步骤按顺序执行，每步完成后再进入下一步。

## 1. 检查环境

- Node ≥24：`node -p process.version`。不满足时请用户升级 Node。
- Google Chrome：确认已安装。未安装时把 https://www.google.com/chrome/ 交给用户，等待「好了」。

## 2. 同步 skill

- 本地开发安装，在仓库根目录运行 `npm run dev:install`。
- 在线安装运行 `npx skills add yanggggjie/yodo -g -y -a '*' -s yodo`。
- 运行 `npx skills ls -g`，找到 yodo 的安装目录，下面的步骤都从这个目录运行。

## 3. 运行引导脚本

```bash
node <安装目录>/setup.js
```

脚本依次完成：拷贝运行时到 `~/.yodo/src`，安装依赖，注册 native messaging host，生成 `~/.yodo/bin/yodo` 与 `yodo.cmd`，创建 `~/.yodo/task` 与 `~/.yodo/record`，最后运行 `doctor`。

## 4. 加载或刷新 Chrome 扩展（需要用户操作）

扩展不能由 agent 或脚本加载。请用户按以下步骤操作：

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 第一次安装：点「加载已解压的扩展程序」，选择扩展目录。`setup.js` 不会替用户打开文件管理器，请你：
   - 把 `setup.js` 输出的绝对路径告诉用户。
   - 列出该目录下的文件（应包含 `manifest.json`、`background.js`），让用户能对照确认选的是哪个目录。
   - 说明：macOS 在文件选择框按 `Cmd+Shift+G` 粘贴路径，Windows 在地址栏粘贴路径。
3. 已经加载过：在 yodo 扩展卡片上点刷新。
4. 完成后回复「好了」。

daemon 一般不用手动重启：`setup.js` 发现运行中的 daemon 是旧代码时，会让它退出，并在扩展重连时换成新的。装的时候 daemon 正忙（run、录制），`setup.js` 换不掉，会打印醒目的提示；等 run 或录制结束后运行 `yodo daemon restart`——不会有任何命令自动帮你换。扩展本身不能自动更新，扩展代码有改动时 `doctor` 的 `extension-build` 会提示刷新。

刷新扩展会断开旧的 relay，Chrome 随后用新的 manifest 重新拉起 relay。relay 只转发消息，daemon 常驻不受影响；扩展代码或 relay 代码有改动时，必须做这一步才会生效。

## 5. 验收

用户回复后运行：

```bash
~/.yodo/bin/yodo doctor
```

- 所有检查通过：报告安装成功。
- 扩展未连接（`need-extension`）：请用户打开 `chrome://extensions` 确认扩展已开启，并点一下扩展的 service worker 或工具栏图标，然后重新运行 `doctor`。
- `extension-build` 提示扩展版本不同或没有报告版本：请用户在 `chrome://extensions` 里刷新 yodo 扩展，再重新运行 `doctor`。
- 其它失败：按 `doctor` 输出的修复命令处理，再重新运行 `doctor`。

## 6. 报告

告诉用户：版本、安装目录、命令路径（`~/.yodo/bin/yodo`）、扩展状态。

命令可以用绝对路径调用；如果用户希望直接使用 `yodo`，可以把 `~/.yodo/bin` 加入 PATH。
