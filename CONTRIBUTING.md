# Contributing to Pantheon

English | [简体中文](CONTRIBUTING.zh-CN.md)

Pantheon is an early-stage, experimental product. Interfaces and data formats still change often.
Before you start a large change, open an issue and describe the change. This prevents work on a part that is about to change.

## Set up

The [development guide](docs/development.md) gives the requirements, the build, the tests and the scripts.
The [architecture notes](docs/architecture.md) describe the packages and the control modules.

## Before you open a pull request

Run these commands. CI runs the same checks on Linux.

```sh
pnpm test
pnpm format:check
node scripts/api-doc.mjs --check
node scripts/check-design.mjs
```

- Put each new test in the `tests/<area>/` directory of the code that it tests.
- Tests use only fixture adapters. A test must not call a real model or need an account.
- If you change `packages/protocol`, run `pnpm build && node scripts/api-doc.mjs` and commit the updated `docs/api.md`.
- If you change behavior that a document describes, change the document in the same pull request.

## Conventions

- Interface text goes through `t({ id, defaultMessage })`. Write the English text in `defaultMessage` and the Simplified Chinese text in `apps/web/src/i18n/locales/zh-CN/<area>.json`.
- Read [`apps/web/DESIGN.md`](apps/web/DESIGN.md) before you change `apps/web/src`.
- Commit titles are one line in English, with a type prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:` or `chore:`. An optional scope goes in parentheses, for example `fix(sessions): …`.
- Keep a pull request to one change. Split unrelated changes.

## Report a bug

Use the bug report form in the issue tracker. Give the Pantheon version, the OS and architecture, and the runtime and its version.
Remove tokens, account names and private paths from the logs before you attach them.

To report a security problem, follow [SECURITY.md](SECURITY.md). Do not open a public issue for it.

## License

Pantheon uses the [Apache License 2.0](LICENSE).
When you submit a contribution, you agree that it is licensed under the same license (section 5 of the license).
