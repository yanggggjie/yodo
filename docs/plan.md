# 拆 `install.md`

SKILL 正文现在同时写「初始化」和「做用户任务」。初始化不是每回合都走，却挡在 process 前面，路径 / Node / `setup.js` 还写了两遍。拆出去。

旧的「统一概念」稿已执行，本文件改记这一刀。

---

## 落盘

| 文件 | 写 |
|---|---|
| `skills/yodo/install.md` | 初始化的唯一正文。进 skill payload，和 `SKILL.md` 一起分发 |
| `skills/yodo/SKILL.md` frontmatter | `.yodo` 路径结论 + 何时读 `install.md` |
| `skills/yodo/SKILL.md` 正文 | 只留用户任务 process。删 Node / 路径 / `setup.js` 段 |
| `README.md` | 不复述步骤；安装见 `install.md` |

`docs/plan.md` 只是本计划。AGENTS.md 仍写改源码时的 `setup.js`（链到本 repo），不搬。

---

## `install.md` 写什么

Agent 按顺序做。每步有完成条件。不新造脚本：Node 用 `node -p` / `setup.js` 自己的门；Chrome 是否安装用现有 `need-install`（`chromeAppPath()` 已在 `connect.ts`）；布局用 `ls` 或 `doctor`。

1. **路径**  
   `.yodo/` = `os.homedir()` 下的 `.yodo`。跑命令用绝对路径。能推断就用；不能：`node -p "require('os').homedir()"`，再拼 `.yodo`。  
   完成：手上有一条绝对根路径。

2. **Node**  
   需要 ≥24。`node -p process.version`。不够就停，让人升级。  
   完成：major ≥ 24。

3. **Chrome 已安装**  
   指本机有 Google Chrome，不是已开、也不是 remote-debugging。未装会在第一次需要浏览器时拿到 `need-install` + `guide`。install 阶段能事先确认更好，但不要把 `connect.ts` 的路径表抄进文档——那是代码的 SoT。  
   完成：能指出 Chrome 在，或已决定交给第一次连接的 `need-install`。

4. **`.yodo/src`**  
   没有 `src/` = 未初始化。在 **skill 目录**（`SKILL.md` 旁边）执行 `node setup.js`。它检查 Node、链或拷 `src/`、再调 `init.js` 建 `task/` `tmp/` `record/` `session/`。  
   完成：绝对路径下存在 `src/`（链接或拷贝）。

5. **验收**  
   `src/`、`task/`、`tmp/`、`record/`、`session/` 都在。缺一块再跑 `setup.js` 或 `src/bin/init.js`。布局仍乱、路径不对、holder 占死才跑 `doctor`。  
   完成：上述目录都在。此时 yodo 已初始化，可以做用户任务。

**不算初始化：** Chrome 已开、remote-debugging、Allow 弹窗。那些是第一次连浏览器的 `need-*`，`guide` 在 SKILL 的 `status` 表，不进 `install.md`。

---

## SKILL frontmatter

`description` 做两件事：触发用户任务，以及把初始化指到 `install.md`。路径结论写在这里（每回合都用），步骤不写。

拟用：

```yaml
description: >-
  触发词 yodo；操作本机已登录带有票据的 Chrome 来完成用户任务。
  .yodo 在用户 home 下。跑命令用绝对路径。
  没有 .yodo/src、Node 不够、或初始化不确定：读 install.md。
```

正文开头不再讲 Node、`setup.js`、如何拼路径。目录树和命令表仍留 SKILL（做用户任务时要查）。

---

## 不做

- 不为 install 再加一个 `bin` / `doctor` 替身。
- 不把 handshake 四层写进 `install.md`。
- 不把 `.yodo` 的绝对路径写死进 frontmatter（每台机器不同）。
- README 不保留第二份 `node setup.js` 步骤。
