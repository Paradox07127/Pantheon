# Using Pantheon

English | [简体中文](usage.zh-CN.md)

> [!WARNING]
> Pantheon is an early-stage product under development. It is experimental.
> Interfaces, commands and data formats can change without notice.
> Do not use Pantheon for production work.

This guide describes the desktop app. The names in quotes are the names that the app shows.

## Install

On macOS and Linux, run Pantheon from a checkout of this repository:

```sh
git clone https://github.com/Paradox07127/Pantheon.git
cd Pantheon
sh scripts/install.sh
pnpm dev
```

The [development guide](development.md#requirements) gives the requirements. To update, stop `pnpm dev`, run `git pull` and `sh scripts/install.sh`, then run `pnpm dev` again.

On Windows, or to use a package, download it from the [Releases page](https://github.com/Paradox07127/Pantheon/releases). Each release is a pre-release test build, and it can be older than `main`.
Check the download against `SHA256SUMS` from the same release: `shasum -a 256 -c SHA256SUMS --ignore-missing`.

| Platform           | File                           | Install                                                                          |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------- |
| macOS (Apple chip) | `Pantheon-<version>-arm64.dmg` | Open the dmg and drag Pantheon to Applications. The app is signed and notarized. |
| Linux              | `.deb`                         | `sudo apt install ./pantheon_<version>_<arch>.deb`                               |
| Linux              | `.AppImage`                    | `chmod +x Pantheon-<version>-<arch>.AppImage`, then run it.                      |
| Windows            | `.exe`                         | Run the installer. Read the Windows notes below first.                           |

To build the packages yourself, run `pnpm package` and read the [development guide](development.md#packaging).

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

Each project in "All projects" shows "Decisions waiting" with the count; click it to open the project with only the sessions that wait for you. The counts by kind are beside it. A line "Since you left" gives the short brief; click it to open the sessions of the project.

If a folder is not a git repository, Pantheon runs `git init` and commits the existing files.
To prevent this, turn off "Automatic git init" in "Settings" > "Project". Pantheon then refuses to open such a folder.

## Sessions

To start a session, open "Sessions" and click "New session".

| Field             | Choice                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime, model    | The runtime, the model and the effort of the session.                                                                                                                                                                                                                     |
| "Start point"     | The branch that the new worktree starts from.                                                                                                                                                                                                                             |
| "Where to change" | "Current folder" changes the project folder on its current branch. "New worktree" creates a new worktree. Without a choice, the session uses the current folder; it uses a new worktree when another session already writes in the folder or when you pick a start point. |
| First message     | The task. You can attach files and images, and refer to GitHub issues and pull requests.                                                                                                                                                                                  |

Each session has a permission mode: "Manual", "Auto edit", "Plan", "Auto" or "Full access".
When a runtime asks for permission, a card shows in the conversation and in "Needs you".
You can approve one request. If the request has a rule, you can also approve the rule for the session or for the project.
"Settings" > "Permissions" lists the project rules ("Always-allowed rules").

While a turn runs, you can send another message. The send key queues it by default, and ⌘↵ (Ctrl+Enter outside macOS) steers it into the running turn. "Settings" > "Session display" > "Messages sent while running" swaps the two: choose "Steer" and the send key steers while ⌘↵ queues; choose "Queue" for the default.
You can interrupt the turn and keep the session.
You can compact the context of an idle session (Claude Code and Codex only).
The turn menu has "Fork from here", "Roll back" (files only, conversation only, or both) and "Rewrite and resend".
Pantheon keeps a checkpoint before each turn, so a roll back can restore the files.

The session view has panels: changes, checks, plan and browser.
A session can draw charts, graphs, Mermaid diagrams, tables and sandboxed pages in the conversation. "Pin to Diagrams" puts one on the "Diagrams" tab of "Memory".
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
- what to do when the gate fails: hand it back to fix, retry the failed commands once, or stop;
- where the gate runs: in a candidate clone (daemon) or in the session worktree;
- "Let gate commands use the GPU", off by default: the gate sandbox on macOS blocks the GPU, so tests that render with Metal or decode video with AVFoundation fail there. Only you can turn it on, and then the gate commands of the project can reach the GPU kernel driver and the Metal compiler and video decoder services.

## Import an external session

Pantheon reads the native history of Claude Code and Codex.
"Trace" shows the sessions that you started outside Pantheon in the project folders as "External session".

1. Open "Trace" and find the external session.
2. Click "Continue in Pantheon".
3. The session continues in its original folder. Pantheon does not create a worktree. The changes go directly into that folder.

If a process outside Pantheon holds the native session, Pantheon refuses to continue it. Close the session in that terminal first.

## Sessions with Pantheon tools

A session that you create with `"purpose": "conductor"` in its `session.create` command gets five Pantheon tools. The app has no button for it; send the command with `pnpm cli command`. The session plans, splits the work and runs subagents with the tools of its own runtime.

- `request_review`: a runtime of another vendor reviews the committed changes of the session, or of a session that it started. The result comes back to the session as a message.
- `report_ready`: the committed changes go through the project gate and land. Pantheon refuses this while the latest review of the work has open blocking findings. When you click "Merge into <target>" yourself, this rule does not apply.
- `spawn_session`: starts a session of another runtime in a new worktree from the current commit. The new session has no Pantheon tools. When its turn ends or fails, the session that started it gets a message. A session can have at most 4 unfinished sessions that it started.
- `read_state`: the changes of the project, their checks, the landing queue and the items that wait for you.
- `draw`: a chart or diagram that you see in the conversation.

## Trace

"Trace" shows what the sessions of a project did. It has five tabs: "Timeline", "Runs", "Activity", "Diagnose" and "Approved for you".
The timeline shows one lane for each session, including external sessions.
You can replay a turn and see the file changes of one step.
"Diagnose" starts a separate read-only analysis session on the recorded evidence.
"Approved for you" lists what a stored rule approved without you, with the reason and the rule. "Notifications" opens the delivery choices of each kind of decision.

## Memory

"Memory" keeps project decisions, reports and notes. It has three tabs: "Overview", "Entries" and "Diagrams".

- Agents propose drafts. A draft has no effect until you confirm it.
- You confirm, archive and restore entries.
- Pantheon sends the current memory before each message only to the sessions that it starts with memory tools: project setup, baseline, project intro, change explanation and review sessions. The sessions that you start do not get it.
- The details of an entry show when a session last read it ("Last read"). An entry with file references that a session proposed shows the commit it was checked at ("Checked at").
- A note of an agent that no session read in 90 days expires: "Expired: not read in 90 days". Decisions, reports, handoff notes, imported entries and your own entries do not expire this way.

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
| "Notifications"         | How each kind of decision reaches you, quiet hours, sound, app icon count.       |
| "Shortcuts"             | Keyboard shortcuts.                                                              |
| "Data"                  | Data folder, diagnostic log, import and export of personal settings.             |
| "About"                 | Versions, daemon state, logs folder.                                             |
| "Gates"                 | Gate commands of the project and the environment check.                          |
| "Worktrees and merging" | Files to copy, preparation command, cleanup.                                     |
| "Permissions"           | Always-allowed rules of the project.                                             |
| "External requests"     | Sources of external requests and when they need your approval.                   |
| "Default model"         | Model for each role.                                                             |
| "Usage"                 | Budget, quota threshold and token targets.                                       |
| "Extensions"            | MCP servers, skills, plugins and hooks that the project opens.                   |
| "Project"               | Project settings, including "Automatic git init".                                |

- **Shortcuts.** Search by name or by keys. Click "Record keys" to change a shortcut. "Restore all defaults" resets all shortcuts.
- **Notifications.** Each kind of decision, and merges, has "Now", "Brief only" or "Never". During quiet hours, "Now" works as "Brief only". A question that has waited over 4 hours always notifies you.
- **Question default.** The page of a project in "Settings" > "Projects" has "Apply the lead's recommended answer to reversible questions after N hours". It is off until you turn it on, and it applies to the current project only.
- **Environment.** "Check environment" on the "Gates" page prepares a fresh worktree the way a session gets one, then runs the gate commands in it. The baseline confirmation card has the same check for the commands that the baseline proposes. When one of them fails, the baseline agent fixes it once.
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

| Command                                                             | Result                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm cli health`                                                   | Service name, protocol version, version.                                    |
| `pnpm cli capabilities`                                             | Capability report of each adapter.                                          |
| `pnpm cli board --project PROJECT_ID`                               | State snapshot of the project.                                              |
| `pnpm cli events --after 0 --project PROJECT_ID`                    | Stored events after a cursor.                                               |
| `pnpm cli command --file /absolute/path/command.json`               | Runs one command envelope.                                                  |
| `pnpm cli mcp`                                                      | MCP tool server for a native session.                                       |
| `pnpm cli mcp --personal`                                           | MCP tool server for your own agent.                                         |
| `pnpm cli review --base REF [HEAD]` or `pnpm cli review BASE..HEAD` | Reviews the commits from the merge base of the two refs up to the head ref. |
| `pnpm cli land [BRANCH]`                                            | Lands a branch through the project gate.                                    |

`pnpm cli review` reviews only committed content; without a head it reviews the branch of the current directory. Add `--runtime NAME` once per reviewing runtime. It waits for the result and prints the open findings and each reviewer's verdict. It exits 0 when every reviewer passes, 1 on a blocking finding or a fail verdict, 2 when the review failed, is incomplete or was refused or the daemon could not be read, and 64 on a usage error. Ctrl-C stops the wait; the review goes on.

`pnpm cli land` lands the branch (by default the branch of the current directory) onto the branch checked out in the project directory. The project directory needs a gate. `--message TEXT` lands the commits as one commit. It exits 0 when the branch landed or had no changes, and 1 when the landing is blocked or refused.

```sh
pnpm cli review --base main
pnpm cli land my-feature --message "Add the export button"
```

Each command accepts `--data-dir DIR`. The [API reference](api.md) describes the command envelope and the queries.

## Connect your own agent

Your everyday agent (Claude Code, Codex, Claude Desktop or any agent that runs a local stdio MCP server) can work across your Pantheon projects with a personal key. Only local agents can connect: the daemon listens only on `127.0.0.1`.

1. Create a key. Send a `personal.key.create` command with `pnpm cli command --file key.json`, with `"actor": "local-user"` and `"input": {"label": "My agent"}` in the [command envelope](api.md). The receipt gives `key_id` and `token_file`. The daemon writes the token to `token_file`, which only you can read.
2. Add the server to the agent's MCP configuration. Use the `token_file` path as it is: the server reads the key id from the file name.

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

The agent can:

- read the summary of every project (`projects_overview`), what needs you (`needs_you`), a project's brief (`project_brief`) and the decisions made without you (`project_decisions`).

The agent cannot read sessions, answer a question or a permission prompt, or upload attachments. Revoke the key with `personal.key.revoke`; the agent loses access at once.
