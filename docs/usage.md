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

Each project in "All projects" shows "Decisions waiting" with the count; click it to open the project with only the sessions that wait for you. The counts by kind are beside it. A line "Since you left" gives the short brief; click it to open the "Overview" of the board.

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

While a turn runs, you can send another message. Pantheon inserts it into the running turn.
You can interrupt the turn and keep the session.
You can compact the context of an idle session (Claude Code and Codex only).
The turn menu has "Fork from here", "Roll back" (files only, conversation only, or both) and "Rewrite and resend".
Pantheon keeps a checkpoint before each turn, so a roll back can restore the files.

The session view has panels: changes, checks, plan, files and browser.
A session can draw charts, graphs, Mermaid diagrams, tables and sandboxed pages in the conversation. "Pin to the canvas" puts one on the "Canvas" view of the project board.
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

## Assistant and Triage

Each project has two resident agents. The sidebar lists them under "Agents". Click one to open its session.

- "Assistant" is the main agent of the project. It answers your requests, plans the work and hands the changes to task sessions. It reads code but does not change it.
- "Triage" handles the problems that come from outside the conversation: GitHub issues and pull requests, gate failures on main, flaky tests, app errors, failing sessions and trace findings. It plans a fix task for each real problem, or tells you what you must decide.
- "New agent" next to "Agents" adds another agent from a template: "Ideas", "Goals" or "Custom". Right-click an agent and choose "Profile" to change or archive it.
- "Add routine" in an agent's form adds a "Blank routine" or one from a template: "Bug hunt" runs daily at 09:00, only when there are new commits since its last run; "Security scan" and "Test coverage" run weekly.
- An agent's contract (the `contract` field of the `agent.update` command) limits when it reaches you: during its quiet hours, or once its input tokens of the week reach the limit, Pantheon does not wake it. During quiet hours its messages that are not urgent do not notify you.
- "Automations" in the sidebar lists the routines of the agents of the project. It shows once the project has an agent that is not archived. The table has "Agent", "Routine", "Schedule", "Next run" and "Last run". "Run now" runs a routine at once, and "Pause" and "Resume" turn it off and on. Open a row to see its recent runs with the result: "Nothing", "Acted", "Told you" or "Asked you". "Make a task" turns a finished run into a task for the "Assistant", and "Open" opens the session that it got. "Add a routine" opens the profile of the "Assistant".
- An agent's profile also shows what it did. "Contract" sets the "Weekly budget", the "Quiet hours" and the "Loudest" level ("Feed", "Notify" or "Ask") of its messages, and shows what it "Spent this week". "Recent wakes" lists each wake with its cause and result; open one to see its session. "Routine runs" shows each routine with its next run and "Run now". "This week" counts the wakes, the tasks started and merged, the input tokens and the prompts approved for you.
- A lead can propose a change it learned to a gate or to the worktree setup. The change waits in "Needs you" until you decide. The item shows the gate or the setup "Now" and "Proposed". A confirmed change takes effect without a trial.

## Project board

The "Project board" shows the work of a project. It has two pages: "Overview" and "Tasks". "Overview" shows, from the top, "Since you left", "Needs you", "Agents" and "Goals". "Tasks" shows the tasks as "Flow", "List" or "Timeline", for the "Current milestone" or "All".

