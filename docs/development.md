# Developing Pantheon

English | [简体中文](development.zh-CN.md)

> [!WARNING]
> Pantheon is an early-stage product under development. It is experimental.
> Interfaces, commands and data formats can change without notice.
> Do not use Pantheon for production work.

## Requirements

| Tool                     | Version or source                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Node                     | 26 (`devEngines.runtime` in the root `package.json` gives the exact version; `engines` is `>=26 <27`) |
| pnpm                     | 12.11.2 (`packageManager` in the root `package.json`)                                                 |
| git                      | Any recent version                                                                                    |
| Xcode command line tools | macOS only. `pnpm dev` and `pnpm package` compile the voice engine with `xcrun swiftc`.               |
| Docker                   | Only for `scripts/linux-test.mjs`                                                                     |

## Install and build

```sh
sh scripts/install.sh
```

`scripts/install.sh` checks the Node and pnpm versions, runs `pnpm install --frozen-lockfile` and runs `pnpm build`.
You can also run the steps yourself:

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` and `pnpm typecheck` both run `tsc -b`. They also check the types of the tests.

## Test

```sh
pnpm test
pnpm build && pnpm exec vitest run
pnpm build && pnpm exec vitest run tests/control/<file>.test.ts
```

- `pnpm test` builds and runs all tests except `tests/acceptance/acceptance-reproducibility.test.ts` (about 56 seconds).
- The second command runs all tests.
- The third command runs one test file.
- Tests import the packages from the build output. Run `pnpm build` after you change the source.
- Unit and integration tests use only fixture adapters. They do not call a real model.
- CI (`.github/workflows/ci.yml`) runs the build, the checks and the tests of `pnpm test` in 3 parallel shards on Linux. It does not run the acceptance cases, the reproducibility test or packaging.

Put a new test in `tests/<area>/`. Import the shared helpers from `tests/helpers.ts` as `../helpers.js`.

| Directory           | Content                                                    |
| ------------------- | ---------------------------------------------------------- |
| `tests/adapters/`   | Runtime adapters, including a fake ACP agent               |
| `tests/cli/`        | MCP tools of the CLI                                       |
| `tests/control/`    | Control logic: sessions, worktrees, gates, board, memory   |
| `tests/daemon/`     | HTTP and WebSocket service                                 |
| `tests/desktop/`    | Electron shell and packaging script                        |
| `tests/protocol/`   | Schemas and the generated API tables                       |
| `tests/store/`      | SQLite store and migrations                                |
| `tests/web/`        | Web interface, including the i18n catalog guard            |
| `tests/scripts/`    | Unit tests of the scripts                                  |
| `tests/acceptance/` | Product acceptance driver, scenarios, fixtures and library |
| `tests/eval/`       | Eval runner and frozen tasks                               |
| `tests/fixtures/`   | Fixed data that tests read                                 |

## Run

| Command          | Result                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`       | Runs `tsc -b --watch` and the desktop app. The app reloads its daemon after a rebuild.    |
| `pnpm relaunch`  | Stops the running dev app and its daemon, builds, then runs `pnpm dev` in the foreground. |
| `pnpm demo`      | Runs the workbench flow with a scripted fixture agent in a temporary repository.          |
| `pnpm start`     | Runs only the daemon.                                                                     |
| `pnpm cli <cmd>` | Runs the CLI. See the [usage guide](usage.md#cli).                                        |

`pnpm relaunch`:

- It stops the `pnpm dev` of this checkout (the start script, Electron, electron-vite and `tsc --watch`).
- It stops the daemon that this checkout started in the data directory.
- If sessions still run, it does nothing. Add `--force` to cut off these sessions.
- `--dry-run` only lists the processes that it would stop.
- It does not touch other worktrees, windows that acceptance scripts opened, or daemons of other data directories.

`pnpm demo` creates a temporary git repository and a daemon under `node_modules/.cache`.
It opens a project, creates a fixture session, commits in the worktree of the session, merges into the temporary repository and cleans up.
It does not call a model and does not change your projects.

`pnpm start` accepts these options:

| Option                 | Effect                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `--data-dir /abs/path` | Data directory. `PANTHEON_DATA_DIR` has the same effect.                            |
| `--port N`             | HTTP port. Without it, the daemon picks a free port and writes it to `daemon.json`. |
| `--allow-fixture`      | Registers the test runtimes `fixture` and the scripted `fixture-agent`.             |

## Packaging

```sh
pnpm package
pnpm package --target win-x64
pnpm package --target linux-arm64
```

The output is in `apps/desktop/release/`. Each package contains Node 26, the daemon and the CLI.
All targets build on macOS. Windows targets do not need Wine.

| `--target`                 | Output                                                      |
| -------------------------- | ----------------------------------------------------------- |
| `mac-arm64` (default)      | Signed and notarized `Pantheon.app` and `.dmg`              |
| `linux-x64`, `linux-arm64` | AppImage and `.deb`                                         |
| `win-x64`, `win-arm64`     | NSIS installer that contains `linux-runtime.tar.gz` for WSL |

macOS signing and notarization:

- The build signs with a Developer ID Application certificate from the keychain, with the hardened runtime.
- The entitlements are in `apps/desktop/build/entitlements.mac.plist`.
- The build notarizes and staples both the app and the dmg.
- Without a certificate or notarization credentials, the build fails.
- Store the credentials once as the notarytool keychain profile `pantheon-notary`. Use an Apple ID with an app-specific password, or an App Store Connect API key:

```sh
xcrun notarytool store-credentials pantheon-notary --key <AuthKey.p8> --key-id <Key ID> --issuer <Issuer ID>
```

- To use another profile name, set `APPLE_KEYCHAIN_PROFILE`.
- The Windows installer is not signed.
- Build the Windows targets from a checkout with a short path. `makensis` stops with `SIGABRT` when the checkout path is long (seen at about 100 characters).

The [usage guide](usage.md#install) gives the run-time needs of each platform.

## Repository layout

| Directory           | Content                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `packages/domain`   | Object types, `DomainError`, pure functions                               |
| `packages/protocol` | Command and query schemas, MCP tool table, paths                          |
| `packages/store`    | SQLite state, events, outbox, migrations                                  |
| `packages/adapters` | Claude, Codex, ACP and fixture adapters, capability report, preflight     |
| `packages/control`  | Workbench back end: commands, sessions, worktrees, gates, merge, recovery |
| `apps/daemon`       | HTTP and WebSocket service                                                |
| `apps/cli`          | CLI and the MCP tool server                                               |
| `apps/web`          | React interface                                                           |
| `apps/desktop`      | Electron shell                                                            |
| `scripts/`          | Install, run, package, acceptance, eval, probes                           |

[Architecture](architecture.md) (in Chinese) gives the details.

## Design check

```sh
pnpm check:design
```

This command checks the acceptance case catalog (`tests/acceptance/cases.json`) and the local links in the docs.

## Acceptance

```sh
node scripts/acceptance.mjs --list
node scripts/acceptance.mjs --case A001 --driver tests/acceptance/driver.mjs --out <new directory>
```

| Option         | Effect                                             |
| -------------- | -------------------------------------------------- |
| `--list`       | Lists the cases.                                   |
| `--case <id>`  | Runs one case.                                     |
| `--driver`     | The product driver. Without it, no case runs.      |
| `--out <dir>`  | Output directory. It must be a new path.           |
| `--allow-live` | Allows `live` cases. These cases call real models. |

- `tests/acceptance/scenarios/index.mjs` registers the scenarios of the driver.
- A scenario is written before its feature. Before the feature works, the scenario reports FAILED with exit code 1.
- A case without a scenario reports `NOT_IMPLEMENTED` with exit code 2. The driver does not skip such cases or count them as passed.
- For a case that needs a person, the driver writes a review request. Run `node scripts/acceptance-review.mjs [--store <dir>] <case id>` to confirm each item and write a receipt. The driver only checks the receipt.
- Before you run an interface scenario, run `pnpm --filter @pantheon/desktop bundle`.
- `node tests/acceptance/memory-catalog-smoke.mjs` checks the memory screen in an isolated database and Electron instance. Build the desktop app first. It does not start a model.

## Eval

`scripts/eval.mjs` measures how many merged results fail hidden checks. The frozen tasks come from the history of this repository.

| Command                                                 | Effect                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `node scripts/eval.mjs check [task...]`                 | Checks that each hidden check fails at the start point and passes at the source commit. |
| `node scripts/eval.mjs run --runtime fixture`           | Tests the eval runner without a model.                                                  |
| `node scripts/eval.mjs run --runtime reference`         | Runs the frozen tasks with a fixture that writes the source commit.                     |
| `node scripts/eval.mjs run --runtime codex` or `claude` | Runs the frozen tasks with a real model.                                                |
| `node scripts/eval.mjs report <run dir>`                | Writes the report again from a run directory.                                           |

`run` also accepts `--task <name>` (more than once), `--repetitions <n>`, `--workspace <dir>` and `--out <dir>`.
A `codex` or `claude` run uses the real home folder and a real model. Its workspace is `~/.pantheon-eval/` by default, and `--workspace` must be outside this checkout.

## Probes

| Command                             | Effect                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm probe`                        | Checks the version, the sign-in type and the protocol handshake of Claude and Codex.           |
| `pnpm probe --live`                 | Also calls real models.                                                                        |
| `node scripts/probe-acp.mjs`        | ACP handshake with agy and grok.                                                               |
| `node scripts/probe-acp.mjs --live` | Runs text, resume, permission, cancel and outside-folder write checks on a fixture repository. |

- Both probes accept `--out <dir>`. `probe-acp.mjs` also accepts `--runtime <name>`.
- Before you use `--live`, decide the account and the budget. The script refuses a subscription sign-in that you did not confirm. It does not pass API key environment variables to the runtimes.

## Other scripts

| Command                                     | Effect                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/linux-test.mjs [command]`     | Copies the checkout (with uncommitted and untracked files, without ignored files) into a privileged Docker container with git, bubblewrap, socat and nc. The container uses the Node version from `devEngines.runtime` in the root `package.json`. It installs the dependencies and runs the command (default `pnpm test`). |
| `node scripts/benchmark-session-search.mjs` | After `pnpm build`, measures session search. It fails if one query takes more than 100 ms.                                                                                                                                                                                                                                  |
| `node scripts/refresh-leaderboards.mjs`     | Reads public leaderboards and writes `~/.pantheon/leaderboards.json` (`--out` sets another file). The routing table uses it as a prior.                                                                                                                                                                                     |

## API reference

`docs/api.md` has generated command and query tables.
After you change `packages/protocol`, run:

```sh
pnpm build && node scripts/api-doc.mjs
```

`tests/protocol/api-doc.test.ts` fails when the tables are out of date. Do not edit the generated part by hand.

## Interface text and design

- All text that the interface shows, including `aria-label`s, comes from `t({ id, defaultMessage })` in `apps/web/src/i18n`.
- Write the English text in `defaultMessage`. English has no catalog.
- Write the Simplified Chinese text in `apps/web/src/i18n/locales/zh-CN/<area>.json`.
- Use ICU plurals for counts. Do not join sentence fragments.
- `tests/web/i18n-catalog.test.ts` guards these rules.
- Read [`apps/web/DESIGN.md`](../apps/web/DESIGN.md) before you change `apps/web/src`. It gives the rules for surfaces, colour, type, text, shortcuts and motion.

## Formatting

```sh
pnpm format:check
```

This command runs Prettier on the TypeScript sources, the tests and the acceptance scripts.
The settings are in the `prettier` field of the root `package.json`. To fix a file, run `pnpm exec prettier --write <file>`.
