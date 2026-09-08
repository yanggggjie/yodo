# Skill 重写计划

上一版把「流程 / 目录 / 脚本」和「bin / task / tmp / mv」当成了规定用词。那些是结构示例，不是这套产品必须用的标题。这一版按序号重选概念词，只改文档计划，不改正文。

要写两份，都进 skill payload：

| 文件 | 给谁 |
|---|---|
| `skills/yodo/SKILL.md` | 每回合做用户任务 |
| `skills/yodo/install.md` | 还没立好 `.yodo` 时 |

`AGENTS.md` 仍写改源码。`README.md` 不复述步骤，安装指到 `install.md`，任务指到 `SKILL.md`。

现在仓库里的 `SKILL.md` / `install.md` 是按误读写的，确认这份 plan 后再改正文。

---

## 怎么写

### 1. 总分两层，标题是概念词

结构是序号，不是「第几步」。每一层的标题是一个概念词。有下级时，标题下面先写一句：这几个下级怎么动、谁推谁。然后再写下级。只两层，不到 `1.1.1`。

```text
1. 概念词
   1.1、1.2、1.3 之间怎么动
   1.1 概念词
       具体内容
   1.2 概念词
       具体内容
   1.3 概念词
       具体内容
2. 概念词
       具体内容（没有下级就到此为止）
3. 概念词
   3.1、3.2… 之间怎么动
   3.1 概念词
       具体内容
   3.2 概念词
       具体内容
```

「流程、目录、脚本」是示例里的三个词，用来说明「总」是一句动作关系。不是两份文档都要套这三个字。概念词从产品里长出来：这份文档里，读者手里到底在跟哪几样东西打交道。下级也是。没有的东西不留空号。

`status`、等人、报告不是概念词，是枝上的动作，不升格成 `4.`。

### 2. 给人也能读下去

命令、路径、`status` 保持字面量，不改写。`guide` 原文照念。其余写完整句子。实现细节（holder、CDP attach、过滤）在 `AGENTS.md`，skill 只写手往哪伸。

### 3. 正文是展开的树，节点允许重复

节点是一段做完就能停的动作，不是一个词，也不是整章。走到哪一步需要哪段动作，就在这里写完：做了什么、看 stdout 哪一个字、完了是什么。别处又走到同一步，再写一遍，意思对齐。不写「同上」「见上文」。

同一份正文内部不准跳读。跨文件的门可以：没有 `.yodo/src` 就去读 `install.md`。

重复的是动作，不是把 `1.` `2.` `3.` 互相抄一遍。`1.1 查` 里跑通了要报告，就把报告写全；`1.3 试` 里再跑通了，再写一遍。不要把脚本模板贴进 `1.`，也不要把整棵目录树贴进每个 `3.x`。

---

## 概念词怎么来的

agent 做用户任务时，手里只有三样东西：眼前这个**任务**、磁盘上的**目录**、能跑或能写的**脚本**。所以 `SKILL.md` 的 `1. 2. 3.` 是这三个。任务怎么走，拆成查、录、试。脚本怎么动，拆成 bin、tmp、task、mv。

安装时还没有任务。手里是**环境**、将要立起来的**目录**、用来立目录的**脚本**。所以 `install.md` 的 `1. 2. 3.` 是这三个。环境拆成 Chrome、Node。脚本拆成 setup、init、doctor。

---

## `SKILL.md`

frontmatter 触发用户任务，并指向 `install.md`。路径结论写在这里，步骤不写。

```yaml
description: >-
  触发词 yodo；操作本机已登录带有票据的 Chrome 来完成用户任务。
  .yodo 在用户 home 下。跑命令用绝对路径。
  没有 .yodo/src、Node 不够、或初始化不确定：读 install.md。
```

正文从 `1.` 起，不再讲 Node、`setup.js`、怎么拼路径。

### 1. 任务

先查有没有现成的；没有就录用户做一遍；对着抓包试，试通了留下再跑。

```text
查 ──有──► 跑 task ──► 报告
 │
 没有 ──► 录 ──► 试 tmp
                 ├── success ──► mv ──► 跑 task ──► 报告
                 └── 5 次 failure ──► 停，写原因
```

#### 1.1 查

`task/*.js` 是已经跑通的。文件头有 `@summary`，参数对应 `argv`。按用户任务找（怎么查自定）。