- Write a requirement in the bar at the bottom of "Tasks". By default Pantheon sends it to the "Assistant". In the "Send to" menu you can choose another agent, the lead of a plan or a session. "New lead" starts a lead session with the requirement. The lead writes a plan of tasks and milestones.
- A receipt shows the steps: received, queued, planning and creating tasks. When an agent such as the "Assistant" ends its turn, the receipt says what it did: "Answered here", "New plan", "Added to" a lane, or "Asked you". "Route differently" sends the request again: "Answer here", "New plan", "Add to a plan" or "Send to" another agent.
- "Since you left" counts what happened since you last clicked "Mark as read": "Waiting on you", "Milestones moved", "Merged", "Failed", "New assumptions" and "Agent proposals". It can also show a short summary paragraph.
- Each task runs in its own task session and worktree, and merges through the gate.
- "Goals" lists the goals of the project, at most 7. "Add goal" adds one. A goal's menu has "Rename", "Move up", "Move down" and "Archive"; "Undo" brings back an archived goal. Each goal shows the milestones the lead put under it and their progress. After you change the goals, "Have the lead sync the plan" asks the lead to update the plan.
- The current milestone card shows the merged and planned tasks, the acceptance criteria and "Accept".
- Under a milestone, "Assumptions" lists what the lead's plan takes as given. Click "No, do something else", write what holds instead and click "Send". The lead gets it as a plan change. While it "Waits for the lead", "Withdraw" takes it back. Then the line says "Lead changed the plan" or "Lead kept it".
- To verify milestones, turn on "Settings" > "Gates" > "Verify milestones automatically". When a lead's milestone is ready for acceptance, Pantheon runs the gate and the acceptance commands of its tasks on the merged code in a fresh clone. If they pass, a read-only verifier reviews the changes against the milestone's criteria, on a runtime of another vendor than the writers when one is available. The milestone shows "Verifying", "Verified", "Verification failed" or "Not verified", and the lead gets the result.
- Merged tasks and done milestones show what backs them: "Report only", "Gate passed", "Reviewed other runtime" or "Reviewed other vendor". A milestone can also show "Verified" or "Accepted" (by you).
- A task that went wrong shows who acts next and why: "Pantheon retries" with the count, "Moved to" another runtime, "Lead has it" or "Waits for you".
- "Needs you" lists the items that need your action, such as approvals.
- When the lead asks several questions at once, one card "N decisions for" the plan holds them, and "Answer all" sends your choices together. A question that can be undone may show "Recommended answer takes effect in" a time: when the time passes, the lead's recommended answer applies. "Keep open" stops that. To turn it on, set the hours in "Settings" > "Workflow".
- When you ask the "Assistant" to change a setting, it can propose the change as a "Setting change" card that shows your words, the old value and the new one. Click "Apply" or "Decline".
- "Pause" in the bar of the board, next to the plan version, stops a plan: running task sessions go on, no new one starts, and the bar says "Lead is reassessing". The lead writes "Reassessment from lead" ("Done", "Blocked" and "Would change"), and a "Plan paused" card shows it in "Needs you". "Resume" (in the bar or on the card) continues the plan.
- A milestone card can show a button with the number of its re-plan conditions. It lists when the lead re-plans: a task is handed back several times, a task spends a share of its budget, a task stalls, or an assumption turns out false. When one is met, the button says "Re-plan condition met" with the wait until the lead changes the plan, and the list has "Open lead session".
- "Timeline" with the range "All" has a "Re-plans" list: for each re-plan, the conditions met and the tasks "Added", "Removed" and "Changed". "Since you left" counts re-plans and met conditions too.
- "Replay" in the bar of the "Timeline" view steps through the events of a plan. Move "Plan time" or use "Previous event" and "Next event". The chart shows the tasks as "Planned", "Dispatched", "Merged" or "Accepted" at that point, and "Events at this point" lists what happened. "Load earlier events" reads further back.
- "Thread" in the task drawer shows what passed between the lead and the task: review findings ("Finding", and "Blocking" when it blocks the merge), questions and answers ("Default answer", "Overruled the lead"), gate results, notes, and when the task was dispatched, handed back and merged. A question that nobody answered shows "Waits for you" or "Not answered".
- A lead decides some things for you: it approves the permission requests and answers the questions of its task sessions, changes the plan, accepts milestones and merges changes outside a task's scope. It asks you before it adds an agent. To approve each plan change yourself, set "Settings" > "Workflow" > "Plan changes" to "Wait for my approval".
- Some decisions always reach you: destructive git commands (such as a force push or `git reset --hard`), network and credential tools, writes outside the worktree, and plan changes when the project is over its budget.
- The flow chart shows the tasks and their dependencies. To add a dependency, drag a connection.
- Each lane of a plan has a depth: "Just do it", "Plan first" or "Spec first". When a lead adds a lane with a top-tier task, its tasks wait for you to approve its plan. "Needs you" shows the lane with an estimate of the sessions, tokens and time. Approve it, or set the lane to "Just do it". "Plan first" and "Spec first" hold the tasks of a lane that have not started.
- The task drawer shows the route, the changes, the checks and the dependencies of a task. You can change the runtime, model and effort, or stop, restart or delete the task.
- "Workflow step" in the task drawer shows the verdict of the newest workflow step: its summary, the commands and files it checked, and the verdict of each reviewer. A reviewer that gives no verdict fails a blocking review step. A failed step before the merge goes back to the lead. When a step ends without a verdict, click "Count as passed" or "Count as failed".

## Engineering board

