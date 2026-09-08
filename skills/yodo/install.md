流程、目录、脚本。先按流程把环境和目录备齐，再执行脚本把 `.yodo` 立起来；目录齐了，才去做用户任务。

没有 `.yodo/src`、Node 不够、或初始化不确定时读这份。不新造脚本。

## 1. 流程

```text
查 Chrome → 查 Node → 在 skill 目录执行 setup.js → 验收目录
```

**Chrome。** 这里只问本机有没有 Google Chrome，不是已经打开，也不是已经开了远程调试。没有就告诉用户去装：https://www.google.com/chrome/ 。请他装好后回「好了」，再看一次。不要把代码里的 Chrome 路径表抄进来。

装好 Chrome、但还没打开、还没开远程调试、还没点 Allow，不是安装失败。那些是第一次连浏览器时的 `need-*`：把 stdout 里的 `guide` 原样念给用户，停，等用户回「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。

**Node。** 需要 ≥24。`node -p process.version`。没有 Node，或 major 不够：帮用户装到当前的 Node，装完再查一次版本。major ≥ 24 才往下走。

**setup。** 在 skill 目录（这份文件和 `SKILL.md` 旁边）执行 `node setup.js`。它检查 Node、把 `src/` 链接或拷到 `.yodo/src`，再调 `init.js` 建 `task/` `tmp/` `record/` `session/`。用户和 agent 写的脚本在 `task/` `tmp/`，`setup.js` 不碰它们。

初始化报错：对着这次报错和 `setup.js` 源码看，给出能做的办法。不要另写一个安装脚本。

**验收。** `src/`、`task/`、`tmp/`、`record/`、`session/` 都在，这一步才算完。缺一块再跑 `setup.js`；只缺数据目录时可以跑 `src/bin/init.js`。布局仍乱、路径不对、holder 占死，才跑 `doctor`。目录齐了，去做用户任务。

## 2. 目录

`.yodo/` 在用户 home 下。能推断就用；不能：`node -p "require('os').homedir()"`，再拼 `.yodo`。跑命令用绝对路径。

| 目录 | 安装要留下 |
|---|---|
| `.yodo/src` | 源码（链接或拷贝）。没有它 = 未初始化 |
| `.yodo/task` | 以后放已验证脚本。安装时带上 `_common/` |
| `.yodo/tmp` | 以后试跑。安装时只要目录在 |
| `.yodo/record` | 以后放抓包 |
| `.yodo/session` | pid · sock · log.jsonl |

`src/` 更新会覆盖源码，不要在那里写业务脚本。`task/` `tmp/` 是用户的，更新不碰。

## 3. 脚本

setup 一次做完源码就位和建目录。init 只建数据目录。doctor 不推进安装，只在对不上的时候看一眼。

| 脚本 | 做什么 |
|---|---|
| `node setup.js` | 在 skill 目录跑。检查 Node ≥24，链或拷 `src/` 到 `.yodo/src`，再调 `init.js`。用户脚本在 `task/` `tmp/`，它不碰。报错就对着这次输出和 `setup.js` 源码给办法。 |
| `node src/bin/init.js` | 建 `task/` `tmp/` `record/` `session/`，并同步 `_common/`。`setup.js` 已经会调；只缺数据目录时可以单独跑。 |
| `node src/bin/doctor.js` | 打印 Node、`platform`、`home`、`src` 是链接还是拷贝、四个数据目录在不在、holder 是否占死。布局乱、路径不对、占死才用。这是给自己看的，不要把整段输出念给用户。 |