能直接跑：`node task/<name>.js <参数>`。连不上或要等人：把 `guide` 原样念给用户，停，等「好了」，再重跑。不轮询，不改写 `guide`。只有 `error`、没有 `status`：停，对人说明没跑起来。`success`：对人说这次做成了什么，用 `result` 或 `resultFile`，念出 `result.url`（直达结果页）。只说任务本身。大结果落同目录 `output.json` 时，打开 `resultFile` 再讲。`failure`：停，说明原因，不改 `task/` 原文件。卡住了杀 `session/pid`（断 CDP，不杀 Chrome）。stdout 不够再看 `session/log.jsonl`。

能拼：在 `tmp/` 写新文件，不改原文件，再 `node tmp/<name>.js`。等人、`error`、`success` 后的 `mv` 再跑 task、报告，都在这一枝写全。`failure` 不到 5 次就改 `tmp/` 再跑；满 5 次就停，写清接口、原因、试了什么，并对人说明做不成。没出现过 `success` 不准进 `task/`。

没有可跑的、又拼不出来：去录。没抓包不要先写脚本探接口。

#### 1.2 录

`node src/bin/record-start.js [name]`。连不上或要等人：把 `guide` 原样念给用户，停，等「好了」，再重跑。`recording`：把 `guide` 原样念给用户，停，等「好了」，再 `node src/bin/record-stop.js`。只在新窗口录。stop / abort 只关录制窗。`stopped` 且有 `recordDir`：去读这个目录。`aborted` / `idle`：停，对人说明这次没有抓到。卡住了杀 `session/pid`。stdout 不够再看 `session/log.jsonl`。

#### 1.3 试

先读 `timeline.jsonl`，定接口，再打开对应 request。只重放抓到的。`late` 的 `mainDoc` 是迟到的页面快照，没有 `method`、也没有 HTTP `status`——在快照里找信息，或对那个 `url` 再做 HTML GET。只发网络请求，不操作 DOM。

写 `tmp/<name>.js`，`node tmp/<name>.js`。等人、5 次、`error` 不算次数，都在这一枝写全。`failure` 且 403 改走页内 XHR。页内太慢就减小数据量。

`success`：补 `@summary`，`mv tmp/<name>.js task/<name>.js`，再 `node task/<name>.js`。这遍的等人、报告再写一遍。5 次 `failure`：停，写清原因，并对人说明做不成。没出现过 `success` 不准进 `task/`。

`need-chrome` / `need-remote-debugging` / `need-allow` / `need-install` 在这一枝碰到了就当场接住：念 `guide`，停，等「好了」，再重跑。

### 2. 目录

路径相对用户 home 下的 `.yodo/`。文中写相对路径，跑命令用绝对路径。

```text
.yodo/
  src/       源码。bin 在 src/bin/。别在这写业务（更新会覆盖）。
  task/      已验证脚本 + _common/。小，任意读。
  tmp/       未验证脚本。唯一能随便写的地方。小，任意读。
  record/    抓包。stop 之后才有可用目录。
             timeline.jsonl              索引。小。
             01_GET_host.json            request。这里的 status 是 HTTP。小。
             01_GET_host.response.json   响应体。大，不要整份读。
             01_GET_host.response.html   整页 HTML。大，不要整份读。
  session/   pid · sock · log.jsonl。
```

`recording` 时不要读 `record/.active/`。

### 3. 脚本

bin 把任务往前推。业务先写在 tmp 里试；试通了，用 mv 挪到 task。task 只收已经跑通的。

#### 3.1 bin

在 `.yodo/src/bin/`。不写业务。

| 脚本 | 做什么 |
|---|---|
| `node src/bin/record-start.js [name]` | 开始抓。连不上或 `recording`：念 `guide`，停，等「好了」，再重跑或跑 `record-stop`。这时没有 `recordDir`，不读 `.active/`。 |
| `node src/bin/record-stop.js` | 归档。`stopped` 且有 `recordDir`：去读。`aborted` / `idle`：停，对人说明没有抓到。 |
| `node src/bin/record-abort.js` | 扔掉这次。`aborted` / `idle`：对人说明。 |
| `node src/bin/start.js` | 拉起并连 Chrome。`ok` 继续。`need-*`：念 `guide`，停，等「好了」，再重跑。 |
| `node src/bin/stop.js` | 停连接。只在用户要求断开时说一声。 |
| `node src/bin/doctor.js` | 排障。给自己看，不整段念给用户。 |

`init.js` 是安装用的，任务里用不到。

