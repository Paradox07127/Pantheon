# Pantheon 使用说明

[English](usage.md) | 简体中文

> [!WARNING]
> Pantheon 是一个开发中的早期产品，仍处于实验阶段。
> 接口、命令和数据格式可能随时改变，不另行通知。
> 不要把 Pantheon 用于生产工作。

本文介绍桌面端。引号里的名字是界面上显示的名字。

## 安装

在 macOS 和 Linux 上，从本仓库的检出目录运行 Pantheon:

```sh
git clone https://github.com/Paradox07127/Pantheon.git
cd Pantheon
sh scripts/install.sh
pnpm dev
```

要求见[开发说明](development.zh-CN.md#要求)。更新时，先停掉 `pnpm dev`,运行 `git pull` 和 `sh scripts/install.sh`,再运行 `pnpm dev`。

在 Windows 上，或者要用安装包时，从 [Releases 页](https://github.com/Paradox07127/Pantheon/releases)下载。每个 release 都是预发布的测试版，可能比 `main` 旧。
用同一个 release 里的 `SHA256SUMS` 核对下载的文件:`shasum -a 256 -c SHA256SUMS --ignore-missing`。

| 平台              | 文件                        | 安装方法                                                |
| ----------------- | --------------------------- | ------------------------------------------------------- |
| macOS(Apple 芯片) | `Pantheon-<版本>-arm64.dmg` | 打开 dmg,把 Pantheon 拖进"应用程序"。app 已签名并公证。 |
| Linux             | `.deb`                      | `sudo apt install ./pantheon_<版本>_<架构>.deb`         |
| Linux             | `.AppImage`                 | `chmod +x Pantheon-<版本>-<架构>.AppImage`,然后运行它。 |
| Windows           | `.exe`                      | 运行安装程序。先读下面 Windows 的说明。                 |

要自己打安装包，运行 `pnpm package`,并读[开发说明](development.zh-CN.md#打包)。

| 平台    | 安装包                 | 机器上需要的东西                                                      |
| ------- | ---------------------- | --------------------------------------------------------------------- |
| macOS   | `Pantheon.app`、`.dmg` | git 2.38+,以及你要用的运行时 CLI                                      |
| Linux   | AppImage、`.deb`       | git 2.38+、`bubblewrap`、`socat`、`libatomic1`,以及运行时 CLI         |
| Windows | NSIS 安装包            | WSL 2,默认 distro 里有 git 2.38+、`bubblewrap`、`socat`、`libatomic1` |

- 每个安装包自带 Node 26、daemon 和 CLI,不依赖本仓库。
- macOS:app 从登录 shell 的 `PATH` 里找 `claude` 和 `codex`。
- Linux:Ubuntu 上运行 `sudo apt install git bubblewrap socat libatomic1`。自带的 Node 26 链接 `libatomic1`。
- Windows:安装包不签名,SmartScreen 会提示。智能应用控制会拦下安装，要先关掉它。
- Windows:桌面壳跑在 Windows 上。daemon、git、`claude` 和 `codex` 跑在 WSL 2 的默认 distro 里。
- Windows:在 distro 里安装 `claude` 和 `codex`,并在 distro 里登录。
- Windows:首次启动时,app 把安装包里的 `linux-runtime.tar.gz` 解到 distro 的 `${XDG_DATA_HOME:-~/.local/share}/pantheon/runtime/<app 版本>+<压缩包修改时间>`,再经 `wsl.exe` 在 distro 里启动 daemon。
- Windows:仓库放在 distro 的文件系统里。`C:\` 盘的文件夹也能用(经 `/mnt/c`),但文件 IO 慢，文件监听不生效。
- Windows:卸载时可勾选同时删除 Windows 和 WSL 里的 Pantheon 数据。

## 运行时

Pantheon 运行以下原生运行时：

| 运行时      | 可执行文件 | 说明                                   |
| ----------- | ---------- | -------------------------------------- |
| Claude Code | `claude`   | 安装 CLI 并登录。                      |
| Codex       | `codex`    | 安装 CLI 并登录。                      |
| grok        | `grok`     | ACP agent。本机装了，daemon 就登记它。 |
| agy         | `agy`      | ACP agent。本机装了，daemon 就登记它。 |

「设置」>「运行时」显示每个运行时的可执行文件、登录状态和可用模型。
在这一页可以设置运行时的可执行文件路径和启动参数。
daemon 每 5 分钟重新检查一次各运行时。

能力报告(`pnpm cli capabilities`)给出实测结论，不比对本机 CLI 的版本。
Pantheon 只在实测过的平台上沿用这些结论:Claude Code 和 Codex 是 macOS 和 Linux,grok 是 macOS。

## 首次设置

首次启动时,app 显示「首次设置」。
这一页检查运行时和连接(GitHub、Hugging Face、Cloudflare)。
它还让你选编辑器和终端(「打开方式」)。
装好或登录一个工具后，点「重新检测」。

## 打开项目

1. 打开「全部项目」。
2. 点「打开文件夹」,或把文件夹拖到窗口上。「在这台电脑上找到的仓库」列出原生运行时历史里的文件夹。
3. 在对话框里选文件夹、项目名和环境变量。也可以写一个目标。
4. 点「打开项目」。打开项目不会启动运行。

文件夹不是 git 仓库时,Pantheon 运行 `git init` 并提交现有文件。
不想这样，就在「设置」>「项目」里关掉「自动 git init」。之后 Pantheon 拒绝打开这样的文件夹。

## 会话

开会话：打开「会话」,点「新会话」。

| 字段         | 选择                                                            |
| ------------ | --------------------------------------------------------------- |
| 运行时、模型 | 会话的运行时、模型和力度。                                      |
| 「起点」     | 新 worktree 从哪个分支开始。                                    |
| 「在哪里改」 | 「新工作树」新建一个 worktree。「当前目录」直接改这个目录。     |
| 首条消息     | 任务。可以附文件和图片，可以引用 GitHub issue 和 pull request。 |

每个会话有一个权限模式:「逐条审批」「自动编辑」「计划」「全自动」或「完全访问」。
运行时请求权限时，对话里和「需要你」里都出现一张卡。
你可以批准一次请求。请求带规则时，还可以把规则批准到本会话或本项目。
「设置」>「权限」列出项目的规则(「总是允许的规则」)。

回合运行时，你可以再发一条消息,Pantheon 把它插进正在跑的回合。
你可以打断回合，会话保留。
空闲的会话可以压缩上下文(只限 Claude Code 和 Codex)。
回合菜单有「从这里分叉」「回滚」(只退文件、只退对话，或两者都退)和「改写后重发」。
Pantheon 在每个回合前存一个 checkpoint,所以回滚能恢复文件。

会话视图有这些面板：改动、检查、计划、文件和浏览器。
桌面端还在对话下方显示终端。
macOS 上「语音输入」使用系统内置的语音引擎。

## worktree 与沙箱

- Pantheon 用 `git worktree add --detach` 建会话的 worktree。
- Claude Code 和 Codex 的原生沙箱按同一份保护清单配置，只放行 worktree 和会话临时目录的写入。
- 「设置」>「工作树与合并」>「带上这些文件」列出要拷进每个新 worktree 的文件。还可以设一条准备命令，在首个回合前在新 worktree 里运行。
- 拷贝或命令失败时,Pantheon 保留 worktree,关闭会话，状态为 `failed`。
- 「清理」>「清理…」删除会话全部已归档的 worktree。分支和提交保留。

## 审阅与合并

1. 打开改动面板，看 diff。可以给某一行加评论。评论不挡合并。
2. 点「合并到 <目标分支>」。会话必须空闲，没有未提交的改动，并且有新提交。
3. Pantheon 在后台合并：先 rebase,再跑门禁，最后运行 `git merge --ff-only`。
4. 结果是已合并或被挡。被挡后修好原因，再合并一次。

检查面板按失败、通过、跳过、未跑分组显示门禁结果。「重跑门禁」再跑一次门禁。
「丢弃…」结束会话，不合并。
「建 PR」创建 GitHub pull request,需要 `gh` CLI 并登录 GitHub。
会话列表显示合并时可能冲突的文件。

「设置」>「门禁」设置项目的门禁：

- 门禁命令；可以关掉某条命令，或让某条命令失败时记为跳过；
- 门禁失败后怎么办：交回任务、把失败的命令重跑一次，或停下；
- 门禁在哪里跑：候选 clone 里(daemon),或会话 worktree 里。

## 导入外部会话

Pantheon 读取 Claude Code 和 Codex 的原生历史。
「轨迹」把你在 Pantheon 之外、在项目目录里开的会话显示为「外部会话」。

1. 打开「轨迹」,找到这个外部会话。
2. 点「在 Pantheon 里继续」。
3. 会话在原目录续接。Pantheon 不开 worktree,改动直接写进这个目录。

这个原生会话被 Pantheon 之外的进程占着时,Pantheon 拒绝续接。先在那个终端里关掉它。

## 项目看板

「项目看板」显示一个项目的工作。

- 「新 lead」开一个 lead 会话。lead 写任务和里程碑的计划。
- 在顶部的输入条里写需求,Pantheon 把它发给最新的 lead。回执按收到、排队、拆计划、建任务四步推进。
- 每个任务在自己的任务会话和 worktree 里运行，经门禁合并。
- 当前里程碑卡显示已合并和计划的任务数、验收标准和「验收」按钮。
- 「需要你」列出要你处理的事项，例如审批。
- 流程图显示任务和依赖。拖一条连线就加一个依赖。
- 任务抽屉显示任务的路由、改动、检查和上下游。可以改运行时、模型和力度，也可以停止、重派或删除任务。
- 看板的时间范围可选 1、3、7、14、30 天或全部。

## 工程看板

「工程看板」有三个分页：

| 分页     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 「迭代」 | 项目的迭代。                                             |
| 「协作」 | lead 和任务会话之间的消息、子 agent、模型变更。          |
| 「流程」 | 命名工作流。可以编辑、复制、设为默认。改动先按试用保存。 |

## 轨迹

「轨迹」显示项目里各会话做了什么，有四个分页:「时间轴」「运行」「活动」「诊断」。
时间轴每个会话一条泳道，外部会话也在内。
可以回放一个回合，查看某一步的文件改动。
「诊断」基于记下的证据另开一个只读的分析会话。

## 记忆

「记忆」保存项目的决定、报告和笔记，有四个分页:「总览」「条目」「图谱」「经验」。

- agent 提交草稿。你确认之前，草稿不生效。
- 由你确认、归档和恢复条目。
- 每次发消息前,Pantheon 把当前记忆送给会话。
- 「经验」显示学到的经验和试用结果。

存储、预算与边界见[项目记忆](memory.md)。

## 设置

「设置」以对话框打开。第一组对整个 app 生效，第二组对当前项目生效。

| 页面             | 内容                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| 「通用」         | 语言、app 图标、关闭窗口后继续运行、合并后自动归档会话。             |
| 「外观」         | 主题、强调色、字体、字号、密度、布局宽度。                           |
| 「会话显示」     | 对话里显示和折叠哪些内容。                                           |
| 「差异视图」     | 统一或分栏视图、折叠、空白、换行。                                   |
| 「运行时」       | 可执行文件、登录、模型、可执行文件路径和启动参数。                   |
| 「打开方式」     | 编辑器、终端和浏览器。                                               |
| 「连接」         | GitHub(`gh`)、Hugging Face(`hf`)、Cloudflare(`wrangler`)的登录状态。 |
| 「设备」         | 本机，以及经 SSH 连接的其他机器。                                    |
| 「通知」         | 哪些事件通知你，以及勿扰时段。                                       |
| 「快捷键」       | 键盘快捷键。                                                         |
| 「数据」         | 数据目录、诊断日志、个人设置的导入和导出。                           |
| 「关于」         | 版本、daemon 状态、日志目录。                                        |
| 「门禁」         | 项目的门禁命令。                                                     |
| 「工作树与合并」 | 要带上的文件、准备命令、自动合并、清理。                             |
| 「权限」         | 项目的总是允许的规则。                                               |
| 「外部请求」     | 外部请求的来源，以及何时需要你批准。                                 |
| 「流程」         | 流程参数、任务预算和项目预算。                                       |
| 「默认模型」     | 各角色的模型和路由表。                                               |
| 「用量」         | 预算、额度阈值和 token 目标。                                        |
| 「扩展」         | 项目打开的 MCP 服务、skill、插件和 Hooks。                           |
| 「项目」         | 项目设置，包括「自动 git init」。                                    |

- **主题。** 可选内置主题「石灰华」「暮色」「青金」「陶土」。也可以让会话做一个主题：会话调用 `theme.set` 工具,Pantheon 应用这个主题。主题可以删除。
- **快捷键。** 按名字或按键搜索。点「录制」改一个快捷键。「全部恢复默认」重置所有快捷键。
- **设备。** 点「添加设备」,填 `~/.ssh/config` 里的主机名。Pantheon 经 SSH 检查系统、运行时版本和登录状态。每台设备可以设标签、资源和会话上限，也可以重新探测。

## 数据与安全

- macOS 上默认数据目录是 `~/Library/Application Support/Pantheon/`。Linux 和 WSL 上是 `${XDG_DATA_HOME:-~/.local/share}/pantheon/data`。
- 用 `--data-dir /absolute/path` 或 `PANTHEON_DATA_DIR` 指定别的数据目录。数据目录必须在项目之外。
- 用户级设置(例如运行时的可执行文件和参数)在 `~/.pantheon/config.json`。
- daemon 只监听 `127.0.0.1`。
- `daemon.json` 是发现文件(权限 0600)。`user.token` 保存本机用户凭证。不要把 token 放进 URL、仓库或模型上下文。
- 关闭客户端不会停掉会话。用 `pnpm start` 启动的 daemon,按 Ctrl-C 停止。
- Pantheon 不为 daemon 注册用户级 LaunchAgent。

## CLI

在检出目录里用 `pnpm cli` 运行 CLI。CLI 从数据目录读 `daemon.json` 和凭证。

| 命令                                                  | 结果                          |
| ----------------------------------------------------- | ----------------------------- |
| `pnpm cli health`                                     | 服务名、协议版本、版本。      |
| `pnpm cli capabilities`                               | 每个适配器的能力报告。        |
| `pnpm cli board --project PROJECT_ID`                 | 看板快照。                    |
| `pnpm cli events --after 0 --project PROJECT_ID`      | 某个游标之后的持久事件。      |
| `pnpm cli command --file /absolute/path/command.json` | 执行一个命令信封。            |
| `pnpm cli mcp`                                        | 给原生会话用的 MCP 工具服务。 |

每条命令都接受 `--data-dir DIR`。命令信封和查询见[接口](api.md)。
