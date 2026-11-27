# Pantheon 接口

daemon 只监听 `127.0.0.1`。客户端有桌面端(`apps/desktop`,经 preload 桥)、CLI(`apps/cli`)、原生会话里的 MCP 工具(`pantheon mcp`,stdio)和用户自己的 agent 用的个人级 MCP 服务器(`pantheon mcp --personal`,stdio)。所有写操作走同一个 `Control.execute`(`packages/control/src/index.ts`)。

本页后半部分(`api-doc` 标记之间)由 `node scripts/api-doc.mjs` 从 `packages/protocol` 的 schema 生成，不手改。改了协议后先 `pnpm build`,再跑这个脚本；`tests/protocol/api-doc.test.ts` 在文档过期时变红。

## 发现与认证

- `daemon.json`(状态目录下，权限 0600):`url`、`pid`、`protocol_version`、`token_file`。默认状态目录 `~/Library/Application Support/Pantheon/`,可用 `--data-dir` 或 `PANTHEON_DATA_DIR` 改。
- `user.token`:本机用户凭证。除 `GET /health` 外，HTTP 请求都要带 `Authorization: Bearer <token>`。
- 带 `Origin` 头的请求只接受 daemon 启动时配置的来源，否则 403 `origin_denied`。
- 会话凭证：daemon 给挂 Pantheon MCP 的会话发凭证，24 小时到期，daemon 重启后失效。
- 个人密钥：`personal.key.create {label}` 返回 `{key_id, token_file}`,daemon 把 token 写进状态目录下的 `personal-keys/<key_id>`(权限 0600)。对应的 principal 是 `personal:<key_id>`(role `personal`),不过期,daemon 重启后仍有效；`personal.key.revoke {key_id}` 立即吊销。`personal.key.list` 列出密钥，不含 token。
- 个人 principal 只能用 `POST /v1/commands` 和五个查询(`projects.summary`、`needs_you.list`、`project.brief`、`project.decisions`、`session.thread`),命令只限 `project.seen`;其余返回 403 `permission_denied`。每次写操作记一条 `personal.called` 事件。
- `GET /v1/session-principal`:当前凭证对应的 principal。

## HTTP 端点

| 端点                                       | 说明                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                              | `{service, protocol_version, version}`,不需凭证                                                                             |
| `GET /v1/capabilities`                     | 每个适配器的实测能力报告                                                                                                    |
| `POST /v1/commands`                        | 执行一条命令，返回 `{receipt}`                                                                                              |
| `GET /v1/board?project_id=`                | 状态快照                                                                                                                    |
| `GET /v1/<method>?…`                       | 只读查询，见下方"查询"表；参数走 URL query                                                                                  |
| `GET /v1/events?after=&project_id=&limit=` | 持久事件续传，`limit` 1–2000,默认 256:`{events, cursor}`;游标超出保留范围时 `{snapshot_required: true, cursor, events: []}` |
| `WS /v1/events/ws`                         | 实时事件，见下文                                                                                                            |

## 命令信封

```json
{
  "protocol_version": 1,
  "command_id": "uuid",
  "idempotency_key": "uuid",
  "actor": "<认证 principal 的 id>",
  "expected_revision": null,
  "type": "project.open",
  "input": {}
}
```

- `input` 按下方命令表里该 `type` 的 schema 校验，多出的字段被拒(strict)。
- `expected_revision`:新建传 `null`;改已有对象传它当前的 revision,不一致返回 `revision_conflict`。
- 幂等：同一 principal 的 `idempotency_key` 或 `command_id` 重复且输入相同，返回原回执；输入不同返回 `conflict`。
- `packages/protocol` 的 `command(actor, type, input, expected_revision)` 生成这个信封。

## 错误

响应体 `{error, message}`。`permission_denied` 返回 403,未知路由 404 `unknown_route`,其余 400。常见 `error`:

- `invalid_input`:schema 校验失败，`message` 每个问题一行
- `unsupported_command`:`type` 不在命令表里
- `conflict`:revision 不符或幂等键复用
- `not_found`、`permission_denied`,以及各命令自己的领域错误码(`packages/domain` 的 `DomainError`)

## 事件流

1. 连接 `WS /v1/events/ws`,5 秒内发 `{"token": "...", "cursor": 0, "project_id": "可选"}`。
2. 服务端回 `{"type": "subscribed", "cursor"}`,之后逐条发 `{"type": "event", "event"}`。
3. `event` 字段：`sequence`、`event_id`、`kind`、`aggregate_id`、`aggregate_revision`、`project_id`、`causation_id`、`created_at`、`payload`(`packages/domain` 的 `Event`)。
4. 游标超出保留范围时服务端发 `{"type": "snapshot_required", "cursor"}` 并关闭：重新读 `/v1/board`,从新游标重连。
5. 发送缓冲超过 1 MB 时以 1013 关闭；凭证过期或撤销时以 1008 关闭。断线后用最后处理的 `sequence` 重连。

## MCP 工具

带 Pantheon 工具的会话挂 Pantheon MCP,凭证角色由 `packages/domain` 的 `credentialRole` 定:带工具的会话(`purpose: 'conductor'`)拿 conductor 凭证,交叉审查的 reviewer 会话拿 reviewer 凭证,摸底、简介、改动解读、项目初始化和运行时分析会话拿 planner 凭证。普通会话和导入会话不挂 Pantheon MCP、不拿凭证。工具名和命令的对应写在 `packages/protocol` 的 `sessionTools`(按会话角色)和 `coordinationTools`(摸底、简介和改动解读会话,只放行该用途列出的命令)里,下方命令表的"MCP 工具"列由它们生成。会话凭证只能调它角色允许的命令。

用户自己的 agent 用 `pantheon mcp --personal`:token 从 `PANTHEON_PERSONAL_TOKEN_FILE` 读，文件名就是 key id;daemon 地址取 `PANTHEON_DAEMON_URL`,没有时读数据目录的 `daemon.json`。工具定义在 `apps/cli/src/personal-tools.ts`,共六个:`projects_overview`(`projects.summary`)、`needs_you`(`needs_you.list`)、`project_brief`(`project.brief`)、`project_decisions`(`project.decisions`)、`send_request`(`request.send`,不带附件)和 `answer_decision`(按 `kind` 发 `lead.question.answer`、`board.plan.proposal.resolve` 或 `milestone.accept`)。

## 命令语义要点

