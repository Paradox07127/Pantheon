# 参与 Pantheon 开发

[English](CONTRIBUTING.md) | 简体中文

Pantheon 是一个早期的实验产品，接口和数据格式还会经常改变。
开始一个大改动之前，先开一个 issue 说明要改什么，免得在马上要变的部分上白做工。

## 准备

[开发说明](docs/development.zh-CN.md)写了环境要求、构建、测试和脚本。
[架构说明](docs/architecture.md)介绍各个包和 control 模块。

## 提 pull request 之前

运行下面的命令。CI 在 Linux 上跑同样的检查。

```sh
pnpm test
pnpm format:check
node scripts/api-doc.mjs --check
node scripts/check-design.mjs
```

- 新测试放进被测代码对应的 `tests/<区域>/` 目录。
- 测试只用 fixture 适配器，不能调用真实模型，也不能依赖账号。
- 改了 `packages/protocol`,运行 `pnpm build && node scripts/api-doc.mjs`,并提交更新后的 `docs/api.md`。
- 改了文档描述的行为，在同一个 pull request 里改文档。

## 约定

- 界面文案经 `t({ id, defaultMessage })` 取。英文写在 `defaultMessage`,简体中文写进 `apps/web/src/i18n/locales/zh-CN/<区域>.json`。
- 改 `apps/web/src` 之前读 [`apps/web/DESIGN.md`](apps/web/DESIGN.md)。
- 提交标题用一行英文，带类型前缀:`feat:`、`fix:`、`refactor:`、`docs:`、`test:` 或 `chore:`。范围可选，写在括号里，例如 `fix(sessions): …`。
- 一个 pull request 只做一件事。无关的改动拆开提。

## 报告 bug

用 issue 里的 bug 报告表单。写明 Pantheon 版本、系统和架构、运行时及其版本。
附日志之前，删掉里面的 token、账号名和私人路径。

安全问题按 [SECURITY.md](SECURITY.md) 报告，不要开公开 issue。

## 许可证

Pantheon 使用 [Apache License 2.0](LICENSE)。
提交贡献即表示你同意该贡献按同一许可证授权(许可证第 5 条)。
