立 `.yodo`、查 Node、确认本机有 Chrome，只在这份做。不新造脚本。Chrome 和 Node 都齐了才跑 `setup.js`；`.yodo/{src,task,tmp,record,session}` 都在，安装才算完。

`.yodo` 在用户 home 下。能推断就用；不能：`node -p "require('os').homedir()"`，再拼 `.yodo`。跑命令用绝对路径（Windows 不要用 `~`）。

# 1. 环境

本机要有 Google Chrome，Node 要 ≥24。两者都齐了才去立 `.yodo`。装好 Chrome 但还没打开、还没开远程调试、还没点 Allow，不是安装失败——那些是第一次连浏览器时的 `need-*`，不写进这里当安装步骤。

## 1.1 确认 Chrome 已装

只问本机有没有 Google Chrome，不是已经打开，也不是已经开了 remote-debugging。没有就请用户去装：https://www.google.com/chrome/ 。请他装好回「好了」，再看一次。不要把代码里的 Chrome 路径表抄进来。

完成：能指出 Chrome 在，或已把安装说明给人并在等「好了」。第一次连浏览器若 stdout 是 `need-install`：把 `guide` 原样念给用户，停，等「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。

## 1.2 确认 Node ≥ 24

`node -p process.version`。没有 Node，或 major < 24：帮用户装到当前的 Node，装完再查一次。major ≥ 24 才往下走。`setup.js` 自己也会拦不够的版本，不要另写一个检查脚本。

完成：`process.version` 的 major ≥ 24。

# 2. setup

`setup.js` 一次做完源码就位和建目录。`init.js` 只建数据目录。`doctor.js` 不推进安装，只在对不上的时候看一眼。

## 2.1 跑 setup.js

在 skill 目录（这份文件和 `SKILL.md` 旁边）执行 `node setup.js`。它检查 Node ≥24，把本 skill 的 `src/` 链接或拷到 `<home>/.yodo/src`（建不了链接就整目录拷贝），再调 `src/bin/init.js` 建 `task/` `tmp/` `record/` `session/`，并同步 `task/_common/`。用户和 agent 写的脚本在 `task/` `tmp/`，`setup.js` 不碰它们。`src/` 更新会覆盖，不要在那里写业务脚本。

报错就对着这次输出和 `setup.js` 源码给办法。不要另写一个安装脚本。

完成：绝对路径下存在 `.yodo/src`（链接或拷贝）。

## 2.2 验收目录

这五个都要在：

| 目录 | 安装要留下 |
|---|---|
| `.yodo/src` | 源码（链接或拷贝）。没有它 = 未初始化 |
| `.yodo/task` | 以后放已验证脚本。安装时带上 `_common/` |
| `.yodo/tmp` | 以后试跑 |
| `.yodo/record` | 以后放抓包 |
| `.yodo/session` | pid · sock · log.jsonl |

缺一块再跑 `setup.js`。只缺数据目录时可以单独跑 `node <home>/.yodo/src/bin/init.js`（建四个数据目录并同步 `_common/`；`setup.js` 已经会调）。布局仍乱、路径不对、holder 占死，才跑 `node <home>/.yodo/src/bin/doctor.js`：打印 Node、`platform`、`home`、`src` 是链接还是拷贝、四个数据目录在不在、holder 是否占死。这是给自己看的，不要把整段输出念给用户。

完成：五个目录都在，且 `task/_common/yodo.js` 在。安装结束。