#### 3.2 tmp

唯一能随便写的地方。模板、`page.evaluate`、`serializeUrl` 拼 `result.url`、`goto` 没有 `waitUntil`，写在这里。跑通之后的 `mv`、再跑 task、报告，在这一枝写全。不要把 `1.3 试` 里读抓包的步骤抄进来。

#### 3.3 task

只从 tmp `mv` 进来，不新建、不改原文件。`node task/<name>.js [参数]`。头注释写 `@summary` 和 argv。跑的时候等人、报告，在这一枝写全。

#### 3.4 mv

Unix `mv`，不是 yodo 子命令。只有出现过 `status: success` 才能 `mv tmp/<name>.js task/<name>.js`。挪完再跑 task。这遍的等人、报告再写一遍。

---

## `install.md`

安装不是每回合都走。没有 `.yodo/src`、Node 不够、或初始化不确定时才读。概念词按安装来，不套任务那一套。

### 1. 环境

Chrome 得在，Node 得够，两者都齐了才去立 `.yodo`。

#### 1.1 Chrome

只问本机有没有 Google Chrome，不是已经打开，也不是已经开了远程调试。没有就请用户去装：https://www.google.com/chrome/ 。请他装好回「好了」，再看一次。不要抄代码里的路径表。

装好了但还没打开 / 没开调试 / 没点 Allow，不是安装失败。第一次连浏览器时的 `need-*`：把 `guide` 原样念给用户，停，等「好了」，再重跑刚才那条命令。不轮询，不改写 `guide`。

#### 1.2 Node

需要 ≥24。`node -p process.version`。没有，或 major 不够：帮用户装到当前的 Node，装完再查一次。major ≥ 24 才往下走。

### 2. 目录

`.yodo/` 在用户 home 下。能推断就用；不能：`node -p "require('os').homedir()"`，再拼 `.yodo`。跑命令用绝对路径。

| 目录 | 安装要留下 |
|---|---|
| `.yodo/src` | 源码（链接或拷贝）。没有它 = 未初始化 |
| `.yodo/task` | 以后放已验证脚本。安装时带上 `_common/` |
| `.yodo/tmp` | 以后试跑 |
| `.yodo/record` | 以后放抓包 |
| `.yodo/session` | pid · sock · log.jsonl |

`src/` 更新会覆盖，不要在那里写业务。`task/` `tmp/` 是用户的，更新不碰。五个都在，安装才算完。缺一块再跑 `setup.js`；只缺数据目录可以跑 `init.js`。布局仍乱、路径不对、holder 占死，才跑 `doctor`。

### 3. 脚本

setup 一次做完源码就位和建目录。init 只建数据目录。doctor 不推进安装，只在对不上的时候看一眼。

#### 3.1 setup

在 skill 目录（`SKILL.md` 旁边）执行 `node setup.js`。它检查 Node、链或拷 `src/` 到 `.yodo/src`，再调 `init.js`。不碰 `task/` `tmp/` 里的用户脚本。报错就对着这次输出和 `setup.js` 源码给办法。不要另写一个安装脚本。

#### 3.2 init

`node src/bin/init.js`。建 `task/` `tmp/` `record/` `session/`，同步 `_common/`。`setup.js` 已经会调；只缺数据目录时可以单独跑。

#### 3.3 doctor

`node src/bin/doctor.js`。打印 Node、`platform`、`home`、`src` 是链接还是拷贝、四个数据目录、holder 是否占死。给自己看，不整段念给用户。

---

## 落盘

| 文件 | 写 |
|---|---|
| `skills/yodo/SKILL.md` | 按上面 `1. 任务` / `2. 目录` / `3. 脚本` |
| `skills/yodo/install.md` | 按上面 `1. 环境` / `2. 目录` / `3. 脚本` |
| `README.md` | 安装见 `install.md`，任务见 `SKILL.md`。不留 `node setup.js` 步骤 |

不新造 bin。不把 handshake 四层写进 `install.md` 当安装步骤（第一次连上时当场接住）。不把某台机器的绝对路径写进 frontmatter。不把 `yodo run` 写回去。

---

## 上一版哪里错了

把示例词当成了两份文档的公共目录，又用 `a. b. c.` 当下级，流程一节还写成一整块，没有 `1.1 1.2 1.3`。安装也被套成「流程 / 目录 / 脚本」，还一度留下空的 task / tmp / mv。这一版按产品重选词，按序号分层。
