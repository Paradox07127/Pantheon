# Pantheon 开发说明

[English](development.md) | 简体中文

> [!WARNING]
> Pantheon 是一个开发中的早期产品，仍处于实验阶段。
> 接口、命令和数据格式可能随时改变，不另行通知。
> 不要把 Pantheon 用于生产工作。

## 要求

| 工具             | 版本或来源                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| Node             | 26(准确版本见根 `package.json` 的 `devEngines.runtime`;`engines` 是 `>=26 <27`) |
| pnpm             | 12.11.2(根 `package.json` 的 `packageManager`)                                  |
| git              | 较新的版本即可                                                                  |
| Xcode 命令行工具 | 只限 macOS。`pnpm dev` 和 `pnpm package` 用 `xcrun swiftc` 编译语音引擎。       |
| Docker           | 只有 `scripts/linux-test.mjs` 需要                                              |

## 安装与构建

```sh
sh scripts/install.sh
```

`scripts/install.sh` 检查 Node 和 pnpm 的版本，运行 `pnpm install --frozen-lockfile`,再运行 `pnpm build`。
也可以自己逐步运行：

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 和 `pnpm typecheck` 都运行 `tsc -b`,也检查测试的类型。

## 测试

```sh
pnpm test
pnpm build && pnpm exec vitest run
pnpm build && pnpm exec vitest run tests/control/<文件>.test.ts
```

- `pnpm test` 先构建，再跑除 `tests/acceptance/acceptance-reproducibility.test.ts`(约 56 秒)以外的全部测试。
- 第二条命令跑全部测试。
- 第三条命令跑一个测试文件。
- 测试从构建产物导入包。改了源码后先 `pnpm build`。
- 单元和集成测试只用 fixture 适配器，不调用真实模型。
- CI(`.github/workflows/ci.yml`)在 Linux 上跑构建、各项检查，以及分成 3 份并行的 `pnpm test` 测试。它不跑验收案例、复现测试和打包。

新测试放进 `tests/<区域>/`。共用的 helper 在 `tests/helpers.ts`,用 `../helpers.js` 引入。

| 目录                | 内容                                       |
| ------------------- | ------------------------------------------ |
| `tests/adapters/`   | 运行时适配器，含一个假的 ACP agent         |
| `tests/cli/`        | CLI 的 MCP 工具                            |
| `tests/control/`    | 控制逻辑：会话、worktree、门禁、看板、记忆 |
| `tests/daemon/`     | HTTP 和 WebSocket 服务                     |
| `tests/desktop/`    | Electron 壳和打包脚本                      |
| `tests/protocol/`   | schema 和生成的接口表                      |
| `tests/store/`      | SQLite 存储和迁移                          |
| `tests/web/`        | Web 界面，含 i18n catalog 守卫             |
| `tests/scripts/`    | 脚本的单元测试                             |
| `tests/acceptance/` | 产品验收 driver、场景、fixture 和库        |
| `tests/eval/`       | 评测运行器和冻结任务                       |
| `tests/fixtures/`   | 测试读的固定数据                           |

## 运行

