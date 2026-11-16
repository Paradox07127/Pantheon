import { workflowPolicy } from './workflow-policy.js';
import { onDevice } from './remote-workspace.js';
import { deviceHasLabel } from './devices.js';
import { githubReference } from './github.js';
import {
  recordWorkflowGates,
  startSlot,
  taskWorkflow,
  waitBeforeMerge,
} from './workflow-engine.js';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import {
  credentialRole,
  DomainError,
  hash,
  id,
  requireThat,
  NATIVE_ENV_ALLOWLIST,
  type Approval,
  type BoardPlan,
  type ChangeStory,
  type EffortLevel,
  type Event,
  type Milestone,
  type Principal,
  type Project,
  type RuntimeModel,
  type ProjectBaseline,
  type LandingItem,
  type HarnessAdapter,
  type Review,
  type AgentEvent,
  type Session,
  type SessionComment,
  type SessionHandle,
  type SessionSpec,
  type SessionTurn,
  type Timer,
  type TurnAttachment,
  type Visual,
  type Workspace,
} from '@pantheon/domain';
import {
  inputSchemas,
  type Command,
  type SessionCreatePreview,
  type AttachmentMeta,
  type ProjectGatesHistory,
  type ProjectHead,
  type ProjectTimeline,
  type SessionActivity as ProtocolSessionActivity,
  type SessionDiff,
  type SessionGateRun,
  type SessionGateRunResult,
  type SessionGates,
  type SessionPreflight,
  type SessionGatesHistory,
  type WorkbenchSession,
} from '@pantheon/protocol';
import {
  inside,
  insert,
  projectAccess,
  resolvedPath,
  revision,
  sessionMcp,
  sessionAdapter,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { admitWriterChoice } from './admission.js';
import { checkpointRef, forkCheckpoint, gitWorkspace, restorableTurns } from './checkpoint.js';
import { buildHandoff } from './handoff.js';
import { sessionEnded } from './baseline.js';
import {
  sessionPlanTask,
  boardTask,
  boardTaskId,
  currentAcceptance,
  currentBinding,
  retiredBinding,
  taskGeneration,
  taskSessions,
  taskState,
} from './board-plan.js';
import { checkedSource, numstatFiles, PATCH_BOUND, sourceGit, TIME_BOUND } from './source-git.js';
import { runGit, type GitResult } from './git.js';
import { mergePreview } from './merge-preview.js';
import { repositoryInsights } from './repository-insights.js';
import {
  AGENT_CONFIGURATION,
  checkGates,
  gateArgv,
  gateCommands,
  gateFailed,
  landWorkspace,
  type LandingOwner,
  type LandingProgress,
} from './landing.js';
import { appendNote, blockedReport, contractLines } from './lead-inbox.js';
import { managedSessionSpec } from './native-session.js';
import { projectFacts } from './project-facts.js';
import { runTimes, sessionRun } from './run-state.js';
import { sessionTasks } from './session-tasks.js';
import { appDebugSkill } from './app-debug-skill.js';
import { projectSetupSkill } from './project-setup-skill.js';
import { worktreeSandbox } from './protection.js';
import { ownWorkspaceOnly } from './workspace-files.js';
import { failWorkbenchTurns, workspaceReady } from './provisioning.js';
import {
  nativeTurnActive,
  queuedTurn,
  releaseIdleConversation,
  reviewsRoots,
  stopTurn,
  unsnooze,
} from './session.js';
import { openUserTaskSession, userTaskChoice, overlaps } from './task-dispatch.js';
import { kindOfPaths } from './task-kind.js';
import {
  autoMerge,
  backendProfile,
  homeRuntime,
  readUserConfig,
  sessionDefaults,
} from './user-config.js';
import {
  cancelProvisioning,
  registerInPlaceWorkspace,
  registerWorkspace,
  workspaceReadAccess,
} from './workspace.js';
import { writerTempDirectory } from './workspace-removal.js';

// One turn runs at most six hours; adapters time it with setTimeout, which fires at once above 2^31 - 1 ms.
const WORKBENCH_TURN_MS = 6 * 60 * 60 * 1000;

const LEAD_INSTRUCTIONS = [
  'You are a lead session: you plan the board for the requests the user brings you.',
  'Before you plan a request, call project_read and read the code, the tests and the recent commits that the request touches. Do not ask the user what the repository, project_read or project memory can tell you.',
  'When reading cannot settle a point the request leaves open, and the answer would change which paths a task may change, change what result counts as done, or lead to a step that cannot be undone, ask the user: at most 3 questions for one request, the one that changes the plan most first. Write the plan on the answer you recommend, call ask_user with the ids of the tasks that depend on the answer in blocks, and start the other tasks. When the request is so open that you cannot write any task, ask before you plan.',
  "Decide every other open point yourself and write each decision as one line in the plan's assumptions. Do not ask about a small request whose result is easy to undo.",
  'Add every request that changes the repository to your plan with update_board before you change anything. Write a small request that one session can finish right away as one task whose scope names the one or two files it changes; lead.workflow.path in project_read most likely makes its path direct, so claim it with start_task, change and commit it yourself, then call report with kind done. A request that only answers a question and changes nothing needs no task. While your plan has an unfinished task your turns are read-only unless you work on a direct task.',
  'Split a request that needs several sessions in parallel or in stages into tasks with dependencies and milestones, and send the whole plan with update_board every time you change it.',
  "Give every task its source (verbatim excerpts copied from the user's messages), its scope (the repository paths it may change) and its acceptance (the shell commands that must pass).",
  'Give a task that fixes a bug an acceptance command that runs a test that reproduces the bug: put the test file in its scope, and say in its goal that the session writes this test first and sees it fail before the fix. Give a task that adds behavior an acceptance command that runs a test of the new behavior.',
  'A task is done when its session merges. Give a task without commits, such as research or a document reply, done_when report; it may have no scope or acceptance, and it is done when you call accept_task with the evidence from its done report.',
  'Choose the model for each task with its runtime, model and effort fields.',
  'Give every task its kind, a domain and a tier; lead.routing in project_read gives the first runtime, model and effort for each kind. Use that choice, or choose another and give the reason in one sentence in route_reason.',
  'When project_read has lead.devices, a task may name the device its session runs on in device, with the reason in one sentence in device_reason. Put what the device must have in needs: os=<system> and arch=<architecture> as lead.devices gives them (such as os=macos or arch=arm64), and the device labels. Name what the task session holds for itself while it runs, such as a test database, a port, a simulator or a GPU, as a resource in uses; give tasks that would compete for the same thing the same resource name, or put them on different devices.',
  "lead.workflow.path in project_read gives the suggested path for each tier; when a task's path differs from it, give the reason in one sentence in flow_reason. A task whose path is review_loop is dispatched like one whose path is dispatch, and before it merges another runtime, or the task's own runtime when it is the only one, reviews its changes and sends blocking findings back to its session until the review passes or the review rounds run out.",
  "lead.workflow.steps in project_read lists the user's custom steps by slot: before_dispatch steps run before a task opens, before_merge steps after its gates pass and before it merges, and after_merge steps after it merges (for a done_when report task, after its done report and before you accept it). A task may wait there for the user's approval, a prompt turn or a review; a failed step comes back to you as a board update.",
  'Calling start_task with a task whose path is direct means you do that task yourself, with no task session: change and commit it in your own worktree, then call report with kind done. Pantheon runs the gates and merges your commits, and your session stays open.',
  'Work on one direct task at a time and start it on its own; stop_task with its id gives it up.',
  'lead.experiences in project_read lists the practices on trial or in force in this project; follow each one where it applies.',
  'When your plan has pending user edits, which board updates name by edit_id, first apply or reject each one with the resolve_edit op of edit_board and a reason, before you do anything else.',
  'When reflecting on task execution, use shared conclusions in project_read lead.runtime_reviews and the matching retrospectives. Treat proposed experiments as unverified until a measured result is recorded. Keep detailed runtime diagnostics in the analysis session.',
  'When the same problem shows in two or more records of lead.retrospectives in project_read, you may use propose_improvement to propose one workflow parameter change or one experience, citing those retrospective ids; do not propose one for a single event.',
  'When a task turn goes off course, stop that turn with interrupt_task, then use message_task to tell the task session how to go on.',
  'When a task turn fails because its model is unavailable, change the model of the task in the plan; Pantheon has the task session retry on the new model. Do not open another task for it.',
  'When a task session reports a requirement problem, do one of three things: change the plan, ask the user, or explain why and let the task go on as planned.',
  'After you handle a requirement report, use message_task to tell the task session how to go on. When a task session waits for the user or fails, tell the user; do not do that task yourself.',
  'After update_board, call start_task with the tasks to work on; you can pass them all at once, since Pantheon opens each task session only when its upstream tasks are done, its scope does not overlap a running task and a task session slot is free; lead.workflow.max_parallel in project_read gives the number of slots. Then end your turn.',
  'To stop a task that went wrong or is no longer wanted, call stop_task with its id and the reason; once its sessions are discarded the task is todo, and start_task starts it again.',
  "When the merge of a task session stopped on files outside the task's scope that the task needs and no other unfinished task's scope holds, call merge_task with the task id, allow_out_of_scope true and the reason to merge them.",
  'Use request_review with a worker session_id from project_read and reviewer runtimes different from its writer when another runtime is available to request an independent read-only review of your current task. The result returns as a board update; handle concrete findings with message_task. A failed reviewer is not a clean review, and review completion never accepts or merges a task.',
  'Do not implement planned tasks other than your direct task yourself, start sub-agents for them, or copy their commits into this worktree. While your plan has an unfinished task and you work on no direct task, Pantheon blocks file edits and commands that change state; git log, git status, git diff, reading files and the Pantheon tools still work.',
  'Pantheon computes task state and sends you a message when a session of one of your tasks merges, fails, waits for the user, cannot merge after the same problem was handed back to it as often as the project allows or a hand-back changed nothing, makes no progress or repeats a failing tool call, or reports a report task done.',
  'Call milestone_accept only when project_read shows the milestone ready_for_acceptance and its criteria hold.',
  'Board updates cut a long note short and list notes past their size limit by id only; call read_note with the note id to read one in full before you act on it.',
  "The project board shows what you write with the Pantheon tools: update_board and edit_board write the plan panels (lanes, tasks and their dependencies, milestones, risks and assumptions), and Pantheon fills in task states and progress from the sessions; draw with pin puts a chart on the board when the user asks for one there, and draw with replaces redraws it in place; rerun_baseline refreshes the baseline, introduction and repository panels and needs the user's approval. When the work changes, update the plan in the same turn.",
].join('\n');

export function workerInstructions(
  ctx: ControlContext,
  task: NonNullable<Session['task']>,
): string {
  const lead = ctx.store.get<Session>('sessions', task.lead_session_id),
    parent = ctx.store
      .get<BoardPlan>('board_plans', task.lead_session_id)
      ?.tasks.find((candidate) => candidate.id === task.id),
    part = task.parallel_index === undefined ? undefined : parent?.parallel?.[task.parallel_index],
    planned = parent && part ? { ...parent, ...part } : parent;
  return [
    `You work on task ${task.id}${planned ? ` "${planned.title}"` : ''} of the lead session "${lead?.title ?? task.lead_session_id}".`,
    ...(planned ? contractLines(planned) : []),
    ...(planned?.done_when === 'report'
      ? ['Deliver your conclusion with report kind done; this task needs no commit.']
      : [
          'Merging this worktree completes the task; you do not declare it done.',
          'Run every acceptance command before you commit.',
        ]),
    "If the user's words conflict with the goal, the task needs changes outside its scope, or an acceptance command cannot pass as written, use report with kind requirement to name the conflict and end your turn; do not guess.",
    'Use report to tell the lead about risks, suggested tasks or dependencies, and when you think the task is done.',
    "A question you ask the user goes to your lead's board, where the user answers it; the answer comes back to this session.",
    'Messages that start with [Lead] come from your lead.',
  ].join('\n');
}

export function workbenchSessionSpec(ctx: ControlContext, session: Session): SessionSpec {
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!),
    project = ctx.store.must<Project>('projects', session.project_id);
  const temporary = writerTempDirectory(workspace.id);
  if (ctx.protectionPaths) mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const sandbox = ctx.protectionPaths
    ? worktreeSandbox({
        ...ctx.protectionPaths,
        sourceRepo: workspace.source!,
        workspacePath: workspace.path,
        worktreeId: path.basename(workspace.path),
        tempDir: temporary,
        // A folder session works in the source checkout, which the source rules below already cover.
        otherWorkspaces: ctx.store
          .list<Workspace>('workspaces')
          .filter((other) => other.id !== workspace.id && other.kind !== 'in_place')
          .map((other) => other.path),
        ...(session.task
          ? {
              taskSession: { reviewsDirs: reviewsRoots(ctx) },
            }
          : {}),
      })
    : undefined;
  const pantheonMcp = sessionMcp(ctx, session, credentialRole(session, workspace.kind));
  const adapter = sessionAdapter(ctx, session);
  const questionTool = adapter?.questionTool;
  // The runtime names a conversation the user opened; a board lead's first turn has an origin.
  const autoTitle =
    adapter?.generatesTitles === true &&
    !session.task &&
    session.native_title === undefined &&
    ctx.store.list<SessionTurn>('session_turns').find((turn) => turn.session_id === session.id)
      ?.origin === undefined;
  const saved = project.extension_overrides?.[session.runtime];
  return managedSessionSpec(ctx, {
    ...(autoTitle ? { auto_title: true } : {}),
    platform_session_id: session.id,
    project_id: project.id,
    runtime: session.runtime,
    model: session.requested_model,
    effort: session.requested_effort,
    profile_version: session.profile_version,
    account_ref: session.account_ref,
    role: 'writer',
    ...(session.task ? { task_session: true } : {}),
    control_instructions: [
      `You are working for the user in the git worktree at ${workspace.path}. When your changes are complete, commit them there with git. Do not write files outside this worktree.`,
      ...(questionTool
        ? [
            `When the user must decide or answer something, ask with the ${questionTool} tool instead of asking in plain text.${session.task ? " The question goes to your lead's board, where the user answers it, and the answer comes back to this session." : ''} Give 2 to 4 short options with the one you recommend first; the user can also type an answer of their own.`,
          ]
        : []),
      // The board tools exist only while the session holds a Pantheon credential.
      ...(pantheonMcp
        ? [session.task ? workerInstructions(ctx, session.task) : LEAD_INSTRUCTIONS]
        : []),
    ].join('\n\n'),
    workspace: { id: workspace.id, path: workspace.path },
    ...(sandbox
      ? {
          env: { TMPDIR: temporary },
          sandbox: {
            writable_roots: sandbox.writable_roots,
            protected_entries: sandbox.protected_entries.map(({ path, deny }) => ({ path, deny })),
          },
        }
      : {}),
    cwd: workspace.path,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: session.app_debug?.cdp_port
      ? [
          {
            name: 'chrome_devtools',
            command: 'npx',
            args: [
              '-y',
              'chrome-devtools-mcp@1.13.0',
              `--browser-url=http://127.0.0.1:${session.app_debug.cdp_port}`,
            ],
            env: {},
          },
        ]
      : [],
    pantheon_mcp: pantheonMcp,
    extensions: {
      mode: 'inherit',
      // User-level MCP servers, skills and account connectors stay off until the project opens them.
      overrides: {
        disabled_mcp_servers: [],
        disabled_plugins: [],
        disabled_skills: [],
        disable_hooks: false,
        ...saved,
        disable_apps:
          session.enabled_user_connectors !== undefined
            ? !session.enabled_user_connectors.length
            : saved?.disable_apps === true || !saved?.enabled_user_connectors?.length,
        enabled_user_mcp_servers: saved?.enabled_user_mcp_servers ?? [],
        enabled_user_skills: saved?.enabled_user_skills ?? [],
        enabled_user_connectors:
          session.enabled_user_connectors ?? saved?.enabled_user_connectors ?? [],
      },
    },
    device_id: session.device_id ?? 'local',
    budget: { max_turns: 1, wall_time_ms: ctx.turnWallTimeMs ?? WORKBENCH_TURN_MS },
    permission_mode: session.permission_mode ?? 'ask',
    ...(session.fast ? { fast: true as const } : {}),
    ...(session.ultracode ? { ultracode: true as const } : {}),
    ...(session.allowed_rules ? { allowed_rules: session.allowed_rules } : {}),
  });
}

const ATTACHMENT_META = 'meta.json';

/** Uploads sit beside the artifacts directory, in the daemon's data directory. */
function attachmentsDirectory(ctx: ControlContext, projectId: string): string {
  return path.join(path.dirname(ctx.files.directory), 'attachments', projectId);
}

/** Stores an upload as attachments/<project>/<id>/<name>, with its mime in meta.json beside it. */
export function addAttachment(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  name: string,
  mime: string,
  bytes: Uint8Array,
): AttachmentMeta {
  requireThat(p.role === 'user', 'permission_denied', 'Only user can attach a file');
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  const base = path.basename(name).replace(/[/\0]/g, '');
  // meta.json holds the mime, in any case on a case-insensitive disk, and . or .. would name a directory.
  const fileName =
    ['', '.', '..'].includes(base) || base.toLowerCase() === ATTACHMENT_META ? 'file' : base;
  const attachmentId = id(),
    directory = path.join(attachmentsDirectory(ctx, projectId), attachmentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, ATTACHMENT_META), JSON.stringify({ mime }), { mode: 0o600 });
  writeFileSync(path.join(directory, fileName), bytes, { mode: 0o600 });
  return { id: attachmentId, name: fileName, mime, size: bytes.byteLength };
}

/**
 * The attachments and skills a new turn carries. Attachments are copied into the session's
 * temporary directory: its sandbox denies reads of the data directory, and the temporary
 * directory is a writable root the session can read.
 */
export function turnExtras(
  ctx: ControlContext,
  session: Session,
  input: { attachments?: string[]; skills?: SessionTurn['skills']; refs?: SessionTurn['refs'] },
): Pick<SessionTurn, 'attachments' | 'skills' | 'refs' | 'reference_context'> {
  const summaries = input.refs?.map((ref) => {
    if (ref.kind !== 'session') return githubReference(ctx, session.project_id, ref);
    const referenced = ctx.store.must<Session>('sessions', ref.id);
    requireThat(
      referenced.project_id === session.project_id,
      'invalid_input',
      'Referenced session belongs to another project',
    );
    const summary = buildHandoff(ctx, referenced).split('\n\n').slice(1).join('\n\n');
    return `[Pantheon] Referenced session ${referenced.id}:\n${summary}`;
  });
  const skills = {
    ...(input.skills?.length ? { skills: input.skills } : {}),
    ...(summaries?.length ? { refs: input.refs, reference_context: summaries.join('\n\n') } : {}),
  };
  if (!input.attachments?.length) return skills;
  requireThat(session.workspace_id, 'invalid_state', 'Only a worktree session takes attachments');
  const found = input.attachments.map((attachmentId) => {
    const directory = path.join(attachmentsDirectory(ctx, session.project_id), attachmentId);
    // Ids are generated UUIDs; any other id could name a directory outside this project.
    const names =
      /^[A-Za-z0-9-]+$/.test(attachmentId) && existsSync(directory)
        ? readdirSync(directory).filter((name) => name !== ATTACHMENT_META)
        : [];
    requireThat(names.length === 1, 'not_found', `attachments/${attachmentId}`);
    const meta = JSON.parse(readFileSync(path.join(directory, ATTACHMENT_META), 'utf8')) as {
      mime: string;
    };
    return { id: attachmentId, name: names[0]!, mime: meta.mime, source: directory };
  });
  const temporary = writerTempDirectory(session.workspace_id),
    target = path.join(temporary, 'attachments');
  // A link the session put in place of its temporary directory would redirect every path below.
  requireThat(
    lstatSync(temporary, { throwIfNoEntry: false })?.isDirectory() !== false,
    'sandbox_path_replaced',
    `A writable sandbox root is no longer a real directory: ${temporary}`,
  );
  // The session can write here: a link it planted is removed, never followed.
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === false) unlinkSync(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  // Checked before anything in it is removed, so a swapped folder cannot point the removals elsewhere.
  requireThat(
    realpathSync(target) === path.join(realpathSync(temporary), 'attachments'),
    'sandbox_path_replaced',
    `A writable sandbox root is no longer a real directory: ${target}`,
  );
  const attachments = found.map(({ source, ...attachment }): TurnAttachment => {
    const copy = path.join(target, `${attachment.id}-${attachment.name}`);
    if (lstatSync(copy, { throwIfNoEntry: false })) unlinkSync(copy);
    // O_NOFOLLOW guards only the last component; a directory above it may since have become a link.
    const descriptor = openSync(
      copy,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const opened = fstatSync(descriptor),
        real = realpathSync(copy),
        found = statSync(real);
      if (!inside(temporary, real) || found.dev !== opened.dev || found.ino !== opened.ino) {
        const created = lstatSync(copy, { throwIfNoEntry: false });
        if (created?.dev === opened.dev && created.ino === opened.ino) unlinkSync(copy);
        throw new DomainError(
          'sandbox_path_replaced',
          `A writable sandbox root is no longer a real directory: ${target}`,
        );
      }
      writeFileSync(descriptor, readFileSync(path.join(source, attachment.name)));
    } finally {
      closeSync(descriptor);
    }
    return { ...attachment, path: copy };
  });
  return { ...skills, attachments };
}

const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv'];
const UNTRACKED = ['ls-files', '--others', '--exclude-standard', '-z'];
const trackedDiff = (base: string, ...extra: string[]) => [
  'diff',
  ...extra,
  ...DIFF_OPTIONS,
  '--find-renames',
  base,
  '--',
];
const untrackedDiff = (file: string, ...extra: string[]) => [
  'diff',
  '--no-index',
  ...extra,
  ...DIFF_OPTIONS,
  '--',
  '/dev/null',
  file,
];
// A no-index diff exits 1 when the files differ.
const noIndexDiffed = (code: number | null) => code === 0 || code === 1;

/** Untracked files a diff reads with Git, and the time it spends on them; later files come without lines. */
const UNTRACKED_DIFF_BOUND = 200,
  UNTRACKED_DIFF_TIME = 3 * TIME_BOUND;

/** Untracked files whose lines a listing reads; files past it count without lines. */
const UNTRACKED_LINES_BOUND = 2000;