- `memory.archive` keeps its record result and adds `archived_ids`: the retracted id and every record made stale by that retraction, including transitive dependents. The durable journal records their previous states; records already invalid before the retraction are not part of its undo.
- `memory.undo_retraction {memory_id}` is user-only and uses the archived root's `expected_revision`. It returns `{restored_ids, skipped: [{memory_id, reason}]}`, where reasons are `changed` (revision changed after retraction) or `replaced` (a newer version of that scope was committed). It restores the same ids and prior lifecycle states, including drafts. `memory_not_retracted` refuses expired, superseded, stale or legacy archives without a retraction journal; `memory_retraction_replaced` refuses a newer committed version of the root key and task scope, even if that version was later archived. Both retraction and undo are atomic command transactions. Undo emits `memory.retraction_undone`, shown by `memory.recent` as `retraction_undone`. The existing `memory.restore` still creates a new draft for review.

- `session.create` 从项目第一个文件夹的当前 HEAD 建 worktree,`input` 是首回合消息；worktree 准备好后才起回合。
- `session.comment.add {session_id, path, line, side, text}` 只供用户调用，返回持久化的 `SessionComment`；`text` 去掉首尾空白后非空，最多 10,000 个 Unicode 码点；`expected_revision` 为 null。
- `session.comment.resolve {comment_id, state}` 只供用户调用，`state` 为 `sent` 或 `kept`，返回更新后的评论；`expected_revision` 为评论当前 revision，命令不发送消息。
- `session.comment.delete {comment_id}` 只供用户调用，物理删除评论并返回被删除的记录；`expected_revision` 为评论当前 revision，三个评论命令都拒绝 merged、discarded 或 closed 会话。
- `GET /v1/session.comments?session_id=…` 返回 `SessionComment[]`，按文件路径、行号、创建时间升序；每次增删改在所属会话追加一条 `session.comment_added`、`session.comment_resolved` 或 `session.comment_deleted` 事件，payload 为评论记录。
- `SessionComment.session_id` 是评论所属的会话。
- `SessionComment.path` 是 diff 的文件路径。
- `SessionComment.line` 是 diff 对应侧的正整数行号。
- `SessionComment.side` 为 `old` 或 `new`，标识 diff 的旧侧或新侧。
- `SessionComment.text` 是用户的评论正文。
- `SessionComment.created_at` 是创建时间，单位为 Unix 毫秒。
- `SessionComment.state` 为 `open`、`sent` 或 `kept`；新评论为 open，sent 表示用户已发送，kept 表示仅作笔记。
- `SessionPreflight.open_comments` 是 open 评论数，零时省略；评论不影响合并条件或门禁。
- `session.steer` 把用户消息插进运行中的回合；`session.interrupt` 只接受直接对话，打断回合但保留会话。
- `session.compact` 只允许用户请求空闲会话立即压缩上下文；运行中、等待中、已关闭、已合并或已丢弃的会话不接受请求。
- `session.compact.instructions` 是可选的单行保留指示，最多 2000 个 Unicode 码点；Claude 接受，Codex 不接受。
- runtime capabilities 的 `manual_compaction` 表示适配器是否支持用户请求压缩；Claude 和 Codex 支持，ACP 和其他 runtime 不支持。`compaction_instructions` 表示压缩时是否收指示；Claude 支持，Codex 不支持，不支持时带 `instructions` 的请求被拒绝。
- 回合的 `origin: "compaction"` 标记维护回合；`input` 只保留指示，不保存 `/compact` 用户消息，压缩仍用 `context.compacted` 事件和现有计数。
- `approval.respond` 只有用户能调；权限请求不过期，`approve_session` 只用于带规则的权限请求，把规则记到会话上，之后同一规则的请求直接放行。
- `session.merge` 要求会话空闲、worktree 没有未提交改动且有新提交；合并在后台跑(rebase、门禁、`merge --ff-only`),结果是 `session.merged` 或 `session.merge_blocked` 事件，被挡后可直接重发。
- `visual.draw` 是带 Pantheon 工具的会话的 `draw` 工具，项目和会话取自凭证，返回 `{visual_id, revision}`。`spec` 按 `kind` 校验；Vega-Lite 数据只允许内联，HTML 原文只检查长度，不解析或清洗。
- `visual.draw.source?` 是数据出处（文件路径、命令、URL 或查询），单行、至多 500 字符；`size?: "S" | "M" | "L"` 是会话卡片高度，省略时由屏幕选默认值，与看板 `pin` 无关。重画不传 source 或 size 时清掉旧值。
- 只有 kind 对应的 spec 校验失败时，仍保存原始 spec 和至多 20 条 `error: {message, path}[]`，path 相对于 spec；命令仍返回原有 `invalid_input` 错误和完整字段信息。其他输入校验或 replaces 权限失败时不保存图表。`visual.read` 和 `visual.list` 包含失败图表；成功的 replaces 清掉 error。
- `visual.read` 返回 `Visual`，`visual.list` 返回 `{visuals}`，至多 200 条；默认按创建时间倒序，`pinned: true` 按 `pin.position`，未传或 `pinned: false` 时列全部图表。读取和看板命令只供用户调用。
- `Visual` 含 `id`、`project_id`、`session_id`、`title`、`kind`、`spec`、`revision`、`created_at`、`updated_at`，固定时另有 `pin: {size, width?, position}`。时间为 Unix 毫秒，revision 从 1 起只在重画时加一。`replaces` 保留 id 和 pin；`pin` 与 `visual.pin` 一样，追加到看板末尾，已有固定位置只改大小。`visual.pin` 可另传 `width: 4 | 6 | 8 | 12`（12 列网格的列数），省略时保留已有宽度；没有宽度的 pin 不写入默认值。`visual.draw.pin` 只指定高度。`visual.arrange` 保留宽度。`visual.unpin` 去掉 pin，`visual.arrange` 的 order 必须恰好包含该项目全部固定图表的 id。
- 每次画图在绘图会话的事件流追加一条 `visual.drawn`，payload 为 `{visual_id, title, kind, revision, failed?: true}`，失败图表带 failed。删除会话时，未固定的图表随之删除，固定的图表保留并将 `session_id` 置为 null。
- `visual.pin`、`visual.unpin`、`visual.arrange` 各追加一条 `visual.changed`,payload 为 `{visual_ids}`。pin 和 unpin 的聚合是该图表;arrange 的聚合是项目，`visual_ids` 按看板顺序。
- Claude 的 MCP draw 参数流追加 `visual.drawing {tool_call_id, received_bytes}` 会话事件；received_bytes 是累计 UTF-8 参数字节数（不是数据点数），每次调用至多每 250 ms 发一次。Codex 和 ACP 适配器没有增量参数字节流，不发此事件。
- `project.intro.start` 只供用户调用，返回 `{session_id}`；创建 `intro: true` 的只读会话，在项目目录运行，不建 worktree。运行时选择与摸底一致，模型同样使用运行时默认值；已有简介回合排队或运行时返回 `invalid_input`。
- `project_intro_submit` 对应 `project.intro.submit`，只在摸底和简介会话中提供，项目来自凭证，返回 `{written: true}`。提交会替换项目唯一的 `ProjectIntro`，追加 `project.intro.written` 事件，payload 为 `{project_id}`。`ProjectIntro` 的字段见 `packages/domain/src/index.ts`；`written_at` 为 Unix 毫秒。删除项目时移除简介，删除撰写会话时保留简介并把 `session_id` 置为 null。
- `GET /v1/project.intro.read?project_id=…` 只供用户读取，返回 `{intro: ProjectIntro | null, behind: number | null, writing_session_id: string | null}`。`behind` 汇总各记录 HEAD 以来的提交数，无简介时为 0，历史已不可读取时为 null。`writing_session_id` 是排队或运行中的简介或摸底会话，否则为 null。
- 简介的行数和语言来自 `baseline-facts.ts` 的共享文本计数：Git 根读取 `git ls-files` 跟踪的普通文件，非 Git 根复用摸底的文件扫描，含 NUL 的二进制文件跳过。语言按扩展名判定，未知语言和超出展示数量的部分归入 `other`，总计至多 8 项，按行数降序。`weeks` 是写入时刻之前连续 8 个七天窗口，由旧到新；目录提交数为最近 30 天触及该目录的提交数。目录及 entry 相对于同一个项目根，同名目录按根顺序取第一个。
- 不支持的功能返回明确错误，不模拟成功。

