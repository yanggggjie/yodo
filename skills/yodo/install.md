# 安装与升级 yodo

安装和升级使用同一套流程。以下步骤按顺序执行，每步完成后再进入下一步。

## 对用户说话的规则

整个安装过程里，只对用户说两类话：用户下一步要做什么；装完是否成功。

- 不说内部状态：目录里有哪些文件、扩展 ID、native host、依赖安装、`doctor` 逐项结果、某一项为什么失败。
- 第 3 步结束时 `doctor` 里 `holder` 失败，是扩展还没加载造成的，属于正常现象，不要向用户提。
- 出问题时只告诉用户一件要做的事，一句话说清；用户追问再讲原因。
- 冒烟测试可以自己做；通过就不提，只有失败才报告。

## 1. 检查环境

- Node ≥24：`node -p process.version`。不满足时请用户升级 Node。
- Google Chrome：确认已安装。未安装时把 https://www.google.com/chrome/ 交给用户，等待「好了」。
- macOS 已验证。Windows 与 Linux 有适配代码，尚未充分测试；遇到问题照实告诉用户。

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

扩展不能由 agent 或脚本加载。

先自己确认 `setup.js` 输出的扩展目录里有 `manifest.json`，不要把文件清单念给用户。

**扩展没连上（默认）**：在 `setup.js` 之后运行 `~/.yodo/bin/yodo doctor`，只要扩展没连上，就按这一套来。包括从 v1 升级的用户：v1 没有扩展，等于第一次安装。不要凭「已有 `~/.yodo`」判断扩展装过。用 `node -p process.platform` 判断系统，把 `<扩展目录>` 换成 `setup.js` 输出的绝对路径，只对用户说对应系统的那一套：

macOS（`darwin`）：

> 请在 Chrome 里加载 yodo 扩展：
> 1. 打开 `chrome://extensions`，打开右上角「开发者模式」
> 2. 点「加载已解压的扩展程序」，按 `Cmd+Shift+G`，粘贴 `<扩展目录>`，选择它
> 3. 完成后告诉我「好了」

Windows（`win32`）：

> 请在 Chrome 里加载 yodo 扩展：
> 1. 打开 `chrome://extensions`，打开右上角「开发者模式」
> 2. 点「加载已解压的扩展程序」，在窗口顶部的地址栏粘贴 `<扩展目录>`，回车，再点「选择文件夹」
> 3. 完成后告诉我「好了」

Linux（`linux`）：

> 请在 Chrome 里加载 yodo 扩展：
> 1. 打开 `chrome://extensions`，打开右上角「开发者模式」
> 2. 点「加载已解压的扩展程序」，按 `Ctrl+L`，粘贴 `<扩展目录>`，回车，再点「选择」
> 3. 完成后告诉我「好了」

**扩展已连上、仅版本不同（`extension-build` 提示）**：只说「请在 `chrome://extensions` 里点 yodo 扩展卡片上的刷新，完成后告诉我『好了』」。

以下是给 agent 的背景，不要讲给用户：

- daemon 一般不用手动重启：`setup.js` 发现运行中的 daemon 是旧代码时，会让它退出，并在扩展重连时换成新的。装的时候 daemon 正忙（run、录制），`setup.js` 换不掉，会打印醒目的提示；等 run 或录制结束后运行 `yodo daemon restart`，不会有任何命令自动帮你换。
- 扩展本身不能自动更新，扩展代码有改动时 `doctor` 的 `extension-build` 会提示刷新。刷新扩展会断开旧的 relay，Chrome 随后用新的 manifest 重新拉起 relay；扩展代码或 relay 代码有改动时，必须做刷新才会生效。

## 5. 验收

用户回复后运行：

```bash
~/.yodo/bin/yodo doctor
```

- 全部通过：进入第 6 步。
- 扩展未连接（`need-extension`）：对用户只说「请在 `chrome://extensions` 里确认 yodo 扩展是开着的，再点一下它的图标」，然后重新运行 `doctor`。
- `extension-build` 提示扩展版本不同或没有报告版本：对用户只说「请在 `chrome://extensions` 里刷新 yodo 扩展」，然后重新运行 `doctor`。
- 其它失败：按 `doctor` 输出的修复命令自己处理，再重新运行 `doctor`；处理不了时，对用户说清需要他做的一件事。

通过后可以自己做冒烟测试（例如 `yodo run` 列出 task、跑一个只读 task）。

## 6. 报告

只告诉用户：

> yodo 安装成功。

用户问到命令路径时再补充：命令是 `~/.yodo/bin/yodo`，可以用绝对路径调用，想直接用 `yodo` 就把 `~/.yodo/bin` 加入 PATH。不要主动报告版本、安装目录或扩展状态。