/** Lines of a text as Git counts them: a last line without a newline still counts. */
const textLines = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** Lines of an untracked file as Git counts them; a file with a NUL byte is binary and has none. */
function untrackedLines(file: string): number {
  const stat = lstatSync(file);
  // Git diffs a symbolic link as the text of its target.
  if (stat.isSymbolicLink()) return textLines(readlinkSync(file));
  if (!stat.isFile()) return 0;
  // Non-blocking, so a path replaced by a named pipe since lstat opens at once; fstat then refuses it.
  const descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
    chunk = Buffer.alloc(64 * 1024);
  try {
    if (!fstatSync(descriptor).isFile()) return 0;
    let lines = 0,
      last = 0x0a,
      read: number;
    while ((read = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      const bytes = chunk.subarray(0, read);
      if (bytes.includes(0)) return 0;
      for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) lines++;
      last = bytes[read - 1]!;
    }
    return last === 0x0a ? lines : lines + 1;
  } finally {
    closeSync(descriptor);
  }
}

/** untrackedLines with asynchronous reads, so a large file does not hold the event loop. */
async function readUntrackedLines(file: string): Promise<number> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) return textLines(await readlink(file));
  if (!stat.isFile()) return 0;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    chunk = Buffer.alloc(64 * 1024);
  try {
    if (!(await handle.stat()).isFile()) return 0;
    let lines = 0,
      last = 0x0a,
      read: number;
    while ((read = (await handle.read(chunk, 0, chunk.length, null)).bytesRead) > 0) {
      const bytes = chunk.subarray(0, read);
      if (bytes.includes(0)) return 0;
      for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) lines++;
      last = bytes[read - 1]!;
    }
    return last === 0x0a ? lines : lines + 1;
  } finally {
    await handle.close();
  }
}

/** Changed files and lines of the directory against the base commit; null when it cannot be read. */
function worktreeChanges(directory: string, base: string): WorkbenchSession['changes'] {
  const tracked = runGit(directory, trackedDiff(base, '--numstat', '-z')),
    untracked = runGit(directory, UNTRACKED);
  if (tracked.exit_code !== 0 || untracked.exit_code !== 0) return null;
  const untrackedFiles = untrackedOf(untracked);
  let untrackedAdditions = 0;
  try {
    for (const file of untrackedFiles.slice(0, UNTRACKED_LINES_BOUND))
      untrackedAdditions += untrackedLines(path.join(directory, file));
  } catch {
    // The session removed or replaced a file while it was read.
    return null;
  }
  return changesOf(tracked, untrackedFiles, untrackedAdditions);
}

async function prefetchedChanges(
  directory: string,
  base: string,
): Promise<WorkbenchSession['changes']> {
  const tracked = await runGit(directory, trackedDiff(base, '--numstat', '-z'), undefined, true),
    untracked = await runGit(directory, UNTRACKED, undefined, true);
  if (tracked.exit_code !== 0 || untracked.exit_code !== 0) return null;
  const untrackedFiles = untrackedOf(untracked);
  let untrackedAdditions = 0;
  try {
    for (const file of untrackedFiles.slice(0, UNTRACKED_LINES_BOUND))
      untrackedAdditions += await readUntrackedLines(path.join(directory, file));
  } catch {
    // The session removed or replaced a file while it was read.
    return null;
  }
  return changesOf(tracked, untrackedFiles, untrackedAdditions);
}

const untrackedOf = (untracked: GitResult) =>
  untracked.stdout.toString().split('\0').filter(Boolean);

function changesOf(
  tracked: GitResult,
  untrackedFiles: string[],
  untrackedAdditions: number,
): WorkbenchSession['changes'] {
  const files = numstatFiles(tracked.stdout);
  return {
    files: files.length + untrackedFiles.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), untrackedAdditions),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}

const BRANCH_STATUS = ['status', '--porcelain=v2', '--branch', '-z'];

function branchStatus(result: GitResult) {
  if (result.exit_code !== 0) return null;
  const records = result.stdout.toString().split('\0');
  let branch: string | null = null,
    head = '',
    uncommitted = 0,
    ahead_upstream: number | undefined;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length);
      branch = name === '(detached)' ? null : name;
    } else if (record.startsWith('# branch.oid ')) head = record.slice('# branch.oid '.length);
    else if (record.startsWith('# branch.ab ')) ahead_upstream = Number(record.split(' ')[2]);
    else if (record && !record.startsWith('# ')) {
      uncommitted++;
      if (record.startsWith('2 ')) index++;
    }
  }
  return { branch, head, uncommitted, ...(ahead_upstream !== undefined ? { ahead_upstream } : {}) };
}

type SessionGitFacts = Pick<WorkbenchSession, 'branch' | 'ahead' | 'behind'> & {
  clean: boolean;
  head: string;
};

function sessionGitFacts(status: GitResult, distance?: GitResult): SessionGitFacts | null {
  const current = branchStatus(status);
  if (!current) return null;
  const [ahead, behind] = distance?.stdout.toString().trim().split(/\s+/).map(Number) ?? [];
  return {
    branch: current.branch,
    head: current.head,
    clean: current.uncommitted === 0,
    ...(distance?.exit_code === 0 ? { ahead: ahead!, behind: behind! } : {}),
  };
}

const WORKTREE_READ_MS = 2000;

interface WorktreeRead {
  /** When the entry was made, or its prefetch last read Git; WORKTREE_READ_MS counts from it. */
  at: number;
  activity: number;
  changes?: WorkbenchSession['changes'];
  facts?: SessionGitFacts | null;
  head?: string | null;
  /** The asynchronous read of the entry's missing fields, shared by concurrent prefetches. */
  prefetch?: Promise<void>;
  /** Set while prefetch runs; the entry is not replaced until it ends. */
  reading?: true;
  /** The reads of the entry this one replaced; a list from the cache shows them until this one has its own. */
  last?: KnownReads;
  /** Set when the entry replaced one of the same activity that aged out; a prefetch's answer does not wait for it. */
  aged?: true;
}

type KnownReads = Pick<WorktreeRead, 'changes' | 'facts' | 'head'>;

/** The entry's reads, each one it lacks taken from the entry it replaced. */
function knownReads(read: WorktreeRead): KnownReads {
  const { changes, facts, head, last } = read;
  return {
    changes: changes !== undefined ? changes : last?.changes,
    facts: facts !== undefined ? facts : last?.facts,
    head: head !== undefined ? head : last?.head,
  };
}

/** Whether the entry read a field the entry it replaced did not show. */
const readsMoved = (read: WorktreeRead) =>
  (['changes', 'facts', 'head'] as const).some(
    (key) =>
      read[key] !== undefined && JSON.stringify(read[key]) !== JSON.stringify(read.last?.[key]),
  );

/** The session list's Git reads of each workspace, by workspace id. */
const worktreeReads = new Map<string, WorktreeRead>();

/** Drops the workspace's listed Git reads after something other than session activity moved its worktree. */
export function forgetWorktreeReads(workspaceId: string): void {
  worktreeReads.delete(workspaceId);
}

/** The workspace's listed Git reads, empty after the session's last activity moved or the reads aged out. */
function worktreeRead(workspaceId: string, activity: number): WorktreeRead {
  const now = Date.now(),
    cached = worktreeReads.get(workspaceId);
  if (
    cached &&
    cached.activity === activity &&
    (cached.reading || now - cached.at < WORKTREE_READ_MS)
  )
    return cached;
  const read = {
    at: now,
    activity,
    ...(cached ? { last: knownReads(cached) } : {}),
    ...(cached?.activity === activity ? { aged: true as const } : {}),
  };
  worktreeReads.set(workspaceId, read);
  return read;
}

/** A folder session's checked folder, read against its HEAD; undefined when the folder cannot be read. */
function folderSource(
  ctx: ControlContext,
  p: Principal,
  workspace: Workspace,
): { directory: string; base: string } | undefined {
  try {
    // The scope check runs for every principal; only the Git read is reused.
    return { directory: checkedSource(ctx, p, workspace.project_id, workspace.path), base: 'HEAD' };
  } catch (error) {
    if (error instanceof DomainError) return undefined;
    throw error;
  }
}

const PREFETCH_WORKSPACES = 8;
let prefetching = 0;
const prefetchQueue: (() => void)[] = [];

/** Runs read once fewer than PREFETCH_WORKSPACES workspace prefetches run, across all projects. */
async function prefetchSlot(read: () => Promise<void>): Promise<void> {
  if (prefetching < PREFETCH_WORKSPACES) prefetching++;
  else await new Promise<void>((resolve) => prefetchQueue.push(resolve));
  try {
    await read();
  } finally {
    // A queued prefetch takes over the slot.
    const next = prefetchQueue.shift();
    if (next) next();
    else prefetching--;
  }
}

/** When the baseline of a baseline session without a title started; the interface names it by this. */
export function baselineStart(
  ctx: ControlContext,
  session: Session,
): { baseline_started_at?: number } {
  if (session.title !== undefined || !session.baseline) return {};
  const baseline = ctx.store.must<ProjectBaseline>(
    'project_baselines',
    session.baseline.baseline_id,
  );
  return { baseline_started_at: baseline.created_at };
}

/** The listed state, with idle standing for ready too: telling them apart reads the worktree. */
function listedState(
  ctx: ControlContext,
  session: Session,
  waiting: number,
  newestBaseline: string | undefined,
): WorkbenchSession['state'] {
  if (session.runtime_review)
    return session.state === 'running'
      ? 'running'
      : session.state === 'open'
        ? 'idle'
        : session.runtime_review.report
          ? 'done'
          : 'failed';
  if (!session.workspace_id) {
    const baseline = ctx.store.must<ProjectBaseline>(
      'project_baselines',
      session.baseline!.baseline_id,
    );
    return session.state === 'running'
      ? 'running'
      : waiting || (baseline.state === 'submitted' && baseline.id === newestBaseline)
        ? 'waiting'
        : baseline.state === 'running'
          ? 'idle'
          : baseline.state === 'failed'
            ? 'failed'
            : 'done';
  }
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id),
    // A folder session is never provisioned.
    provisioning = workspace.kind === 'in_place' ? 'ready' : workspace.provisioning?.state;
  return (
    session.outcome ??
    (session.merge?.state === 'running'
      ? 'merging'
      : provisioning === 'failed' || provisioning === 'cancelled' || session.state === 'closed'
        ? 'failed'
        : provisioning !== 'ready'
          ? 'starting'
          : waiting
            ? 'waiting'
            : session.state === 'running'
              ? 'running'
              : 'idle')
  );
}

const newestBaselineId = (ctx: ControlContext, projectId: string) =>
  ctx.store
    .list<ProjectBaseline>('project_baselines')
    .filter((baseline) => baseline.project_id === projectId)
    .at(-1)?.id;

export const TURN_ENDS = ['turn.completed', 'turn.failed', 'turn.cancelled'];

/** The waits that make a listed session waiting, by run wait reason. */
const WAITING_KIND: Partial<Record<string, WorkbenchSession['waiting_kind']>> = {
  approval: 'approval',
  question: 'question',
  baseline_review: 'baseline_review',
};

interface SessionActivity {
  /** Epoch milliseconds. */
  at: number;
  opened?: number;
  gate_counts?: {
    passed: number;
    failed: number;
    skipped: number;
    running: number;
    not_run?: number;
  };
  checked?: { at: number; failed: boolean; stale: boolean; spec: string; commit: string };
  /** A gate started and has not been checked, cancelled or ended with its merge since. */
  gating?: boolean;
}

/** Each session's newest activity and newest gate run, read from the project's events. */
function sessionActivity(
  ctx: ControlContext,
  projectId: string,
  approvals: Approval[],
): Map<string, SessionActivity> {
  const sessionOf = new Map(
    (
      ctx.store.db
        .prepare(
          "SELECT id, data->>'$.session_id' AS session_id FROM session_turns WHERE data->>'$.project_id'=?",
        )
        .all(projectId) as { id: string; session_id: string }[]
    ).map((turn) => [turn.id, turn.session_id]),
  );
  const activity = new Map<string, SessionActivity>();
  const touch = (sessionId: string, at: number) => {
    const entry = activity.get(sessionId) ?? { at };
    entry.at = Math.max(entry.at, at);
    activity.set(sessionId, entry);
    return entry;
  };
  for (const approval of approvals)
    if (approval.session_id) touch(approval.session_id, approval.created_at);
  const kinds = [
    'session.opened',
    'session.merged',
    'session.merge_blocked',
    'session.merge_cancelled',
    'session.merge_cancel_requested',
    'session.gate_run_requested',
    'session.gate_started',
    'session.gate_checked',
    'session.gate_step_checked',
    'session.gate_run_cancelled',
    'session.gate_run_failed',
    'turn.running',
    ...TURN_ENDS,
  ];
  // Only the gate counts read a payload; the turn events' payloads stay unread.
  const payloadKinds = [
    'session.gate_started',
    'session.gate_run_requested',
    'session.gate_step_checked',
    'session.gate_checked',
  ];
  const rows = ctx.store.db
    .prepare(
      `SELECT kind, aggregate_id, created_at, CASE WHEN kind IN (${payloadKinds.map(() => '?').join(',')}) THEN payload END AS payload FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY sequence`,
    )
    .all(...payloadKinds, projectId, ...kinds) as {
    kind: string;
    aggregate_id: string;
    created_at: number;
    payload: string | null;
  }[];
  for (const event of rows) {
    const turnSession = sessionOf.get(event.aggregate_id),
      entry = touch(turnSession ?? event.aggregate_id, event.created_at);
    if (event.kind === 'session.opened') entry.opened = event.created_at;
    if (event.kind === 'session.gate_started' || event.kind === 'session.gate_run_requested') {
      const payload = JSON.parse(event.payload!) as { commands?: unknown[] };
      entry.gating = true;
      entry.gate_counts = {
        passed: 0,
        failed: 0,
        skipped: 0,
        running: payload.commands?.length ?? 0,
      };
    } else if (
      event.kind === 'session.gate_run_cancelled' ||
      event.kind === 'session.gate_run_failed' ||
      event.kind === 'session.merge_cancelled' ||
      event.kind === 'session.merge_blocked'
    ) {
      entry.gating = false;
      if (entry.gate_counts) entry.gate_counts.running = 0;
    } else if (
      event.kind === 'session.gate_step_checked' ||
      event.kind === 'session.gate_checked'
    ) {
      const { results, check_spec_hash, commit, total } = JSON.parse(event.payload!) as {
        results: NonNullable<LandingItem['gate_results']>;
        check_spec_hash: string;
        commit: string;
        total?: number;
      };
      const before = entry.gate_counts;
      entry.gate_counts = {
        passed: results.filter((result) => result.state !== 'skipped' && !gateFailed(result))
          .length,
        failed: results.filter(gateFailed).length,
        skipped: results.filter((result) => result.state === 'skipped').length,
        running: event.kind === 'session.gate_checked' ? 0 : total! - results.length,
      };
      // The run's planned total is in the counts its start or last step left.
      const notRun = before
        ? before.passed +
          before.failed +
          before.skipped +
          before.running +
          (before.not_run ?? 0) -
          results.length
        : 0;
      if (event.kind === 'session.gate_checked' && notRun > 0) entry.gate_counts.not_run = notRun;
      if (event.kind === 'session.gate_step_checked') continue;
      entry.gating = false;
      entry.checked = {
        at: event.created_at,
        failed: results.some(gateFailed),
        stale: false,
        spec: check_spec_hash,
        commit,
      };
    } else if (turnSession && entry.checked && TURN_ENDS.includes(event.kind))
      // The run checked the head it started on; a turn ending since may have committed.
      entry.checked.stale = true;
  }
  return activity;
}

interface ListedSession {
  session: Session;
  requests: Approval[];
  state: WorkbenchSession['state'];
  activity: SessionActivity | undefined;
  workspace?: Workspace;
  commands?: ReturnType<typeof gateCommands>;
  /** The workspace's Git reads; absent when the list does not read the worktree. */
  cached?: WorktreeRead;
}

type ListedRead = ListedSession & { workspace: Workspace; cached: WorktreeRead };

/** The project's listed sessions with their state, and the cache entry of each the list reads Git for. */
function listedSessions(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  readChanges: boolean,
): ListedSession[] {
  projectAccess(ctx, p, projectId, 'project.read');
  const approvals = ctx.store
    .list<Approval>('approvals')
    .filter((approval) => approval.project_id === projectId);
  const pending = approvals.filter(
    (approval) => approval.kind === 'permission' && approval.state === 'pending',
  );
  const newestBaseline = newestBaselineId(ctx, projectId);
  const activities = sessionActivity(ctx, projectId, approvals),
    project = ctx.store.must<Project>('projects', projectId);
  return ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.project_id === projectId &&
        (session.workspace_id || session.baseline || session.runtime_review),
    )
    .map((session) => {
      const requests = pending.filter((approval) => approval.session_id === session.id);
      const state = listedState(ctx, session, requests.length, newestBaseline),
        activity = activities.get(session.id);
      if (!session.workspace_id) return { session, requests, state, activity };
      const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
      return {
        session,
        requests,
        state,
        activity,
        workspace,
        // A folder session has no merge gate.
        commands:
          workspace.kind === 'in_place'
            ? undefined
            : gateCommands(ctx, project, workspace, session),
        ...(readChanges && workspaceReady(workspace) && workspace.removed_at === undefined
          ? { cached: worktreeRead(workspace.id, activity?.at ?? 0) }
          : {}),
      };
    });
}

type GitStep = { read: 'changes'; directory: string; base: string } | { read: 'facts' | 'head' };

interface ListedGit {
  changes: WorkbenchSession['changes'];
  worktree: { clean: boolean; head: string } | null;
  head: string | undefined;
}

/** The worktree facts a listed session's state reads; null when its state reads none. */
function stateWorktree(
  workspace: Workspace,
  state: WorkbenchSession['state'],
  facts: SessionGitFacts | null | undefined,
): ListedGit['worktree'] {
  // Ready means mergeable work: commits on the base and nothing uncommitted, whatever files they change.
  return workspace.kind !== 'in_place' && state === 'idle' ? (facts ?? null) : null;
}

const listsReady = (workspace: Workspace, worktree: ListedGit['worktree']) =>
  !!worktree?.clean && worktree.head !== workspace.base_sha;

/**
 * Whether the session lists as ready by the newest cached Git reads of its workspace, as a list
 * from the cache shows them; runs no Git, and is undefined while no list read what its state needs.
 */
export function cachedReady(
  ctx: ControlContext,
  session: Session,
  workspace: Workspace,
  waiting: boolean,
): boolean | undefined {
  if (!workspaceReady(workspace) || workspace.kind === 'in_place') return false;
  const cached = worktreeReads.get(workspace.id);
  if (!cached) return undefined;
  const { facts } = knownReads(cached);
  // A failed read (null) says no more than a missing one.
  if (facts == null) return undefined;
  return listsReady(
    workspace,
    stateWorktree(workspace, listedState(ctx, session, waiting ? 1 : 0, undefined), facts),
  );
}

/** What the list shows of the worktree from the cached reads, or the next read the cache lacks. */
function listedGit(ctx: ControlContext, p: Principal, listed: ListedRead): ListedGit | GitStep {
  const { workspace, cached } = listed,
    inPlace = workspace.kind === 'in_place';
  const source = ['starting', 'failed', 'merged', 'discarded'].includes(listed.state)
    ? undefined
    : inPlace
      ? folderSource(ctx, p, workspace)
      : { directory: workspace.path, base: workspace.base_sha! };
  if (!inPlace && cached.facts === undefined) return { read: 'facts' };
  if (source && cached.changes === undefined) return { read: 'changes', ...source };
  const changes = source ? cached.changes! : null;
  const worktree = stateWorktree(workspace, listed.state, cached.facts);
  // A commit or rollback outside a turn also moves HEAD off the commit the run checked.
  // Facts read before an empty commit would hide it, so a worktree without changed files reads HEAD too.
  const readsHead =
    !!listed.activity?.checked &&
    !!listed.commands?.length &&
    !!changes &&
    (!worktree || !changes.files);
  if (readsHead && cached.head === undefined) return { read: 'head' };
  return {
    changes,
    worktree,
    head: readsHead ? (cached.head ?? undefined) : worktree?.head,
  };
}

function readListedGit(ctx: ControlContext, p: Principal, listed: ListedRead): ListedGit {
  const { workspace, cached } = listed;
  for (;;) {
    const next = listedGit(ctx, p, listed);
    if (!('read' in next)) return next;
    if (next.read === 'changes') cached.changes = worktreeChanges(next.directory, next.base);
    else if (next.read === 'facts') {
      cached.facts = sessionGitFacts(
        runGit(workspace.path, BRANCH_STATUS),
        workspace.source_branch
          ? runGit(workspace.path, [
              'rev-list',
              '--left-right',
              '--count',
              `HEAD...refs/heads/${workspace.source_branch}`,
              '--',
            ])
          : undefined,
      );
    }
    // Only a prefetch caches HEAD; a list without one reads it each time, so a commit outside a turn shows at once.
    else
      listed = {
        ...listed,
        cached: { ...cached, head: headOf(runGit(workspace.path, HEAD_COMMIT)) },
      };
  }
}

/** What the list shows of the worktree from the cached reads alone; a read not cached shows as unknown. */
function cachedListedGit(ctx: ControlContext, p: Principal, listed: ListedRead): ListedGit {
  const cached = { ...listed.cached, ...knownReads(listed.cached) };
  for (;;) {
    const next = listedGit(ctx, p, { ...listed, cached });
    if (!('read' in next)) return next;
    cached[next.read] = null;
  }
}

async function prefetchListedGit(ctx: ControlContext, p: Principal, listed: ListedRead) {
  const { workspace, cached } = listed;
  for (;;) {
    const next = listedGit(ctx, p, listed);
    if (!('read' in next)) return;
    if (next.read === 'changes')
      cached.changes = await prefetchedChanges(next.directory, next.base);
    else if (next.read === 'facts') {
      cached.facts = sessionGitFacts(
        await runGit(workspace.path, BRANCH_STATUS, undefined, true),
        workspace.source_branch
          ? await runGit(
              workspace.path,
              [
                'rev-list',
                '--left-right',
                '--count',
                `HEAD...refs/heads/${workspace.source_branch}`,
                '--',
              ],
              undefined,
              true,
            )
          : undefined,
      );
    } else cached.head = headOf(await runGit(workspace.path, HEAD_COMMIT, undefined, true));
    cached.at = Date.now();
  }
}

