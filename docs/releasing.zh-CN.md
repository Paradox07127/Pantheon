# 发布 Pantheon

[English](releasing.md) | 简体中文

> [!WARNING]
> Pantheon 是一个开发中的早期产品，仍处于实验阶段。
> 每个 release 都是测试版，在 GitHub 上标为预发布(Pre-release)。

## 版本号

Pantheon 用 `0.1.0-dev.<YYYYMMDD>`,例如 `0.1.0-dev.20261115`。

- 日期是打发布包的那一天。
- 同一天再发一次，加序号:`0.1.0-dev.20261115.2`。
- git tag 是 `v` 加版本号:`v0.1.0-dev.20261115`。
- 这个版本号是合法的 semver。electron-builder 要求 semver。
- 不要把日期当成版本号的一段，例如 `0.20261115.0`。Windows 每段版本号只有 16 位,20261115 放不下。

## 步骤

1. 选 `main` 上的一个提交。这个提交的 CI 必须是绿的。
2. 在打包机器上跑检查：

   ```sh
   pnpm install --frozen-lockfile
   pnpm test
   pnpm format:check
   node scripts/api-doc.mjs --check
   node scripts/check-design.mjs
   ```

3. 改工作区里每个 `package.json` 的版本号，并提交：

   ```sh
   V=0.1.0-dev.20261115
   pnpm -r --include-workspace-root exec npm pkg set version=$V
   git commit -am "chore: release $V"
   git tag -a v$V -m "Pantheon $V"
   ```

4. 在 Mac 上打每个目标的包。目标和签名设置见[开发说明](development.zh-CN.md#打包)。

   ```sh
   rm -rf apps/desktop/release
   for t in mac-arm64 win-x64 win-arm64 linux-x64 linux-arm64; do pnpm package --target $t; done
   ```

5. 写校验和：

   ```sh
   cd apps/desktop/release
   shasum -a 256 *.dmg *.exe *.AppImage *.deb > SHA256SUMS
   ```

6. 做下一节的冒烟测试。
7. 推送提交和 tag,再建预发布：

   ```sh
   git push origin main v$V
   gh release create v$V --prerelease --title "Pantheon $V" --notes-file <notes.md> \
     apps/desktop/release/*.dmg apps/desktop/release/*.exe \
     apps/desktop/release/*.AppImage apps/desktop/release/*.deb apps/desktop/release/SHA256SUMS
   ```

## 冒烟测试

| 安装包                  | 测试                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| macOS `.dmg`            | `xcrun stapler validate <dmg>` 和 `spctl -a -vv -t install <dmg>` 通过。从 dmg 打开 app,窗口连上自己的 daemon。 |
| Linux `.deb`            | 在干净的 Ubuntu 容器里安装。自带的 daemon 能启动，自带的 CLI 的 `health` 有应答。                               |
| Linux AppImage          | `--appimage-extract` 能解包，解出的 daemon 能用自带的 Node 启动。                                               |
| Windows 安装程序(x64)   | 在装了 WSL 2 的 Windows 11 上安装。app 在 WSL 里拉起 daemon,并显示项目列表。                                    |
| Windows 安装程序(arm64) | 没有在实机上测过。在 release 说明里写明。                                                                       |

## Release 说明

说明开头放实验阶段的提示。然后写：

- 平台表：每个安装包，以及它有没有在实机上测过；
- 和上一个 release 相比的主要改动；
- 已知限制，附 issue 链接。
