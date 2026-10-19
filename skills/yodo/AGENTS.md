# AGENTS

`user goal` 的处理流程与 规范术语 见 `skills/yodo/SKILL.md`。本文只规定仓库边界、开发验证、分发发布和运行时实现。

yodo 完全以原始源码分发：`skills/yodo/` 整个目录（源码、`scripts/dev`、文档）安装后原样镜像到 `~/.yodo`，本文在 `~/.yodo/AGENTS.md`。文中以仓库为基准的路径，在本机去掉 `skills/yodo/` 前缀即可，如 `skills/yodo/src` → `~/.yodo/src`、`skills/yodo/scripts/dev` → `~/.yodo/scripts/dev`。运行时架构见 `ARCHITECTURE.md`，故障排查见 `TROUBLESHOOTING.md`。遇到问题可以直接读源码并修改；下次升级会覆盖 `~/.yodo/src` 与 `~/.yodo/scripts`。

## 1. 职责边界

### 1.1 分离安装与运行时职责

| 文件 | 职责 |
|---|---|
| `skills/yodo/install.md` | 只负责一次性安装与更新，并在结束前确保本机安装正确 |
| `skills/yodo/SKILL.md` | 只描述安装后的运行时任务；不提及、不跳转到、也不感知 `install.md` |

运行时 skill 不负责安装、更新或环境修复；相关变更只维护在 `install.md` 和仓库开发约束中。

## 2. 开发与验证

源码位于 `skills/yodo/src/`。Node ≥24 通过 strip types 直接运行 `.ts`，不生成编译产物。

### 2.1 本地安装

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，完整执行 `skills/yodo/install.md`。不在本文件重复安装、迁移或验收步骤。

### 2.2 检查与测试

Node strip types 不执行类型检查。运行 check 或 test 前，先安装 `skills/yodo/src/node_modules`；该目录被 gitignore，不进入 payload。

```bash
npm install --prefix skills/yodo/src --omit=optional
npm run check
npm test
npm run verify:pack
```

| 命令 | 作用 |
|---|---|
| `npm run check` | 运行 `tsc --noEmit` |
| `npm test` | 按文件名顺序逐个运行 `*.selfcheck.ts` |
| `npm run verify:pack` | 使用隔离 HOME 执行真实的 `skills add`、setup 和 doctor |

多文件改动时，改完全部文件再一次性跑 `check`/`test`，不要逐文件验证。这几个命令都不是瞬间返回：`check` 要过一遍 `npx` 解析，`test` 里有真实的 `sleep`/超时等待，`verify:pack` 是真实的 `npm install`；跑一次和跑五次的差距是实打实的时间。

### 2.3 dev：本地验证工具

`dev` 服务于本地修改代码、debug、调算法，目的是拿到真实数据和真实现象，不是 CI，也不是通过 / 失败。

**克制原则**（违反任何一条，先删再加）：

1. **体量上限**：`dev` 相关代码（`skills/yodo/src/dev/`、`skills/yodo/scripts/dev/`，不含 `*.selfcheck.*`）总量不超过生产代码的 15%。度量方式：生产代码为 `skills/yodo/src` 下除自检、`dev/` 外的 `.ts/.js/.mjs` 行数。
2. **可整体删除**：生产代码里对 `dev` 只允许一行式调用，不放逻辑。删掉 `src/dev/` 和这些调用后，应用行为完全不变。
3. **零新增运行时依赖**。本机开发工具只用于本地，不进发布内容。
4. **每个能力必须对应一个真实发生过的痛点**，写进提交说明。"将来可能用到"不算理由。
5. **一进一出**：新增一个机制前，先评估能不能删掉旧的某个。
6. **默认关闭，关闭时零行为差异。**

另外：
- 不新增 hub、事件目录、探针、`dev.eval` 等通用机制。需要进入运行中的 holder 时，用 Node 自带的 inspector（`kill -USR1 <holder pid>`）。
- `dev` 不出现在 usage 和 SKILL.md，只写在这里。

**用法**：