/**
 * Runs the Git reads sessionList would run, asynchronously, into its cache; emits
 * workspace.repository_changed when a read this call started found what the list did not show.
 */
export function prefetchWorktreeReads(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<void> {
  const started: WorktreeRead[] = [],
    awaited: Promise<void>[] = [];
  const reads = listedSessions(ctx, p, projectId, true)
    .filter((listed): listed is ListedRead => !!listed.cached)
    .map((listed) => {
      const { cached } = listed;
      if (!cached.prefetch) {
        started.push(cached);
        cached.reading = true;
        cached.prefetch = prefetchSlot(() => prefetchListedGit(ctx, p, listed)).finally(
          () => delete cached.reading,
        );
      }
      if (!cached.aged) awaited.push(cached.prefetch);
      return cached.prefetch;
    });
  const work: Promise<void> = Promise.all(reads)
    .then(() => {
      if (ctx.closing || !started.some(readsMoved)) return;
      // Clients read the list again only after an event.
      ctx.store.event(
        'workspace.repository_changed',
        ctx.store.must<Project>('projects', projectId),
        projectId,
        {},
      );
      ctx.changed();
    })
    .finally(() => ctx.completions.delete(work));
  ctx.completions.add(work);
  // Reads that only aged out land later with their event; racing work keeps its failure handled.
  return Promise.race([work, Promise.all(awaited).then(() => undefined)]);
}

/**
 * `readChanges` false skips the per-worktree Git read; ready sessions then list as idle.
 * 'cached' reads no Git: it shows the cached reads, and a read not cached yet as unknown.
 */
export function sessionList(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  readChanges: boolean | 'cached' = true,
): WorkbenchSession[] {
  const listed = listedSessions(ctx, p, projectId, readChanges !== false);
  const predictions = repositoryInsights(ctx, projectId).predictions;
  // Free text is read as JSON and parsed here: ->> would not keep a lone surrogate.
  type ListedTurn = Pick<SessionTurn, 'id' | 'session_id' | 'kind' | 'state'> & {
    delivery_reason: string | null;
    rolled_back: number | null;
    usage: string | null;
  };
  const latestSends = new Map<string, ListedTurn>(),
    // The usage JSON of each session's newest turn that reports context tokens.
    latestContexts = new Map<string, string>(),
    firstInputs = new Map<string, { text: string; at: string }>();
  const initialInputs = new Set<string>();
  const queued = ctx.store.db
    .prepare(
      "SELECT e.created_at, t.data->>'$.session_id' AS session_id, t.data->>'$.origin' AS origin, t.data->'$.input' AS input FROM events e INDEXED BY events_project_kind JOIN session_turns t ON t.id=e.aggregate_id WHERE e.project_id=? AND e.kind='turn.queued' ORDER BY e.sequence",
    )
    .all(projectId) as {
    created_at: number;
    session_id: string;
    origin: SessionTurn['origin'] | null;
    input: string;
  }[];
  for (const turn of queued) {
    // Analysis marks both its generated first turn and user follow-ups as reflection.
    const generated =
      turn.origin && (turn.origin !== 'reflection' || !initialInputs.has(turn.session_id));
    initialInputs.add(turn.session_id);
    if (!generated && !firstInputs.has(turn.session_id))
      firstInputs.set(turn.session_id, {
        text: (JSON.parse(turn.input) as string).slice(0, 200),
        at: new Date(turn.created_at).toISOString(),
      });
  }
  const projectTurns = ctx.store.db
    .prepare(
      "SELECT id, data->>'$.session_id' AS session_id, data->>'$.kind' AS kind, data->>'$.state' AS state, data->'$.delivery_reason' AS delivery_reason, data->>'$.rolled_back' AS rolled_back, CASE WHEN json_type(data,'$.usage.context_tokens') IS NOT NULL THEN data->'$.usage' END AS usage FROM session_turns WHERE data->>'$.project_id'=? ORDER BY rowid",
    )
    .all(projectId) as ListedTurn[];
  for (const turn of projectTurns) {
    if (turn.kind === 'send' && !turn.rolled_back) latestSends.set(turn.session_id, turn);
    if (turn.usage !== null) latestContexts.set(turn.session_id, turn.usage);
  }
  const sessionTurns = new Map<string, ListedTurn[]>();
  for (const turn of projectTurns)
    sessionTurns.set(turn.session_id, [...(sessionTurns.get(turn.session_id) ?? []), turn]);
  const times = runTimes(
      ctx,
      projectId,
      new Map(projectTurns.map((turn) => [turn.id, turn.session_id])),
    ),
    now = ctx.store.now();
  const compactions = new Map<string, number>();
  for (const event of ctx.store.db
    .prepare(
      "SELECT aggregate_id FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind='agent.context.compacted'",
    )
    .all(projectId) as { aggregate_id: string }[])
    compactions.set(event.aggregate_id, (compactions.get(event.aggregate_id) ?? 0) + 1);
  const latestErrors = new Map<string, string>(),
    latestErrorCodes = new Map<string, string>();
  // A payload field that is not a string reads as null.
  const text = (field: string, as: '->' | '->>') =>
    `CASE WHEN json_type(payload,'$.${field}')='text' THEN payload${as}'$.${field}' END AS ${field}`;
  for (const event of ctx.store.db
    .prepare(
      `SELECT kind, aggregate_id, ${text('turn_id', '->>')}, ${text('error_code', '->')}, ${text('error', '->')} FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind IN ('turn.failed','turn.cancelled','agent.turn.completed') ORDER BY sequence`,
    )
    .all(projectId) as {
    kind: string;
    aggregate_id: string;
    turn_id: string | null;
    error_code: string | null;
    error: string | null;
  }[]) {
    // The runtime's own code comes on its completion event, keyed by turn_id; a launch failure's on turn.failed.
    const turnId = event.kind === 'agent.turn.completed' ? event.turn_id : event.aggregate_id;
    if (turnId === null) continue;
    if (event.error_code !== null) latestErrorCodes.set(turnId, JSON.parse(event.error_code));
    if (event.kind !== 'agent.turn.completed' && event.error !== null)
      latestErrors.set(turnId, JSON.parse(event.error));
  }
  // Task sessions of one lead share its plan.
  const plans = new Map<string, BoardPlan | undefined>();
  const planOf = (leadId: string) => {
    if (!plans.has(leadId)) plans.set(leadId, ctx.store.get<BoardPlan>('board_plans', leadId));
    return plans.get(leadId);
  };
  const restorable = restorableTurns(ctx, projectId);
  return listed.map((each): WorkbenchSession => {
    const { session, requests, state, activity, workspace, commands, cached } = each;
    const latestTurn = latestSends.get(session.id);
    const turnError = (
      latestTurn &&
      (latestErrors.get(latestTurn.id) ??
        (latestTurn.delivery_reason === null
          ? undefined
          : (JSON.parse(latestTurn.delivery_reason) as string | null)))
    )?.slice(0, 200);
    const turnErrorCode =
      latestTurn && ['failed', 'cancelled'].includes(latestTurn.state)
        ? latestErrorCodes.get(latestTurn.id)
        : undefined;
    const waiting = requests.length;
    const request = [...requests].sort((a, b) => a.created_at - b.created_at)[0];
    const usageJson = latestContexts.get(session.id);
    const usage =
      usageJson === undefined
        ? undefined
        : (JSON.parse(usageJson) as NonNullable<SessionTurn['usage']>);
    const marks = {
      ...(session.pinned_at ? { pinned_at: session.pinned_at } : {}),
      ...(session.archived_at ? { archived_at: session.archived_at } : {}),
      ...(session.snoozed_at ? { snoozed_at: session.snoozed_at } : {}),
      ...(session.backend_id ? { backend_id: session.backend_id } : {}),
      ...(session.forked_from ? { forked_from: session.forked_from } : {}),
      ...(session.app_debug ? { app_debug: session.app_debug } : {}),
    };
    const plan = session.task ? planOf(session.task.lead_session_id) : undefined;
    const task = plan && sessionPlanTask(plan, session);
    const goal = task
      ? { text: task.goal.slice(0, 200), at: new Date(plan!.updated_at).toISOString() }
      : firstInputs.get(session.id);
    const fastModel = sessionModel(ctx, session)?.fast || session.fast;
    const facts = {
      ...(fastModel ? { fast_mode: { on: session.fast === true, ...session.fast_mode } } : {}),
      ...(ultracodeSession(session) ? { ultracode: session.ultracode === true } : {}),
      remote_pull: session.remote_pull ?? {
        status: 'not_needed' as const,
        changed_at: new Date(activity?.opened ?? 0).toISOString(),
      },
      ...(goal ? { goal } : {}),
      ...(session.device_id ? { device_id: session.device_id } : {}),
      compaction_count: compactions.get(session.id) ?? 0,
      ...(session.auto_compact_at_tokens !== undefined
        ? { auto_compact_at_tokens: session.auto_compact_at_tokens }
        : {}),
      ...(session.enabled_user_connectors !== undefined
        ? { enabled_user_connectors: session.enabled_user_connectors }
        : {}),
      ...(latestTurn
        ? {
            last_turn: {
              id: latestTurn.id,
              state: latestTurn.state,
              ...(turnError ? { error: turnError } : {}),
              ...(turnErrorCode ? { error_code: turnErrorCode } : {}),
            },
          }
        : {}),
      ...(request
        ? {
            waiting_request: {
              tool: request.tool ?? '',
              ...(request.input_summary ? { detail: request.input_summary } : {}),
            },
          }
        : {}),
      ...(usage?.context_window !== undefined
        ? { context: { used_tokens: usage.context_tokens!, window_tokens: usage.context_window } }
        : {}),
      ...(session.pull_request ? { pull_request: session.pull_request } : {}),
      // As session.rollback, which restores files only of an open session in a git worktree.
      ...(restorable.has(session.id) && !session.outcome && gitWorkspace(ctx, session)
        ? { checkpoint_turn_id: restorable.get(session.id) }
        : {}),
      workspace_kind: 'linked_worktree' as const,
      reconciling: session.state === 'reconciling',
      stopping: !!session.stop_pending || (!!session.stop_requested && !session.outcome),
      created_at: new Date(activity?.opened ?? 0).toISOString(),
      last_activity_at: new Date(activity?.at ?? 0).toISOString(),
    };
    const withRun = (shown: WorkbenchSession): WorkbenchSession => {
      const run = sessionRun(
          ctx,
          session,
          shown,
          sessionTurns.get(session.id) ?? [],
          requests,
          times.get(session.id) ?? {},
          now,
        ),
        waitingKind = shown.state === 'waiting' ? WAITING_KIND[run.wait?.reason ?? ''] : undefined,
        running =
          session.state === 'closed'
            ? 0
            : sessionTasks(ctx, session.id).tasks.filter((task) => task.state === 'running').length;
      return {
        ...shown,
        run,
        ...(running ? { tasks: { running } } : {}),
        ...(waitingKind ? { waiting_kind: waitingKind } : {}),
        ...(session.recap ? { recap: session.recap } : {}),
      };
    };
    if (!workspace)
      return withRun({
        id: session.id,
        ...(session.runtime_review ? { runtime_review: true } : {}),
        title: session.title ?? '',
        ...baselineStart(ctx, session),
        runtime: session.runtime,
        model: session.reported_model ?? session.requested_model ?? null,
        effort: session.requested_effort ?? null,
        permission_mode: session.permission_mode ?? 'ask',
        workspace_id: null,
        state,
        waiting,
        changes: null,
        merge: null,
        ...facts,
        ...marks,
      });
    const { changes, worktree, head } = !cached
      ? { changes: null, worktree: null, head: undefined }
      : readChanges === 'cached'
        ? cachedListedGit(ctx, p, { ...each, workspace, cached })
        : readListedGit(ctx, p, { ...each, workspace, cached });
    const gitFacts = cached && knownReads(cached).facts;
    const checked = activity?.checked;
    const gate:
      Omit<NonNullable<WorkbenchSession['gate']>, 'passed' | 'failed' | 'running'> | undefined =
      !commands?.length
        ? undefined
        : session.gate_run?.state === 'cancelling' || session.gate_run?.state === 'cancelled'
          ? { state: session.gate_run.state }
          : session.gate_run?.state === 'failed'
            ? {
                state: 'failed',
                ...(session.gate_run.finished_at
                  ? { finished_at: new Date(session.gate_run.finished_at).toISOString() }
                  : {}),
              }
            : gateOperationActive(session) ||
                runningGates(ctx).has(session.id) ||
                (session.merge?.state === 'running' && activity?.gating)
              ? { state: 'running' }
              : checked
                ? {
                    state:
                      checked.stale ||
                      checked.spec !== hash(commands) ||
                      (head !== undefined && head !== checked.commit)
                        ? 'stale'
                        : checked.failed
                          ? 'failed'
                          : 'passed',
                    finished_at: new Date(checked.at).toISOString(),
                  }
                : undefined;
    return withRun({
      id: session.id,
      title: session.title ?? '',
      runtime: session.runtime,
      model: session.reported_model ?? session.requested_model ?? null,
      effort: session.requested_effort ?? null,
      permission_mode: session.permission_mode ?? 'ask',
      workspace_id: workspace.id,
      state: listsReady(workspace, worktree) ? 'ready' : state,
      waiting,
      changes,
      merge: session.merge ? publicMerge(session.merge) : null,
      ...facts,
      workspace_kind: workspace.kind,
      ...(gitFacts
        ? { branch: gitFacts.branch, ahead: gitFacts.ahead, behind: gitFacts.behind }
        : {}),
      ...(predictions.has(session.id)
        ? { predicted_conflicts: predictions.get(session.id)!.value }
        : {}),
      ...(gate
        ? {
            gate: {
              ...gate,
              ...(activity?.gate_counts ?? { passed: 0, failed: 0, skipped: 0, running: 0 }),
            },
          }
        : {}),
      ...(session.task ? { lead: session.task.lead_session_id } : {}),
      ...marks,
    });
  });
}

/** The merge as the session list shows it, without what only the daemon reads. */
function publicMerge(merge: NonNullable<Session['merge']>) {
  const {
    landing: _landing,
    allow_out_of_scope: _allowed,
    allowed_files: _allowedFiles,
    conflict_tasks: _conflictTasks,
    ...shown
  } = merge;
  return shown;
}

/** The change a merged session fast-forwarded into its source, read there after its worktree is removed. */
async function mergedSessionDiff(
  ctx: ControlContext,
  principal: Principal,
  session: Session,
  workspace: Workspace,
): Promise<SessionDiff> {
  const git = sourceGit(ctx, principal, session.project_id, workspace.source!);
  const failed = (): never => {
    throw new DomainError(
      'workspace_read_failed',
      'Merged session diff failed or exceeded its time bound',
    );
  };
  const merged = ctx.store
    .kindEvents(session.project_id, ['session.merged'])
    .findLast((event) => event.aggregate_id === session.id)?.payload as
    { from_sha?: string; to_sha?: string } | undefined;
  if (!merged?.from_sha || !merged.to_sha)
    throw new DomainError('landing_unavailable', 'Session merge recorded no commits');
  const range = [...DIFF_OPTIONS, '--find-renames', merged.from_sha, merged.to_sha, '--'];
  const numstat = await git(['diff', '--numstat', '-z', ...range], {
    max_buffer: 4 * PATCH_BOUND,
    timeout_ms: TIME_BOUND,
  });
  if (numstat.exit_code !== 0) failed();
  const patch = await git(['diff', ...range], { max_buffer: PATCH_BOUND, timeout_ms: TIME_BOUND });
  const truncated =
    patch.exit_code !== 0 && /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/.test(patch.error ?? '');
  if (patch.exit_code !== 0 && !truncated) failed();
  return {
    session_id: session.id,
    base_sha: merged.from_sha,
    head_sha: merged.to_sha,
    files: numstatFiles(numstat.stdout).map((file) => ({ ...file, untracked: false })),
    patch: truncated ? null : patch.stdout.toString(),
    truncated,
  };
}

/** The worktree's committed, uncommitted and untracked changes against its base commit. */
export async function readSessionDiff(
  ctx: ControlContext,
  principal: Principal,
  sessionId: string,
): Promise<SessionDiff> {
  const session = ctx.store.must<Session>('sessions', sessionId);
  requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
  if (session.outcome === 'merged') return mergedSessionDiff(ctx, principal, session, workspace);
  // A folder session's diff is the uncommitted work in the user's own checkout.
  const inPlace = workspace.kind === 'in_place';
  const run = inPlace
    ? sourceGit(ctx, principal, session.project_id, workspace.path)
    : workspaceReadAccess(ctx, principal, workspace).git;
  if (!run)
    throw new DomainError(
      'workspace_unavailable',
      'Workspace directory is missing or not a Git repository',
    );
  const failed = (): never => {
    throw new DomainError(
      'workspace_read_failed',
      'Session diff failed or exceeded its time bound',
    );
  };
  const base = inPlace ? 'HEAD' : workspace.base_sha;
  if (!base) throw new DomainError('diff_base_missing', 'Worktree has no base commit');
  const bound = { max_buffer: 4 * PATCH_BOUND, timeout_ms: TIME_BOUND };
  const head = await run(['rev-parse', 'HEAD'], { max_buffer: 4096, timeout_ms: TIME_BOUND });
  const numstat = await run(trackedDiff(base, '--numstat', '-z'), bound);
  const untracked = await run(UNTRACKED, bound);
  if (head.exit_code !== 0 || numstat.exit_code !== 0 || untracked.exit_code !== 0) failed();
  const files: SessionDiff['files'] = numstatFiles(numstat.stdout).map((file) => ({
    ...file,
    untracked: false,
  }));
  let patch = '',
    truncated = false;
  // Appends a patch within the remaining bound; false when the command failed.
  const append = async (args: string[], accepted: (code: number | null) => boolean) => {
    const remaining = PATCH_BOUND - Buffer.byteLength(patch);
    if (truncated || remaining <= 0) return (truncated = true);
    const result = await run(args, { max_buffer: remaining, timeout_ms: TIME_BOUND });
    if (accepted(result.exit_code)) patch += result.stdout.toString();
    else if (/ERR_CHILD_PROCESS_STDIO_MAXBUFFER/.test(result.error ?? '')) truncated = true;
    else return false;
    return true;
  };
  if (!(await append(trackedDiff(base), (code) => code === 0))) failed();
  const deadline = Date.now() + UNTRACKED_DIFF_TIME;
  for (const [index, file] of untracked.stdout.toString().split('\0').filter(Boolean).entries()) {
    // Each untracked file costs its own Git processes; past the bounds its lines stay unknown.
    if (index >= UNTRACKED_DIFF_BOUND || Date.now() >= deadline) {
      files.push({ path: file, additions: null, deletions: null, untracked: true });
      truncated = true;
      continue;
    }
    const counted = await run(untrackedDiff(file, '--numstat', '-z'), bound);
    if (!noIndexDiffed(counted.exit_code)) failed();
    const [stat] = numstatFiles(counted.stdout);
    files.push({
      path: file,
      additions: stat ? stat.additions : 0,
      deletions: stat ? stat.deletions : 0,
      untracked: true,
    });
    if (!(await append(untrackedDiff(file), noIndexDiffed))) failed();
  }
  const headSha = head.stdout.toString().trim();
  return {
    session_id: session.id,
    base_sha: inPlace ? headSha : base,
    head_sha: headSha,
    files,
    patch: truncated ? null : patch,
    truncated,
  };
}

const nativeKeys = (ctx: ControlContext, sessionId: string) =>
  [...ctx.handles]
    .filter(([, handle]) => handle.platform_session_id === sessionId)
    .map(([key]) => key);

/** Closes the session's native processes; false when one did not confirm it stopped. */
async function closeNativeProcesses(ctx: ControlContext, sessionId: string): Promise<boolean> {
  await Promise.all(
    nativeKeys(ctx, sessionId).map((key) => stopTurn(ctx, key, undefined, 'close')),
  );
  return !nativeKeys(ctx, sessionId).length;
}

const NO_MERGE_GATE = 'A session in the user folder has no merge gate';

/** Refuses a session in the user's own folder, which has no worktree to check, merge, discard or move. */
function refuseInPlace(ctx: ControlContext, session: Session, message: string): void {
  requireThat(
    !session.workspace_id ||
      ctx.store.must<Workspace>('workspaces', session.workspace_id).kind !== 'in_place',
    'invalid_state',
    message,
  );
}

const DISCARDED_TEXT =
  'The user discarded the session. The task is todo again and its downstream tasks do not open until it is done; start it again with start_task, change the plan, or ask the user.';
const DISCARDED_ACCEPTED_TEXT =
  'The user discarded the session. You accepted its report, so the task stays done; change its contract or stop it with stop_task to reopen it.';

/** The caller owns the transaction; the session's native process has ended. */
export function discardSession(
  ctx: ControlContext,
  sessionId: string,
  cause: string,
  remove = true,
): Session {
  unsnooze(ctx, sessionId, 'session_ended', cause);
  const current = ctx.store.must<Session>('sessions', sessionId);
  const next = ctx.store.update(
    'sessions',
    { ...current, state: 'closed' as const, outcome: 'discarded' as const, merge: undefined },
    current.revision,
  );
  ctx.store.event('session.discarded', next, next.project_id, {}, cause);
  if (next.workspace_id) worktreeReads.delete(next.workspace_id);
  // The folder of a folder session is the user's own checkout.
  if (
    remove &&
    next.workspace_id &&
    ctx.store.must<Workspace>('workspaces', next.workspace_id).kind !== 'in_place'
  )
    ctx.store.enqueue('workspace.remove', {
      workspace_id: next.workspace_id,
      reason: 'discarded',
    });
  // A lead that stopped the task itself already knows.
  const plan = next.task && ctx.store.get<BoardPlan>('board_plans', next.task.lead_session_id);
  if (plan && next.stop_requested?.by !== 'lead' && currentBinding(plan, next.task!))
    appendNote(ctx, plan, {
      at: ctx.store.now(),
      session_id: next.id,
      task_id: next.task!.id,
      kind: 'discarded',
      text: currentAcceptance(plan, next.task!.id) ? DISCARDED_ACCEPTED_TEXT : DISCARDED_TEXT,
    });
  return next;
}

/**
 * Discards the worktree session; one with a native process keeps the stop on its row and is
 * discarded once the process confirms it stopped, by recovery when the daemon restarts first.
 */
export function stopWorktreeSession(
  ctx: ControlContext,
  session: Session,
  stop: { reason: string; by: 'user' | 'lead' },
  cause: string,
): Session {
  // A merge may already have moved the source; it records its own result.
  requireThat(
    session.merge?.state !== 'running',
    'merge_in_progress',
    'Wait for the merge of the session to end',
  );
  const marked = ctx.store.update(
    'sessions',
    { ...session, stop_requested: { ...stop, at: ctx.store.now() } },
    session.revision,
  );
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  if (['queued', 'running'].includes(workspace.provisioning?.state ?? '')) {
    // Provisioning removes the worktree once its cancellation has stopped Git.
    cancelProvisioning(ctx, workspace, cause);
    failWorkbenchTurns(ctx, marked, 'Session discarded');
    return discardSession(ctx, session.id, cause, false);
  }
  if (!nativeKeys(ctx, session.id).length) {
    // Nothing can confirm the end of a process a restart left without a stored identity; the user discards it.
    if (
      session.state === 'reconciling' &&
      !session.process_identity &&
      !nativeTurnActive(ctx, session) &&
      stop.by === 'user'
    ) {
      failWorkbenchTurns(ctx, marked, 'Session discarded');
      return discardSession(ctx, session.id, cause);
    }
    // A process still starting is closed by finishStops, one a restart left by reconcile.
    if (
      session.state === 'reconciling' ||
      session.process_identity ||
      nativeTurnActive(ctx, session)
    )
      return marked;
    failWorkbenchTurns(ctx, marked, 'Session discarded');
    return discardSession(ctx, session.id, cause);
  }
  closeStopped(ctx, session.id, cause);
  return marked;
}

// Sessions whose stop is closing their native processes.
const stopsClosing = new WeakMap<ControlContext, Set<string>>();

/** Closes the stopped session's native processes once the command commits, then discards it. */
function closeStopped(ctx: ControlContext, sessionId: string, cause: string): void {
  let closing = stopsClosing.get(ctx);
  if (!closing) stopsClosing.set(ctx, (closing = new Set()));
  closing.add(sessionId);
  const failed = (error: string): void => {
    const current = ctx.store.must<Session>('sessions', sessionId);
    ctx.store.event('session.discard_failed', current, current.project_id, { error }, cause);
  };
  // A rolled-back command, or a stop that has ended since, leaves the session and its process be.
  const committed = afterCommit(ctx);
  const stopping = () => {
    const current = ctx.store.get<Session>('sessions', sessionId);
    return committed() && !!current?.stop_requested && !current.outcome;
  };
  // The worktree is removed only after its native process has closed.
  const completion = Promise.resolve()
    .then(() => (stopping() ? closeNativeProcesses(ctx, sessionId) : undefined))
    .then(
      (closed) =>
        rollbackTransaction(ctx, () => {
          if (closed === undefined || !stopping()) return;
          if (!closed) failed('The native process did not confirm it stopped');
          else discardStopped(ctx, sessionId, cause);
        }),
      (error: unknown) => ctx.store.transaction(() => failed(String(error))),
    )
    .finally(() => {
      closing.delete(sessionId);
      ctx.completions.delete(completion);
      ctx.changed();
    });
  ctx.completions.add(completion);
}

/**
 * Carries on each stop that could not finish when it was asked: closes a process that has
 * started since, and discards a session whose retried close has since confirmed it stopped.
 */
export function finishStops(ctx: ControlContext): void {
  const closing = stopsClosing.get(ctx);
  for (const session of ctx.store.list<Session>('sessions')) {
    if (
      !session.stop_requested ||
      session.outcome ||
      session.state === 'reconciling' ||
      session.stop_pending ||
      closing?.has(session.id)
    )
      continue;
    const keys = nativeKeys(ctx, session.id);
    if (keys.length) {
      if (!keys.some((key) => ctx.cancelling.has(key))) closeStopped(ctx, session.id, '');
    } else if (!session.process_identity && !nativeTurnActive(ctx, session))
      discardStopped(ctx, session.id, '');
  }
}

const DELETE_REASON = 'Deleted by the user';

/** Discards the stopped session and removes it, or for a delete no longer admitted keeps it without its stop. */
export function discardStopped(ctx: ControlContext, sessionId: string, cause: string): void {
  const current = ctx.store.must<Session>('sessions', sessionId);
  // A lead's task.stop can carry any reason; only the user deletes.
  if (current.stop_requested?.reason !== DELETE_REASON || current.stop_requested.by !== 'user') {
    failWorkbenchTurns(ctx, current, 'Session discarded');
    discardSession(ctx, sessionId, cause);
    return;
  }
  try {
    admitDelete(ctx, current);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const { stop_requested: _, ...rest } = current;
    const kept = ctx.store.update<Session>('sessions', rest, current.revision);
    ctx.store.event(
      'session.delete_failed',
      kept,
      kept.project_id,
      { error: error.message },
      cause,
    );
    return;
  }
  const next = discardSession(ctx, sessionId, cause);
  deleteSessionRows(ctx, next, next.title ?? '', cause);
}

/** Removes the finished baseline conversation while retaining the project's assessment. */
function discardBaselineSession(ctx: ControlContext, session: Session, cause: string): Session {
  requireThat(
    sessionEnded(ctx, session.id) &&
      session.merge?.state !== 'running' &&
      !runningGates(ctx).has(session.id),
    'resource_busy',
    'Wait for the baseline session to end',
  );
  if (session.workspace_id) {
    const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
    requireThat(
      !['queued', 'running'].includes(workspace.provisioning?.state ?? ''),
      'resource_busy',
      'Wait for the baseline worktree to finish provisioning',
    );
  }
  const baseline = ctx.store.must<ProjectBaseline>(
    'project_baselines',
    session.baseline!.baseline_id,
  );
  const nextBaseline = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    {
      ...baseline,
      session_id: undefined,
      ...(baseline.state === 'running' ? { state: 'failed', reason: 'baseline_missing' } : {}),
    },
    baseline.revision,
  );
  if (baseline.state === 'running')
    ctx.store.event(
      'project.baseline_failed',
      nextBaseline,
      session.project_id,
      {
        reason: nextBaseline.reason,
      },
      cause,
    );
  const next = discardSession(ctx, session.id, cause);
  for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
    if (turn.session_id !== session.id) continue;
    for (const job of ctx.store.pending()) {
      if (job.kind === 'session.turn' && JSON.parse(job.payload).turn_id === turn.id)
        ctx.store.mark(job.id, 'done');
    }
    ctx.store.remove('session_turns', turn.id, turn.revision);
  }
  for (const approval of ctx.store.list<Approval>('approvals'))
    if (approval.session_id === session.id)
      ctx.store.remove('approvals', approval.id, approval.revision);
  ctx.revokeSessionCredential?.(session.id);
  ctx.store.remove('sessions', next.id, next.revision);
  ctx.store.detachProjectIntroSession(next.id);
  return next;
}