- `project.gates.history {project_id, since?, limit?}` accepts an optional epoch-millisecond `since`. With it, runs starting at or after that instant are returned newest by start first, with `limit` up to 500. Without it, the existing newest-completed-first order, default of 30 and maximum of 100 remain.
- Gate commands accept `enabled` (default `true`) and `skippable` (default `false`). Disabled commands produce no result or count. Failed skippable commands retain their exit code and reason with `state: skipped`; they never count as passed. `session.gate_step_checked` updates the session list's completed counts while later commands run.
- `workflow.policy.set` accepts `gate_on_fail: retry | stop` and `gate_runner: daemon | session`, defaulting to `stop` and `daemon`. Retry repeats each failed command once without repeating successes. Stop leaves a failed gate to the user. Session gates run in the local session workspace; remote session execution is refused with `unsupported_capability` because the existing device helper has no bounded exit-code executor.

## Project workbench settings

- `approval.respond { approval_id, decision: "approve_project" }` stores the approval's `rule` in `Project.permission_rules: { rule, session_id, added_at }[]`. `Approval.project_rule_supported` and `NeedsYouItem.binding.project_rule_supported` tell the page whether this answer is available. Later matching approvals record `answered_by_rule` in `approval.approved`; they receive a one-call runtime answer, so each use remains in history. Rules stay dormant in plan mode and read-only reviews.
- Claude supports its existing tool and Bash rule keys. Codex supports its existing MCP server/tool keys; file-change approvals retain their current answers, and escalated command approvals remain denied by the adapter. ACP has no reusable rule key and retains its current answers. The fixture adapter supports rule keys for tests.
- `permission.rule.add { project_id, rule, session_id }` lets only the user store a project permission rule with its source session and the current `added_at`, recording `project.rule_allowed`; an existing rule returns the project unchanged without another event.
- `GET permission.rules { project_id }` returns `{ rule, session_id, session_title?, added_at }[]`, newest first. A removed source session leaves the rule and session ID intact. `permission.rule.remove { project_id, rule }` removes that rule and returns the updated project.
- `GET project.branches { project_id, root? }` returns `{ name, sha, commit_time, checked_out }[]`: local branches ordered by commit time descending, capped at 200. `root` defaults to the first project folder and must identify a project root. Times are Unix milliseconds.
- `project.worktree.set { project_id, copy_paths: string[], command?: { argv: string[], timeout_ms?: number } }` replaces `Project.worktree` and returns the updated project. Use the project's revision, as with `project.gate.set`; read the settings through `project.read`. Paths apply relative to each worktree's source project folder. Missing paths are skipped; existing selected files and folders are copied, preserving symlinks. Saving rejects absolute paths, parent traversal and paths resolving outside a project root. Runtime copying also checks the live source and destination boundaries.
- Preparation runs after the existing dependency-folder copy and before the first turn. The command runs directly in the worktree with the native environment and project environment variables; its default timeout is 20 minutes, as for gate commands. Copy or command failures retain the worktree, set provisioning to `failed`, close the session with `session.closed { reason: "workspace_failed", error }`, and fail its queued turns. The session list shows `failed`. The last 4,000 characters of combined command output are stored in `Workspace.provisioning.output` and included in the failed turn's error. Workspace data is available in the board snapshot and `workspace.provisioning` events.
- `GET workspace.stale { project_id }` returns `{ count, size_bytes?, worktree_disk?, worktree_root? }`. `count` and `size_bytes` cover existing linked worktrees whose bound sessions are all archived. `worktree_disk { count, size_bytes, unmeasured }` covers all existing linked worktrees, excluding removed records, and is absent without one; unmeasured worktrees contribute no bytes. Both totals reuse per-worktree measurements of logical file and symlink bytes without following symlinks. Measurements run asynchronously; a worktree is measured again at most every five minutes, and its last size stays until the new one lands. A measurement error emits `workspace.stale_size_failed` and leaves that worktree unmeasured. `worktree_root` is the read-only managed worktree folder, absent when none is configured.
- `session.list` supplies optional `predicted_conflicts { files: string[], total }` beside each session's `ahead` and `behind`. Only unfinished linked-worktree sessions with commits ahead of their target receive a prediction; a clean merge has an empty file list. `files` is limited to 20 and `total` is the full conflict count. Background reads use the preflight merge preview and cache it by session and target head commits. A read after a new event refreshes the worktrees of the sessions that changed, at most every two seconds; without a new event, a read 30 seconds or more after the last full read reads every worktree again, so edits and commits made outside a session appear the next time a client reads the board (window focus, project events) rather than on a fixed schedule; a read that finds other predictions or shared files emits `workspace.repository_changed`. Git read failures emit `workspace.repository_read_failed` and retain the last completed snapshot.
- `workspace.prune_stale { project_id }` returns `{ removed }`, using existing worktree removal guards. A worktree still in use or holding unlanded changes after a merge is retained. Branches and commits remain intact. A failed Git removal is not counted or marked removed.

## Trace queries