| 命令              | 结果                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `pnpm dev`        | 运行 `tsc -b --watch` 和桌面端。重新构建后，桌面端重载它的 daemon。  |
| `pnpm relaunch`   | 停掉正在跑的开发版 app 和它的 daemon,构建，再在前台运行 `pnpm dev`。 |
| `pnpm demo`       | 在临时仓库里用脚本化的 fixture agent 走一遍工作台流程。              |
| `pnpm start`      | 只运行 daemon。                                                      |
| `pnpm cli <命令>` | 运行 CLI。见[使用说明](usage.zh-CN.md#cli)。                         |

`pnpm relaunch`:

- 停掉本检出目录的 `pnpm dev`(启动脚本、Electron、electron-vite、`tsc --watch`)。
- 停掉数据目录里由本检出目录启动的 daemon。
- 还有会话在运行时，它不动手。加 `--force` 才会打断这些会话。
- `--dry-run` 只列出会停掉的进程。
- 别的 worktree、验收脚本打开的窗口和别的数据目录的 daemon 不受影响。

`pnpm demo` 在 `node_modules/.cache` 下新建一个临时 git 仓库和一个 daemon。
它打开项目，建一个 fixture 会话，在会话的 worktree 里提交，合并回临时仓库，最后清理。
它不调用模型，不修改你的项目。

`pnpm start` 接受这些选项：

| 选项                   | 作用                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `--data-dir /abs/path` | 数据目录。`PANTHEON_DATA_DIR` 作用相同。                      |
| `--port N`             | HTTP 端口。不给时 daemon 选一个空闲端口，写进 `daemon.json`。 |
| `--allow-fixture`      | 登记测试运行时 `fixture` 和脚本化的 `fixture-agent`。         |

## 打包

```sh
pnpm package
pnpm package --target win-x64
pnpm package --target linux-arm64
```

产物在 `apps/desktop/release/`。每个安装包自带 Node 26、daemon 和 CLI。
所有目标都能在 macOS 上打。Windows 目标不需要 Wine。

| `--target`                 | 产物                                                |
| -------------------------- | --------------------------------------------------- |
| `mac-arm64`(默认)          | 签名并公证的 `Pantheon.app` 和 `.dmg`               |
| `linux-x64`、`linux-arm64` | AppImage 和 `.deb`                                  |
| `win-x64`、`win-arm64`     | NSIS 安装包，内含给 WSL 用的 `linux-runtime.tar.gz` |

macOS 签名与公证：

- 构建用钥匙串里的 Developer ID Application 证书签名，启用 hardened runtime。
- entitlements 在 `apps/desktop/build/entitlements.mac.plist`。
- app 和 dmg 都公证并 staple。
- 没有证书或没有公证凭据时，构建失败。
- 先把凭据存成一次 notarytool 钥匙串项 `pantheon-notary`。可以用 Apple ID 加 app 专用密码，也可以用 App Store Connect API key:

```sh
xcrun notarytool store-credentials pantheon-notary --key <AuthKey.p8> --key-id <Key ID> --issuer <Issuer ID>
```

- 换钥匙串项的名字，设 `APPLE_KEYCHAIN_PROFILE`。
- Windows 安装包不签名。
- 在路径短的检出目录里打 Windows 包。检出路径太长时 `makensis` 会以 `SIGABRT` 退出(约 100 个字符时出现过)。

各平台运行时的要求见[使用说明](usage.zh-CN.md#安装)。

## 仓库结构

| 目录                | 内容                                                 |
| ------------------- | ---------------------------------------------------- |
| `packages/domain`   | 对象类型、`DomainError`、纯函数                      |
| `packages/protocol` | 命令和查询的 schema、MCP 工具表、路径                |
| `packages/store`    | SQLite 状态、事件、outbox、迁移                      |
| `packages/adapters` | Claude、Codex、ACP 和 fixture 适配器，能力报告，预检 |
| `packages/control`  | 工作台后端：命令、会话、worktree、门禁、合并、恢复   |
| `apps/daemon`       | HTTP 和 WebSocket 服务                               |
| `apps/cli`          | CLI 和 MCP 工具服务                                  |
| `apps/web`          | React 界面                                           |
| `apps/desktop`      | Electron 壳                                          |
| `scripts/`          | 安装、运行、打包、验收、评测、探测                   |

细节见[架构](architecture.md)。

## 设计检查

```sh
pnpm check:design
```

这条命令检查验收案例正本(`tests/acceptance/cases.json`)和文档里的本地链接。

## 验收

```sh
node scripts/acceptance.mjs --list
node scripts/acceptance.mjs --case A001 --driver tests/acceptance/driver.mjs --out <新目录>
```

| 选项           | 作用                                       |
| -------------- | ------------------------------------------ |
| `--list`       | 列出案例。                                 |
| `--case <id>`  | 跑一个案例。                               |
| `--driver`     | 产品 driver。不给时不跑任何案例。          |
| `--out <目录>` | 输出目录，必须是新的路径。                 |
| `--allow-live` | 允许跑 `live` 案例。这些案例调用真实模型。 |

- driver 注册的场景见 `tests/acceptance/scenarios/index.mjs`。
- 场景先于功能写成。功能实现前，场景判 FAILED,退出码 1。
- 没有场景的案例返回 `NOT_IMPLEMENTED`,退出码 2。driver 不会悄悄跳过这些案例，也不把它们当作通过。
- 要人工确认的案例由 driver 写审阅请求。用 `node scripts/acceptance-review.mjs [--store <目录>] <案例 id>` 逐项确认并写回执。driver 只核对回执。
- 跑界面场景前，先运行 `pnpm --filter @pantheon/desktop bundle`。
- `node tests/acceptance/memory-catalog-smoke.mjs` 在隔离的数据库和 Electron 实例里检查记忆屏。先构建桌面端。它不启动模型。

## 评测

`scripts/eval.mjs` 量合并的结果里有多少通不过隐藏检查。冻结任务取自本仓库的提交历史。

| 命令                                                    | 作用                                           |
| ------------------------------------------------------- | ---------------------------------------------- |
| `node scripts/eval.mjs check [任务名...]`               | 核对每个隐藏检查在起点上失败、在原提交上通过。 |
| `node scripts/eval.mjs run --runtime fixture`           | 不用模型自检评测运行器。                       |
| `node scripts/eval.mjs run --runtime reference`         | 用写出原提交内容的 fixture 跑冻结任务。        |
| `node scripts/eval.mjs run --runtime codex` 或 `claude` | 用真实模型跑冻结任务。                         |
| `node scripts/eval.mjs report <运行目录>`               | 按运行目录重出报告。                           |

`run` 还接受 `--task <名字>`(可多次)、`--repetitions <n>`、`--workspace <目录>` 和 `--out <目录>`。
`codex` 或 `claude` 的运行用真实 home 和真实模型。工作区默认在 `~/.pantheon-eval/`,`--workspace` 必须在本检出目录之外。

## 探测

| 命令                                | 作用                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `pnpm probe`                        | 检查 Claude 和 Codex 的版本、登录类型和协议握手。         |
| `pnpm probe --live`                 | 另外调用真实模型。                                        |
| `node scripts/probe-acp.mjs`        | 对 agy 和 grok 做 ACP 握手。                              |
| `node scripts/probe-acp.mjs --live` | 在 fixture 仓库上检查文本、续聊、权限、取消和目录外写入。 |

- 两个探测脚本都接受 `--out <目录>`。`probe-acp.mjs` 还接受 `--runtime <名字>`。
- 用 `--live` 之前，先定好账号和预算。脚本拒绝未经确认的订阅登录，不把 API key 环境变量传给运行时。

## 其他脚本

| 命令                                        | 作用                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/linux-test.mjs [命令]`        | 把检出目录(含未提交和未跟踪的文件，不含被忽略的文件)拷进装了 git、bubblewrap、socat、nc 的特权 Docker 容器。容器的 Node 版本取根 `package.json` 的 `devEngines.runtime`。装好依赖后运行命令(默认 `pnpm test`)。 |
| `node scripts/benchmark-session-search.mjs` | 在 `pnpm build` 之后量会话搜索。单次查询超过 100 ms 就失败。                                                                                                                                                    |
| `node scripts/refresh-leaderboards.mjs`     | 读取公开排行榜，写 `~/.pantheon/leaderboards.json`(`--out` 可改)。路由表把它当作先验。                                                                                                                          |

## 接口文档

`docs/api.md` 里有生成的命令和查询表。
改了 `packages/protocol` 后运行：

```sh
pnpm build && node scripts/api-doc.mjs
```

表过期时 `tests/protocol/api-doc.test.ts` 失败。不要手改生成的部分。

## 界面文案与设计

- 界面显示的所有文字(含 `aria-label`)都来自 `apps/web/src/i18n` 的 `t({ id, defaultMessage })`。
- 英文写在 `defaultMessage` 里。英文没有 catalog。
- 简体中文写在 `apps/web/src/i18n/locales/zh-CN/<区域>.json`。
- 数量用 ICU 复数。不要拼接句子片段。
- `tests/web/i18n-catalog.test.ts` 守着这些规则。
- 改 `apps/web/src` 之前先读 [`apps/web/DESIGN.md`](../apps/web/DESIGN.md)。它规定界面层次、颜色、字体、文案、快捷键和动效。

## 格式

```sh
pnpm format:check
```

这条命令用 Prettier 检查 TypeScript 源码、测试和验收脚本。
配置在根 `package.json` 的 `prettier` 字段。要修正一个文件，运行 `pnpm exec prettier --write <文件>`。