/** Whether a milestone of the project requires the session or cites it as evidence. */
function milestoneNames(ctx: ControlContext, session: Session): boolean {
  const ref = `session:${session.id}`;
  return (
    ctx.store
      .list<Milestone>('milestones')
      .some(
        (milestone) =>
          milestone.project_id === session.project_id &&
          ((milestone.required_sessions ?? []).includes(session.id) ||
            !!milestone.acceptance?.evidence_refs.includes(ref)),
      ) ||
    projectFacts(ctx, session.project_id).milestones.some((view) =>
      view.required_sessions.includes(session.id),
    )
  );
}

/** The reviewer and change story sessions that worked on the session's changes. */
function helperSessions(ctx: ControlContext, sessionId: string): Session[] {
  const reviews = new Set(
      ctx.store
        .list<Review>('reviews')
        .filter((review) => review.session_id === sessionId)
        .map((review) => review.id),
    ),
    stories = new Set(
      ctx.store
        .list<ChangeStory>('change_stories')
        .filter((story) => story.workbench_session_id === sessionId)
        .map((story) => story.id),
    );
  return ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        (session.review_id && reviews.has(session.review_id)) ||
        (session.change_story && stories.has(session.change_story.story_id)),
    );
}

/** Refuses deleting the session while something still holds it. */
function admitDelete(ctx: ControlContext, session: Session): void {
  requireThat(
    session.outcome !== 'merged',
    'invalid_state',
    'A merged session can only be archived',
  );
  requireThat(
    !milestoneNames(ctx, session),
    'invalid_state',
    'A milestone requires this session or cites it as evidence',
  );
  requireThat(
    !ctx.store.get<BoardPlan>('board_plans', session.id),
    'invalid_state',
    'This session leads a board plan; discard it and sync the board so a new lead takes the plan over',
  );
  requireThat(
    session.merge?.state !== 'running' && !runningGates(ctx).has(session.id),
    'resource_busy',
    'Wait for the merge or the gate run of the session to end',
  );
  requireThat(
    ctx.store
      .list<Review>('reviews')
      .every((review) => review.session_id !== session.id || review.state !== 'running') &&
      ctx.store
        .list<ChangeStory>('change_stories')
        .every((story) => story.workbench_session_id !== session.id || story.state !== 'running') &&
      helperSessions(ctx, session.id).every((helper) => sessionEnded(ctx, helper.id)),
    'resource_busy',
    'Wait for the reviews and change stories of the session to end',
  );
  // Without a handle only a confirmed stop proves the process gone.
  requireThat(
    session.state !== 'reconciling' &&
      (nativeKeys(ctx, session.id).length > 0 ||
        (!nativeTurnActive(ctx, session) && !session.stop_pending && !session.process_identity)),
    'resource_busy',
    'Wait for the native process of the session to start, stop or be reconciled',
  );
}

/** Managed native history lies in native-sessions beside the artifacts, in the daemon's data directory. */
function removeNativeHistory(ctx: ControlContext, directories: (string | undefined)[]): void {
  let root: string;
  try {
    root = realpathSync(path.join(path.dirname(ctx.files.directory), 'native-sessions'));
  } catch {
    return;
  }
  // Sessions of one project and runtime share one directory.
  const used = ctx.store.list<Session>('sessions').flatMap((s) => {
    if (!s.native_state_dir) return [];
    try {
      return [resolvedPath(s.native_state_dir)];
    } catch {
      return [path.resolve(s.native_state_dir)];
    }
  });
  for (const directory of new Set(directories)) {
    if (!directory) continue;
    let target: string;
    try {
      target = realpathSync(directory);
    } catch {
      continue;
    }
    if (
      target !== root &&
      inside(root, target) &&
      !used.some((other) => inside(target, other) || inside(other, target))
    )
      removeAfterCommit(ctx, target);
  }
}

/** Removes the path once the running transaction, which keeps a rollback list, commits. */
function removeAfterCommit(ctx: ControlContext, target: string): void {
  const committed = afterCommit(ctx);
  queueMicrotask(() => {
    if (!committed()) return;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // The delete has committed; a folder that cannot be removed stays behind.
    }
  });
}

/** Runs a transaction outside a command with a rollback list, so its file removals wait for its commit. */
export function rollbackTransaction(ctx: ControlContext, fn: () => void): void {
  const rollback: (() => void)[] = (ctx.rollback = []);
  try {
    ctx.store.transaction(fn);
  } catch (error) {
    for (const undo of rollback.reverse()) undo();
    throw error;
  } finally {
    ctx.rollback = undefined;
  }
}

/**
 * The caller owns the transaction and has ended the session. Removes the session, its turns,
 * approvals, comments, reviews, change stories and their sessions, its queued work, uploads and
 * native history; the events and the workspace row stay.
 */
function deleteSessionRows(
  ctx: ControlContext,
  session: Session,
  title: string,
  cause: string,
): void {
  const removed = [session, ...helperSessions(ctx, session.id)],
    ids = new Set(removed.map((s) => s.id));
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => ids.has(turn.session_id));
  const turnIds = new Set(turns.map((turn) => turn.id)),
    uploads = new Set(turns.flatMap((turn) => turn.attachments?.map((a) => a.id) ?? []));
  for (const job of ctx.store.pending()) {
    const payload = JSON.parse(job.payload) as { turn_id?: string; session_id?: string };
    if (turnIds.has(payload.turn_id ?? '') || ids.has(payload.session_id ?? ''))
      ctx.store.mark(job.id, 'done');
  }
  for (const turn of turns) ctx.store.remove('session_turns', turn.id, turn.revision);
  for (const approval of ctx.store.list<Approval>('approvals'))
    if (ids.has(approval.session_id ?? ''))
      ctx.store.remove('approvals', approval.id, approval.revision);
  for (const timer of ctx.store.list<Timer>('timers'))
    if (ids.has(timer.subject_id)) ctx.store.remove('timers', timer.id, timer.revision);
  for (const comment of ctx.store.list<SessionComment>('session_comments'))
    if (ids.has(comment.session_id))
      ctx.store.remove('session_comments', comment.id, comment.revision);
  for (const review of ctx.store.list<Review>('reviews'))
    if (review.session_id === session.id) ctx.store.remove('reviews', review.id, review.revision);
  for (const story of ctx.store.list<ChangeStory>('change_stories'))
    if (story.workbench_session_id === session.id)
      ctx.store.remove('change_stories', story.id, story.revision);
  for (const visual of ctx.store.list<Visual>('visuals')) {
    if (!ids.has(visual.session_id ?? '')) continue;
    if (visual.pin)
      ctx.store.saveVisual({ ...visual, session_id: null, updated_at: ctx.store.now() });
    else ctx.store.remove('visuals', visual.id, visual.revision);
  }
  for (const sessionId of ids) ctx.store.detachProjectIntroSession(sessionId);
  for (const each of removed) {
    ctx.revokeSessionCredential?.(each.id);
    // A baseline session's discard has already removed its row.
    const row = ctx.store.get<Session>('sessions', each.id);
    if (row) ctx.store.remove('sessions', row.id, row.revision);
    if (each.workspace_id) worktreeReads.delete(each.workspace_id);
  }
  ctx.store.event('session.deleted', session, session.project_id, { title }, cause);
  // Files go last, once every refusal above has passed.
  const kept = new Set(
    ctx.store
      .list<SessionTurn>('session_turns')
      .flatMap((turn) => turn.attachments?.map((a) => a.id) ?? []),
  );
  for (const upload of uploads)
    if (/^[A-Za-z0-9-]+$/.test(upload) && !kept.has(upload))
      removeAfterCommit(ctx, path.join(attachmentsDirectory(ctx, session.project_id), upload));
  removeNativeHistory(
    ctx,
    removed.map((s) => s.native_state_dir),
  );
  // A folder session continued a native session that stays the user's.
  if (
    session.workspace_id &&
    ctx.store.must<Workspace>('workspaces', session.workspace_id).kind === 'in_place'
  ) {
    const committed = afterCommit(ctx);
    queueMicrotask(() => {
      if (committed()) ctx.trace?.release(session.id);
    });
  }
}

const merges = new WeakMap<ControlContext, Set<string>>();
// Sessions whose session.gates.run is checking; its gate processes share the merge's key.
const gateRuns = new WeakMap<ControlContext, Set<string>>();

// Turns whose automatic merge waits for the session.gates.run that was checking when they ended.
const waitingMerges = new WeakMap<ControlContext, Map<string, string>>();

function mergesAfterGates(ctx: ControlContext): Map<string, string> {
  let waiting = waitingMerges.get(ctx);
  if (!waiting) waitingMerges.set(ctx, (waiting = new Map()));
  return waiting;
}

function runningGates(ctx: ControlContext): Set<string> {
  let running = gateRuns.get(ctx);
  if (!running) gateRuns.set(ctx, (running = new Set()));
  return running;
}

function gateOperationActive(session: Session): boolean {
  return session.gate_run?.state === 'running' || session.gate_run?.state === 'cancelling';
}

/** The session's landing owner; recovery reaps gate processes recorded under its key. */
function sessionOwner(ctx: ControlContext, session: Session, gateRunId?: string): LandingOwner {
  return {
    key: `session-${session.id}`,
    session_id: session.id,
    projectId: session.project_id,
    cancelled: () => {
      const current = ctx.store.must<Session>('sessions', session.id);
      return (
        !!current.outcome ||
        !!current.stop_requested ||
        (gateRunId !== undefined
          ? current.gate_run?.id !== gateRunId || current.gate_run.state !== 'running'
          : !!current.merge?.cancel_requested)
      );
    },
    event: (kind, payload) => {
      const current = ctx.store.must<Session>('sessions', session.id);
      if (gateRunId && (current.gate_run?.id !== gateRunId || current.gate_run.state !== 'running'))
        return;
      recordWorkflowGates(ctx, current, kind, payload);
      ctx.store.event(
        `session.${kind}`,
        ctx.store.must<Session>('sessions', session.id),
        session.project_id,
        { ...payload, ...(gateRunId ? { run_id: gateRunId } : {}) },
      );
    },
  };
}

/** Called after process reconciliation on startup; an explicit check is never silently rerun. */
export function recoverGateRuns(ctx: ControlContext): void {
  for (const session of ctx.store.list<Session>('sessions')) {
    if (!gateOperationActive(session)) continue;
    const cancelled = session.gate_run!.state === 'cancelling';
    const next = ctx.store.update(
      'sessions',
      {
        ...session,
        gate_run: {
          ...session.gate_run!,
          state: cancelled ? ('cancelled' as const) : ('failed' as const),
          finished_at: ctx.store.now(),
          ...(cancelled ? {} : { error: 'daemon_restart' }),
        },
      },
      session.revision,
    );
    ctx.store.event(
      cancelled ? 'session.gate_run_cancelled' : 'session.gate_run_failed',
      next,
      next.project_id,
      { run_id: session.gate_run!.id, ...(cancelled ? {} : { error: 'daemon_restart' }) },
    );
  }
}

function finishGateRun(
  ctx: ControlContext,
  sessionId: string,
  runId: string,
  error?: unknown,
): void {
  ctx.store.transaction(() => {
    const session = ctx.store.get<Session>('sessions', sessionId);
    if (!session || session.gate_run?.id !== runId || !gateOperationActive(session)) return;
    const cancelled = session.gate_run.state === 'cancelling';
    // Shutdown leaves the intent for startup to settle after reaping recorded processes.
    if (ctx.closing && !cancelled) return;
    const next = ctx.store.update(
      'sessions',
      {
        ...session,
        gate_run: {
          ...session.gate_run,
          state: cancelled
            ? ('cancelled' as const)
            : error
              ? ('failed' as const)
              : ('completed' as const),
          finished_at: ctx.store.now(),
          ...(error && !cancelled ? { error: String(error) } : {}),
        },
      },
      session.revision,
    );
    ctx.store.event(
      cancelled
        ? 'session.gate_run_cancelled'
        : error
          ? 'session.gate_run_failed'
          : 'session.gate_run_completed',
      next,
      next.project_id,
      { run_id: runId, ...(error && !cancelled ? { error: String(error) } : {}) },
    );
  });
}

/** The newest gate result recorded for the session, by its merge or by session.gates.run. */
export function sessionGates(ctx: ControlContext, p: Principal, sessionId: string): SessionGates {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, p, session.project_id, 'project.read');
  requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id),
    commands = gateCommands(
      ctx,
      ctx.store.must<Project>('projects', session.project_id),
      workspace,
      session,
    );
  const checked = ctx.store
    .kindEvents(session.project_id, ['session.gate_checked'])
    .findLast((event) => event.aggregate_id === session.id);
  const payload = checked?.payload as
    { commit: string; results: NonNullable<LandingItem['gate_results']> } | undefined;
  return {
    configured: !!commands?.length,
    ...(commands?.length ? { commands: commands.map((command) => command.name) } : {}),
    running: gateOperationActive(session) || runningGates(ctx).has(session.id),
    ...(session.gate_run
      ? {
          operation: {
            id: session.gate_run.id,
            state: session.gate_run.state,
            ...(session.gate_run.error ? { error: session.gate_run.error } : {}),
          },
        }
      : {}),
    last:
      checked && payload
        ? {
            commit: payload.commit,
            checked_at: checked.created_at,
            results: payload.results.map((result) => ({
              name: result.name,
              exit_code: result.exit_code,
              timed_out: result.timed_out,
              output_tail: result.output,
              ...(result.state ? { state: result.state } : {}),
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.tests ? { tests: result.tests } : {}),
              ...(result.carried ? { carried: true } : {}),
            })),
          }
        : null,
  };
}

/** The gate_started event of each gate_checked event, by its id: the session's last start after its previous check. */
function gateStarts(events: Event[]): Map<string, Event> {
  const starts = new Map<string, Event>(),
    open = new Map<string, Event>();
  for (const event of events)
    if (event.kind === 'session.gate_started') open.set(event.aggregate_id, event);
    else {
      const started = open.get(event.aggregate_id);
      if (started) starts.set(event.event_id, started);
      open.delete(event.aggregate_id);
    }
  return starts;
}

function gateStartedAt(checked: Event, started: Event | undefined): number {
  const recorded =
    (checked.payload as { results?: NonNullable<LandingItem['gate_results']> } | undefined)
      ?.results ?? [];
  return (
    started?.created_at ??
    checked.created_at - recorded.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0)
  );
}

