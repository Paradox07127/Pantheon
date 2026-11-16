# Using Pantheon

English | [简体中文](usage.zh-CN.md)

> [!WARNING]
> Pantheon is an early-stage product under development. It is experimental.
> Interfaces, commands and data formats can change without notice.
> Do not use Pantheon for production work.

This guide describes the desktop app. The names in quotes are the names that the app shows.

## Install

Download a package from the [Releases page](https://github.com/Paradox07127/Pantheon/releases). Each release is a pre-release test build.
Check the download against `SHA256SUMS` from the same release: `shasum -a 256 -c SHA256SUMS --ignore-missing`.

| Platform           | File                           | Install                                                                          |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------- |
| macOS (Apple chip) | `Pantheon-<version>-arm64.dmg` | Open the dmg and drag Pantheon to Applications. The app is signed and notarized. |
| Linux              | `.deb`                         | `sudo apt install ./pantheon_<version>_<arch>.deb`                               |
| Linux              | `.AppImage`                    | `chmod +x Pantheon-<version>-<arch>.AppImage`, then run it.                      |
| Windows            | `.exe`                         | Run the installer. Read the Windows notes below first.                           |

To build the app from source, follow the [development guide](development.md).
You can run the app from the checkout with `pnpm dev`, or package it with `pnpm package`.

| Platform | Package                | What you need on the machine                                                        |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| macOS    | `Pantheon.app`, `.dmg` | git 2.38+, and the runtime CLIs that you use                                        |
| Linux    | AppImage, `.deb`       | git 2.38+, `bubblewrap`, `socat`, `libatomic1`, and the runtime CLIs                |
| Windows  | NSIS installer         | WSL 2 with a default distro that has git 2.38+, `bubblewrap`, `socat`, `libatomic1` |

- Each package contains Node 26, the daemon and the CLI. It does not need this repository.
- macOS: the app finds `claude` and `codex` in the `PATH` of your login shell.
- Linux: on Ubuntu, run `sudo apt install git bubblewrap socat libatomic1`. The bundled Node 26 links `libatomic1`.
- Windows: the installer is not signed. SmartScreen shows a warning. Smart App Control blocks the installation, so turn it off first.
- Windows: the desktop shell runs on Windows. The daemon, git, `claude` and `codex` run in the default WSL 2 distro.
- Windows: install `claude` and `codex` in the distro and sign in there.
- Windows: at the first start, the app unpacks `linux-runtime.tar.gz` from the installer into `${XDG_DATA_HOME:-~/.local/share}/pantheon/runtime/<app version>+<archive modification time>` in the distro. Then it starts the daemon in the distro through `wsl.exe`.
- Windows: keep your repositories in the file system of the distro. A folder on `C:\` also works (through `/mnt/c`), but file IO is slow and file watching does not work.
- Windows: the uninstaller can also delete the Pantheon data in Windows and in WSL. Select the option to do this.

## Runtimes

Pantheon runs these native runtimes:

| Runtime     | Executable | Notes                                                    |
| ----------- | ---------- | -------------------------------------------------------- |
| Claude Code | `claude`   | Install the CLI and sign in.                             |
| Codex       | `codex`    | Install the CLI and sign in.                             |
| grok        | `grok`     | ACP agent. The daemon registers it when it is installed. |
| agy         | `agy`      | ACP agent. The daemon registers it when it is installed. |

"Settings" > "Runtimes" shows the executable, the sign-in state and the available models of each runtime.
On that page you can set the binary path and the launch arguments of a runtime.
The daemon checks each runtime again every 5 minutes.

The capability report (`pnpm cli capabilities`) gives tested results. It does not compare them with the local CLI version.
Pantheon uses these results only on the tested platforms: Claude Code and Codex on macOS and Linux, grok on macOS.

## First-time setup

At the first start, the app shows "First-time setup".
This page checks the runtimes and the connections (GitHub, Hugging Face, Cloudflare).
It also asks which editor and which terminal to use ("Open with").
Click "Check again" after you install or sign in to a tool.

## Open a project

1. Open "All projects".
2. Click "Open folder", or drop a folder on the window. "Repositories found on this computer" lists folders from the history of your native runtimes.
3. In the dialog, choose the folders, the project name and the environment variables. You can also write a goal.
4. Click "Open project". Opening a project does not start a run.

If a folder is not a git repository, Pantheon runs `git init` and commits the existing files.
To prevent this, turn off "Automatic git init" in "Settings" > "Project". Pantheon then refuses to open such a folder.

## Sessions

To start a session, open "Sessions" and click "New session".

| Field             | Choice                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Runtime, model    | The runtime, the model and the effort of the session.                                    |
| "Start point"     | The branch that the new worktree starts from.                                            |
| "Where to change" | "New worktree" creates a new worktree. "Current folder" changes the folder directly.     |
| First message     | The task. You can attach files and images, and refer to GitHub issues and pull requests. |

Each session has a permission mode: "Manual", "Auto edit", "Plan", "Auto" or "Full access".
When a runtime asks for permission, a card shows in the conversation and in "Needs you".
You can approve one request. If the request has a rule, you can also approve the rule for the session or for the project.
"Settings" > "Permissions" lists the project rules ("Always-allowed rules").

While a turn runs, you can send another message. Pantheon inserts it into the running turn.
You can interrupt the turn and keep the session.
You can compact the context of an idle session (Claude Code and Codex only).
The turn menu has "Fork from here", "Roll back" (files only, conversation only, or both) and "Rewrite and resend".
Pantheon keeps a checkpoint before each turn, so a roll back can restore the files.

The session view has panels: changes, checks, plan, files and browser.
The desktop app also shows a terminal under the conversation.
On macOS, voice input uses the built-in speech engine.

## Worktrees and the sandbox

- Pantheon creates the worktree of a session with `git worktree add --detach`.
- The native sandboxes of Claude Code and Codex use the same protection list. They allow writes only to the worktree and to the temporary folder of the session.
- "Settings" > "Worktrees and merging" > "Copy these files" lists files that Pantheon copies into each new worktree. A preparation command can also run in each new worktree before the first turn.
- If the copy or the command fails, Pantheon keeps the worktree and closes the session with the state `failed`.
- "Cleanup" > "Clean up…" deletes the worktrees whose sessions are all archived. Branches and commits stay.

## Review and merge

1. Open the changes panel. Read the diff. You can add a comment to a line. Comments do not block a merge.
2. Click "Merge into <target>". The session must be idle, have no uncommitted changes and have new commits.
3. Pantheon merges in the background: it rebases the commits, runs the gate and then runs `git merge --ff-only`.
4. The result is merged or blocked. After a block, fix the cause and merge again.

The checks panel shows the gate results in groups: failed, passed, skipped and not run. "Rerun gates" runs the gate again.
"Discard…" ends the session without a merge.
"Create pull request" opens a GitHub pull request. It needs the `gh` CLI and a GitHub sign-in.
The session list shows the files that will probably conflict when you merge.

"Settings" > "Gates" sets the gate of the project:

- the gate commands; you can turn off a command, or let a command be skipped when it fails;
- what to do when the gate fails: hand the task back, retry the failed commands once, or stop;
- where the gate runs: in a candidate clone (daemon) or in the session worktree.

## Import an external session

Pantheon reads the native history of Claude Code and Codex.
"Trace" shows the sessions that you started outside Pantheon in the project folders as "External session".

1. Open "Trace" and find the external session.
2. Click "Continue in Pantheon".
3. The session continues in its original folder. Pantheon does not create a worktree. The changes go directly into that folder.

If a process outside Pantheon holds the native session, Pantheon refuses to continue it. Close the session in that terminal first.

## Project board

The "Project board" shows the work of a project.

- "New lead" starts a lead session. The lead writes a plan of tasks and milestones.
- Write a requirement in the bar at the top. Pantheon sends it to the newest lead. A receipt shows the steps: received, queued, planning and creating tasks.
- Each task runs in its own task session and worktree, and merges through the gate.
- The current milestone card shows the merged and planned tasks, the acceptance criteria and "Accept".
- "Needs you" lists the items that need your action, such as approvals.
- The flow chart shows the tasks and their dependencies. To add a dependency, drag a connection.
- The task drawer shows the route, the changes, the checks and the dependencies of a task. You can change the runtime, model and effort, or stop, restart or delete the task.
- You can choose the time range of the board: 1, 3, 7, 14 or 30 days, or all time.

## Engineering board

The "Engineering board" has three tabs:

| Tab             | Content                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| "Iterations"    | The iterations of the project.                                                   |
| "Collaboration" | Messages between leads and task sessions, sub-agents and model changes.          |
| "Workflow"      | Named workflows. You can edit, copy and set the default. Edits start as a trial. |

## Trace

"Trace" shows what the sessions of a project did. It has four tabs: "Timeline", "Runs", "Activity" and "Diagnose".
The timeline shows one lane for each session, including external sessions.
You can replay a turn and see the file changes of one step.
"Diagnose" starts a separate read-only analysis session on the recorded evidence.

## Memory

"Memory" keeps project decisions, reports and notes. It has four tabs: "Overview", "Entries", "Graph" and "Learned".

- Agents propose drafts. A draft has no effect until you confirm it.
- You confirm, archive and restore entries.
- Pantheon sends the current memory to a session before each message.
- "Learned" shows the learned lessons and their trial results.

[Project memory](memory.md) (in Chinese) describes storage, budgets and limits.

## Settings

"Settings" opens as a dialog. The first group applies to the app. The second group applies to the current project.

| Page                    | Content                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| "General"               | Language, app icon, run after the window closes, archive sessions after merge.   |
| "Appearance"            | Theme, accent colour, fonts, text sizes, density, layout widths.                 |
| "Session display"       | What the conversation shows and folds.                                           |
| "Diff view"             | Unified or split view, folding, whitespace, line wrap.                           |
| "Runtimes"              | Executable, sign-in, models, binary path and launch arguments.                   |
| "Open with"             | Editor, terminal and browser.                                                    |
| "Connections"           | Sign-in state of GitHub (`gh`), Hugging Face (`hf`) and Cloudflare (`wrangler`). |
| "Devices"               | This computer and other machines over SSH.                                       |
| "Notifications"         | Which events notify you, and quiet hours.                                        |
| "Shortcuts"             | Keyboard shortcuts.                                                              |
| "Data"                  | Data folder, diagnostic log, import and export of personal settings.             |
| "About"                 | Versions, daemon state, logs folder.                                             |
| "Gates"                 | Gate commands of the project.                                                    |
| "Worktrees and merging" | Files to copy, preparation command, automatic merge, cleanup.                    |
| "Permissions"           | Always-allowed rules of the project.                                             |
| "External requests"     | Sources of external requests and when they need your approval.                   |
| "Workflow"              | Workflow parameters, task budget and project budget.                             |
| "Default model"         | Model for each role and the routing table.                                       |
| "Usage"                 | Budget, quota threshold and token targets.                                       |
| "Extensions"            | MCP servers, skills, plugins and hooks that the project opens.                   |
| "Project"               | Project settings, including "Automatic git init".                                |

- **Themes.** Choose a built-in theme: "Travertine", "Dusk", "Lapis" or "Terracotta". You can also ask a session to make a theme. The session calls the `theme.set` tool, and Pantheon applies the theme. You can delete a theme.
- **Shortcuts.** Search by name or by keys. Click "Record keys" to change a shortcut. "Restore all defaults" resets all shortcuts.
- **Devices.** Click "Add device" and enter a host name from `~/.ssh/config`. Pantheon checks the system, the runtime versions and the sign-in state over SSH. You can set labels, resources and the session limit of each device, and probe it again.

## Data and security

- The default data directory on macOS is `~/Library/Application Support/Pantheon/`. On Linux and in WSL it is `${XDG_DATA_HOME:-~/.local/share}/pantheon/data`.
- Use `--data-dir /absolute/path` or `PANTHEON_DATA_DIR` to set another data directory. The data directory must be outside the projects.
- User settings, such as runtime executables and arguments, are in `~/.pantheon/config.json`.
- The daemon listens only on `127.0.0.1`.
- `daemon.json` is the discovery file (mode 0600). `user.token` holds the local user credential. Do not put the token in a URL, a repository or a model context.
- Closing a client does not stop the sessions. To stop a daemon that you started with `pnpm start`, press Ctrl-C.
- Pantheon does not register a user LaunchAgent for the daemon.

## CLI

In a checkout, run the CLI with `pnpm cli`. The CLI reads `daemon.json` and the token from the data directory.

| Command                                               | Result                                   |
| ----------------------------------------------------- | ---------------------------------------- |
| `pnpm cli health`                                     | Service name, protocol version, version. |
| `pnpm cli capabilities`                               | Capability report of each adapter.       |
| `pnpm cli board --project PROJECT_ID`                 | Board snapshot.                          |
| `pnpm cli events --after 0 --project PROJECT_ID`      | Stored events after a cursor.            |
| `pnpm cli command --file /absolute/path/command.json` | Runs one command envelope.               |
| `pnpm cli mcp`                                        | MCP tool server for a native session.    |

Each command accepts `--data-dir DIR`. The [API reference](api.md) describes the command envelope and the queries.