- `project.trace` preserves its lane, statistics and segment fields. Its turns also return `tokens` (including `cache_read` when reported) and `cost_usd` when available. `session.trace` already returns these on turn spans, and already exposes reported tool `exit_code` and positive `retry_count`. Cache reads remain named `tokens.cache_read`; absent cost or cache data is not estimated.
- `tool.calls {project_id, command?, limit?}` returns `ToolCall[]`, newest start first, with unknown starts last. The limit is 1–200, default 50. Rows contain `session_id`, `session_title`, `turn_id`, `span_id`, `tool_name`, `start`, `status`, and optional `input_summary`, `duration_ms`, `exit_code`, `retry_count`. External sessions use their native lane key as `session_id`. Summaries contain at most 200 characters; the case-sensitive substring filter matches tool names or complete retained command lines. Retries count consecutive identical calls in the same turn, each started after the preceding failed result; zero is omitted.
- `project.timeline` adds `queued` while messages await execution, and `ready` after a successful turn completes for review. Running turns and permission waits take precedence over queued messages. `ready` does not certify Git cleanliness or merge eligibility; merge admission still checks those separately.
- `trace.time` keeps its project allocation and adds `by_lane`, keyed by trace lane key, when no `lane_key` is supplied. Each value is an allocation over the same window and observations; the project wall time remains a union, so lane wall times may overlap.
- `project.trace.stats {project_id, since, until}` accepts an inclusive epoch-millisecond range. It returns `turn_duration_p50_ms`, `turn_duration_p95_ms`, `tool_duration_p50_ms`, `tool_duration_p95_ms`, `cache_read_share` and `failed_tool_calls`. Samples start in the range and have a recorded end; tools include subagent calls and prefer runtime-reported durations. Each pair of percentiles is absent with fewer than five timed samples; the median averages the middle pair and p95 uses nearest rank. Cache share divides reported cache reads by input tokens for turns that report cache reads, falling back to model-call totals when turn usage is absent; it is absent without such input. Failure counts include only tool and subagent spans, not failed turns. Existing percentiles in the `stats` objects inside `project.trace` remain available with their original sample rules.
- `session.step_diff {session_id, turn_id, span_id}` returns `{session_id, turn_id, span_id, files: [{path, patch, truncated}]}` from recorded inputs. It reads the native trace cache first, then daemon tool events, without scanning transcripts, reading the worktree or invoking Git. Read-only tools return `files: []`; unknown spans in the specified turn return `not_found`. Claude `Edit`, `MultiEdit`, `Write`, Codex `apply_patch`, `fileChange` and cached native `file_change` update inputs are supported. Replacement fragments use fragment-relative line numbers because the inputs do not carry their positions in the original file. Whole-file writes without prior content are additions. A deletion without recorded old content retains its path with `patch: null`; missing text is not reconstructed from today's files. The total patch budget is 409,600 UTF-8 bytes; files that do not fit have `truncated: true, patch: null`, and smaller later files can still fit. Already capped event input also returns no patch text.
- Each `session.trace` span now has `gate_state` (`passed`, `failed`, or `none`) from the latest `session.gate_checked` or `session.gate_run_failed` at or before its start. Any nonzero exit, missing exit code or timeout fails the gate. `context_tokens` and `context_window` come from the latest `agent.usage.updated` at or before that start, including previous turns, and remain absent when that event did not report them. Events from other sessions and future events are excluded. A span with no start has no context snapshot and gate state `none`.
- `project.collab {project_id, since, until}` accepts an inclusive epoch-millisecond range. `subagents` contains `{session_id, span_id, name, start, duration_ms?, status}` for indexed subagent spans starting in the range; duration is absent when unreported and unfinished. `model_changes` contains `{session_id, at, before?, after}`, reconstructed from opening snapshots and `session.model_changed` history; `null` means the runtime default selector, and `before` is absent without an earlier record or after a runtime switch whose event carries no model selector. Model changes made only by those runtime switches have no model record and are omitted. Effort-only updates are excluded. Empty sections mean no matching records are available.

## CLI

```sh
pnpm cli health
pnpm cli capabilities
pnpm cli board  # 状态快照,名字沿用旧看板
pnpm cli events --after 0 --project PROJECT_ID
pnpm cli command --file /absolute/path/command.json
pnpm cli command --json '{"type":"…"}'
pnpm cli trace.time --project PROJECT_ID --param lane_key=LANE
pnpm cli mcp
pnpm cli mcp --personal
```

CLI 从状态目录读 `daemon.json` 和凭证；`mcp` 读 `PANTHEON_SESSION_TOKEN_FILE`,`mcp --personal` 读 `PANTHEON_PERSONAL_TOKEN_FILE`。第一个参数是查询名时，它发 `GET /v1/<查询名>`;`--param KEY=VALUE` 可重复，重复的键按多值发送。

<!-- prettier-ignore-start -->

## Session search

`GET /v1/session.search?text=…&project_id=…&limit=…` is user-only. `project_id` is optional; without it all daemon-held sessions are searched, including archived sessions. `text` is trimmed, case-insensitive literal text; fewer than two characters returns no hits. `limit` defaults to 20 and accepts integers from 1 to 50.

The result is `{ hits: SessionSearchHit[], indexing_complete: boolean }`. Each hit has `session_id`, `project_id`, `title`, `archived`, `kind` (`title`, `branch`, or `message`), ISO `at`, `excerpt`, and `match: { start, length }`. Message hits also have `turn_id` and `speaker` (`user` or `agent`). Match offsets are UTF-16 units in the excerpt. Excerpts contain about 120 units, expanding to fit a longer query. Title and branch hits precede messages; each group is newest first. Each session contributes at most one title hit, one branch hit, and three message hits.

Search indexes stored user input and agent reply deltas joined per turn, excluding tool input, tool output, reasoning, and daemon-generated input. Branches come from the worktree's current symbolic HEAD when indexed. SQLite FTS5 uses the trigram tokenizer over lowercased text. A second indexed field holds padded adjacent character pairs, so two-character queries (including Chinese) also use FTS5. Changes are queued transactionally and indexed in the background; `indexing_complete: false` means hits reflect the portion indexed so far. Startup rechecks sessions in the background and keeps existing hits available.

After building, `node scripts/benchmark-session-search.mjs` measures queries against a temporary on-disk history of 200 sessions with 200 messages each and asserts that each query takes less than 100 ms.

## Runtime and connection data

`runtime.status` retains runtime sign-in and preflight data and adds `connection`:
`{ connected, disconnected_since?, reason?, held_session_count, held_session_ids }`.
Times are ISO strings. An unexpected session transport loss holds later inputs of
that runtime until `runtime.reconnect { runtime }` succeeds. The receipt is
`{ runtime, connected: true }`; failure is `runtime_reconnect_failed` with the
runtime and startup reason. Reconnect probes startup without a model turn; queued
input resumes native sessions on dispatch. A delivered turn lost with its process
fails and is never replayed.

`runtime.connection_changed` uses the existing durable event stream. Each project
receives `{ runtime, ...connection }` with only its own held session ids; the
user-only status query returns the runtime-wide list.