function gateRun(
  checked: Event,
  started: Event | undefined,
  configured: NonNullable<Project['gates']>[string],
): SessionGateRun {
  const payload = (checked.payload ?? {}) as {
    commit?: string;
    results?: NonNullable<LandingItem['gate_results']>;
  };
  const recorded = payload.results ?? [];
  const started_at = new Date(gateStartedAt(checked, started)).toISOString();
  const finished_at = new Date(checked.created_at).toISOString();
  // A null exit code is a command that changed the candidate or was stopped: it failed too.
  const failed = recorded.some(gateFailed);
  // Runs recorded before gate_started carried the commands fall back to the current configuration.
  const commands =
    (started?.payload as { commands?: typeof configured } | undefined)?.commands ?? configured;
  const skipped: SessionGateRunResult[] = failed
    ? commands.slice(recorded.length).map((cmd) => ({
        name: cmd.name,
        command: cmd.argv,
        skipped: true,
      }))
    : [];
  const results: SessionGateRunResult[] = [
    ...recorded.map((r) => ({
      name: r.name,
      command: r.argv,
      ...(r.state ? { state: r.state } : {}),
      ...(r.state === 'skipped' ? { skipped: true } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      exit_code: r.exit_code,
      timed_out: r.timed_out,
      duration_ms: r.duration_ms,
      ...(r.tests ? { tests: r.tests } : {}),
      ...(r.carried ? { carried: true } : {}),
    })),
    ...skipped,
  ];
  return {
    run_id: checked.event_id,
    commit: payload.commit ?? '',
    started_at,
    finished_at,
    results,
  };
}

/** Recorded gate runs of the session, newest first. */
export function sessionGatesHistory(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
  limit = 20,
): SessionGatesHistory {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, p, session.project_id, 'project.read');
  requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id),
    configured =
      gateCommands(
        ctx,
        ctx.store.must<Project>('projects', session.project_id),
        workspace,
        session,
      ) ?? [];
  const events = ctx.store
    .kindEvents(session.project_id, ['session.gate_checked', 'session.gate_started'])
    .filter((event) => event.aggregate_id === session.id);
  const starts = gateStarts(events);
  const runs = events
    .filter((event) => event.kind === 'session.gate_checked')
    .reverse()
    .slice(0, limit)
    .map((checked) => gateRun(checked, starts.get(checked.event_id), configured));
  return { runs };
}

/** Recorded gate runs across the project's worktree sessions, newest first. */
export function projectGatesHistory(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  limit = 30,
  since?: number,
): ProjectGatesHistory {
  projectAccess(ctx, p, projectId, 'project.read');
  requireThat(
    since !== undefined || limit <= 100,
    'invalid_input',
    'A limit above 100 requires since',
  );
  const project = ctx.store.must<Project>('projects', projectId);
  const sessions = new Map(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === projectId && session.workspace_id)
      .map((session) => [session.id, session]),
  );
  const events = ctx.store.kindEvents(projectId, ['session.gate_checked', 'session.gate_started']);
  const starts = gateStarts(events);
  const newest = events
    .filter((event) => event.kind === 'session.gate_checked' && sessions.has(event.aggregate_id))
    .reverse()
    .map((checked) => {
      const started = starts.get(checked.event_id);
      return { checked, started, at: gateStartedAt(checked, started) };
    });
  const shown =
    since === undefined
      ? newest.slice(0, limit)
      : newest
          .filter((run) => run.at >= since)
          .sort((a, b) => b.at - a.at)
          .slice(0, limit);
  return {
    runs: shown.map(({ checked, started }) => {
      const session = sessions.get(checked.aggregate_id)!,
        workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!),
        configured = gateCommands(ctx, project, workspace, session) ?? [];
      return {
        ...gateRun(checked, started, configured),
        session_id: session.id,
        session_title: session.title ?? '',
      };
    }),
  };
}

export function projectTimeline(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  since?: string,
): ProjectTimeline {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  const now = ctx.store.now(),
    fromMs = since === undefined ? now - 7 * 24 * 60 * 60 * 1000 : Date.parse(since);
  const sessions = new Map(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === projectId && session.workspace_id)
      .map((session) => [session.id, { session, events: [] as Event[] }]),
  );
  const sessionOf = new Map<string, string>();
  for (const { session } of sessions.values()) {
    sessionOf.set(session.id, session.id);
    sessionOf.set(session.workspace_id!, session.id);
  }
  for (const turn of ctx.store.list<SessionTurn>('session_turns'))
    if (sessions.has(turn.session_id)) sessionOf.set(turn.id, turn.session_id);
  for (let after = 0; ;) {
    const events = ctx.store.events(after, projectId, 256);
    if (events.length === 0) break;
    for (const event of events) {
      const sessionId = event.kind.startsWith('approval.')
        ? (event.payload as Approval).session_id
        : sessionOf.get(event.aggregate_id);
      if (sessionId) sessions.get(sessionId)?.events.push(event);
    }
    after = events[events.length - 1]!.sequence;
  }
  for (const entry of sessions.values())
    entry.events.sort((a, b) => a.created_at - b.created_at || a.sequence - b.sequence);
  const lanes = [...sessions.values()]
    .filter(({ events }) => events.length)
    .sort(
      (a, b) =>
        a.events[0]!.created_at - b.events[0]!.created_at ||
        a.events[0]!.sequence - b.events[0]!.sequence,
    )
    .flatMap(({ session, events }): ProjectTimeline['sessions'] => {
      let provisioning: NonNullable<Workspace['provisioning']>['state'] | undefined,
        merging = false,
        ready = false,
        sessionState: Session['state'] = 'open',
        outcome: Session['outcome'];
      const turns = new Set<string>(),
        started = new Set<string>(),
        pending = new Set<string>(),
        intervals: ProjectTimeline['sessions'][number]['intervals'] = [];
      // The user's own folder is never provisioned, so it is ready from the start.
      if (ctx.store.get<Workspace>('workspaces', session.workspace_id!)?.kind === 'in_place')
        provisioning = 'ready';
      for (const event of events) {
        if (event.kind === 'workspace.registered')
          provisioning = (event.payload as Workspace).provisioning?.state ?? provisioning;
        else if (event.kind === 'workspace.provisioning')
          provisioning = (event.payload as NonNullable<Workspace['provisioning']>).state;
        else if (event.kind === 'workspace.ready') provisioning = 'ready';
        else if (event.kind === 'session.opened') sessionState = (event.payload as Session).state;
        else if (event.kind === 'turn.queued' || event.kind === 'turn.running') {
          turns.add(event.aggregate_id);
          if (event.kind === 'turn.running') started.add(event.aggregate_id);
          ready = false;
          sessionState = 'running';
          merging = false;
        } else if (
          TURN_ENDS.includes(event.kind) ||
          // A steer delivered into the running turn, or refused, gets no turn end event.
          (event.kind === 'session.turn.delivery' &&
            !started.has(event.aggregate_id) &&
            ['delivered', 'failed'].includes((event.payload as { delivery: string }).delivery))
        ) {
          turns.delete(event.aggregate_id);
          if (event.kind === 'turn.completed') ready = true;
          if (sessionState === 'running' && turns.size === 0) sessionState = 'open';
        } else if (event.kind.startsWith('approval.')) {
          if ((event.payload as Approval).state === 'pending') pending.add(event.aggregate_id);
          else pending.delete(event.aggregate_id);
        } else if (event.kind === 'session.merge_started') merging = true;
        else if (event.kind === 'session.merge_blocked' || event.kind === 'session.merge_cancelled')
          merging = false;
        // A lead's direct task merge leaves its session open for the next task.
        else if (event.kind === 'session.merged')
          if ((event.payload as { direct?: boolean }).direct) merging = false;
          else outcome = 'merged';
        else if (event.kind === 'session.discarded') outcome = 'discarded';
        else if (event.kind === 'session.closed') sessionState = 'closed';
        else if (event.kind === 'session.reconciling' || event.kind === 'session.resume_failed')
          sessionState = 'reconciling';
        else if (event.kind === 'session.recovered' || event.kind === 'session.resumed')
          sessionState = 'open';
        const state =
          outcome ??
          (merging
            ? 'merging'
            : provisioning === 'failed' || provisioning === 'cancelled' || sessionState === 'closed'
              ? 'failed'
              : pending.size
                ? 'waiting'
                : [...turns].some((id) => started.has(id))
                  ? 'running'
                  : turns.size
                    ? 'queued'
                    : provisioning !== 'ready'
                      ? 'starting'
                      : sessionState === 'running'
                        ? 'running'
                        : ready
                          ? 'ready'
                          : 'idle');
        const at = new Date(event.created_at).toISOString(),
          last = intervals.at(-1);
        if (last?.state !== state) {
          if (last) last.to = at;
          intervals.push({ state, from: at, to: null });
        }
        // A failed session can still be discarded.
        if (state === 'merged' || state === 'discarded') {
          intervals.at(-1)!.to = at;
          break;
        }
      }
      // A lane quiet in the window still shows while it has work or awaits review.
      const open = intervals.at(-1);
      if (
        !events.some((event) => event.created_at >= fromMs) &&
        !(
          open?.to === null &&
          ['starting', 'queued', 'running', 'waiting', 'ready', 'merging'].includes(open.state)
        )
      )
        return [];
      return [
        {
          session_id: session.id,
          title: session.title ?? '',
          runtime: session.runtime,
          intervals: intervals.flatMap((interval) => {
            const start = Date.parse(interval.from),
              end = interval.to === null ? null : Date.parse(interval.to);
            if (end !== null && (end < fromMs || (end === fromMs && start < fromMs))) return [];
            return [{ ...interval, from: new Date(Math.max(start, fromMs)).toISOString() }];
          }),
        },
      ];
    });
  return { from: new Date(fromMs).toISOString(), to: new Date(now).toISOString(), sessions: lanes };
}

/** Reads merge facts without running gates, queuing a merge or updating either repository. */
export function sessionPreflight(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
): SessionPreflight {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, p, session.project_id, 'project.read');
  requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
  refuseInPlace(ctx, session, NO_MERGE_GATE);
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id),
    source = workspace.source ?? workspace.path,
    worktree = mergeWorktreeState(workspace),
    sourceState = mergeSourceState(workspace),
    commits = runGit(workspace.path, [
      'rev-list',
      '--count',
      `${workspace.base_sha}..${worktree.head}`,
    ]),
    files = runGit(workspace.path, [
      'diff',
      '--name-only',
      '-z',
      workspace.base_sha!,
      worktree.head,
    ]);
  requireThat(
    commits.exit_code === 0 && files.exit_code === 0,
    'workspace_read_failed',
    'Worktree changes could not be read',
  );
  const { branch: targetBranch, clean: sourceClean } = sourceState,
    commands = gateCommands(
      ctx,
      ctx.store.must<Project>('projects', session.project_id),
      workspace,
      session,
    ),
    checked = ctx.store
      .kindEvents(session.project_id, ['session.gate_checked'])
      .findLast((event) => event.aggregate_id === session.id),
    payload = checked?.payload as
      | {
          commit: string;
          check_spec_hash: string;
          results: NonNullable<LandingItem['gate_results']>;
        }
      | undefined;
  let conflicts: SessionPreflight['conflicts'] = { state: 'unknown' };
  if (targetBranch !== null) {
    const merge = mergePreview(source, `refs/heads/${targetBranch}`, worktree.head);
    if (merge.exit_code !== 129) {
      requireThat(
        merge.exit_code === 0 || merge.exit_code === 1,
        'workspace_read_failed',
        'Merge conflicts could not be read',
      );
      const paths = merge.stdout.toString().split('\0\0')[0]!.split('\0').slice(1, 51);
      conflicts = merge.exit_code === 0 ? { state: 'none' } : { state: 'conflicts', files: paths };
    }
  }
  const openComments = ctx.store
    .list<SessionComment>('session_comments')
    .filter((comment) => comment.session_id === session.id && comment.state === 'open').length;
  const blockedReason = mergeBlockedReason(ctx, session, { worktree, source: sourceState })?.code;
  return {
    target_branch: targetBranch,
    source_root: source,
    commit_count: Number(commits.stdout.toString().trim()),
    files_changed: files.stdout.toString().split('\0').filter(Boolean).length,
    worktree_clean: worktree.clean,
    source_clean: sourceClean,
    conflicts,
    gate: {
      configured_total: commands?.length ?? 0,
      last: !payload
        ? 'none'
        : payload.commit !== worktree.head || payload.check_spec_hash !== hash(commands)
          ? 'stale'
          : payload.results.some(gateFailed)
            ? 'failed'
            : 'passed',
    },
    ...(openComments ? { open_comments: openComments } : {}),
    can_merge: blockedReason === undefined,
    ...(blockedReason ? { blocked_reason: blockedReason } : {}),
  };
}

/** Tool call counts in 5-minute buckets of the last hour for the session. */
export function sessionToolActivity(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
): ProtocolSessionActivity {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, p, session.project_id, 'project.read');
  const now = ctx.store.now();
  const fromMs = now - 12 * 300_000;
  const tools_completed = new Array(12).fill(0);
  // agentEvent records agent.* events under the session.
  for (const event of ctx.store.kindEvents(session.project_id, ['agent.tool.completed'])) {
    if (event.aggregate_id !== sessionId) continue;
    if (event.created_at < fromMs || event.created_at > now) continue;
    const index = Math.min(11, Math.floor((event.created_at - fromMs) / 300_000));
    tools_completed[index]++;
  }
  return {
    bucket_ms: 300000,
    from: new Date(fromMs).toISOString(),
    tools_completed,
  };
}

/** The newest merge of each source repository; the next one starts after it. */
const sourceMerges = new WeakMap<ControlContext, Map<string, Promise<void>>>();

/** Runs a queued merge off the dispatch loop; its job stays pending until a result commits. */
export function mergeSession(ctx: ControlContext, sessionId: string, jobId: string): void {
  let running = merges.get(ctx);
  if (!running) merges.set(ctx, (running = new Set()));
  if (ctx.closing || running.has(jobId)) return;
  const session = ctx.store.get<Session>('sessions', sessionId),
    workspace = session?.workspace_id
      ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
      : undefined;
  if (!session || !workspace) {
    // A session or worktree retired or deleted with its merge still queued has nothing to merge.
    ctx.store.transaction(() => {
      ctx.store.event(
        'session.merge_dropped',
        session ?? { id: sessionId, revision: 0 },
        session?.project_id ?? '',
        { reason: session ? 'workspace_missing' : 'session_missing' },
      );
      ctx.store.mark(jobId, 'done');
    });
    return;
  }
  running.add(jobId);
  const source = workspace.source ?? workspace.path;
  let queue = sourceMerges.get(ctx);
  if (!queue) sourceMerges.set(ctx, (queue = new Map()));
  // Two landings that read the same source HEAD would race its ref update.
  const completion: Promise<void> = (queue.get(source) ?? Promise.resolve())
    .catch(() => {})
    .then(() => completeMerge(ctx, sessionId, jobId))
    .finally(() => {
      running.delete(jobId);
      if (queue.get(source) === completion) queue.delete(source);
      ctx.completions.delete(completion);
      if (!ctx.closing) ctx.changed();
    });
  queue.set(source, completion);
  ctx.completions.add(completion);
  void completion.catch(() => {});
}

/** Records the lead's landed direct task; the lead stays open, its worktree at the landed commit. */
function landDirectTask(
  ctx: ControlContext,
  sessionId: string,
  direct: NonNullable<Session['direct_task']>,
  item: LandingItem,
  jobId: string,
  measured: Record<string, unknown>,
): void {
  ctx.store.transaction(() => {
    const current = ctx.store.must<Session>('sessions', sessionId);
    const next = ctx.store.update(
      'sessions',
      { ...current, merge: undefined, direct_task: undefined },
      current.revision,
    );
    // Else the lead's next merge would pass the check for commits without one.
    const workspace = ctx.store.must<Workspace>('workspaces', item.workspace_id);
    ctx.store.update('workspaces', { ...workspace, base_sha: item.to_sha! }, workspace.revision);
    worktreeReads.delete(workspace.id);
    ctx.store.event('session.merged', next, next.project_id, {
      branch: item.branch,
      source: item.source,
      from_sha: item.from_sha,
      to_sha: item.to_sha,
      ...measured,
      task_id: direct.id,
      generation: direct.generation,
      direct: true,
    });
    const plan = ctx.store.get<BoardPlan>('board_plans', sessionId);
    if (plan) {
      const at = ctx.store.now();
      const merged = ctx.store.update(
        'board_plans',
        {
          ...plan,
          direct_merged: {
            ...plan.direct_merged,
            [direct.id]: {
              generation: direct.generation,
              at,
              session_id: sessionId,
              from_sha: item.from_sha!,
              to_sha: item.to_sha!,
            },
          },
        },
        plan.revision,
      );
      appendNote(ctx, merged, {
        at,
        session_id: sessionId,
        task_id: direct.id,
        kind: 'merged',
        text: `Your direct task ${direct.id} merged: its changes are on the source branch ${item.branch} at ${item.to_sha}, and your worktree is now at that commit. Go on with the next task of your plan.`,
      });
    }
    ctx.store.mark(jobId, 'done');
  });
}

/** The board tasks whose merges in the project landed the commits, newest merge first; a commit no merge landed names none. */
async function mergedTasks(
  ctx: ControlContext,
  projectId: string,
  source: string,
  shas: string[],
): Promise<string[]> {
  const left = new Set(shas),
    tasks: string[] = [];
  for (const event of ctx.store.kindEvents(projectId, ['session.merged']).reverse()) {
    if (!left.size) break;
    const merged = event.payload as {
      from_sha?: string;
      to_sha?: string;
      task_id?: string;
      direct?: boolean;
    };
    if (!merged.from_sha || !merged.to_sha) continue;
    const listed = await runGit(
      source,
      ['rev-list', `${merged.from_sha}..${merged.to_sha}`, '--'],
      undefined,
      true,
    );
    if (listed.exit_code !== 0) continue;
    const landed = listed.stdout
      .toString()
      .split('\n')
      .filter((sha) => left.delete(sha));
    if (!landed.length) continue;
    // A lead's direct merge names its task; a task session's merge, the session's task.
    const binding = ctx.store.get<Session>('sessions', event.aggregate_id)?.task,
      task = merged.direct
        ? merged.task_id && boardTaskId(event.aggregate_id, merged.task_id)
        : binding && boardTaskId(binding.lead_session_id, binding.id);
    if (task && !tasks.includes(task)) tasks.push(task);
  }
  return tasks;
}

async function completeMerge(ctx: ControlContext, sessionId: string, jobId: string): Promise<void> {
  const session = ctx.store.must<Session>('sessions', sessionId);
  if (session.outcome || session.merge?.state !== 'running') {
    ctx.store.mark(jobId, 'done');
    return;
  }
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  const saved = session.merge.landing;
  let alreadyLanded = saved?.stage === 'fast_forwarded';
  if (session.merge.cancel_requested && saved?.stage === 'gated') {
    // A crash can happen after git moved the branch and before the receipt was saved.
    const landed = await runGit(
      workspace.source ?? workspace.path,
      ['merge-base', '--is-ancestor', saved.candidate, `refs/heads/${saved.branch}`],
      undefined,
      true,
    );
    if (landed.exit_code !== 0 && landed.exit_code !== 1) return;
    alreadyLanded = landed.exit_code === 0;
  }
  if (session.merge.cancel_requested && !alreadyLanded) {
    ctx.store.transaction(() => {
      const current = ctx.store.must<Session>('sessions', session.id);
      const next = ctx.store.update(
        'sessions',
        { ...current, merge: { state: 'blocked' as const, reason: 'cancelled' } },
        current.revision,
      );
      ctx.store.event('session.merge_cancelled', next, next.project_id, { reason: 'cancelled' });
      ctx.store.mark(jobId, 'done');
    });
    return;
  }
  const head = await runGit(
    workspace.path,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    undefined,
    true,
  );
  // A lead merging its direct task keeps its session open and checks the task on its own plan.
  const direct = session.direct_task;
  // A lead taking the plan over moves the task to another plan, so each check reads the binding anew.
  const bound = () => ctx.store.must<Session>('sessions', session.id);
  const planNow = () => {
    const task = bound().task;
    return task
      ? ctx.store.get<BoardPlan>('board_plans', task.lead_session_id)
      : direct && ctx.store.get<BoardPlan>('board_plans', session.id);
  };
  // A removed task's session has no task contract to merge on, whatever task reuses its id.
  const unboundNow = (): string | undefined => {
    const current = bound();
    if (!current.task && !direct) return undefined;
    const plan = planNow();
    if (!plan) return 'task_plan_missing';
    if (direct)
      return current.direct_task?.id === direct.id &&
        current.direct_task.generation === direct.generation &&
        plan.tasks.some((task) => task.id === direct.id) &&
        taskGeneration(plan, direct.id) === direct.generation
        ? undefined
        : 'task_retired';
    return retiredBinding(plan, current) ? 'task_retired' : undefined;
  };
  const unbound = unboundNow();
  if (unbound && !alreadyLanded) {
    ctx.store.transaction(() => {
      const current = bound();
      const next = ctx.store.update(
        'sessions',
        { ...current, merge: { state: 'blocked' as const, reason: unbound } },
        current.revision,
      );
      ctx.store.event('session.merge_blocked', next, next.project_id, next.merge);
      unsnooze(ctx, session.id, 'merge_blocked');
      if (direct) releaseRetiredClaim(ctx, session.id, direct, unbound);
      ctx.store.mark(jobId, 'done');
    });
    return;
  }
  const gateNow = () =>
    gateCommands(ctx, ctx.store.must<Project>('projects', session.project_id), workspace, bound());
  const commands = gateNow(),
    sessionGate = sessionOwner(ctx, session),
    owner: LandingOwner = direct
      ? {
          ...sessionGate,
          event: (kind, payload) => sessionGate.event(kind, { ...payload, task_id: direct.id }),
        }
      : sessionGate,
    allowed = session.merge.allow_out_of_scope,
    scopeNow = () => {
      const task = bound().task ?? bound().direct_task;
      const scope =
        task && !allowed ? planNow() && sessionPlanTask(planNow()!, bound())?.scope : undefined;
      return scope && [...scope, ...(session.merge!.allowed_files ?? [])];
    },
    scope = scopeNow();
  const saveProgress = (landing: LandingProgress) =>
    ctx.store.transaction(() => {
      const current = ctx.store.must<Session>('sessions', session.id);
      ctx.store.update(
        'sessions',
        { ...current, merge: { ...current.merge!, landing } },
        current.revision,
      );
    });
  // Once the source moved, a rerun only writes the receipt.
  const item: LandingItem | undefined =
    alreadyLanded && saved
      ? {
          workspace_id: workspace.id,
          source: workspace.source ?? workspace.path,
          state: 'landed',
          branch: saved.branch,
          from_sha: saved.from_sha,
          to_sha: saved.candidate,
        }
      : await landWorkspace(
          ctx,
          {
            ...owner,
            // A gate or scope changed meanwhile does not decide this merge; the session's next turn merges on it.
            cancelled: () =>
              owner.cancelled() ||
              gateArgv(gateNow()) !== gateArgv(commands) ||
              JSON.stringify(scopeNow()) !== JSON.stringify(scope) ||
              unboundNow() !== undefined,
            progress: { saved, save: saveProgress },
            beforeLand: () =>
              ctx.store.transaction(() => {
                if (!waitBeforeMerge(ctx, bound())) return true;
                // Read after the wait, which may bring the snoozed session back.
                const current = bound();
                ctx.store.update(
                  'sessions',
                  {
                    ...current,
                    merge: {
                      ...current.merge!,
                      state: 'blocked' as const,
                      reason: 'workflow_approval',
                    },
                  },
                  current.revision,
                );
                ctx.store.mark(jobId, 'done');
                return false;
              }),
            scope,
          },
          workspace,
          head.exit_code === 0 ? head.stdout.toString().trim() : undefined,
          commands,
        );
  if (!item) return;
  if (ctx.store.must<Session>('sessions', session.id).outcome) {
    // A discard while the merge held the worktree could not remove it then.
    ctx.store.transaction(() => {
      ctx.store.enqueue('workspace.remove', { workspace_id: workspace.id, reason: 'discarded' });
      ctx.store.mark(jobId, 'done');
    });
    return;
  }
  if (item.state === 'landed') {
    if (saved?.stage !== 'fast_forwarded')
      saveProgress({
        stage: 'fast_forwarded',
        candidate: item.to_sha!,
        branch: item.branch!,
        from_sha: item.from_sha!,
      });
    ctx.failpoint('after_fast_forward_before_receipt');
    // The pending job lands again as a no-op and retries the close.
    if (!direct && !(await closeNativeProcesses(ctx, session.id))) return;
    const numstat = await runGit(
      item.source,
      ['diff', '--numstat', '-z', item.from_sha!, item.to_sha!],
      undefined,
      true,
      { max_buffer: 4 * PATCH_BOUND, timeout_ms: TIME_BOUND },
    );
    const files = numstat.exit_code === 0 ? numstatFiles(numstat.stdout) : [];
    const measuredKind = kindOfPaths(files.map((file) => file.path));
    if (direct) {
      landDirectTask(ctx, session.id, direct, item, jobId, {
        files: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        ...(measuredKind ? { measured_kind: measuredKind } : {}),
      });
      return;
    }
    ctx.store.transaction(() => {
      const current = ctx.store.must<Session>('sessions', session.id);
      const next = ctx.store.update(
        'sessions',
        { ...current, state: 'closed' as const, outcome: 'merged' as const, merge: undefined },
        current.revision,
      );
      ctx.store.event('session.merged', next, next.project_id, {
        branch: item.branch,
        source: item.source,
        from_sha: item.from_sha,
        to_sha: item.to_sha,
        files: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        ...(measuredKind ? { measured_kind: measuredKind } : {}),
      });
      unsnooze(ctx, session.id, 'session_ended');
      if (readUserConfig(ctx.userConfigDir).auto_archive_merged) archiveSession(ctx, session.id);
      ctx.store.enqueue('workspace.remove', { workspace_id: workspace.id, reason: 'merged' });
      ctx.store.mark(jobId, 'done');
    });
    worktreeReads.delete(workspace.id);
    return;
  }
  const gate = item.gate_results?.find(gateFailed),
    { conflicts, conflict_commits, conflict_shas } = item as {
      conflicts?: string[];
      conflict_commits?: string[];
      conflict_shas?: string[];
    },
    conflict_tasks = conflict_shas?.length
      ? await mergedTasks(ctx, session.project_id, item.source, conflict_shas)
      : [];
  ctx.store.transaction(() => {
    const current = ctx.store.must<Session>('sessions', session.id);
    const next = ctx.store.update(
      'sessions',
      {
        ...current,
        merge: {
          state: 'blocked' as const,
          reason: unboundNow() ?? item.reason ?? item.state,
          ...(conflicts ? { conflicts } : {}),
          ...(conflict_commits ? { conflict_commits } : {}),
          ...(conflict_tasks.length ? { conflict_tasks } : {}),
          ...(gate
            ? {
                gate: {
                  name: gate.name,
                  output: gate.output,
                  ...(gate.tests ? { tests: gate.tests } : {}),
                },
              }
            : {}),
          ...(gate?.failure_class ? { failure_class: gate.failure_class } : {}),
        },
      },
      current.revision,
    );
    ctx.store.event(
      item.reason === 'cancelled' ? 'session.merge_cancelled' : 'session.merge_blocked',
      next,
      next.project_id,
      next.merge,
    );
    if (direct) releaseRetiredClaim(ctx, session.id, direct, next.merge!.reason);
    if (item.reason !== 'cancelled') unsnooze(ctx, session.id, 'merge_blocked');
    ctx.store.mark(jobId, 'done');
  });
}

