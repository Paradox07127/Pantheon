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

「全部项目」里每个项目显示「等你决定」和数量，点它打开项目，只列等你处理的会话，旁边是按类型的数量。「你离开后」一行给出简报，点它打开这个项目的会话。

文件夹不是 git 仓库时,Pantheon 运行 `git init` 并提交现有文件。
不想这样，就在「设置」>「项目」里关掉「自动 git init」。之后 Pantheon 拒绝打开这样的文件夹。

## 会话

开会话：打开「会话」,点「新会话」。

| 字段         | 选择                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时、模型 | 会话的运行时、模型和力度。                                                                                                                  |
| 「起点」     | 新 worktree 从哪个分支开始。                                                                                                                |
| 「在哪里改」 | 「当前目录」直接在项目目录的当前分支上改。「新工作树」新建一个 worktree。不选时用当前目录;目录里已有会话在改、或选了起点时，用新 worktree。 |
| 首条消息     | 任务。可以附文件和图片，可以引用 GitHub issue 和 pull request。                                                                             |

每个会话有一个权限模式:「逐条审批」「自动编辑」「计划」「全自动」或「完全访问」。
运行时请求权限时，对话里和「需要你」里都出现一张卡。
你可以批准一次请求。请求带规则时，还可以把规则批准到本会话或本项目。
「设置」>「权限」列出项目的规则(「总是允许的规则」)。

回合运行时，你可以再发一条消息。发送键默认把它排队，⌘↵(非 macOS 用 Ctrl+Enter)把它插进正在跑的回合。「设置」>「会话显示」>「运行中发的消息」把两者对调：选「插话」，发送键插话，⌘↵ 排队；选「排队」恢复默认。
你可以打断回合，会话保留。
空闲的会话可以压缩上下文(只限 Claude Code 和 Codex)。
回合菜单有「从这里分叉」「回滚」(只退文件、只退对话，或两者都退)和「改写后重发」。
Pantheon 在每个回合前存一个 checkpoint,所以回滚能恢复文件。

会话视图有这些面板：改动、检查、计划和浏览器。
会话可以在对话里画统计图、关系图、Mermaid 图、表格和沙箱页面。「钉到图解」把它放到「记忆」的「图解」分页上。
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
- 门禁失败后怎么办：交回修、把失败的命令重跑一次，或停下；
- 门禁在哪里跑：候选 clone 里(daemon),或会话 worktree 里。

门禁命令不套沙箱。它们拿到的环境和你开的会话一样：项目变量加 daemon 的环境。桌面端用登录 shell 的 PATH 启动 daemon。Pantheon 记下被测提交、每条命令、退出码和输出。

门禁跑的是被测提交里的文件，所以改这些文件的改动要等你批。一次合并或落地的改动碰到门禁命令点名的仓库文件，或项目 `protected_paths`(`project.gate.set`)里的路径时，不落地。会话合并进「待办」,原因是 `gate_files_changed`,并列出这些文件;「仍然落地」放行。`pantheon land` 打印这些文件和放行它们的命令(`--allow-gate-change`)。门禁通过的测试比同名门禁在这个分支上次落地时少，或跳过的多，同样不落地，原因是 `tests_dropped`,带上两边的数;「仍然落地」和 `--allow-gate-change` 放行。

## 导入外部会话

Pantheon 读取 Claude Code 和 Codex 的原生历史。
「轨迹」把你在 Pantheon 之外、在项目目录里开的会话显示为「外部会话」。

1. 打开「轨迹」,找到这个外部会话。
2. 点「在 Pantheon 里继续」。
3. 会话在原目录续接。Pantheon 不开 worktree,改动直接写进这个目录。

这个原生会话被 Pantheon 之外的进程占着时,Pantheon 拒绝续接。先在那个终端里关掉它。

## 带 Pantheon 工具的会话

`session.create` 命令里写 `"purpose": "conductor"` 开的会话，多下面这些 Pantheon 工具。在 app 里，开始新会话前打开消息框下面那一排的「主 agent」开关(皇冠图标)。会话列表和会话栏用皇冠标出这个会话，列表的类型筛选里有「主 agent」一类。会话用它自己运行时的工具做计划、拆活和跑子 agent。