`mcp.status { project_id, runtime }` or `{ session_id }` returns
`{ runtime, reconnect_available, servers?: [{ name, state, reason? }] }`. Project
queries inspect the first project folder. Session queries inspect the live native
connection; an inactive or disconnected session has no server-state field. `servers` is also
absent when its adapter cannot report MCP state. States are `connected`, `failed`,
`needs_sign_in`, `pending`, `disabled` and `unknown`. Codex preserves catalog error
reasons and leaves an unavailable catalog `unknown`. Claude reads SDK server
states; ACP has no MCP status implementation.

`mcp.reconnect { session_id, server }` calls a supporting live adapter and returns
`{ runtime, server, reconnected: true }`. Otherwise it returns
`unsupported_capability` with `<runtime> does not support reconnecting MCP servers`.
No production adapter currently advertises this capability.

`connections.status { refresh? }` is user-only and returns
`{ github: { state, installed, signed_in, account?, host?, scopes? } }`. Its states
are `missing`, `timeout`, `signed_out`, and `signed_in`; `signed_in` is `null` on a
timeout. It runs only `gh auth status --json hosts`, with a three-second timeout,
and never returns tokens. It chooses the active github.com account, otherwise the
first active account reported by gh. Answers, including missing CLI, timeout and
signed-out answers, stay cached for the daemon lifetime until `refresh: true`.
Runtime sign-in remains exclusively in `runtime.status`.

## Project settings

All settings writes require the user. `workflow.policy.reset` uses the policy row's revision
(or `null` before one exists); the other settings commands use the project revision.
`revision_conflict` rejects stale writes, and `permission_denied` rejects agent writes.

- `workflow.policy` returns `defaults` alongside the current settings. Reset restores all settings,
  including budgets, and records changed parameters in a new policy version.
- `project.read.project.session_defaults` is present only when the project has its own defaults.
  `project.sessionDefaults.clear` removes it. The existing composer/runtime defaults then apply.
  `writer` and `reviewer` are optional `{runtime, model?, effort?}` choices; omitting them keeps
  task routing and reviewer selection. Explicit task choices retain precedence over writer defaults.
- `session_defaults.fallbacks` has optional `lead`, `writer` and `reviewer` choices. New session
  creation uses `lead` (the key keeps its old name) when runtime admission rejects the first choice.
  Reviewer selection tries `reviewer` after the preferred reviewer fails admission. These settings
  add no installation, authentication or connection probes and do not transfer running native sessions.

<!-- api-doc:start -->

## 命令(`POST /v1/commands`)

### app

| type | input | MCP 工具 |
|---|---|---|
| `app.settings.set` | `auto_git_init?`: boolean<br>`auto_archive_merged?`: boolean<br>`session_recap?`: boolean<br>`brief_prose?`: boolean<br>`attention_delivery?`: object<br>`quiet_hours?`: object \| null |  |

### approval

| type | input | MCP 工具 |
|---|---|---|
| `approval.respond` | `approval_id`: string<br>`decision`: "approve" \| "approve_session" \| "approve_project" \| "reject"<br>`reason?`: string<br>`answers?`: object |  |

### browser

| type | input | MCP 工具 |
|---|---|---|
| `browser.open` | `url`: string | browser_open (planner) |
| `browser.read` | — | browser_read (planner) |
| `browser.result` | `request_id`: string<br>`page?`: object<br>`error?`: object |  |
| `browser.screenshot` | — | browser_screenshot (planner) |

### change_story

| type | input | MCP 工具 |
|---|---|---|
| `change_story.revert_patch` | `story_id`: string<br>`card`: integer |  |
| `change_story.start` | `session_id`: string |  |
| `change_story.submit` | `overall`: object<br>`cards`: object[]<br>`noise`: string[]<br>`story_id`: string | change_story_submit (project session) |

### conductor

| type | input | MCP 工具 |
|---|---|---|
| `conductor.answer` | `session_id`: string<br>`approval_id`: string<br>`decision`: "approve" \| "reject"<br>`answers?`: object<br>`reason`: string | answer_request (conductor) |
| `conductor.message` | `session_id`: string<br>`text`: string<br>`mode?`: "send" \| "steer" | message_session (conductor) |
| `conductor.needs_you` | — | read_needs_you (conductor) |
| `conductor.plan_set` | `milestones`: object[]<br>`items`: object[] | write_plan (conductor) |
| `conductor.propose_setting` | `command`: "project.gate.set" \| "workflow.policy.set" \| "project.sessionDefaults.set" \| "project.extensions.set"<br>`input`: object<br>`reason`: string | propose_setting (conductor) |
| `conductor.ready` | `session_id?`: string<br>`reason?`: string | report_ready (conductor) |
| `conductor.review` | `runtimes`: string[]<br>`session_id?`: string | request_review (conductor) |
| `conductor.spawn` | `runtime?`: string<br>`runtimes?`: string[]<br>`input`: string<br>`acceptance?`: string[]<br>`owns?`: string[]<br>`model?`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"<br>`permission_mode?`: "ask" \| "auto_edit"<br>`reason?`: string | spawn_session (conductor) |
| `conductor.state` | — | read_state (conductor) |
| `conductor.stop` | `session_id`: string<br>`close?`: boolean<br>`reason?`: string | stop_session (conductor) |

### device

| type | input | MCP 工具 |
|---|---|---|
| `device.remove` | `id`: string |  |
| `device.save` | `id`: string<br>`ssh`: string<br>`name?`: string<br>`note?`: string |  |

### github

| type | input | MCP 工具 |
|---|---|---|
| `github.pr.create` | `session_id`: string<br>`title?`: string<br>`draft?`: boolean |  |

### mcp

| type | input | MCP 工具 |
|---|---|---|
| `mcp.app.tool_call` | `session_id`: string<br>`server`: string<br>`tool`: string<br>`arguments?`: object |  |
| `mcp.reconnect` | `session_id`: string<br>`server`: string |  |

### memory

| type | input | MCP 工具 |
|---|---|---|
| `memory.archive` | `memory_id`: string |  |
| `memory.commit` | `memory_id`: string |  |
| `memory.context` | `project_id`: string<br>`max_bytes?`: integer | memory_context (reviewer), memory_context (planner), memory_context (conductor) |
| `memory.get` | `memory_id`: string | memory_get (reviewer), memory_get (planner), memory_get (conductor) |
| `memory.history` | `project_id`: string<br>`key?`: string<br>`limit?`: integer<br>`ids?`: string[] |  |
| `memory.maintain` | `project_id`: string |  |
| `memory.propose` | `project_id`: string<br>`key`: string<br>`kind`: "decision" \| "report" \| "note"<br>`title?`: string<br>`summary?`: string<br>`tags?`: string[]<br>`references?`: object[]<br>`text`: string<br>`dependencies?`: string[]<br>`expires_at?`: integer<br>`based_on?`: string | memory_propose (reviewer), memory_propose (planner), memory_propose (conductor) |
| `memory.related` | `project_id`: string<br>`memory_id`: string<br>`state?`: "active" \| "draft" \| "archived" \| "all"<br>`kind?`: "decision" \| "report" \| "note"<br>`tag?`: string \| string[]<br>`q?`: string<br>`relation?`: "all" \| "dependency" \| "dependent" \| "version" \| "tag"<br>`depth?`: integer<br>`limit?`: integer | memory_related (reviewer), memory_related (planner), memory_related (conductor) |
| `memory.restore` | `memory_id`: string |  |
| `memory.search` | `project_id`: string<br>`state?`: "active" \| "draft" \| "archived" \| "all"<br>`kind?`: "decision" \| "report" \| "note"<br>`tag?`: string \| string[]<br>`q?`: string<br>`limit?`: integer | memory_search (reviewer), memory_search (planner), memory_search (conductor) |
| `memory.undo_retraction` | `memory_id`: string |  |