/** Lets go of the lead's claim the merge found retired, as task.stop does, so the lead can start the task again. */
function releaseRetiredClaim(
  ctx: ControlContext,
  sessionId: string,
  direct: NonNullable<Session['direct_task']>,
  reason: string | undefined,
): void {
  const current = ctx.store.must<Session>('sessions', sessionId);
  if (
    reason !== 'task_retired' ||
    current.direct_task?.id !== direct.id ||
    current.direct_task.generation !== direct.generation
  )
    return;
  const next = ctx.store.update(
    'sessions',
    { ...current, direct_task: undefined },
    current.revision,
  );
  ctx.store.event('task.released', next, next.project_id, { task_id: direct.id });
}

/** Whether the worktree has no uncommitted or untracked files, and its HEAD; null when Git cannot read them. */
function worktreeState(workspace: Workspace): { clean: boolean; head: string } | null {
  const status = runGit(workspace.path, STATUS),
    head = runGit(workspace.path, HEAD_COMMIT);
  if (status.exit_code !== 0 || head.exit_code !== 0) return null;
  return { clean: !status.stdout.toString().trim(), head: headOf(head)! };
}

const STATUS = ['status', '--porcelain=v1'],
  HEAD_COMMIT = ['rev-parse', '--verify', 'HEAD^{commit}'];

const headOf = (head: GitResult) => (head.exit_code === 0 ? head.stdout.toString().trim() : null);

function mergeWorktreeState(workspace: Workspace): { clean: boolean; head: string } {
  const state = worktreeState(workspace);
  requireThat(state, 'workspace_read_failed', 'Worktree status could not be read');
  return state;
}

