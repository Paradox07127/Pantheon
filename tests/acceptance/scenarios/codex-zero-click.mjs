import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import {
  checkClone,
  checkExtensions,
  closeDaemon,
  configureCodexProject,
  git,
  MINUTE,
  POLL_MS,
  REQUEST_MS,
  repositoryRoot,
  testCounts,
  watchApprovals,
} from '../lib/codex-live.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = 'Codex 零点击冒烟';
export const mode = 'live';

const TASKS = [
  {
    id: 'usage-previous-period',
    title: 'Report the usage of the period before the range',
    goal: 'board.view in packages/control/src/board-view.ts counts tokens and cost only inside the chosen range. Add counts.previous { tokens: number; cost_usd: number | null } summed over turns that ended in the equally long period just before the range; cost_usd is null when none of them has a cost. Declare it in BoardModel (packages/protocol/src/index.ts) and test it under tests/control.',
  },
  {
    id: 'kpi-previous-compare',
    title: 'Compare the usage tiles with the period before',
    goal: 'kpis in apps/web/src/screens/board/usage-model.ts takes the previous period from BoardModel.usage, which board.view never sends outside the range, so the tiles never show a change. Compare the tokens and cost tiles with model.counts.previous instead, show no change when it is null or zero, and test it in tests/web/board-usage-kpis.test.ts.',
  },
];
// update_board refuses a goal or source excerpt over 400 characters.
for (const task of TASKS)
  if (task.goal.length > 400) throw new Error(`Task ${task.id} goal is over 400 characters`);
const [FIRST, SECOND] = TASKS.map((task) => task.id);
const LEAD_INPUT = [
  `Plan exactly these two tasks with update_board, copying ids, titles and goals verbatim. Give each task its source, scope and acceptance as update_board asks. Task ${SECOND} depends_on ${FIRST}. Put both in one milestone with id "zero-click" titled "Codex zero-click"; one lane "main". Then call start_task with ${JSON.stringify([FIRST, SECOND])} and end your turn. Do not implement the tasks yourself and do not commit.`,
  ...TASKS.map((task) => `id: ${task.id}\ntitle: ${task.title}\ngoal: ${task.goal}`),
].join('\n\n');
const READY = ['ready_for_acceptance', 'completed'];

const SCENARIO_MS = 80 * MINUTE;
const PLAN_MS = 20 * MINUTE;
const TASK_MS = 30 * MINUTE;
const DISPATCH_MS = 2 * MINUTE;
const NOTES_MS = 20 * MINUTE;
const READY_MS = 5 * MINUTE;
/** No turn, merge or worktree preparation running in the project this long ends the wait. */
const QUIET_MS = 5 * MINUTE;
const MAX_DENIALS_PER_SESSION = 3;

