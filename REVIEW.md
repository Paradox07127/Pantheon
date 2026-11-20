# Review rules

Reviewers of a Pantheon change (people, mmrun, hosted review) follow this file.

## What to report

- **Important**: a defect that a user or a session can hit. Give the `file:line`, the input or state that triggers it, and the wrong result.
- **Nit**: a small quality issue. Report at most 5, the most useful first.
- **Pre-existing**: a defect the change did not introduce but touches. Mark it as such; it does not block.
- Report only what you can point to in the code. Do not report a guess as a defect; write it as a question.

## What to skip

- Formatting, types, lint and test failures: `pnpm build`, `pnpm test` and `pnpm format:check` catch them.
- Added `.skip` / `.only` and removed test files: the gate checks them.
- Style choices that follow the code around them.

## Checks for this repository

Each check names the change that makes it apply. The same defect was fixed more than once in this repository.

1. **Linked worktree git metadata.** Applies to sandbox profiles and writable roots (`packages/control/src/protection.ts`, `packages/adapters/src/acp-profiles.ts`, `packages/adapters/src/capabilities.ts`) and to code that reads `.git`, follows `gitdir:` or sets `GIT_DIR`. In a linked worktree `.git` is a file. Its metadata folder and the shared objects and refs are outside the worktree. A session must be able to commit through them, and must not write other worktrees' metadata. Resolve pointers the way git does: relative to the folder git opened, through symlinks, and with drive letters under WSL.
2. **Tool names and inputs per runtime.** Applies when a runtime or ACP profile is added, or when a tool-name list or tool-input read changes: `apps/web/src/data/tool-calls.ts`, `apps/web/src/data/step-replay.ts`, `packages/adapters/src/trace.ts`, `packages/adapters/src/acp-profiles.ts`. Every list that classifies tool calls must have each runtime's names (case included) and input fields. The web lists and the adapter tables must agree.
3. **Git states of a session worktree.** Applies to code that parses git output or calls `merge-base`, `symbolic-ref`, `rev-parse HEAD` or `status --branch`. Session worktrees are on a detached HEAD. A branch can be unborn (`(initial)`). `merge-base` exits 1 with no output when there is no shared history; use `mergeBase()` in `packages/control/src/merge-preview.ts`. These are normal states, not errors and not branch names.
4. **Signalling a process group.** Applies to `process.kill(-pgid, …)`, `kill -TERM -$g` and stop or leftover logic in `packages/adapters/src/process.ts`, `claude.ts`, `acp.ts` and device stop scripts. Signal a group number only while a process recorded earlier by pid and start time is still in it. After a stop saw the group empty, do not signal it again. A zombie counts as exited. Every stop path must follow the same rule, so check the other paths too, not only the edited one.
5. **Deadlines on spawned helpers.** Applies to `setTimeout(… child.kill(…))`, `execFile`/`spawn` with `timeout`, and waits on a child's `close`. Spawn the helper `detached` and kill the whole group at the deadline. The wait must not depend on pipes a descendant can hold open. The caller's abort signal must also end the wait.
6. **Parallel task parts.** Applies to code in `packages/control/src/board-view.ts`, `board-history.ts`, `task-tracking.ts`, `task-dispatch.ts` and `project-board.ts` that maps a plan task to sessions. A task with `parallel_index` parts counts all its parts, the newest session of each. It is done only when every live part merged. It failed when a part closed unmerged with no retry. One dispatch of N parts is one attempt.
7. **Task ids that outlive the task.** Applies to a lookup, `Map` or SQL join keyed by `task.id`, `task_id` or `direct_task.id`. The key must include the task generation, or the code must check `plan.retired`. Otherwise sessions, requests, merges and done marks of a removed task attach to a new task that reuses the id.
8. **Git calls and user git config.** Applies to `execFile('git', …)`, `execFileSync('git', …)` or `spawn('git', …)` outside `packages/control/src/git.ts` and `source-git.ts`, and to git output that depends on config (`status` untracked mode, `log --since`, maintenance and gc, line endings). Call git through `runGit`, or `userGit` for writes in the user's repository, so the `-c` overrides apply. Pin the behaviour the code parses (`--untracked-files=all`, `--since-as-filter`). An override added to one wrapper goes into the other too.
9. **WSL drive paths.** Applies to `apps/desktop/src/main/wsl.ts`, `packages/control/src/wsl-mount.ts` and any regex on `/mnt/`, `[a-z]:`, `\\wsl.localhost` or `\\?\`. Take the automount root from `wsl.conf`, not a fixed `/mnt/`. Accept both slashes and the `\\?\` prefix. The `wsl.conf` parser exists in both files above; a fix changes both.
10. **Reads triggered by event kinds.** Applies to `apps/web/src/data/**` hooks that read again on events (`useProjectQuery({ kinds })`, `REPOSITORY_KINDS`, `touchesNeedsYou`, `useGateTick`) and to a new daemon event kind. List what can change the read's answer, including another session's merge into the same source. Each matching event kind must be in the trigger list. Edits outside the app send no event and rely on the window-focus read.
11. **Trace parser version.** Applies to changes in the reducers and row readers of `packages/adapters/src/native-transcript.ts`, or in `toolInputSummary`, `toolFiles` or `toolCommand` in `packages/adapters/src/trace.ts`. The same change must bump `PARSER_VERSION` in `packages/control/src/trace-index.ts`. Otherwise cached spans keep the old parse.
12. **Web copies of daemon decisions.** Applies to `apps/web/src/data/**` code that predicts a daemon rule (`runtime-status.ts`, `project-defaults.ts`, `workflow-policy.ts`, `workflow-definition.ts`) and to new web paths that create sessions or offer approve and deny. The web rule must match the daemon's current admission, approval or default logic; name that daemon function. A new caller reuses the existing web helper instead of sending a partial command that the daemon fills differently.