### permission

| type | input | MCP 工具 |
|---|---|---|
| `permission.globalRule.add` | `rule`: string |  |
| `permission.globalRule.remove` | `rule`: string |  |
| `permission.rule.add` | `project_id`: string<br>`rule`: string<br>`session_id`: string |  |
| `permission.rule.remove` | `project_id`: string<br>`rule`: string |  |

### personal

| type | input | MCP 工具 |
|---|---|---|
| `personal.key.create` | `label`: string |  |
| `personal.key.revoke` | `key_id`: string |  |

### project.baseline

| type | input | MCP 工具 |
|---|---|---|
| `project.baseline.confirm` | `baseline_id`: string<br>`gates?`: object[] |  |
| `project.baseline.start` | `project_id`: string<br>`runtime?`: string<br>`model?`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" |  |
| `project.baseline.submit` | `baseline_id`: string<br>`folders`: object[] | project_baseline_submit (project session) |

### project.brief

| type | input | MCP 工具 |
|---|---|---|
| `project.brief.prose.write` | `project_id`: string |  |
| `project.brief.set` | `project_id`: string<br>`goal`: string<br>`goals`: string[]<br>`non_goals`: string[] |  |

### project.defaults

| type | input | MCP 工具 |
|---|---|---|
| `project.defaults.clear` | `key`: "workflow_policy" \| "session_defaults" |  |
| `project.defaults.set` | `key`: "workflow_policy"<br>`value`: object<br>或<br>`key`: "session_defaults"<br>`value`: object |  |

### project.environment

| type | input | MCP 工具 |
|---|---|---|
| `project.environment.set` | `project_id`: string<br>`name`: string<br>`roots`: string[]<br>`env`: object |  |
| `project.environment.verify` | `project_id`: string<br>`root?`: string<br>`baseline_id?`: string |  |

### project.extensions

| type | input | MCP 工具 |
|---|---|---|
| `project.extensions.set` | `project_id`: string<br>`runtime`: string<br>`overrides`: object |  |

### project.facts

| type | input | MCP 工具 |
|---|---|---|
| `project.facts.refresh` | `project_id`: string |  |

### project.gate

| type | input | MCP 工具 |
|---|---|---|
| `project.gate.set` | `project_id`: string<br>`root`: string<br>`commands`: object[]<br>`protected_paths?`: string[] |  |

### project.intro

| type | input | MCP 工具 |
|---|---|---|
| `project.intro.start` | `project_id`: string |  |
| `project.intro.submit` | `summary`: string<br>`sources`: string[]<br>`features`: object[]<br>`modules`: object[]<br>`architecture?`: object<br>`body?`: string | project_intro_submit (project session) |

### project.land

| type | input | MCP 工具 |
|---|---|---|
| `project.land` | `root`: string<br>`branch`: string<br>`message?`: string<br>`allow_gate_change?`: boolean |  |

### project.landing

| type | input | MCP 工具 |
|---|---|---|
| `project.landing.cancel` | `landing_id`: string |  |

### project.open

| type | input | MCP 工具 |
|---|---|---|
| `project.open` | `name`: string<br>`roots`: string[]<br>`env?`: object |  |

### project.override

| type | input | MCP 工具 |
|---|---|---|
| `project.override.clear` | `project_id`: string<br>`key`: "workflow_policy" \| "session_defaults"<br>`param?`: "gate_on_fail" \| "gate_runner" |  |

### project.plan

| type | input | MCP 工具 |
|---|---|---|
| `project.plan.accept` | `project_id`: string<br>`item_id`: string<br>`accepted`: boolean |  |

### project.read

| type | input | MCP 工具 |
|---|---|---|
| `project.read` | `project_id`: string | project_read (planner), project_read (conductor) |

### project.remove

| type | input | MCP 工具 |
|---|---|---|
| `project.remove` | `project_id`: string |  |

### project.seen

| type | input | MCP 工具 |
|---|---|---|
| `project.seen` | `project_id`: string<br>`at?`: integer |  |

### project.sessionDefaults

| type | input | MCP 工具 |
|---|---|---|
| `project.sessionDefaults.clear` | `project_id`: string |  |
| `project.sessionDefaults.set` | `project_id`: string<br>`runtime`: string<br>`permission_mode`: "ask" \| "auto_edit" \| "plan" \| "auto" \| "full_access"<br>`model?`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"<br>`single_model?`: boolean<br>`writer?`: object<br>`reviewer?`: object<br>`fallbacks?`: object |  |

### project.worktree

| type | input | MCP 工具 |
|---|---|---|
| `project.worktree.set` | `project_id`: string<br>`copy_paths`: string[]<br>`command?`: object |  |

### review

| type | input | MCP 工具 |
|---|---|---|
| `review.finding` | `location`: string<br>`quote`: string<br>`evidence`: string<br>`impact`: string<br>`blocking`: boolean<br>`reproduction?`: object | review_finding (reviewer) |
| `review.finding.resolve` | `review_id`: string<br>`finding_id`: string<br>`outcome`: "fixed" \| "intentional" \| "not_worth_it" \| "wrong"<br>`note?`: string |  |
| `review.range` | `root`: string<br>`base`: string<br>`head?`: string<br>`paths?`: string[]<br>`exclude_deleted?`: boolean<br>`focus?`: string<br>`runtimes?`: string[]<br>`fallback?`: string[] |  |
| `review.request` | `session_id`: string<br>`runtimes`: string[]<br>`fallback?`: string[] |  |
| `review.verdict` | `verdict`: "pass" \| "fail"<br>`summary`: string | review_verdict (reviewer) |

### runtime

| type | input | MCP 工具 |
|---|---|---|
| `runtime.config.set` | `runtime`: string<br>`enabled?`: boolean<br>`binary?`: string<br>`args?`: string[]<br>`artifacts?`: boolean<br>`unverified_isolation?`: boolean |  |
| `runtime.reconnect` | `runtime`: string |  |