export async function run({ workspace, evidenceDir }) {
  const startedAt = Date.now(),
    deadline = startedAt + SCENARIO_MS;
  const clone = path.join(workspace, 'pantheon');
  const receipts = [],
    views = {},
    gates = {},
    timings = {},
    preflight = {},
    observations = {},
    denials = [],
    processes = new Map(),
    allEvents = [];
  let fixture, daemon, adapter, projectId, leadId, leadCommandId, baseSha, usage, lastBoard;
  let cloneGit, userCommandLog;
  let failure,
    watchFailure,
    stopWatch = false,
    watcher,
    eventCursor = 0,
    pulling,
    quietSince;

  /** The cap, cut to what is left before the scenario deadline. */
  const budget = (cap) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Scenario deadline reached');
    return Math.min(cap, left);
  };
  const timed = async (name, step) => {
    const started = Date.now();
    try {
      return await step();
    } finally {
      timings[name] = Date.now() - started;
    }
  };
  const request = async (pathname, init = {}) => {
    const response = await fetch(`${daemon.url}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${daemon.token}`, ...init.headers },
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    return { status: response.status, ok: response.ok, data: await response.json() };
  };
  const send = async (step, type, input, revision = null) => {
    const body = command(USER_PRINCIPAL_ID, type, input, revision);
    const result = await request('/v1/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    receipts.push({
      step,
      type,
      input,
      expected_revision: revision,
      command_id: body.command_id,
      status: result.status,
      data: result.data,
    });
    return result;
  };
  const call = async (step, type, input, revision = null) => {
    const result = await send(step, type, input, revision);
    if (result.status !== 200 || result.data.receipt?.error)
      throw new Error(`${step} ${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const result = await request(`/v1/${method}?${new URLSearchParams(params)}`);
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const snapshot = async () => {
    const board = await get('board', { project_id: projectId });
    for (const row of [
      ...board.sessions.map((session) => session.process_identity),
      ...board.workspaces.map((row) => row.provisioning?.process_identity),
    ])
      if (row) processes.set(`${row.pid}:${row.start_time_us ?? ''}`, row);
    return (lastBoard = board);
  };
  const view = async (moment) =>
    (views[moment] = await get('board.view', { project_id: projectId, days: '14' }));
  /** Appends the project's events after the last one read, page by page. */
  const pullEvents = () =>
    (pulling ??= (async () => {
      for (;;) {
        const page = await get('events', { after: String(eventCursor), project_id: projectId });
        if (page.snapshot_required)
          throw new Error('Event log no longer reaches the unread events');
        if (!page.events.length) return allEvents;
        allEvents.push(...page.events);
        eventCursor = page.events.at(-1).sequence;
      }
    })().finally(() => (pulling = undefined)));
  const poll = async (check, description, capMs) => {
    const until = Math.min(Date.now() + capMs, deadline);
    for (;;) {
      if (watchFailure) throw watchFailure;
      const result = await check();
      if (result) return result;
      if (Date.now() >= until)
        throw new Error(
          `${Date.now() >= deadline ? 'Scenario deadline reached' : 'Timed out'} waiting for ${description}`,
        );
      await delay(POLL_MS);
    }
  };
  const flush = () => writeEvidence(evidenceDir, evidenceContents());
  /** User commands the daemon recorded, in receipt order. */
  const userCommands = () =>
    daemon.store.db
      .prepare(
        "SELECT rowid, source_key FROM inbox WHERE source_key GLOB 'local-user:command:*' ORDER BY rowid",
      )
      .all()
      .map((row) => row.source_key.slice('local-user:command:'.length));

  const turnsOf = (board, sessionId) =>
    board.session_turns.filter((turn) => turn.session_id === sessionId);
  const ended = (turn) => !['queued', 'running'].includes(turn.state);
  const workspaceOf = (board, session) =>
    board.workspaces.find((row) => row.id === session?.workspace_id);
  const dispatched = (taskId) =>
    allEvents.find(
      (event) =>
        event.kind === 'task.dispatched' &&
        event.aggregate_id === leadId &&
        event.payload.task_id === taskId,
    );
  const merged = (sessionId) =>
    allEvents.find((event) => event.kind === 'session.merged' && event.aggregate_id === sessionId);
  const taskOf = (sessionId) =>
    sessionId === leadId
      ? 'lead'
      : (TASKS.find((task) => dispatched(task.id)?.payload.session_id === sessionId)?.id ??
        sessionId);
  /** Reads the board and events; fails on a user MCP server or when nothing has run for QUIET_MS. */
  const step = async () => {
    const board = await snapshot();
    await pullEvents();
    checkExtensions(allEvents, observations);
    const busy =
      board.session_turns.some((turn) => !ended(turn)) ||
      board.sessions.some((session) => session.merge?.state === 'running') ||
      board.workspaces.some((row) => ['queued', 'running'].includes(row.provisioning?.state));
    if (busy) quietSince = undefined;
    else if (Date.now() - (quietSince ??= Date.now()) > QUIET_MS)
      throw new Error(`Nothing ran in the project for ${QUIET_MS / MINUTE} minutes`);
    return board;
  };
  /** Fails when a dispatched task session can no longer merge. */
  const checkTasks = (board) => {
    for (const task of TASKS) {
      const session = board.sessions.find(
        (row) => row.id === dispatched(task.id)?.payload.session_id,
      );
      if (!session || session.outcome === 'merged') continue;
      const fail = (reason) => {
        throw new Error(`Task ${task.id}: ${reason}`);
      };
      if (session.outcome) fail(`session ended ${session.outcome}`);
      const provisioning = workspaceOf(board, session)?.provisioning?.state;
      if (provisioning === 'failed' || provisioning === 'cancelled')
        fail(`worktree preparation ${provisioning}`);
      if (session.state === 'closed' || session.state === 'reconciling')
        fail(`session is ${session.state}`);
    }
  };
  const dispatchOf = (taskId, capMs) =>
    timed(`dispatch.${taskId}`, () =>
      poll(
        async () => {
          const board = await step();
          checkTasks(board);
          return dispatched(taskId)?.payload.session_id ?? false;
        },
        `the daemon to dispatch ${taskId}`,
        capMs,
      ),
    );
  const mergeOf = (taskId, sessionId) =>
    timed(`work.${taskId}`, () =>
      poll(
        async () => {
          checkTasks(await step());
          return Boolean(merged(sessionId));
        },
        `the session of ${taskId} to merge`,
        TASK_MS,
      ),
    );

  try {
    // Preflight: clone, install, baseline gate, Codex version and subscription login.
    await timed('preflight.clone', async () => {
      baseSha = git(repositoryRoot, 'rev-parse', 'HEAD').trim();
      git(workspace, 'clone', '--quiet', '--no-local', repositoryRoot, clone);
      git(clone, 'checkout', '--quiet', '-B', 'main', baseSha);
      preflight.clone = { source: repositoryRoot, head: baseSha, path: clone };
    });
    await flush();
    await checkClone({ workspace, clone, budget, timed, flush, preflight, gates, observations });

    // Daemon, project, extension overrides, gate, session defaults and auto-merge.
    adapter = new CodexAdapter('codex', preflight.codex.version);
    fixture = await startNativeDaemon(workspace, [adapter], { intervalMs: 200 });
    ({ daemon } = fixture);
    const project = await call('preflight', 'project.open', {
      name: 'Codex zero-click',
      roots: [clone],
    });
    projectId = project.id;
    await configureCodexProject({ call, get, project, preflight });
    const projectRow = async () => (await snapshot()).projects.find((row) => row.id === projectId);
    await call(
      'preflight',
      'project.sessionDefaults.set',
      { project_id: projectId, runtime: 'codex', permission_mode: 'auto_edit' },
      (await projectRow()).revision,
    );
    await call(
      'preflight',
      'project.autoMerge.set',
      { project_id: projectId, enabled: true },
      (await projectRow()).revision,
    );
    timings.preflight = Date.now() - startedAt;
    await flush();

    // The approval watcher runs from before the lead opens until the last tracker turn ends.
    watcher = watchApprovals({
      projectId,
      get,
      send,
      pullEvents,
      events: allEvents,
      denials,
      deadline,
      stopped: () => stopWatch,
      fail: (error) => (watchFailure = error),
      maxPerSession: MAX_DENIALS_PER_SESSION,
    });

    // The user's only request: the lead writes the plan and starts both tasks.
    const lead = await call('request', 'session.create', {
      project_id: projectId,
      runtime: 'codex',
      purpose: 'lead',
      permission_mode: 'auto_edit',
      input: LEAD_INPUT,
    });
    leadId = lead.id;
    leadCommandId = receipts.at(-1).command_id;
    await flush();

    // From here on the daemon and the sessions do everything.
    const firstSession = await timed('plan', () =>
      poll(
        async () => {
          const board = await step();
          const failed = turnsOf(board, leadId).find(
            (turn) => ended(turn) && turn.state !== 'completed',
          );
          if (failed && !dispatched(FIRST))
            throw new Error(`The lead's turn ended ${failed.state}`);
          return dispatched(FIRST)?.payload.session_id ?? false;
        },
        `the lead to plan and the daemon to dispatch ${FIRST}`,
        PLAN_MS,
      ),
    );
    await flush();
    await mergeOf(FIRST, firstSession);
    await flush();
    const secondSession = await dispatchOf(SECOND, DISPATCH_MS);
    await mergeOf(SECOND, secondSession);
    await flush();
    const sessionIds = { [FIRST]: firstSession, [SECOND]: secondSession };

    // The lead hears of both merges; every lead turn ends.
    const mergedLines = (input, session) =>
      input.split('\n').filter((line) => line.includes(`session ${session.id} merged`)).length;
    await timed('notes', () =>
      poll(
        async () => {
          const board = await step();
          const leadRow = board.sessions.find((row) => row.id === leadId);
          const turns = turnsOf(board, leadId);
          const tracker = turns.filter((turn) => turn.origin === 'tracker');
          const sessions = Object.values(sessionIds).map((id) =>
            board.sessions.find((row) => row.id === id),
          );
          return (
            leadRow?.state === 'open' &&
            turns.every(ended) &&
            sessions.every((session) => tracker.some((turn) => mergedLines(turn.input, session)))
          );
        },
        'the lead tracker turns after both merges',
        NOTES_MS,
      ),
    );
    const ready = await timed('ready', () =>
      poll(
        async () => {
          const model = await view('ready');
          const row = model.milestones.find((milestone) => milestone.owner_session_id === leadId);
          return READY.includes(row?.status) ? model : false;
        },
        'the milestone to be ready for acceptance or accepted',
        READY_MS,
      ),
    );
    stopWatch = true;
    await watcher;
    if (watchFailure) throw watchFailure;

    const events = await pullEvents();
    const local = (id) => id.slice(leadId.length + 1);
    const ours = (id) => id.startsWith(`${leadId}:`);
    const contracts =
      (await get('project.read', { project_id: projectId })).plans.find(
        (plan) => plan.lead_session_id === leadId,
      )?.tasks ?? [];
    const lastGate = (sessionId) => {
      const mergedAt = merged(sessionId).sequence;
      return events.findLast(
        (event) =>
          event.kind === 'session.gate_checked' &&
          event.aggregate_id === sessionId &&
          event.sequence < mergedAt,
      );
    };
    observations.plan = {
      tasks: ready.tasks
        .filter((row) => row.owner_session_id === leadId)
        .map((row) => local(row.id))
        .sort(),
      edges: ready.edges
        .filter((edge) => ours(edge.from) && ours(edge.to))
        .map((edge) => `${local(edge.from)}->${local(edge.to)}`)
        .sort(),
    };
    observations.dispatch = {
      order: events
        .filter((event) => event.kind === 'task.dispatched' && event.aggregate_id === leadId)
        .map((event) => event.payload.task_id),
      b_after_a_merged: dispatched(SECOND).sequence > merged(firstSession).sequence,
    };
    observations.work = {
      auto_merged: TASKS.map((task) => task.id)
        .filter(
          (taskId) =>
            merged(sessionIds[taskId]) &&
            events.some(
              (event) =>
                event.kind === 'session.merge_started' &&
                event.aggregate_id === sessionIds[taskId] &&
                event.payload.auto === true,
            ),
        )
        .sort(),
      acceptance_ran: TASKS.map((task) => task.id)
        .filter((taskId) => {
          const first = contracts.find((task) => task.id === taskId)?.acceptance[0];
          return (
            first !== undefined &&
            lastGate(sessionIds[taskId])?.payload.results.some((result) => result.name === first)
          );
        })
        .sort(),
    };
    observations.milestone = {
      ready: READY.includes(
        ready.milestones.find((milestone) => milestone.owner_session_id === leadId)?.status,
      ),
    };
    const approvalCommands = new Set(
      receipts.filter((row) => row.type === 'approval.respond').map((row) => row.command_id),
    );
    const recorded = userCommands();
    observations.user = {
      commands_after_lead_excluding_approvals: recorded
        .slice(recorded.indexOf(leadCommandId) + 1)
        .filter((id) => !approvalCommands.has(id)).length,
    };
    const deniedSessions = new Set(denials.map((row) => row.session_id));
    observations.approvals = {
      denied: denials.length,
      denied_at_most_3: [...deniedSessions].every(
        (id) => denials.filter((row) => row.session_id === id).length <= MAX_DENIALS_PER_SESSION,
      ),
    };
    await flush();
  } catch (error) {
    failure = error;
  } finally {
    stopWatch = true;
    await watcher;
    if (fixture) {
      try {
        await snapshot();
        await pullEvents();
        await view('final');
        usage = await get('project.usage.read', { project_id: projectId });
        for (const session of lastBoard.sessions)
          if (session.workspace_id) {
            try {
              gates[session.id] = await get('session.gates', { session_id: session.id });
              const test = gates[session.id].last?.results.find((result) => result.name === 'test');
              if (test) gates[session.id].test_counts = testCounts(test.output_tail);
            } catch (error) {
              gates[session.id] = { error: error.message };
            }
          }
      } catch (error) {
        timings.collection_error = String(error?.message ?? error);
      }
      try {
        userCommandLog = { lead_command_id: leadCommandId ?? null, recorded: userCommands() };
      } catch (error) {
        userCommandLog = { error: String(error?.message ?? error) };
      }
      observations.processes = {
        stopped: await closeDaemon({ fixture, processes, timed, timings }),
      };
    }
    if (baseSha) {
      try {
        cloneGit = [
          git(clone, 'log', '--oneline', '--decorate', '-n', '30', 'main'),
          git(clone, 'diff', '--stat', baseSha, 'main'),
          git(clone, 'diff', baseSha, 'main'),
        ].join('\n');
      } catch (error) {
        cloneGit = `git log or diff failed: ${error.message}\n`;
      }
    }
    timings.total = Date.now() - startedAt;
    // Recorded for the report, not asserted.
    if (lastBoard)
      observations.metrics = {
        session_usage: Object.fromEntries(
          lastBoard.sessions.map((session) => [taskOf(session.id), session.usage ?? null]),
        ),
        handbacks: lastBoard.session_turns.filter(
          (turn) => turn.origin === 'tracker' && turn.session_id !== leadId,
        ).length,
        lead_turns: turnsOf(lastBoard, leadId).length,
        wall_clock_ms: timings.total,
      };
    await flush();
  }
  if (failure) {
    await writeFile(path.join(evidenceDir, 'failure.txt'), String(failure?.stack ?? failure));
    await writeFile(
      path.join(evidenceDir, 'partial-observations.json'),
      JSON.stringify(observations, null, 2) + '\n',
    );
    throw failure;
  }
  return {
    observations,
    evidence: evidenceContents(),
    adapters: [`${adapter.name}@${adapter.report.version}`],
  };

  function evidenceContents() {
    const board = lastBoard ?? { sessions: [], session_turns: [] };
    const sessions = board.sessions.map((session) => {
      const own = allEvents.filter((event) => event.aggregate_id === session.id);
      const completed = new Map(
        own
          .filter((event) => event.kind === 'agent.tool.completed')
          .map((event) => [event.payload.tool_call_id, event.payload.ok]),
      );
      return {
        id: session.id,
        task_id: taskOf(session.id),
        title: session.title,
        task: session.task ?? null,
        state: session.state,
        outcome: session.outcome ?? null,
        merge: session.merge ?? null,
        usage: session.usage ?? null,
        turns: turnsOf(board, session.id).map(({ id, origin, state, input }) => ({
          id,
          origin: origin ?? null,
          state,
          input,
        })),
        tools: own
          .filter((event) => event.kind === 'agent.tool.started')
          .map((event) => ({
            name: event.payload.name,
            tool_call_id: event.payload.tool_call_id,
            ok: completed.get(event.payload.tool_call_id) ?? null,
          })),
        auth_checked: own
          .filter((event) => event.kind === 'agent.auth.checked')
          .map((event) => event.payload),
        extensions_applied: own
          .filter((event) => event.kind === 'agent.extensions.applied')
          .map((event) => event.payload),
      };
    });
    return {
      'preflight.json': preflight,
      'receipts.json': receipts,
      'events.json': allEvents,
      'sessions.json': sessions,
      'board-views.json': views,
      'gates.json': gates,
      'usage.json': usage ?? {},
      'work.json': { denials },
      'timings.json': timings,
      'clone-git.txt': cloneGit || 'Clone not created\n',
      'user-commands.json': userCommandLog ?? {},
    };
  }
}