/** The source repository's checked-out branch, null when HEAD is detached, and whether its tracked files are unedited. */
function mergeSourceState(workspace: Workspace): { branch: string | null; clean: boolean } {
  const source = workspace.source ?? workspace.path,
    status = runGit(source, ['status', '--porcelain=v1', '--untracked-files=no']),
    branch = runGit(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  requireThat(
    status.exit_code === 0 && (branch.exit_code === 0 || branch.exit_code === 1),
    'workspace_read_failed',
    'Source repository status could not be read',
  );
  return {
    branch: branch.exit_code === 0 ? branch.stdout.toString().trim() : null,
    clean: !status.stdout.toString().trim(),
  };
}

/** The first admission block; preflight can supply the repository states it already read. */
function mergeBlockedReason(
  ctx: ControlContext,
  session: Session,
  read?: {
    worktree: ReturnType<typeof mergeWorktreeState>;
    source: ReturnType<typeof mergeSourceState>;
  },
): { code: string; message: string } | undefined {
  if (ctx.store.must<Workspace>('workspaces', session.workspace_id!).kind === 'in_place')
    return { code: 'invalid_state', message: NO_MERGE_GATE };
  if (
    session.state === 'running' ||
    session.stop_pending ||
    session.merge?.state === 'running' ||
    runningGates(ctx).has(session.id)
  )
    return { code: 'resource_busy', message: 'Wait for the current turn, merge or gate run' };
  if (session.state !== 'open') return { code: 'invalid_state', message: 'Session is not open' };
  if (session.stop_requested)
    return { code: 'invalid_state', message: 'Session is being discarded' };
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  if (!workspaceReady(workspace))
    return { code: 'invalid_state', message: 'Worktree is not ready' };
  const { clean, head } = read?.worktree ?? mergeWorktreeState(workspace);
  // The session agent commits its own work; Pantheon never commits for it.
  if (!clean)
    return {
      code: 'uncommitted_changes',
      message: 'Commit or remove the uncommitted and untracked files first',
    };
  if (head === workspace.base_sha)
    return { code: 'no_changes', message: 'The worktree has no commits to merge' };
  const source = read?.source ?? mergeSourceState(workspace);
  if (source.branch === null)
    return {
      code: 'source_detached',
      message: 'Check out a branch in the source repository first',
    };
  if (workspace.source_branch !== undefined && source.branch !== workspace.source_branch)
    return {
      code: 'target_branch_changed',
      message: `The source repository has ${source.branch} checked out, but the session started from ${workspace.source_branch}; check out ${workspace.source_branch} first`,
    };
  if (!source.clean)
    return {
      code: 'source_dirty',
      message: 'Commit or discard the edited tracked files in the source repository first',
    };
}

/** Preconditions shared by merge admission and the needs-you retry action. */
export function requireMergeReady(ctx: ControlContext, session: Session): void {
  const blocked = mergeBlockedReason(ctx, session);
  if (blocked) throw new DomainError(blocked.code, blocked.message);
}

/** Queues the merge of an open, clean worktree with commits; without a cause it was started automatically. */
export function admitMerge(
  ctx: ControlContext,
  session: Session,
  cause?: string,
  allowOutOfScope?: boolean,
  reason?: string,
  allowedFiles?: string[],
): Session {
  requireMergeReady(ctx, session);
  requireThat(
    workflowPolicy(ctx, session.project_id).gate_runner !== 'session' || !onDevice(session),
    'unsupported_capability',
    'Remote session gates cannot return bounded command exit codes',
  );
  const binding = session.task ?? session.direct_task;
  if (binding) {
    const plan = ctx.store.get<BoardPlan>(
      'board_plans',
      session.task?.lead_session_id ?? session.id,
    );
    const task = plan?.tasks.find((t) => t.id === binding.id);
    if (plan && task) startSlot(ctx, plan, task, 'before_merge', session.id);
  }
  const next = ctx.store.update(
    'sessions',
    {
      ...session,
      gate_run: undefined,
      merge: {
        state: 'running' as const,
        ...(session.merge?.reason === 'workflow_approval' && session.merge.landing
          ? { landing: session.merge.landing }
          : {}),
        ...(allowOutOfScope ? { allow_out_of_scope: true } : {}),
        ...(allowedFiles ? { allowed_files: allowedFiles } : {}),
      },
    },
    session.revision,
  );
  ctx.store.event(
    'session.merge_started',
    next,
    next.project_id,
    cause ? (reason ? { reason } : {}) : { auto: true },
    cause,
  );
  ctx.store.enqueue('session.merge', { session_id: session.id });
  return next;
}

/**
 * Merges the session of a task in the lead's own plan whose merge stopped on files outside the
 * task's scope, unless one of them is agent configuration or in the scope of an unfinished task.
 */
function leadTaskMerge(
  ctx: ControlContext,
  p: Principal,
  input: ReturnType<(typeof inputSchemas)['session.merge']['parse']>,
  cause: string,
): Session {
  requireThat(
    input.project_id &&
      input.task_id &&
      input.allow_out_of_scope &&
      input.reason &&
      !input.session_id,
    'invalid_request',
    'Name the task with task_id, set allow_out_of_scope and give the reason',
  );
  projectAccess(ctx, p, input.project_id, 'session.merge');
  const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
  requireThat(
    plan && plan.tasks.some((task) => task.id === input.task_id),
    'not_found',
    `Not found: task ${input.task_id} in your plan`,
  );
  const session = taskSessions(ctx, plan.id, input.task_id).find(
    (candidate) =>
      !candidate.outcome &&
      candidate.merge?.state === 'blocked' &&
      candidate.merge.reason === 'out_of_scope',
  );
  requireThat(
    session,
    'invalid_state',
    `Task ${input.task_id} has no session whose merge stopped on files outside its scope`,
  );
  const files = session.merge!.conflicts ?? [];
  requireThat(
    !files.some((file) => AGENT_CONFIGURATION.some((entry) => overlaps(file, entry))),
    'permission_denied',
    'The files outside the scope change agent configuration, which only the user may merge',
  );
  const holders = ctx.store
    .list<BoardPlan>('board_plans')
    .filter((each) => each.project_id === plan.project_id)
    .flatMap((each) =>
      each.tasks
        .filter(
          (task) =>
            !(each.id === plan.id && task.id === input.task_id) &&
            task.scope.some((entry) => files.some((file) => overlaps(file, entry))) &&
            taskState(
              each,
              task.id,
              taskSessions(ctx, each.id, task.id),
              ctx.store.get<Session>('sessions', each.id),
            ) !== 'done',
        )
        .map((task) => (each.id === plan.id ? task.id : `${each.id}:${task.id}`)),
    );
  requireThat(
    !holders.length,
    'invalid_state',
    `Files outside the scope of task ${input.task_id} lie in the scope of unfinished task ${holders.join(', ')}`,
  );
  return admitMerge(ctx, session, cause, false, input.reason, files);
}

/**
 * After the turn of a task session, or of a lead that reported its direct task done, completes
 * normally, merges it if its project merges automatically through a gate.
 */
export function autoMergeAfterTurn(ctx: ControlContext, sessionId: string, turnId: string): void {
  const session = ctx.store.must<Session>('sessions', sessionId),
    plan = ctx.store.get<BoardPlan>('board_plans', session.id),
    direct = session.direct_task;
  const reported =
    !!plan &&
    !!direct?.reported_head &&
    plan.tasks.some((task) => task.id === direct.id) &&
    direct.generation === taskGeneration(plan, direct.id);
  if (
    (!session.task && !reported) ||
    blockedReport(ctx, session) ||
    !session.workspace_id ||
    session.outcome ||
    session.stop_requested ||
    session.state !== 'open' ||
    session.stop_pending ||
    session.merge?.state === 'running' ||
    // A lead's worktree holds the plan; its task sessions merge the planned work.
    (plan && !reported)
  )
    return;
  // The user's gate run merges the turn once it ends.
  if (runningGates(ctx).has(session.id)) {
    mergesAfterGates(ctx).set(session.id, turnId);
    return;
  }
  const project = ctx.store.must<Project>('projects', session.project_id),
    workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
  if (!autoMerge(ctx, project) || !gateCommands(ctx, project, workspace, session)?.length) return;
  // Commits after the report may belong to the lead's next task, so it reports again first.
  const head = reported ? worktreeState(workspace)?.head : undefined;
  if (head && head !== direct!.reported_head) {
    ctx.store.event('session.merge_skipped', session, session.project_id, {
      reason: 'head_moved',
      turn_id: turnId,
    });
    return;
  }
  try {
    ctx.store.transaction(() => admitMerge(ctx, session));
  } catch (error) {
    // A worktree that is not ready, not clean or has no commits stays as it is.
    if (!(error instanceof DomainError)) throw error;
    // The tracker hands these back to a task session to fix.
    if (error.code === 'no_changes' || error.code === 'uncommitted_changes')
      ctx.store.event('session.merge_skipped', session, session.project_id, {
        reason: error.code,
        turn_id: turnId,
      });
    // The user fixes the source repository and retries from needs-you.
    else if (
      [
        'source_detached',
        'target_branch_changed',
        'source_dirty',
        'unsupported_capability',
      ].includes(error.code)
    )
      ctx.store.transaction(() => {
        const current = ctx.store.must<Session>('sessions', session.id);
        const next = ctx.store.update(
          'sessions',
          { ...current, merge: { state: 'blocked' as const, reason: error.code } },
          current.revision,
        );
        ctx.store.event('session.merge_blocked', next, next.project_id, next.merge);
        unsnooze(ctx, session.id, 'merge_blocked');
      });
  }
}

function sessionStart(
  ctx: ControlContext,
  input: {
    project_id: string;
    workspace?: 'worktree' | 'in_place';
    from?: { branch: string } | { session_id: string };
  },
): SessionCreatePreview & { source_branch?: string } {
  const project = ctx.store.must<Project>('projects', input.project_id),
    root = project.roots[0]!;
  const branch = runGit(root, ['symbolic-ref', '--quiet', 'HEAD']);
  const branchRef = branch.exit_code === 0 ? branch.stdout.toString().trim() : undefined;
  let directory = root,
    baseRef = branchRef ?? 'HEAD';
  if (input.from) {
    if ('branch' in input.from) baseRef = `refs/heads/${input.from.branch}`;
    else {
      const source = ctx.store.must<Session>('sessions', input.from.session_id);
      requireThat(
        source.project_id === project.id,
        'invalid_input',
        'Source session belongs to another project',
      );
      const workspace = source.workspace_id
        ? ctx.store.must<Workspace>('workspaces', source.workspace_id)
        : undefined;
      requireThat(
        workspace?.kind === 'linked_worktree' && workspaceReady(workspace),
        'invalid_input',
        'Source session has no ready worktree',
      );
      directory = workspace.path;
      baseRef = 'HEAD';
    }
  }
  const head = runGit(
    directory,
    input.from && 'branch' in input.from
      ? ['show-ref', '--verify', '--hash', baseRef]
      : ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
  );
  requireThat(head.exit_code === 0, 'invalid_input', 'Session start point could not be read');
  const baseSha = head.stdout.toString().trim();
  return {
    branch:
      input.workspace === 'in_place' ? (branchRef?.slice('refs/heads/'.length) ?? null) : null,
    base_sha: baseSha,
    base_ref: directory === root ? baseRef : baseSha,
    ...(branchRef ? { source_branch: branchRef.slice('refs/heads/'.length) } : {}),
  };
}

export function sessionCreatePreview(
  ctx: ControlContext,
  p: Principal,
  input: {
    project_id: string;
    workspace?: 'worktree' | 'in_place';
    from?: { branch: string } | { session_id: string };
  },
): SessionCreatePreview {
  projectAccess(ctx, p, input.project_id, 'project.read');
  const { source_branch, ...preview } = sessionStart(ctx, input);
  return preview;
}

function worktreeSessionChoice(
  ctx: ControlContext,
  input: ReturnType<(typeof inputSchemas)['session.create']['parse']>,
  fork = false,
) {
  const project = ctx.store.must<Project>('projects', input.project_id),
    settings = sessionDefaults(ctx, project);
  // Without a model, a session on the project's default runtime starts on its default model and effort.
  const defaults =
    input.model === undefined &&
    (input.runtime === undefined || input.runtime === settings?.runtime)
      ? settings
      : undefined;
  const model = input.model ?? (fork ? undefined : defaults?.model),
    effort = input.effort ?? (fork ? undefined : defaults?.effort);
  const runtimeName =
    input.runtime ??
    defaults?.runtime ??
    (input.model === undefined
      ? undefined
      : homeRuntime(input.model, readUserConfig(ctx.userConfigDir).model_families));
  requireThat(runtimeName, 'invalid_input', 'Give a runtime, or a model whose family names one');
  return admitWriterChoice(
    ctx,
    { runtime: runtimeName, model, effort },
    settings?.fallbacks?.[input.task_id ? 'writer' : 'lead'],
  );
}

/** Task sessions run with workflows off, so ultracode has nothing to run on there. */
const ultracodeSession = (session: { runtime: string; task?: unknown }): boolean =>
  session.runtime === 'claude' && !session.task;

export function checkPermissionMode(
  runtime: string,
  mode: Session['permission_mode'],
  principal: Pick<Principal, 'role' | 'session_id'>,
): void {
  requireThat(
    (mode !== 'auto' || runtime === 'claude') &&
      (mode !== 'full_access' || runtime === 'codex' || runtime === 'claude') &&
      (!['auto', 'full_access'].includes(mode ?? '') ||
        (principal.role === 'user' && !principal.session_id)),
    'unsupported_capability',
    'Permission mode is unavailable for this runtime or principal',
  );
}

function sessionModel(
  ctx: ControlContext,
  session: Pick<Session, 'project_id' | 'runtime' | 'requested_model' | 'reported_model'>,
): RuntimeModel | undefined {
  const models = ctx.runtimeModels.get(`${session.project_id}:${session.runtime}`);
  const model = session.requested_model ?? session.reported_model;
  return models?.find((row) => (model ? row.id === model || row.resolved === model : row.default));
}

export function prepareSessionModels(
  ctx: ControlContext,
  principal: Principal,
  command: Command,
): Promise<void> | undefined {
  let projectId: string;
  let runtime: string;
  if (command.type === 'session.create') {
    const input = command.input as ReturnType<(typeof inputSchemas)['session.create']['parse']>;
    if (!input.fast) return;
    projectId = input.project_id;
    projectAccess(ctx, principal, projectId, command.type);
    const choice = input.task_id ? userTaskChoice(ctx, input) : worktreeSessionChoice(ctx, input);
    runtime = choice.runtime;
  } else if (
    command.type === 'session.setFastMode' ||
    command.type === 'session.setModel' ||
    command.type === 'session.setBackend'
  ) {
    const input = command.input as { session_id: string };
    const session = ctx.store.must<Session>('sessions', input.session_id);
    if (
      command.type === 'session.setFastMode'
        ? !(command.input as { fast: boolean }).fast
        : !session.fast
    )
      return;
    projectId = session.project_id;
    runtime = session.runtime;
    projectAccess(ctx, principal, projectId, command.type);
  } else return;
  const adapter = ctx.adapters.get(runtime);
  requireThat(adapter?.models, 'unsupported_capability', 'Runtime does not list its models');
  const project = ctx.store.must<Project>('projects', projectId);
  return adapter.models(project.roots[0]!).then((models) => {
    ctx.runtimeModels.set(`${projectId}:${runtime}`, models);
  });
}

/** The text cut to 40 UTF-16 units, a cut one ending in "…" and never inside a surrogate pair. */
function derivedTitle(text: string): string {
  if (text.length <= 40) return text;
  const end = /[\uD800-\uDBFF]/.test(text[38]!) ? 38 : 39;
  return `${text.slice(0, end)}…`;
}

/** Opens a session in a new worktree of the project's first root and queues its first turn. */
export function openWorktreeSession(
  ctx: ControlContext,
  input: ReturnType<(typeof inputSchemas)['session.create']['parse']>,
  cause: string,
  fork?: {
    source: Session;
    workspace: Workspace;
    checkpoint?: string;
    before_turn_id?: string;
    before_span_id?: string;
    native_fork?: Session['native_fork'];
  },
  principal: Pick<Principal, 'role' | 'session_id'> = { role: 'user' },
): Session {
  requireThat(
    input.workspace === 'in_place' || ctx.workspaceRoot !== undefined,
    'invalid_workspace',
    'A managed workspace root is required for worktree sessions',
  );
  const project = ctx.store.must<Project>('projects', input.project_id);
  const { runtime: runtimeName, model, effort } = worktreeSessionChoice(ctx, input, !!fork);
  checkPermissionMode(runtimeName, input.permission_mode, principal);
  if (input.fast) {
    requireThat(
      principal.role === 'user' && !principal.session_id,
      'unsupported_capability',
      'Only user can select fast mode',
    );
    requireThat(
      sessionModel(ctx, { project_id: project.id, runtime: runtimeName, requested_model: model })
        ?.fast,
      'unsupported_capability',
      'Model has no fast mode',
    );
  }
  requireThat(
    !input.ultracode ||
      (ultracodeSession({ runtime: runtimeName, task: input.task_id }) &&
        principal.role === 'user' &&
        !principal.session_id),
    'unsupported_capability',
    'Only the user can turn on ultracode, in a Claude session outside a board task',
  );
  if (input.backend !== undefined) backendProfile(ctx, runtimeName, input.backend);
  const deviceId = input.device_id ?? fork?.source.device_id ?? 'local';
  const board = input.task_id ? boardTask(ctx, project.id, input.task_id) : undefined;
  // The user folder has no checkpoint to push to a device and no merge to complete a task.
  requireThat(
    input.workspace !== 'in_place' ||
      (deviceId === 'local' && (!board || board.task.done_when === 'report')),
    'invalid_input',
    'A session in the project folder runs on this machine and only for a report task',
  );
  if (deviceId !== 'local') {
    requireThat(
      Object.hasOwn(readUserConfig(ctx.userConfigDir).devices ?? {}, deviceId),
      'invalid_input',
      `Unknown device ${deviceId}`,
    );
    const device = ctx.devices?.get(deviceId);
    requireThat(
      device?.online,
      'invalid_input',
      `Device ${deviceId} is offline: ${device?.error ?? 'not probed yet'}`,
    );
    requireThat(
      device.runtimes[runtimeName] && device.home,
      'invalid_input',
      `The last probe of device ${deviceId} found no ${runtimeName} runtime or no home directory`,
    );
    // A plan written while the device was offline could not check its labels.
    const missing = (board?.task.needs ?? []).filter((label) => !deviceHasLabel(device, label));
    requireThat(
      !missing.length,
      'invalid_input',
      `The last probe of device ${deviceId} found no label ${missing.join(', ')}, which task ${board?.task.id} needs`,
    );
    requireThat(
      input.backend === undefined,
      'invalid_input',
      `A session on device ${deviceId} cannot use a backend, whose key would reach the device command line`,
    );
  }
  const start = input.workspace === 'in_place' ? undefined : sessionStart(ctx, input);
  const registered =
    input.workspace === 'in_place'
      ? registerInPlaceWorkspace(ctx, { project_id: project.id, cwd: project.roots[0]! }, cause)
      : registerWorkspace(
          ctx,
          {
            project_id: project.id,
            kind: 'linked_worktree',
            source: fork ? fork.workspace.source! : project.roots[0]!,
            base_ref: input.from ? start!.base_sha : start!.base_ref,
            name: board?.task.title ?? input.input.split('\n').find((line) => line.trim() !== ''),
          },
          cause,
        );
  let workspace = start?.source_branch
    ? ctx.store.update(
        'workspaces',
        { ...registered, source_branch: start.source_branch },
        registered.revision,
      )
    : registered;
  const sessionId = id();
  if (fork) {
    const ref = checkpointRef(workspace, sessionId, 'fork');
    forkCheckpoint(fork.workspace, ref, fork.checkpoint);
    ctx.rollback?.push(() => {
      const removed = runGit(workspace.source!, ['update-ref', '-d', ref]);
      requireThat(removed.exit_code === 0, 'invalid_workspace', 'Fork checkpoint cleanup failed');
    });
    workspace = ctx.store.update(
      'workspaces',
      {
        ...workspace,
        source_branch: fork.workspace.source_branch,
        base_sha: fork.workspace.base_sha,
        provisioning: { ...workspace.provisioning!, base_ref: `${ref}^`, checkpoint: ref },
      },
      workspace.revision,
    );
  }
  const workflow = board && taskWorkflow(ctx, board.plan, board.task.id);
  const session = insert<Session>(
    ctx,
    'sessions',
    {
      ...(fork
        ? {
            forked_from: {
              session_id: fork.source.id,
              ...(fork.before_turn_id ? { before_turn_id: fork.before_turn_id } : {}),
              ...(fork.before_span_id ? { before_span_id: fork.before_span_id } : {}),
            },
          }
        : {}),
      ...(fork?.native_fork
        ? { native_fork: fork.native_fork, native_state_dir: fork.source.native_state_dir }
        : {}),
      project_id: project.id,
      runtime: runtimeName,
      ...(input.backend !== undefined ? { backend_id: input.backend } : {}),
      requested_model: model,
      requested_effort: effort,
      device_id: deviceId,
      remote_pull: { status: 'not_needed', changed_at: new Date(ctx.store.now()).toISOString() },
      id: sessionId,
      revision: 1,
      state: 'running',
      turn_count: 1,
      workspace_id: workspace.id,
      permission_mode: input.permission_mode,
      ...(input.fast ? { fast: true as const } : {}),
      ...(input.ultracode ? { ultracode: true as const } : {}),
      ...(input.purpose === 'app_debug'
        ? {
            app_debug: { ...(input.cdp_port !== undefined ? { cdp_port: input.cdp_port } : {}) },
          }
        : {}),
      title: derivedTitle(
        board?.task.title ??
          (input.input.split('\n').find((line) => line.trim() !== '') ?? '').trim(),
      ),
      ...(board
        ? {
            task: {
              lead_session_id: board.plan.id,
              id: board.task.id,
              generation: taskGeneration(board.plan, board.task.id),
              definition_version: workflow!.definition_version,
              ...(workflow!.id !== project.id ? { workflow_id: workflow!.id } : {}),
              ...(board.task.uses ? { uses: board.task.uses } : {}),
            },
          }
        : {}),
    },
    'session.opened',
    project.id,
    cause,
  );
  const extras = turnExtras(ctx, session, input);
  const turn = queuedTurn(session, input.input, 'send', {
    ...extras,
    // The guide goes ahead of the user's words but stays out of the thread.
    ...(input.purpose
      ? {
          reference_context: [
            input.purpose === 'app_debug' ? appDebugSkill : projectSetupSkill,
            extras.reference_context,
          ]
            .filter((part) => part !== undefined)
            .join('\n\n'),
        }
      : {}),
    ...(fork && !fork.native_fork
      ? { handoff: buildHandoff(ctx, fork.source, fork.before_turn_id) }
      : {}),
  });
  // A worktree still being prepared queues this turn when it becomes ready.
  if (workspaceReady(workspace)) ctx.store.enqueue('session.turn', { turn_id: turn.id });
  insert(ctx, 'session_turns', turn, 'turn.queued', project.id, cause);
  ctx.store.event('session.turn.delivery', turn, turn.project_id, { delivery: 'pending' }, cause);
  return session;
}

function archiveSession(ctx: ControlContext, sessionId: string, cause?: string): Session {
  const session = ctx.store.must<Session>('sessions', sessionId);
  if (session.archived_at) return session;
  unsnooze(ctx, session.id, 'archived', cause);
  const current = ctx.store.must<Session>('sessions', session.id);
  const next = ctx.store.update<Session>(
    'sessions',
    { ...current, archived_at: new Date(ctx.store.now()).toISOString() },
    current.revision,
  );
  ctx.store.event(
    'session.archived',
    next,
    next.project_id,
    { archived_at: next.archived_at },
    cause,
  );
  return next;
}

function commentSession(ctx: ControlContext, sessionId: string): Session {
  const session = ctx.store.must<Session>('sessions', sessionId);
  requireThat(session.state !== 'closed' && !session.outcome, 'invalid_state', 'Session has ended');
  return session;
}

/**
 * Whether the native process runs a turn or has an input on its way to it: an idle process
 * closes only while its session is open, so a queued input would run with the old settings.
 */
function nativeTurnBusy(ctx: ControlContext, session: Session): boolean {
  return (
    nativeTurnActive(ctx, session) ||
    (session.state === 'running' &&
      [...ctx.handles.values()].some((handle) => handle.platform_session_id === session.id))
  );
}

export const workbenchSessionHandlers: Handlers = {
  'session.comment.add': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as ReturnType<(typeof inputSchemas)['session.comment.add']['parse']>,
      session = commentSession(ctx, input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c);
    const comment: SessionComment = {
      id: id(),
      revision: 1,
      ...input,
      created_at: ctx.store.now(),
      state: 'open',
    };
    ctx.store.insert('session_comments', comment);
    ctx.store.event('session.comment_added', session, session.project_id, comment, c.command_id);
    return comment;
  },
  'session.comment.resolve': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as ReturnType<(typeof inputSchemas)['session.comment.resolve']['parse']>,
      comment = ctx.store.must<SessionComment>('session_comments', input.comment_id),
      session = commentSession(ctx, comment.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, comment);
    const next = ctx.store.update<SessionComment>(
      'session_comments',
      { ...comment, state: input.state },
      comment.revision,
    );
    ctx.store.event('session.comment_resolved', session, session.project_id, next, c.command_id);
    return next;
  },
  'session.comment.delete': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as ReturnType<(typeof inputSchemas)['session.comment.delete']['parse']>,
      comment = ctx.store.must<SessionComment>('session_comments', input.comment_id),
      session = commentSession(ctx, comment.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, comment);
    ctx.store.remove('session_comments', comment.id, comment.revision);
    ctx.store.event('session.comment_deleted', session, session.project_id, comment, c.command_id);
    return comment;
  },
  'session.create': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can create a session');
    const cause = c.command_id,
      input = inputSchemas['session.create'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    revision(ctx, c);
    return input.task_id
      ? openUserTaskSession(ctx, input, cause)
      : openWorktreeSession(ctx, input, cause, undefined, p);
  },
  'session.fork': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can fork a session');
    const input = inputSchemas['session.fork'].parse(c.input),
      source = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, source.project_id, c.type);
    revision(ctx, c);
    const workspace = source.workspace_id
      ? ctx.store.must<Workspace>('workspaces', source.workspace_id)
      : undefined;
    requireThat(
      workspace?.kind === 'linked_worktree',
      'invalid_state',
      'Only a git worktree session can be forked',
    );
    let native_fork: Session['native_fork'];
    if (input.before_span_id) {
      requireThat(
        (input.runtime ?? source.runtime) === source.runtime &&
          sessionAdapter(ctx, source)?.report.capabilities.fork_within_turn?.status === 'supported',
        'unsupported_capability',
        `${source.runtime} does not support forks within a turn`,
      );
      const boundary = ctx.store
        .kindEvents(source.project_id, ['agent.tool.started'])
        .filter((event) => event.aggregate_id === source.id)
        .map((event) => event.payload as AgentEvent)
        .find(
          (event) => event.kind === 'tool.started' && event.tool_call_id === input.before_span_id,
        );
      const span = ctx.trace
        ?.lanes(source.project_id)
        .find(({ lane }) => lane.session_id === source.id)
        ?.spans.find((span) => span.id === input.before_span_id);
      requireThat(boundary || span, 'invalid_input', 'Span does not belong to this session');
      const after = span?.native_history_before ?? boundary?.native_history_before;
      requireThat(
        source.native_id && after,
        'unsupported_capability',
        'Span has no native history fork point',
      );
      native_fork = { session_id: source.native_id, after };
    }
    let checkpoint: string | undefined;
    let beforeTurnId = input.before_turn_id;
    if (input.before_turn_id) {
      const turn = ctx.store.get<SessionTurn>('session_turns', input.before_turn_id);
      const found =
        turn?.session_id === source.id
          ? runGit(workspace.path, [
              'rev-parse',
              '--verify',
              '--quiet',
              `${checkpointRef(workspace, source.id, turn.id)}^{commit}`,
            ])
          : undefined;
      requireThat(found?.exit_code === 0, 'invalid_state', 'Turn has no checkpoint');
      checkpoint = found.stdout.toString().trim();
    } else if (source.state === 'running' && !input.before_span_id) {
      // The end of the last completed turn is the checkpoint the next turn took before it ran.
      const turns = ctx.store
        .list<SessionTurn>('session_turns')
        .filter((turn) => turn.session_id === source.id && turn.kind === 'send');
      const at = turns.findLastIndex((turn) => turn.state === 'completed' && !turn.rolled_back);
      requireThat(
        at !== -1,
        'invalid_state',
        'Source session has no completed turn to fork from yet',
      );
      const later = turns.slice(at + 1);
      beforeTurnId = later[0]?.id;
      // Without a later checkpoint no turn has run since, so the current files are that end.
      const uncaptured = new Set(
        ctx.store
          .kindEvents(source.project_id, ['session.checkpoint_failed'])
          .filter((event) => event.aggregate_id === source.id)
          .map((event) => (event.payload as { turn_id: string }).turn_id),
      );
      for (const turn of later) {
        const found = runGit(workspace.path, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${checkpointRef(workspace, source.id, turn.id)}^{commit}`,
        ]);
        // A turn that ran without its checkpoint has changed the current files already.
        requireThat(
          found.exit_code === 0 || !uncaptured.has(turn.id),
          'invalid_state',
          'A later turn of the source session has no checkpoint; fork from an earlier turn',
        );
        if (found.exit_code !== 0) continue;
        checkpoint = found.stdout.toString().trim();
        break;
      }
    } else {
      requireThat(
        source.state === 'open' &&
          !source.stop_pending &&
          !source.rollback_pending &&
          source.merge?.state !== 'running',
        'invalid_state',
        'Source session must be idle to fork its current files',
      );
    }
    const moved = input.runtime !== undefined && input.runtime !== source.runtime;
    const session = openWorktreeSession(
      ctx,
      {
        project_id: source.project_id,
        runtime: input.runtime ?? source.runtime,
        backend: moved ? undefined : source.backend_id,
        // Another runtime starts on its own defaults; an elevated mode does not carry over.
        model: input.model ?? (moved ? undefined : source.requested_model),
        effort: input.effort ?? (moved ? undefined : source.requested_effort),
        permission_mode:
          moved && ['auto', 'full_access'].includes(source.permission_mode ?? '')
            ? 'ask'
            : (source.permission_mode ?? 'ask'),
        input: input.input,
        attachments: input.attachments,
        skills: input.skills,
        refs: input.refs,
      },
      c.command_id,
      {
        source,
        workspace,
        checkpoint,
        before_turn_id: beforeTurnId,
        before_span_id: input.before_span_id,
        native_fork,
      },
    );
    ctx.store.event(
      'session.forked',
      session,
      session.project_id,
      {
        source_session_id: source.id,
        before_turn_id: beforeTurnId,
        ...(input.before_span_id ? { before_span_id: input.before_span_id } : {}),
      },
      c.command_id,
    );
    return session;
  },
  'session.rename': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can rename a session');
    const input = inputSchemas['session.rename'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      !p.project_id || p.project_id === session.project_id,
      'permission_denied',
      'Session belongs to another project',
    );
    requireThat(session.workspace_id, 'invalid_state', 'Only a worktree session can be renamed');
    revision(ctx, c, session);
    const next = ctx.store.update(
      'sessions',
      { ...session, title: input.title, title_source: 'user' as const },
      session.revision,
    );
    ctx.store.event('session.renamed', next, next.project_id, { title: next.title }, c.command_id);
    return next;
  },
  'session.discard': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can discard a session');
    const cause = c.command_id,
      input = inputSchemas['session.discard'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      (session.workspace_id || session.baseline) && !session.outcome,
      'invalid_state',
      'Only a worktree or baseline session without an outcome can be discarded',
    );
    refuseInPlace(ctx, session, 'A session in the user folder cannot be discarded; delete it');
    revision(ctx, c, session);
    if (session.baseline) return discardBaselineSession(ctx, session, cause);
    return stopWorktreeSession(
      ctx,
      session,
      { reason: 'Discarded by the user', by: 'user' },
      cause,
    );
  },
  'session.pin': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can pin a session');
    const input = inputSchemas['session.pin'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    if (!!session.pinned_at === input.pinned) return session;
    const { pinned_at: _, ...rest } = session;
    const next = ctx.store.update<Session>(
      'sessions',
      input.pinned ? { ...rest, pinned_at: new Date(ctx.store.now()).toISOString() } : rest,
      session.revision,
    );
    if (input.pinned)
      ctx.store.event(
        'session.pinned',
        next,
        next.project_id,
        { pinned_at: next.pinned_at },
        c.command_id,
      );
    else ctx.store.event('session.unpinned', next, next.project_id, {}, c.command_id);
    return next;
  },
  'session.snooze': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can snooze a session');
    const input = inputSchemas['session.snooze'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    requireThat(
      !input.snoozed || !session.archived_at,
      'invalid_state',
      'An archived session cannot be snoozed',
    );
    if (!!session.snoozed_at === input.snoozed) return session;
    if (!input.snoozed) {
      unsnooze(ctx, session.id, 'user', c.command_id);
      return ctx.store.must<Session>('sessions', session.id);
    }
    const next = ctx.store.update<Session>(
      'sessions',
      { ...session, snoozed_at: new Date(ctx.store.now()).toISOString() },
      session.revision,
    );
    ctx.store.event(
      'session.snoozed',
      next,
      next.project_id,
      { snoozed_at: next.snoozed_at },
      c.command_id,
    );
    return next;
  },
  'session.archive': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can archive a session');
    const input = inputSchemas['session.archive'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    const waiting = ctx.store
      .list<Approval>('approvals')
      .filter(
        (approval) =>
          approval.kind === 'permission' &&
          approval.state === 'pending' &&
          approval.session_id === session.id,
      ).length;
    requireThat(
      (session.workspace_id || session.baseline || session.runtime_review) &&
        session.state !== 'reconciling' &&
        [
          'merged',
          'discarded',
          'failed',
          'done',
          ...(session.workspace_id ? ['idle'] : []),
        ].includes(listedState(ctx, session, waiting, newestBaselineId(ctx, session.project_id))),
      'invalid_state',
      'Only merged, discarded, failed, done, idle or ready sessions can be archived',
    );
    revision(ctx, c, session);
    return archiveSession(ctx, session.id, c.command_id);
  },
  'session.unarchive': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can restore a session');
    const input = inputSchemas['session.unarchive'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    if (!session.archived_at) return session;
    const { archived_at: _, ...rest } = session;
    const next = ctx.store.update<Session>('sessions', rest, session.revision);
    ctx.store.event('session.unarchived', next, next.project_id, {}, c.command_id);
    return next;
  },
  'session.delete': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can delete a session');
    const cause = c.command_id,
      input = inputSchemas['session.delete'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id || session.baseline || session.intro || session.runtime_review,
      'invalid_state',
      'Only a worktree, baseline, introduction or runtime analysis session can be deleted',
    );
    admitDelete(ctx, session);
    revision(ctx, c, session);
    const title = session.title ?? '';
    if (session.intro || session.runtime_review) {
      requireThat(
        sessionEnded(ctx, session.id),
        'resource_busy',
        session.intro
          ? 'Wait for the introduction session to end'
          : 'Wait for the runtime analysis to end',
      );
      deleteSessionRows(ctx, session, title, cause);
      return session;
    }
    if (session.baseline) {
      deleteSessionRows(ctx, discardBaselineSession(ctx, session, cause), title, cause);
      return session;
    }
    if (session.outcome) {
      deleteSessionRows(ctx, session, title, cause);
      return session;
    }
    const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
    if (['queued', 'running'].includes(workspace.provisioning?.state ?? '')) {
      cancelProvisioning(ctx, workspace, cause);
      failWorkbenchTurns(ctx, session, 'Session deleted');
      // The removal waits for provisioning to stop, when no session row is left to ask for it.
      ctx.store.enqueue('workspace.remove', { workspace_id: workspace.id, reason: 'discarded' });
      deleteSessionRows(ctx, discardSession(ctx, session.id, cause, false), title, cause);
      return session;
    }
    if (!nativeKeys(ctx, session.id).length) {
      deleteSessionRows(ctx, discardSession(ctx, session.id, cause), title, cause);
      return session;
    }
    // As with discard, the worktree is removed only after its native process has closed. The stop
    // on the row refuses new input meanwhile, and finishStops or recovery finishes the delete.
    const stop = { reason: DELETE_REASON, by: 'user' as const, at: ctx.store.now() };
    ctx.store.update('sessions', { ...session, stop_requested: stop }, session.revision);
    const failed = (error: string): void => {
      const current = ctx.store.must<Session>('sessions', session.id);
      ctx.store.event('session.delete_failed', current, current.project_id, { error }, cause);
    };
    // A rolled-back command leaves the session and its process as they were.
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() => (committed() ? closeNativeProcesses(ctx, session.id) : undefined))
      .then(
        (closed) =>
          rollbackTransaction(ctx, () => {
            const current = ctx.store.get<Session>('sessions', session.id);
            if (closed === undefined || !current) return;
            if (!closed) return failed('The native process did not confirm it stopped');
            // What the command checked may have changed while the process closed.
            try {
              admitDelete(ctx, current);
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              // A stop left on the row would have finishStops discard the session after all.
              if (JSON.stringify(current.stop_requested) === JSON.stringify(stop)) {
                const { stop_requested: _, ...rest } = current;
                ctx.store.update<Session>('sessions', rest, current.revision);
              }
              return failed(error.message);
            }
            deleteSessionRows(
              ctx,
              current.outcome ? current : discardSession(ctx, session.id, cause),
              title,
              cause,
            );
          }),
        (error: unknown) => ctx.store.transaction(() => failed(String(error))),
      )
      .finally(() => {
        ctx.completions.delete(completion);
        ctx.changed();
      });
    ctx.completions.add(completion);
    return session;
  },
  'session.merge': (ctx, p, c) => {
    const input = inputSchemas['session.merge'].parse(c.input);
    if (p.role === 'lead') return leadTaskMerge(ctx, p, input, c.command_id);
    requireThat(p.role === 'user', 'permission_denied', 'Only user can merge a session');
    requireThat(
      input.session_id && !input.task_id && !input.reason,
      'invalid_request',
      'Name the session to merge',
    );
    const cause = c.command_id,
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session can be merged',
    );
    refuseInPlace(ctx, session, NO_MERGE_GATE);
    revision(ctx, c, session);
    return admitMerge(ctx, session, cause, input.allow_out_of_scope);
  },
  'session.gates.run': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can run the session gates');
    const cause = c.command_id,
      input = inputSchemas['session.gates.run'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session can run its gates',
    );
    refuseInPlace(ctx, session, NO_MERGE_GATE);
    revision(ctx, c, session);
    requireThat(session.merge?.state !== 'running', 'invalid_state', 'Session is being merged');
    const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
    requireThat(workspaceReady(workspace), 'invalid_state', 'Worktree is not ready');
    const configured = gateCommands(
      ctx,
      ctx.store.must<Project>('projects', session.project_id),
      workspace,
      session,
    );
    requireThat(
      configured?.length,
      'invalid_state',
      'No gate or acceptance commands are configured',
    );
    const inWorktree = workflowPolicy(ctx, session.project_id).gate_runner === 'session';
    requireThat(
      !inWorktree || !onDevice(session),
      'unsupported_capability',
      'Remote session gates cannot return bounded command exit codes',
    );
    // A turn's edits in the live worktree would fail the gate command that ran beside them.
    requireThat(
      !inWorktree || (session.state !== 'running' && !nativeTurnActive(ctx, session)),
      'invalid_state',
      'Run the session gates between turns',
    );
    let commands = configured;
    const running = runningGates(ctx);
    requireThat(
      !running.has(session.id) && !gateOperationActive(session),
      'resource_busy',
      'The session gates are already running',
    );
    const head = runGit(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    requireThat(head.exit_code === 0, 'workspace_read_failed', 'Worktree HEAD could not be read');
    let previous: NonNullable<LandingItem['gate_results']> = [];
    if (input.only_failed) {
      const events = ctx.store
        .kindEvents(session.project_id, ['session.gate_started', 'session.gate_checked'])
        .filter((event) => event.aggregate_id === session.id);
      const checked = events.findLast((event) => event.kind === 'session.gate_checked');
      requireThat(checked, 'gate_retry_unavailable', 'No previous gate run to retry');
      const payload = checked.payload as { commit: string; results: typeof previous };
      requireThat(
        payload.commit === head.stdout.toString().trim() && mergeWorktreeState(workspace).clean,
        'gate_retry_unavailable',
        'Retrying failed gates requires the same HEAD and a clean worktree',
      );
      requireThat(
        payload.results.some(gateFailed),
        'gate_retry_unavailable',
        'The previous gate run has no failed steps',
      );
      const previousChecked = events.findLast(
        (event) => event.kind === 'session.gate_checked' && event.sequence < checked.sequence,
      );
      const started = events.findLast(
        (event) =>
          event.kind === 'session.gate_started' &&
          event.sequence < checked.sequence &&
          event.sequence > (previousChecked?.sequence ?? 0),
      );
      commands =
        (started?.payload as { commands?: typeof commands } | undefined)?.commands ?? commands;
      previous = payload.results;
    }
    const runId = id();
    const next = ctx.store.update(
      'sessions',
      {
        ...session,
        gate_run: { id: runId, state: 'running' as const, started_at: ctx.store.now() },
      },
      session.revision,
    );
    ctx.store.event(
      'session.gate_run_requested',
      next,
      next.project_id,
      { run_id: runId, commands },
      cause,
    );
    running.add(session.id);
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() =>
        committed()
          ? checkGates(
              ctx,
              sessionOwner(ctx, next, runId),
              workspace,
              workspace.source ?? workspace.path,
              commands,
              head.stdout.toString().trim(),
              previous,
            )
          : undefined,
      )
      .then(() => {
        if (committed()) finishGateRun(ctx, session.id, runId);
      })
      .catch((error: unknown) => {
        if (committed()) finishGateRun(ctx, session.id, runId, error);
      })
      .finally(() => {
        running.delete(session.id);
        const turnId = mergesAfterGates(ctx).get(session.id);
        mergesAfterGates(ctx).delete(session.id);
        if (turnId && committed() && !ctx.closing) autoMergeAfterTurn(ctx, session.id, turnId);
        ctx.completions.delete(completion);
        if (!ctx.closing) ctx.changed();
      });
    ctx.completions.add(completion);
    return next;
  },
  'session.gates.cancel': (ctx, p, c) => {
    requireThat(
      p.role === 'user' && !p.session_id,
      'permission_denied',
      'Only user can cancel the session gates',
    );
    const input = inputSchemas['session.gates.cancel'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    requireThat(gateOperationActive(session), 'invalid_state', 'No explicit gate run is active');
    if (session.gate_run!.state === 'cancelling') return session;
    const next = ctx.store.update(
      'sessions',
      { ...session, gate_run: { ...session.gate_run!, state: 'cancelling' as const } },
      session.revision,
    );
    ctx.store.event(
      'session.gate_run_cancel_requested',
      next,
      next.project_id,
      { run_id: next.gate_run!.id },
      c.command_id,
    );
    return next;
  },
  'session.merge.cancel': (ctx, p, c) => {
    requireThat(
      p.role === 'user' && !p.session_id,
      'permission_denied',
      'Only user can cancel a merge',
    );
    const input = inputSchemas['session.merge.cancel'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    requireThat(
      !session.outcome && session.merge?.state === 'running',
      'invalid_state',
      'No merge is active',
    );
    if (session.merge.cancel_requested) return session;
    const next = ctx.store.update(
      'sessions',
      { ...session, merge: { ...session.merge, cancel_requested: true } },
      session.revision,
    );
    ctx.store.event('session.merge_cancel_requested', next, next.project_id, {}, c.command_id);
    return next;
  },
  'session.setConnectors': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can change session connectors');
    const input = inputSchemas['session.setConnectors'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished workspace session can change connectors',
    );
    revision(ctx, c, session);
    const next = ctx.store.update(
      'sessions',
      { ...session, enabled_user_connectors: input.enabled },
      session.revision,
    );
    ctx.store.event(
      'session.connectors_changed',
      next,
      next.project_id,
      { enabled: input.enabled },
      c.command_id,
    );
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() => {
        if (committed()) releaseIdleConversation(ctx, session);
      })
      .finally(() => ctx.completions.delete(completion));
    ctx.completions.add(completion);
    return next;
  },
  'session.setPermissionMode': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can change the permission mode');
    const cause = c.command_id,
      input = inputSchemas['session.setPermissionMode'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session has a permission mode',
    );
    revision(ctx, c, session);
    checkPermissionMode(session.runtime, input.permission_mode, p);
    const adapter = sessionAdapter(ctx, session),
      handle = [...ctx.handles.values()].find((h) => h.platform_session_id === session.id);
    requireThat(
      adapter?.setPermissionMode || !nativeTurnBusy(ctx, session),
      'unsupported_capability',
      'Runtime cannot change the permission mode during a turn',
    );
    const next = ctx.store.update(
      'sessions',
      { ...session, permission_mode: input.permission_mode },
      session.revision,
    );
    ctx.store.event(
      'session.permission_mode_changed',
      next,
      next.project_id,
      { permission_mode: input.permission_mode },
      cause,
    );
    // Without a live handle, the next native session starts in the stored mode.
    if (!handle) return next;
    const committed = afterCommit(ctx);
    const previous = session.permission_mode ?? 'ask';
    const completion = Promise.resolve()
      .then(() => {
        if (!committed()) return;
        // An idle process without a setter closes, and the next input resumes it in the new mode.
        if (!adapter?.setPermissionMode) return releaseIdleConversation(ctx, session);
        return applyPermissionMode(ctx, adapter, handle, previous, input.permission_mode, cause);
      })
      .finally(() => ctx.completions.delete(completion));
    ctx.completions.add(completion);
    return next;
  },
  'session.setUltracode': (ctx, p, c) => {
    requireThat(
      p.role === 'user' && !p.session_id,
      'unsupported_capability',
      'Only user can turn on ultracode',
    );
    const input = inputSchemas['session.setUltracode'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session can change ultracode',
    );
    revision(ctx, c, session);
    requireThat(
      !input.ultracode || ultracodeSession(session),
      'unsupported_capability',
      'Ultracode runs only in a Claude session outside a board task',
    );
    const adapter = sessionAdapter(ctx, session),
      handle = [...ctx.handles.values()].find(
        (handle) => handle.platform_session_id === session.id,
      );
    requireThat(
      adapter?.setUltracode || !nativeTurnBusy(ctx, session),
      'unsupported_capability',
      'Runtime cannot change ultracode during a turn',
    );
    const next = ctx.store.update(
      'sessions',
      { ...session, ultracode: input.ultracode ? (true as const) : undefined },
      session.revision,
    );
    ctx.store.event(
      'session.ultracode_changed',
      next,
      next.project_id,
      { ultracode: input.ultracode },
      c.command_id,
    );
    if (!handle) return next;
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() => {
        if (!committed()) return;
        if (!adapter?.setUltracode) return releaseIdleConversation(ctx, session);
        return applyUltracode(
          ctx,
          adapter,
          handle,
          session.ultracode === true,
          input.ultracode,
          c.command_id,
        );
      })
      .finally(() => ctx.completions.delete(completion));
    ctx.completions.add(completion);
    return next;
  },
  'session.setFastMode': (ctx, p, c) => {
    requireThat(
      p.role === 'user' && !p.session_id,
      'unsupported_capability',
      'Only user can select fast mode',
    );
    const input = inputSchemas['session.setFastMode'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session can change fast mode',
    );
    revision(ctx, c, session);
    requireThat(
      !input.fast || sessionModel(ctx, session)?.fast,
      'unsupported_capability',
      'Model has no fast mode',
    );
    const adapter = sessionAdapter(ctx, session),
      handle = [...ctx.handles.values()].find(
        (handle) => handle.platform_session_id === session.id,
      );
    requireThat(
      adapter?.setFastMode || !nativeTurnBusy(ctx, session),
      'unsupported_capability',
      'Runtime cannot change fast mode during a turn',
    );
    const next = ctx.store.update(
      'sessions',
      { ...session, fast: input.fast ? (true as const) : undefined },
      session.revision,
    );
    ctx.store.event(
      'session.fast_mode_changed',
      next,
      next.project_id,
      { fast: input.fast },
      c.command_id,
    );
    if (!handle) return next;
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() => {
        if (!committed()) return;
        if (!adapter?.setFastMode) return releaseIdleConversation(ctx, session);
        return applyFastMode(ctx, adapter, handle, session.fast === true, input.fast, c.command_id);
      })
      .finally(() => ctx.completions.delete(completion));
    ctx.completions.add(completion);
    return next;
  },
  'session.setModel': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can change the model');
    const cause = c.command_id,
      input = inputSchemas['session.setModel'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session can change its model',
    );
    revision(ctx, c, session);
    requireThat(
      sessionAdapter(ctx, session)?.setModel || !nativeTurnBusy(ctx, session),
      'unsupported_capability',
      'Runtime cannot change the model during a turn',
    );
    return changeModel(ctx, session, input.model, input.effort, cause);
  },
  'session.setBackend': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can change the backend');
    const cause = c.command_id,
      input = inputSchemas['session.setBackend'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    requireThat(
      session.workspace_id && !session.outcome,
      'invalid_state',
      'Only an unfinished worktree session can change its backend',
    );
    // Another backend would carry the user's native session to another provider.
    refuseInPlace(ctx, session, 'A session in the user folder cannot change its backend');
    revision(ctx, c, session);
    requireThat(!nativeTurnBusy(ctx, session), 'invalid_state', 'Change the backend between turns');
    if (input.backend !== null) {
      requireThat(
        !onDevice(session),
        'invalid_input',
        `A session on device ${session.device_id} cannot use a backend, whose key would reach the device command line`,
      );
      backendProfile(ctx, session.runtime, input.backend);
    }
    const { backend_id: _previous, ...rest } = session;
    const next = ctx.store.update(
      'sessions',
      {
        ...rest,
        ...(input.backend !== null ? { backend_id: input.backend } : {}),
        ...(input.model !== undefined
          ? {
              requested_model: input.model,
              reported_model: undefined,
              fast:
                session.fast &&
                sessionModel(ctx, { ...session, requested_model: input.model })?.fast
                  ? (true as const)
                  : undefined,
            }
          : {}),
        ...(input.effort !== undefined ? { requested_effort: input.effort } : {}),
      },
      session.revision,
    );
    ctx.store.event(
      'session.backend_changed',
      next,
      next.project_id,
      {
        backend: input.backend,
        model: input.model ?? null,
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
      },
      cause,
    );
    // The backend is fixed for a native process; the next input resumes it on the new one.
    if (![...ctx.handles.values()].some((h) => h.platform_session_id === session.id)) return next;
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() => {
        if (committed()) releaseIdleConversation(ctx, session);
      })
      .finally(() => ctx.completions.delete(completion));
    ctx.completions.add(completion);
    return next;
  },
};

/** Stores the session's model and effort, and applies them to its live native session once the command commits. */
export function changeModel(
  ctx: ControlContext,
  session: Session,
  model: string,
  effort: EffortLevel | undefined,
  cause: string,
): Session {
  const adapter = sessionAdapter(ctx, session),
    handle = [...ctx.handles.values()].find((h) => h.platform_session_id === session.id);
  // Dropping the reported model lists the chosen one until the runtime reports again.
  const next = ctx.store.update(
    'sessions',
    {
      ...session,
      requested_model: model,
      requested_effort: effort,
      reported_model: undefined,
      fast:
        session.fast && sessionModel(ctx, { ...session, requested_model: model })?.fast
          ? (true as const)
          : undefined,
    },
    session.revision,
  );
  ctx.store.event(
    'session.model_changed',
    next,
    next.project_id,
    { model, effort: effort ?? null },
    cause,
  );
  // Without a live handle, the next native session starts with the stored model.
  if (!handle) return next;
  const committed = afterCommit(ctx);
  const previous = {
    model: session.requested_model,
    effort: session.requested_effort,
    fast: session.fast,
  };
  const completion = Promise.resolve()
    .then(() => {
      if (!committed()) return;
      // An idle process without a setter closes, and the next input resumes it with the new model.
      if (!adapter?.setModel) return releaseIdleConversation(ctx, session);
      return applyModel(
        ctx,
        adapter,
        handle,
        previous,
        model,
        effort,
        cause,
        session.fast !== next.fast ? next.fast === true : undefined,
      );
    })
    .finally(() => ctx.completions.delete(completion));
  ctx.completions.add(completion);
  return next;
}

type PermissionMode = NonNullable<SessionSpec['permission_mode']>;

/** Reports whether the running command committed, once its transaction has ended. */
export function afterCommit(ctx: ControlContext): () => boolean {
  let rolledBack = false;
  ctx.rollback?.push(() => {
    rolledBack = true;
  });
  return () => !rolledBack;
}

/** Sets the live native mode; a refusal restores the stored mode it replaced. */
export async function applyPermissionMode(
  ctx: ControlContext,
  adapter: HarnessAdapter,
  handle: SessionHandle,
  previous: PermissionMode,
  mode: PermissionMode,
  cause?: string,
): Promise<void> {
  let error: string | undefined;
  try {
    const receipt = await adapter.setPermissionMode!(handle, mode);
    if (!receipt.ok) error = receipt.reason ?? 'Runtime refused the permission mode';
  } catch (thrown) {
    error = String(thrown);
  }
  if (error === undefined) return;
  ctx.store.transaction(() => {
    // A session deleted meanwhile has no mode left to restore.
    const current = ctx.store.get<Session>('sessions', handle.platform_session_id);
    if (!current) return;
    ctx.store.event(
      'session.permission_mode_failed',
      current,
      current.project_id,
      { error },
      cause,
    );
    if ((current.permission_mode ?? 'ask') !== mode) return;
    const restored = ctx.store.update(
      'sessions',
      { ...current, permission_mode: previous },
      current.revision,
    );
    ctx.store.event(
      'session.permission_mode_changed',
      restored,
      restored.project_id,
      { permission_mode: previous },
      cause,
    );
  });
  ctx.changed();
}

export async function applyFastMode(
  ctx: ControlContext,
  adapter: HarnessAdapter,
  handle: SessionHandle,
  previous: boolean,
  fast: boolean,
  cause?: string,
): Promise<void> {
  let error: string | undefined;
  try {
    const receipt = await adapter.setFastMode!(handle, fast);
    if (!receipt.ok) error = receipt.reason ?? 'Runtime refused fast mode';
  } catch (thrown) {
    error = String(thrown);
  }
  if (error === undefined) return;
  ctx.store.transaction(() => {
    const current = ctx.store.get<Session>('sessions', handle.platform_session_id);
    if (!current) return;
    ctx.store.event('session.fast_mode_failed', current, current.project_id, { error }, cause);
    if ((current.fast === true) !== fast) return;
    const restored = ctx.store.update(
      'sessions',
      { ...current, fast: previous ? (true as const) : undefined },
      current.revision,
    );
    ctx.store.event(
      'session.fast_mode_changed',
      restored,
      restored.project_id,
      { fast: previous },
      cause,
    );
  });
  ctx.changed();
}

export async function applyUltracode(
  ctx: ControlContext,
  adapter: HarnessAdapter,
  handle: SessionHandle,
  previous: boolean,
  ultracode: boolean,
  cause?: string,
): Promise<void> {
  let error: string | undefined;
  try {
    const receipt = await adapter.setUltracode!(handle, ultracode);
    if (!receipt.ok) error = receipt.reason ?? 'Runtime refused ultracode';
  } catch (thrown) {
    error = String(thrown);
  }
  if (error === undefined) return;
  ctx.store.transaction(() => {
    const current = ctx.store.get<Session>('sessions', handle.platform_session_id);
    if (!current) return;
    ctx.store.event('session.ultracode_failed', current, current.project_id, { error }, cause);
    if ((current.ultracode === true) !== ultracode) return;
    const restored = ctx.store.update(
      'sessions',
      { ...current, ultracode: previous ? (true as const) : undefined },
      current.revision,
    );
    ctx.store.event(
      'session.ultracode_changed',
      restored,
      restored.project_id,
      { ultracode: previous },
      cause,
    );
  });
  ctx.changed();
}

/** Sets the live native model; a refusal restores the stored model and effort it replaced. */
export async function applyModel(
  ctx: ControlContext,
  adapter: HarnessAdapter,
  handle: SessionHandle,
  previous: { model?: string; effort?: EffortLevel; fast?: true },
  model: string,
  effort: EffortLevel | undefined,
  cause?: string,
  fast?: boolean,
): Promise<void> {
  let error: string | undefined;
  try {
    const receipt =
      fast === undefined
        ? await adapter.setModel!(handle, model, effort)
        : await adapter.setModel!(handle, model, effort, fast);
    if (!receipt.ok) error = receipt.reason ?? 'Runtime refused the model';
  } catch (thrown) {
    error = String(thrown);
  }
  if (error === undefined) return;
  ctx.store.transaction(() => {
    // A session deleted meanwhile has no model left to restore.
    const current = ctx.store.get<Session>('sessions', handle.platform_session_id);
    if (!current) return;
    ctx.store.event('session.model_failed', current, current.project_id, { error }, cause);
    if (current.requested_model !== model || current.requested_effort !== effort) return;
    const restored = ctx.store.update(
      'sessions',
      {
        ...current,
        requested_model: previous.model,
        requested_effort: previous.effort,
        fast: previous.fast,
      },
      current.revision,
    );
    ctx.store.event(
      'session.model_changed',
      restored,
      restored.project_id,
      { model: previous.model ?? null, effort: previous.effort ?? null },
      cause,
    );
  });
  ctx.changed();
}

/** The branch and commit checked out in the project's first folder. */
export function projectHead(ctx: ControlContext, p: Principal, projectId: string): ProjectHead {
  projectAccess(ctx, p, projectId, 'project.read');
  const root = ctx.store.must<Project>('projects', projectId).roots[0]!;
  const status = branchStatus(runGit(root, BRANCH_STATUS)),
    head = runGit(root, ['log', '-1', '--format=%H%x00%s%x00%ct']);
  requireThat(
    status && head.exit_code === 0,
    'workspace_read_failed',
    'Project HEAD could not be read',
  );
  const [sha, subject, committedAt] = head.stdout.toString().trimEnd().split('\0');
  return {
    branch: status.branch,
    sha: sha!,
    subject: subject ?? '',
    committed_at: Number(committedAt) * 1000,
    ...(status.ahead_upstream !== undefined ? { ahead_upstream: status.ahead_upstream } : {}),
    uncommitted: status.uncommitted,
  };
}

/**
 * Tracked and unignored files of the session's worktree, or of the project's first folder, that
 * match q: file name matches first, then path matches, then paths holding q's characters in order.
 */
export function filesSearch(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  sessionId: string | undefined,
  q: string,
): string[] {
  ownWorkspaceOnly(ctx, p, projectId, sessionId);
  let cwd = ctx.store.must<Project>('projects', projectId).roots[0]!;
  if (sessionId) {
    const session = ctx.store.must<Session>('sessions', sessionId);
    requireThat(
      session.project_id === projectId,
      'permission_denied',
      'Session belongs to another project',
    );
    requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
    cwd = ctx.store.must<Workspace>('workspaces', session.workspace_id).path;
  }
  const listed = runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  requireThat(listed.exit_code === 0, 'workspace_read_failed', 'Files could not be listed');
  const files = [...new Set(listed.stdout.toString().split('\0').filter(Boolean))];
  const needle = q.toLowerCase();
  if (!needle) return files.slice(0, 50);
  const rank = (file: string): number => {
    const lower = file.toLowerCase();
    if (path.posix.basename(lower).includes(needle)) return 0;
    if (lower.includes(needle)) return 1;
    const wanted = [...needle];
    let next = 0;
    for (const character of lower) if (character === wanted[next]) next++;
    return next === wanted.length ? 2 : 3;
  };
  return files
    .map((file) => ({ file, rank: rank(file) }))
    .filter((match) => match.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.file.length - b.file.length)
    .slice(0, 50)
    .map((match) => match.file);
}