The "Engineering board" has three tabs:

| Tab             | Content                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| "Iterations"    | The iterations of the project.                                                   |
| "Collaboration" | Messages between leads and task sessions, sub-agents and model changes.          |
| "Workflow"      | Named workflows. You can edit, copy and set the default. Edits start as a trial. |

## Trace

"Trace" shows what the sessions of a project did. It has five tabs: "Timeline", "Runs", "Activity", "Diagnose" and "Approved for you".
The timeline shows one lane for each session, including external sessions.
You can replay a turn and see the file changes of one step.
"Diagnose" starts a separate read-only analysis session on the recorded evidence.
"Approved for you" lists what a lead, a stored rule or your own agent approved without you, with the reason and the rule. You can filter by "Permissions", "Answers" and "Plan changes". "Overrule" replaces a lead's answer with yours. "Notifications" opens the delivery choices of each kind of decision.

## Memory

"Memory" keeps project decisions, reports and notes. It has five tabs: "Overview", "Entries", "Graph", "Diagrams" and "Learned".

- Agents propose drafts. A draft has no effect until you confirm it.
- You confirm, archive and restore entries.
- Pantheon sends the current memory to a session before each message.
- The details of an entry show when a session last read it ("Last read"). An entry with file references that a session proposed shows the commit it was checked at ("Checked at").
- A note of an agent that no session read in 90 days expires: "Expired: not read in 90 days". Decisions, reports, handoff notes, imported entries and your own entries do not expire this way.
- "Learned" shows the learned lessons and their trial results.
- "Learned" lists every change that agents proposed, in groups: "Needs you", "On trial", "In force" and "Reverted". Open a change to read its evidence and use its actions: "Confirm" or "Reject" for a change that waits for you ("Reject" asks for a reason), "Revert" for a change on trial or in force, and "Pin" or "Keep" where the change offers them.

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
| "Gates"                 | Gate commands of the project, milestone verification and the environment check.  |
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
- **Notifications.** Each kind of decision, and merges, has "Now", "Brief only" or "Never". During quiet hours, "Now" works as "Brief only". A question that has waited over 4 hours always notifies you.
- **Playbook.** "Settings" > "Workflow" ends with "Playbook", the text that a lead reads before it plans. It has three sections: "Before you plan", "Routing" and "Replies". Choose "Default" or a runtime in "Playbook for". "Save as new version" stores your edit, the version list loads an older one, and "Reset to built-in" brings back the built-in text.
- **Question default.** "Settings" > "Workflow" has "Apply the lead's recommended answer to reversible questions after N hours". It is off until you turn it on, and it applies to the current project only.
- **Did it help?** After you change a workflow setting, create an agent or turn on a routine, a "Did it help?" card compares the tasks of the project before and after: "First gate run passed" and "Tokens per accepted task". It says "Better", "Worse" or "Not enough evidence", and it needs 10 tasks after the change. It counts only changes you made in the project. It shows under the setting and in the agent's profile.
- **Environment.** "Check environment" on the "Gates" page prepares a fresh worktree the way a task session gets one, then runs the gate commands in it. The baseline confirmation card has the same check for the commands that the baseline proposes. When one of them fails, the baseline agent fixes it once.
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
| `pnpm cli mcp --personal`                             | MCP tool server for your own agent.      |

Each command accepts `--data-dir DIR`. The [API reference](api.md) describes the command envelope and the queries.

## Connect your own agent

Pantheon has a built-in personal agent. Open "Personal agent" in the "Personal" group of the sidebar. The first open creates its own personal key. "Profile" shows what it can do, the kinds it answers for you ("Answers for you") and its "Personal agent key", which you can revoke; it gets a new key when you open it again. It checks every project daily at 09:00, and Pantheon wakes it at most every 30 minutes when new items wait for you in other projects.

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

- read the summary of every project (`projects_overview`), what needs you (`needs_you`), a project's brief (`project_brief`) and the decisions made without you (`project_decisions`);
- send a request to a project's assistant or one of its sessions (`send_request`);
- answer a decision from needs-you (`answer_decision`), only for the kinds you allow. Set them with the `app.settings.set` command: `personal_answers` lists `question`, `plan_change` and `milestone_accept`. None is allowed by default.

The agent cannot read the whole plan, change the board, start or stop tasks, answer a task session's question or a permission prompt, or upload attachments. Revoke the key with `personal.key.revoke`; the agent loses access at once.