### session

| type | input | MCP 工具 |
|---|---|---|
| `session.adopt` | `project_id`: string<br>`runtime`: "claude" \| "codex"<br>`native_session_id`: string<br>`title?`: string<br>`permission_mode?`: "ask" \| "auto_edit" \| "plan" \| "auto" \| "full_access" |  |
| `session.app_context` | `session_id`: string<br>`server`: string<br>`content`: string |  |
| `session.archive` | `session_id`: string |  |
| `session.background.stop` | `session_id`: string<br>`background_id`: string |  |
| `session.comment.add` | `session_id`: string<br>`path`: string<br>`line`: integer<br>`side`: "old" \| "new"<br>`text`: string<br>`line_text?`: string<br>`turn_id?`: string |  |
| `session.comment.delete` | `comment_id`: string |  |
| `session.comment.resolve` | `comment_id`: string<br>`state`: "sent" \| "kept" |  |
| `session.compact` | `session_id`: string<br>`instructions?`: string |  |
| `session.create` | `project_id`: string<br>`workspace?`: "worktree" \| "in_place" \| "auto"<br>`from?`: object \| object<br>`runtime?`: string<br>`backend?`: string<br>`model?`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"<br>`permission_mode?`: "ask" \| "auto_edit" \| "plan" \| "auto" \| "full_access"<br>`fast?`: boolean<br>`ultracode?`: boolean<br>`input`: string<br>`refs?`: (object \| object)[]<br>`attachments?`: string[]<br>`skills?`: object[]<br>`device_id?`: string<br>`purpose?`: "project_setup" \| "conductor" |  |
| `session.delete` | `session_id`: string |  |
| `session.discard` | `session_id`: string |  |
| `session.fork` | `session_id`: string<br>`runtime?`: string<br>`model?`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"<br>`before_turn_id?`: string<br>`before_span_id?`: string<br>`input`: string<br>`refs?`: (object \| object)[]<br>`attachments?`: string[]<br>`skills?`: object[] |  |
| `session.gates.cancel` | `session_id`: string |  |
| `session.gates.run` | `session_id`: string<br>`only_failed?`: boolean |  |
| `session.interrupt` | `session_id`: string |  |
| `session.merge` | `session_id?`: string<br>`project_id?`: string<br>`allow_gate_change?`: boolean |  |
| `session.merge.cancel` | `session_id`: string |  |
| `session.pin` | `session_id`: string<br>`pinned`: boolean |  |
| `session.reconnect` | `session_id`: string |  |
| `session.rename` | `session_id`: string<br>`title`: string |  |
| `session.resolve` | `session_id`: string<br>`choice`: "resume_session" \| "close" |  |
| `session.rollback` | `session_id`: string<br>`turn_id`: string<br>`scope?`: "files" \| "conversation" \| "both" |  |
| `session.send` | `session_id`: string<br>`input`: string<br>`refs?`: (object \| object)[]<br>`attachments?`: string[]<br>`skills?`: object[]<br>`app?`: object |  |
| `session.setBackend` | `session_id`: string<br>`backend`: string \| null<br>`model?`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" |  |
| `session.setConnectors` | `session_id`: string<br>`enabled`: string[] |  |
| `session.setFastMode` | `session_id`: string<br>`fast`: boolean |  |
| `session.setModel` | `session_id`: string<br>`model`: string<br>`effort?`: "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" |  |
| `session.setPermissionMode` | `session_id`: string<br>`permission_mode`: "ask" \| "auto_edit" \| "plan" \| "auto" \| "full_access" |  |
| `session.setUltracode` | `session_id`: string<br>`ultracode`: boolean |  |
| `session.snooze` | `session_id`: string<br>`snoozed`: boolean |  |
| `session.steer` | `session_id`: string<br>`input`: string<br>`refs?`: (object \| object)[]<br>`attachments?`: string[]<br>`skills?`: object[]<br>`app?`: object |  |
| `session.unarchive` | `session_id`: string |  |

### setting

| type | input | MCP 工具 |
|---|---|---|
| `setting.proposal.respond` | `proposal_id`: string<br>`decision`: "approve" \| "reject" |  |

### terminal

| type | input | MCP 工具 |
|---|---|---|
| `terminal.close` | `terminal_id`: string |  |
| `terminal.open` | `project_id`: string<br>`session_id?`: string<br>`cols`: integer<br>`rows`: integer |  |
| `terminal.resize` | `terminal_id`: string<br>`cols`: integer<br>`rows`: integer |  |
| `terminal.write` | `terminal_id`: string<br>`data`: string |  |

### trace

| type | input | MCP 工具 |
|---|---|---|
| `trace.evidence` | `project_id`: string<br>`view?`: "summary" \| "findings" \| "workflow"<br>`kind?`: "turn_queue" \| "turn_prepare" \| "approval" \| "permission_delivery" \| "gate" \| "slow_tool" \| "tool_failure" \| "turn_failure" \| "context_compaction" \| "background_task"<br>`offset?`: integer<br>`limit?`: integer | trace_evidence (project session) |
| `trace.reflect` | `project_id`: string<br>`runtime?`: string<br>`from`: integer<br>`to`: integer |  |
| `trace.remember` | `session_id`: string |  |
| `trace.report` | `project_id`: string<br>`summary`: string<br>`finding_ids`: string[]<br>`disposition`: "experiment" \| "measure" \| "none"<br>`change`: string<br>`baseline`: string<br>`metric`: string<br>`rollback`: string | trace_report (project session) |
| `trace.verify` | `session_id`: string<br>`outcome`: "improved" \| "unchanged" \| "regressed"<br>`baseline`: number<br>`trial`: number<br>`evidence`: string |  |

### visual

| type | input | MCP 工具 |
|---|---|---|
| `visual.arrange` | `project_id`: string<br>`order`: string[] |  |
| `visual.draw` | `title`: string<br>`kind`: "vega-lite" \| "kline" \| "mermaid" \| "graph" \| "html" \| "table" \| "timeline"<br>`spec`: object<br>`source?`: string<br>`size?`: "S" \| "M" \| "L"<br>`replaces?`: string<br>`pin?`: "S" \| "M" \| "L" | draw (planner), draw (conductor) |
| `visual.list` | `project_id`: string<br>`pinned?`: boolean<br>`session_id?`: string |  |
| `visual.pin` | `visual_id`: string<br>`size`: "S" \| "M" \| "L"<br>`width?`: 4 \| 6 \| 8 \| 12 |  |
| `visual.read` | `visual_id`: string |  |
| `visual.unpin` | `visual_id`: string |  |

### workflow