- `request_review`:另一家厂商的运行时审这个会话或它起的会话已提交的改动。结果作为一条消息回到会话。
- `report_ready`:已提交的改动过项目门禁并落地。这份工作最近一次审查还有未解决的阻塞发现时,Pantheon 拒绝。你自己点「合并到 <目标分支>」不受这条限制。
- `spawn_session`:从当前提交切一个新 worktree,起另一个运行时的会话。新会话不带 Pantheon 工具。它的权限模式是「逐条审批」(`ask`),工具要求时是「自动编辑」(`auto_edit`);别的模式会被拒绝。它的回合结束或失败时，起它的会话收到一条消息。一个会话起的会话里，同时最多 4 个在跑回合。项目用完预算时,Pantheon 拒绝。`acceptance` 写完成标准：第一条消息末尾带上这张清单，对这个会话的 `request_review` 让审查者逐条给出结论和依据。`owns` 写这个会话可以改的路径;`read_state` 列出它改到这些路径之外的文件。用 `runtimes` 代替 `runtime`,同一个任务在两到三个运行时上各起一个会话，各用运行时的默认模型，每个都占 4 个名额之一。要留下最好的结果：逐个审，用 `report_ready` 落地其中一个，用 `stop_session` 关掉其余的。
- `message_session`:给它起的会话发一条消息，作为新回合(`send`)或插进正在跑的回合(`steer`)。每个会话每分钟最多收 2 条。
- `stop_session`:打断它起的会话正在跑的回合。带 `close` 时关闭那个会话并丢弃它的 worktree。
- `read_state`:项目的改动、它们的检查、落地队列和等你处理的事。另外列出它起的每个会话：状态，输入、输出和缓存读取 token,回合数和回合用时;运行时没报的数不写。
- `read_needs_you`:等你处理的事，不带处理它们的操作。只有你能处理。
- `project_read`:项目的设置、简介和记忆。
- `memory_context`、`memory_search`、`memory_related`、`memory_get`:读项目记忆。Pantheon 不把记忆加进这个会话的回合。
- `memory_propose`:写一条记忆。决定在你确认前一直是草稿。
- `draw`:在对话里画一张你能看到的图表或示意图。

这个会话只能给它自己起的会话发消息、打断和关闭。

## 轨迹

「轨迹」显示项目里各会话做了什么，有五个分页:「时间轴」「运行」「活动」「诊断」「替你批准的」。
时间轴每个会话一条泳道，外部会话也在内。
可以回放一个回合，查看某一步的文件改动。
「诊断」基于记下的证据另开一个只读的分析会话。
「替你批准的」列出已存规则没经过你批准的事，带原因和规则。「通知」打开每种决定的送达方式。

## 记忆

「记忆」保存项目的决定、报告和笔记，有三个分页:「总览」「条目」「图解」。

- agent 提交草稿。你确认之前，草稿不生效。
- 由你确认、归档和恢复条目。
- 每次发消息前,Pantheon 只把当前记忆送给它自己起的、带记忆工具的会话：新项目搭建、摸底、项目简介、改动说明和审查会话。你开的会话收不到。
- 条目详情显示会话上次读它的时间(「上次读取」)。会话提交的带文件引用的条目，显示核对时的提交(「核对于」)。
- agent 的笔记 90 天没有会话读过就过期:「已过期：90 天没被读过」。决定、报告、交接笔记、导入的条目和你自己的条目不这样过期。

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
| 「通知」         | 每种决定怎样送达你、勿扰时段、声音、应用图标上的数量。               |
| 「快捷键」       | 键盘快捷键。                                                         |
| 「数据」         | 数据目录、诊断日志、个人设置的导入和导出。                           |
| 「关于」         | 版本、daemon 状态、日志目录。                                        |
| 「门禁」         | 项目的门禁命令和环境检查。                                           |
| 「工作树与合并」 | 要带上的文件、准备命令、清理。                                       |
| 「权限」         | 项目的总是允许的规则。                                               |
| 「默认模型」     | 各角色的模型。                                                       |
| 「扩展」         | 项目打开的 MCP 服务、skill、插件和 Hooks。                           |
| 「项目」         | 项目设置,包括「自动 git init」和 token 预算。                        |

- **快捷键。** 按名字或按键搜索。点「录制」改一个快捷键。「全部恢复默认」重置所有快捷键。
- **通知。** 每种决定和合并可选「立即」「仅简报」或「从不」。勿扰时段里，「立即」按「仅简报」处理。等了超过 4 小时的问题总会通知你。
- **环境。** 「门禁」页上的「检查环境」按会话拿到 worktree 的方式准备一份新 worktree,再在里面跑门禁命令。基线确认卡上有同样的检查，查的是基线提议的命令；其中有命令失败时，写基线的 agent 修一次。
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

在检出目录里用 `pnpm cli` 运行 CLI。打包版(macOS 和 Linux)应用菜单里的「安装命令行工具…」写出 `~/.local/bin/pantheon`,之后在任何目录用 `pantheon` 跑同样的命令。CLI 从数据目录读 `daemon.json` 和凭证。