- 开关是标记文件：`touch ~/.yodo/session/dev` 开启，`rm ~/.yodo/session/dev` 关闭。holder 每次收到 `dev.*` 请求时检查，不需要重启。
- `dev.pages`：列出扩展纳入的全部 tab（pageId、windowId、url、标题）。`record.start` 之后，录制页的标题是 `yodo record`。
- `dev.cdp { pageId, method, params }`：对该页面发 CDP，包括录制窗口。拒绝 `*.disable`、`Target.*`、`Browser.*`。生产环境的 `cdp.send` 仍然只能在 run 中使用。
- 脚本通过现有的 `sessionRpc` 调用这些 method。`skills/yodo/src/dev/driver.ts` 的 `DevPage` 全部是页面内的 DOM 操作（`goto` 用 `Page.navigate`，`click`、`type`、`press`、`scroll` 用页面脚本），不使用 `Input.*`。录制器不区分事件是否由用户触发，驱动、task-lib 与真人操作都会被录到。
- dev 驱动和 task-lib 的输入行为不同：`DevPage.type` 逐字符写入，每个字符触发一个 `input` 事件；task-lib 的 `fill` 一次写入整个值，只触发一个 `input` 事件。演示里能行、写成 task 后不行时，这是排查时要考虑的一个变量；但它不是抖音"录制窗口能搜索、run 窗口不能"的原因（对照实验排除过），不要一开始就怀疑它。
- 流水线：`runPipeline()` 返回每一级的输入数、输出数和丢弃原因；录制结束时写一行 `pipeline N → M` 日志，`data.stages` 里是各级明细。

```bash
touch ~/.yodo/session/dev
node skills/yodo/scripts/dev/record.mjs [场景.mjs]   # 起夹具 → 录制 → 模拟演示 → 停止，打印汇总并与上一次比较
node skills/yodo/scripts/dev/replay.mjs <录制名>      # 用 dev 模式保存的原始事件离线重放流水线，不需要 Chrome
rm ~/.yodo/session/dev
```

（本机是 `node ~/.yodo/scripts/dev/record.mjs`，其余同理。）`record.mjs` 产生的录制会出现在 `~/.yodo/record/`（以场景名开头），用完自行删除。

**安全**：dev 模式下保存的原始事件是脱敏**之前**的数据，可能含密码和 token。它们只写到 `~/.yodo/dev/`（权限 0600），不进 `record/`，不进发布内容；用完 `rm -rf ~/.yodo/dev`。

## 3. 分发与发布

### 3.1 Skill payload

`skills/yodo/` 是分发 payload：

```text
skills/yodo/
├── src/                     运行时 + 自检 + fixtures + package.json
├── scripts/dev/             dev 驱动与重放脚本
├── setup.js  SKILL.md  install.md  LICENSE
├── AGENTS.md                ← 仓库根目录的 AGENTS.md 是指向它的软链接
├── ARCHITECTURE.md
└── TROUBLESHOOTING.md
```

`setup.js` 把整个目录镜像到 `~/.yodo`（只排除 `node_modules`、`.DS_Store`），然后在 `~/.yodo/src` 里 `npm install`。仓库根目录的 `scripts/`（`verify-pack`、`export-payload`、`dev-install`）、`README.md`、`brand/`、`bench/` 只在仓库里，不分发。文档只在 `skills/yodo/` 里维护一份，不要在别处复制。`npm run dev:install` 和 `verify:pack` 都先用 `git ls-files` 导出文件再安装，保证本地安装与在线安装内容一致。

不要将 `node_modules` 提交到 git 或放入 payload。用户或 agent 运行 `setup.js` 时，才在 `~/.yodo/src` 本地执行 `npm install`。

### 3.2 发布规则

- **安装**：对外安装与更新以 `skills/yodo/install.md` 为准。
- **开发**：可以在任意 branch 开发，不要求同步维护发布文档。
- **发布**：不发布 npm 包，不创建 GitHub Release。release commit 进入 `main` 即完成发布。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布分支

用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，不修改 `main`，也不 push。然后：

1. 把本次版本号改成一致：根 `package.json`、`skills/yodo/src/package.json`，以及 `skills/yodo/src/package-lock.json` 里 yodo 包自己的 `version`。
2. 把本次发布里用户能感知的变化写入 README 的「2.3 更新记录」，版本号与上面相同。

完成后停下来，等用户测试和检查。用户自己 push。

### 3.4 发布到 `main`

用户明确要求“发布到 main”时，将发布分支相对 `main` 的提交压缩为一个提交，合入 `main`。

未收到“发布到 main”时，不得修改或 push `main`。

## 4. 运行时架构

运行时架构（命令入口、relay 与 holder、扩展、窗口、录制、存储与安装）见同目录的 `ARCHITECTURE.md`。