| type | input | MCP 工具 |
|---|---|---|
| `workflow.policy.reset` | `project_id`: string |  |
| `workflow.policy.set` | `project_id`: string<br>`gate_on_fail?`: "retry" \| "stop"<br>`gate_runner?`: "daemon" \| "session"<br>`project_budget?`: object \| null |  |

### workspace

| type | input | MCP 工具 |
|---|---|---|
| `workspace.prune_stale` | `project_id`: string |  |

## 查询(`GET /v1/<method>?…`)

| method | 参数 |
|---|---|
| `app.settings` | — |
| `backend.list` | — |
| `change_story.diff` | `story_id`: string |
| `change_story.list` | `project_id`: string |
| `connections.status` | `refresh?`: string |
| `device.list` | `refresh?`: string |
| `device.probe` | `id`: string |
| `device.ssh_hosts` | — |
| `extensions.inventory` | `project_id`: string<br>`runtime`: string |
| `files.list` | `project_id`: string<br>`session_id?`: string<br>`path?`: string |
| `files.read` | `project_id`: string<br>`session_id?`: string<br>`path`: string |
| `files.search` | `project_id`: string<br>`session_id?`: string<br>`q`: string |
| `github.items` | `project_id`: string<br>`kind`: "pr" \| "issue" |
| `github.pr.detail` | `project_id`: string<br>`number`: integer |
| `import.candidates` | — |
| `mcp.app.resource` | `session_id`: string<br>`server`: string<br>`uri`: string |
| `mcp.status` | `project_id`: string<br>`runtime`: string<br>或<br>`session_id`: string |
| `memory.document` | `project_id`: string |
| `memory.graph` | `project_id`: string<br>`memory_id?`: string<br>`state?`: "active" \| "draft" \| "archived" \| "all"<br>`kind?`: "decision" \| "report" \| "note" \| "file" \| "url" \| "session" \| ("decision" \| "report" \| "note" \| "file" \| "url" \| "session")[]<br>`tag?`: string \| string[]<br>`q?`: string<br>`task_id?`: object<br>`lead_session_id?`: object<br>`project_only?`: object<br>`origin?`: object<br>`milestone_id?`: object<br>`keep?`: string<br>`depth?`: integer<br>`max_nodes?`: integer<br>`include_tags?`: boolean \| "true" \| "false" |
| `memory.item` | `project_id`: string<br>`memory_id`: string |
| `memory.read` | `project_id`: string<br>`state?`: "active" \| "draft" \| "archived" \| "all"<br>`kind?`: "decision" \| "report" \| "note"<br>`tag?`: string \| string[]<br>`q?`: string<br>`task_id?`: object<br>`lead_session_id?`: object<br>`project_only?`: object<br>`origin?`: object<br>`milestone_id?`: object<br>`limit?`: integer<br>`cursor?`: string |
| `memory.recent` | `project_id`: string<br>`limit?`: integer |
| `memory.session_turns` | `session_id`: string |
| `memory.turn` | `session_id`: string<br>`turn_id`: string |
| `needs_you.list` | `project_id?`: string |
| `permission.rules` | `project_id`: string |
| `personal.key.list` | — |
| `project.baseline.read` | `project_id`: string |
| `project.branches` | `project_id`: string<br>`root?`: string |
| `project.brief` | `project_id`: string<br>`since?`: integer |
| `project.changes` | `project_id`: string |
| `project.collab` | `project_id`: string<br>`since`: number<br>`until`: number |
| `project.decisions` | `project_id`: string<br>`since?`: integer |
| `project.defaults` | — |
| `project.environment.checks` | `project_id`: string<br>`baseline_id?`: string<br>`limit?`: integer |
| `project.facts.read` | `project_id`: string |
| `project.gates.history` | `project_id`: string<br>`since?`: number<br>`limit?`: integer |
| `project.head` | `project_id`: string |
| `project.heatmap` | `project_id`: string<br>`days?`: "7" \| "30" \| "90" \| "all" |
| `project.intro.read` | `project_id`: string |
| `project.landing.find` | `root`: string<br>`branch`: string |
| `project.landing.read` | `landing_id`: string |
| `project.landings.compare` | `project_id`: string<br>`proposal_id`: string<br>`count`: integer |
| `project.landings.read` | `project_id`: string<br>`from?`: integer<br>`to?`: integer<br>`limit?`: integer |
| `project.overlap` | `project_id`: string |
| `project.plan` | `project_id`: string |
| `project.plan.history` | `project_id`: string<br>`limit?`: integer |
| `project.read` | `project_id`: string |
| `project.review.metrics` | `project_id`: string |
| `project.status.read` | `project_id`: string<br>`from`: integer<br>`to`: integer |
| `project.timeline` | `project_id`: string<br>`since?`: string |
| `project.trace` | `project_id`: string<br>`from?`: string<br>`to?`: string<br>`bucket_ms?`: integer |
| `project.trace.stats` | `project_id`: string<br>`since`: number<br>`until`: number |
| `project.usage.daily` | `project_id`: string<br>`days`: integer<br>`timezone`: string |
| `project.usage.read` | `project_id`: string |
| `projects.summary` | — |
| `review.read` | `review_id`: string |
| `runtime.models` | `project_id`: string<br>`runtime`: string |
| `runtime.status` | `refresh?`: string |
| `session.activity` | `session_id`: string |
| `session.comments` | `session_id`: string |
| `session.create.preview` | `project_id`: string<br>`workspace?`: "worktree" \| "in_place" \| "auto"<br>`from?`: object \| object |
| `session.diff` | `session_id`: string |
| `session.gates` | `session_id`: string |
| `session.gates.history` | `session_id`: string<br>`limit?`: integer |
| `session.importable` | `project_id`: string |
| `session.list` | `project_id`: string |
| `session.mcp_servers` | `session_id`: string |
| `session.preflight` | `session_id`: string |
| `session.reviews` | `session_id`: string |
| `session.search` | `text`: string<br>`project_id?`: string<br>`limit?`: integer |
| `session.step_diff` | `session_id`: string<br>`turn_id`: string<br>`span_id`: string |
| `session.tasks` | `session_id`: string |
| `session.thread` | `session_id`: string |
| `session.tool_image` | `session_id`: string<br>`hash`: string |
| `session.trace` | `project_id`: string<br>`lane_key`: string<br>`turn?`: string |
| `session.turn_diff` | `session_id`: string<br>`turn_id`: string |
| `symbols.search` | `project_id`: string<br>`session_id?`: string<br>`q`: string |
| `tool.calls` | `project_id`: string<br>`command?`: string<br>`limit?`: integer |
| `trace.time` | `project_id`: string<br>`lane_key?`: string<br>`from?`: string<br>`to?`: string |
| `workflow.policy` | `project_id`: string |
| `workspace.stale` | `project_id`: string |

<!-- api-doc:end -->

<!-- prettier-ignore-end -->