| 命令                                                                | 结果                                      |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `pnpm cli health`                                                   | 服务名、协议版本、版本。                  |
| `pnpm cli capabilities`                                             | 每个适配器的能力报告。                    |
| `pnpm cli board --project PROJECT_ID`                               | 项目的状态快照。                          |
| `pnpm cli events --after 0 --project PROJECT_ID`                    | 某个游标之后的持久事件。                  |
| `pnpm cli command --file /absolute/path/command.json`               | 执行一个命令信封。                        |
| `pnpm cli mcp`                                                      | 给原生会话用的 MCP 工具服务。             |
| `pnpm cli mcp --personal`                                           | 给你自己的 agent 用的 MCP 工具服务。      |
| `pnpm cli review --base REF [HEAD]` 或 `pnpm cli review BASE..HEAD` | 审查从两个 ref 的合并基点到 head 的提交。 |
| `pnpm cli review resolve REVIEW_ID FINDING_ID OUTCOME`              | 记下一条发现的结论。                      |
| `pnpm cli land [BRANCH]`                                            | 让一个分支过项目门禁后落地。              |

`pnpm cli review` 只审已提交的内容；不给 head 时审当前目录的分支。每个审查 runtime 加一次 `--runtime NAME`。`--fallback NAME` 按顺序给出接替的 runtime:某个审查者的回合因用量上限结束时由它接手。它等到结果，打印未关闭的发现和每个审查者的结论。退出码：每个审查者都通过为 0;有阻塞发现或 fail 结论为 1;审查失败、不完整、被拒或读不到 daemon 为 2;用法错误为 64。Ctrl-C 只停止等待，审查继续。

`--focus TEXT`(最多 2000 字符)告诉审查者重点看什么，放在审查输入里目标之后。`--paths A,B` 只审这些仓库相对路径(最多 500 个)的改动，作为一次审查;删除的文件照给出的路径一并审，不打印 `LEFT OUT` 行。不带 `--paths` 时，整段 diff 超过 150 KB 的范围按文件切成多段：每段不超过 150 KB,单个超大文件单独一段，最多 8 段;需要更多段时拒绝，请用 `--paths` 缩小范围。删除的文件不进任何一段，列在一行 `LEFT OUT (deleted): ...` 里。每段是一次单独的审查：先打印 `PART i/n` 和审查 id,再打印该段的发现和结论;最后一段结束后每段打印一行结论和阻塞发现数。退出码：任一段阻塞为 1;否则任一段没通过为 2;否则为 0。

`pnpm cli review resolve` 把一条发现记为 `fixed`、`intentional`、`not_worth_it` 或 `wrong`,`--note TEXT` 记下原因。对已有结论的发现再记一次，新结论替换旧的;`review.finding_resolved` 事件在 `previous` 里留下旧结论。

`pnpm cli land` 把分支(缺省为当前目录的分支)落到项目目录当前检出的分支上。项目目录要配了门禁。`--message TEXT` 把这些提交合成一个提交落地。退出码：已落地或没有改动为 0;落地受阻或被拒为 1。因门禁文件被改而挡下时，它打出带 `--allow-gate-change` 的放行命令。

```sh
pnpm cli review --base main
pnpm cli land my-feature --message "Add the export button"
```

每条命令都接受 `--data-dir DIR`。命令信封和查询见[接口](api.md)。

## 接入你自己的 agent

你日常用的 agent(Claude Code、Codex、Claude Desktop,或任何能跑本地 stdio MCP 服务的 agent)拿一把个人密钥，就能跨你的 Pantheon 项目工作。只有本机的 agent 能接入:daemon 只监听 `127.0.0.1`。

1. 创建密钥。用 `pnpm cli command --file key.json` 发一条 `personal.key.create` 命令，[命令信封](api.md)里写 `"actor": "local-user"` 和 `"input": {"label": "My agent"}`。回执给出 `key_id` 和 `token_file`。daemon 把 token 写进 `token_file`,只有你能读。
2. 把服务加进 agent 的 MCP 配置。`token_file` 路径原样使用：服务从文件名读出密钥 id。

```json
{
  "mcpServers": {
    "pantheon": {
      "command": "node",
      "args": ["/absolute/path/to/pantheon/apps/cli/dist/index.js", "mcp", "--personal"],
      "env": { "PANTHEON_PERSONAL_TOKEN_FILE": "/absolute/path/of/token_file" }
    }
  }
}
```

agent 能做的：

- 读每个项目的概况(`projects_overview`)、等你处理的事(`needs_you`)、一个项目的简报(`project_brief`)和没经过你做出的决定(`project_decisions`)。

agent 不能读会话、回答提问或权限请求，也不能上传附件。用 `personal.key.revoke` 吊销密钥,agent 立刻失去访问。
