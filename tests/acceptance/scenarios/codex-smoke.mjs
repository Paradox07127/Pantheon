import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import {
  checkClone,
  checkExtensions as userServersCheck,
  closeDaemon,
  configureCodexProject,
  git,
  MINUTE,
  POLL_MS,
  REQUEST_MS,
  repositoryRoot,
  testCounts,
  watchApprovals as rejectApprovals,
} from '../lib/codex-live.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = 'Codex 工作台冒烟';
export const mode = 'live';

const TASKS = [
  {
    id: 'source-skips-digest',
    title: 'Ignore board digests when checking task sources',
    goal: "In packages/control/src/project-board.ts, sourceProblem must refuse a source quote that appears only in the board digest Pantheon appends to a lead's turn input: the text from INBOX_HEADER of packages/control/src/lead-inbox.ts onward, appended by takeInbox in packages/control/src/session.ts. Add a case to tests/control/project-board.test.ts.",
  },
  {
    id: 'project-read-description',
    title: 'Describe project_read as it is',
    goal: 'In apps/cli/src/mcp.ts the project.read tool description lists feedback, which projectFacts in packages/control/src/project-facts.ts does not return. Make the description name what projectFacts returns, and cover it with a test under tests/.',
  },
];
const LEAD_INPUT = [
  'Plan exactly these two tasks with update_board, copying ids, titles and goals verbatim. Give each task its source, scope and acceptance as update_board asks. Put both in one milestone with key "smoke" titled "Codex smoke"; no dependencies; one lane "main". Do not implement them, do not commit, and do not call milestone_accept: the user accepts the milestone.',
  ...TASKS.map((task) => `id: ${task.id}\ntitle: ${task.title}\ngoal: ${task.goal}`),
].join('\n\n');
/** The first message of a session opened from a board task, as the app writes it. */
const taskPrompt = (task) => `${task.title}\n\n${task.goal}`;
const NUDGE = {
  commit: 'Commit your work in this worktree.',
  dirty: 'Commit or remove the remaining files in this worktree.',
};

const SCENARIO_MS = 80 * MINUTE;
const PLAN_MS = 20 * MINUTE;
const WORK_MS = 50 * MINUTE;
const MERGE_START_MS = MINUTE;
const NOTES_MS = 20 * MINUTE;
const READY_MS = 5 * MINUTE;
const MAX_DENIALS_PER_SESSION = 3;

export async function run({ workspace, evidenceDir }) {
  const startedAt = Date.now(),
    deadline = startedAt + SCENARIO_MS;
  const preflightOnly = process.env.PANTHEON_SMOKE_PREFLIGHT_ONLY === '1';
  const clone = path.join(workspace, 'pantheon');
  const receipts = [],
    views = {},
    gates = {},
    timings = {},
    preflight = {},
    observations = {},
    interventions = [],
    denials = [],
    leadChecks = [],
    processes = new Map(),
    allEvents = [];
  let fixture, daemon, adapter, projectId, leadId, baseSha, usage, lastBoard, cloneGit;
  let failure,
    watchFailure,
    stopWatch = false,
    watcher,
    eventCursor = 0,
    pulling;
  const works = [];

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

  const turnsOf = (board, sessionId) =>
    board.session_turns.filter((turn) => turn.session_id === sessionId);
  const ended = (turn) => !['queued', 'running'].includes(turn.state);
  const workspaceOf = (board, session) =>
    board.workspaces.find((row) => row.id === session?.workspace_id);
  const worktree = (row) => {
    const head = git(row.path, 'rev-parse', 'HEAD').trim();
    const status = git(row.path, 'status', '--porcelain=v1', '--untracked-files=all');
    return {
      head,
      base: row.base_sha,
      advanced: head !== row.base_sha,
      clean: !status.trim(),
      status,
    };
  };
  const checkExtensions = () => userServersCheck(allEvents, observations);
  /** Records the lead worktree once each time its turns have all ended. */
  const checkLead = (board) => {
    const lead = board.sessions.find((row) => row.id === leadId);
    const turns = turnsOf(board, leadId);
    if (lead?.state !== 'open' || !turns.length || !turns.every(ended)) return;
    const unchecked = turns.filter(
      (turn) => !leadChecks.some((row) => row.turn_ids.includes(turn.id)),
    );
    if (!unchecked.length) return;
    const tree = worktree(workspaceOf(board, lead));
    leadChecks.push({
      at: Date.now(),
      turn_ids: unchecked.map((turn) => turn.id),
      origins: unchecked.map((turn) => turn.origin ?? null),
      head: tree.head,
      base: tree.base,
      clean: tree.clean,
      status: tree.status,
    });
  };
  const watchApprovals = () =>
    rejectApprovals({
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
  const classify = async (work, board) => {
    const session = board.sessions.find((row) => row.id === work.id);
    const turns = turnsOf(board, work.id);
    const row = workspaceOf(board, session);
    const fail = (reason) => {
      throw new Error(`Task ${work.task.id}: ${reason}`);
    };
    if (session.outcome === 'merged') {
      work.done = true;
      return;
    }
    if (session.outcome) fail(`session ended ${session.outcome}`);
    const provisioning = row?.provisioning?.state;
    if (provisioning === 'failed' || provisioning === 'cancelled')
      fail(`worktree preparation ${provisioning}`);
    if (session.state === 'closed' || session.state === 'reconciling')
      fail(`session is ${session.state}`);
    if (session.stop_pending && session.state !== 'running') fail('session stop is unconfirmed');
    if (session.merge?.state === 'blocked')
      fail(`merge blocked: ${session.merge.reason ?? 'no reason'}`);
    if (session.merge?.state === 'running') return;
    if (session.state !== 'open' || !turns.length || !turns.every(ended)) return;
    const unfinished = turns.find((turn) => turn.state !== 'completed');
    if (unfinished) fail(`turn ended ${unfinished.state}`);
    const tree = worktree(row);
    if (tree.advanced && tree.clean) {
      work.merge_wait_since ??= Date.now();
      if (Date.now() - work.merge_wait_since > MERGE_START_MS)
        fail('the automatic merge did not start within 60 seconds');
      return;
    }
    work.merge_wait_since = undefined;
    const kind = tree.advanced ? 'dirty' : 'commit';
    if (work.nudged[kind])
      fail(kind === 'dirty' ? 'worktree still has uncommitted files' : 'still no commit');
    work.nudged[kind] = true;
    interventions.push({
      at: Date.now(),
      task: work.task.id,
      session_id: work.id,
      kind,
      status: tree.status,
    });
    await call(
      'work',
      'session.send',
      { session_id: work.id, input: NUDGE[kind] },
      session.revision,
    );
  };

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

    // Daemon, project, extension overrides and gate.
    adapter = new CodexAdapter('codex', preflight.codex.version);
    fixture = await startNativeDaemon(workspace, [adapter], { intervalMs: 200 });
    ({ daemon } = fixture);
    const project = await call('preflight', 'project.open', {
      name: 'Codex smoke',
      roots: [clone],
    });
    projectId = project.id;
    await configureCodexProject({ call, get, project, preflight });
    timings.preflight = Date.now() - startedAt;
    await flush();

    if (!preflightOnly) {
      // The approval watcher runs from before the lead opens until the last tracker turn ends.
      watcher = watchApprovals();

      // The lead writes the plan and changes nothing in its worktree.
      const lead = await call('plan', 'session.create', {
        project_id: projectId,
        runtime: 'codex',
        purpose: 'lead',
        permission_mode: 'auto_edit',
        input: LEAD_INPUT,
      });
      leadId = lead.id;
      const planned = await timed('plan', () =>
        poll(
          async () => {
            const board = await snapshot();
            await pullEvents();
            checkExtensions();
            const session = board.sessions.find((row) => row.id === leadId);
            const turns = turnsOf(board, leadId);
            return session?.state === 'open' && turns.length && turns.every(ended)
              ? { board, turns }
              : false;
          },
          'the lead to write the plan',
          PLAN_MS,
        ),
      );
      const failedPlanTurn = planned.turns.find((turn) => turn.state !== 'completed');
      if (failedPlanTurn) throw new Error(`The lead's turn ended ${failedPlanTurn.state}`);
      const model = await view('planned');
      const leadTasks = model.tasks.filter((task) => task.owner_session_id === leadId);
      const leadMilestones = planned.board.milestones.filter(
        (row) => row.owner_session_id === leadId && !row.removed_at,
      );
      const ids = TASKS.map((task) => task.id).sort();
      checkLead(planned.board);
      const leadTree = leadChecks.at(-1);
      const contracts = (await get('project.read', { project_id: projectId })).plans
        .find((plan) => plan.lead_session_id === leadId)
        ?.tasks.map(({ id, source, scope, acceptance }) => ({ id, source, scope, acceptance }));
      observations.plan = {
        contracts: contracts ?? [],
        matches:
          leadTasks.length === TASKS.length &&
          contracts?.length === TASKS.length &&
          contracts.every(
            (task) => task.source.length && task.scope.length && task.acceptance.length,
          ) &&
          TASKS.every((task) =>
            leadTasks.some(
              (row) =>
                row.id === `${leadId}:${task.id}` &&
                row.title === task.title &&
                row.goal === task.goal,
            ),
          ) &&
          leadMilestones.length === 1 &&
          leadMilestones[0].key === 'smoke' &&
          JSON.stringify([...(leadMilestones[0].task_ids ?? [])].sort()) === JSON.stringify(ids) &&
          !model.edges.some(
            (edge) => edge.from.startsWith(`${leadId}:`) || edge.to.startsWith(`${leadId}:`),
          ),
        lead_clean: Boolean(leadTree && leadTree.head === leadTree.base && leadTree.clean),
      };
      await flush();
      if (!observations.plan.matches) throw new Error('The lead did not write the given plan');

      // Auto-merge on; one session per task.
      const current = (await snapshot()).projects.find((row) => row.id === projectId);
      await call(
        'work',
        'project.autoMerge.set',
        { project_id: projectId, enabled: true },
        current.revision,
      );
      for (const task of TASKS) {
        const session = await call('work', 'session.create', {
          project_id: projectId,
          runtime: 'codex',
          permission_mode: 'auto_edit',
          task_id: `${leadId}:${task.id}`,
          input: taskPrompt(task),
        });
        works.push({ id: session.id, task, nudged: { commit: false, dirty: false }, done: false });
      }
      await flush();

      // Each task session commits and merges through the gate, with at most one nudge of each kind.
      await timed('work', () =>
        poll(
          async () => {
            const board = await snapshot();
            await pullEvents();
            checkExtensions();
            checkLead(board);
            for (const work of works) if (!work.done) await classify(work, board);
            return works.every((work) => work.done);
          },
          'both task sessions to merge',
          WORK_MS,
        ),
      );
      await flush();

      // The lead hears of both merges; every tracker turn ends.
      const mergedLines = (input, session) =>
        input.split('\n').filter((line) => line.includes(`session ${session.id} merged`)).length;
      const heard = await timed('notes', () =>
        poll(
          async () => {
            const board = await snapshot();
            await pullEvents();
            checkExtensions();
            checkLead(board);
            const lead = board.sessions.find((row) => row.id === leadId);
            const turns = turnsOf(board, leadId);
            const tracker = turns.filter((turn) => turn.origin === 'tracker');
            const sessions = works.map((work) => board.sessions.find((row) => row.id === work.id));
            return lead?.state === 'open' &&
              turns.every(ended) &&
              sessions.every((session) => tracker.some((turn) => mergedLines(turn.input, session)))
              ? { board, tracker, sessions }
              : false;
          },
          'the lead tracker turns after both merges',
          NOTES_MS,
        ),
      );
      stopWatch = true;
      await watcher;
      if (watchFailure) throw watchFailure;
      checkLead(heard.board);
      const events = await pullEvents();
      const applied = checkExtensions();
      const unstarted = [leadId, ...works.map((work) => work.id)].filter(
        (id) => !applied.some((event) => event.aggregate_id === id),
      );
      if (unstarted.length)
        throw new Error(`No extensions.applied event for sessions ${unstarted.join(', ')}`);
      const taskOf = (sessionId) => {
        if (sessionId === leadId) return 'lead';
        const work = works.find((row) => row.id === sessionId);
        return work ? work.task.id : sessionId;
      };
      const completedInput = heard.tracker
        .filter((turn) => turn.state === 'completed')
        .map((turn) => turn.input)
        .join('\n');
      observations.plan.lead_clean =
        observations.plan.lead_clean &&
        leadChecks.every((row) => row.head === row.base && row.clean);
      observations.work = {
        merged_sessions: [
          ...new Set(
            events
              .filter((event) => event.kind === 'session.merged')
              .map((event) => taskOf(event.aggregate_id)),
          ),
        ].sort(),
        reported: [
          ...new Set(
            events
              .filter((event) => event.kind === 'task.reported')
              .map((event) => taskOf(event.payload.session_id)),
          ),
        ].sort(),
        interventions: interventions.length,
        approvals_denied: denials.length,
        tool_refusals: events.filter(
          (event) => event.kind === 'agent.tool.completed' && event.payload.ok === false,
        ).length,
      };
      observations.lead = {
        merge_attempted: events.some(
          (event) => event.kind.startsWith('session.merge') && event.aggregate_id === leadId,
        ),
        accept_attempted: events.some(
          (event) =>
            event.kind === 'agent.tool.started' &&
            event.aggregate_id === leadId &&
            String(event.payload.name).endsWith('milestone_accept'),
        ),
        notes_each_once: heard.sessions.every(
          (session) => mergedLines(completedInput, session) === 1,
        ),
      };
      await flush();

      // The user accepts the milestone with both sessions as evidence.
      const ready = await timed('accept', () =>
        poll(
          async () => {
            const model = await view('ready');
            const row = model.milestones.find((milestone) => milestone.owner_session_id === leadId);
            return row?.status === 'ready_for_acceptance' ? row : false;
          },
          'the milestone to be ready for acceptance',
          READY_MS,
        ),
      );
      const milestone = (await snapshot()).milestones.find((row) => row.id === ready.id);
      await call(
        'accept',
        'milestone.accept',
        { milestone_id: milestone.id, evidence_refs: works.map((work) => `session:${work.id}`) },
        milestone.revision,
      );
      const accepted = await view('accepted');
      observations.milestone = {
        completed: accepted.milestones.find((row) => row.id === ready.id)?.status === 'completed',
      };
      await flush();
    }
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
      const stopped = await closeDaemon({ fixture, processes, timed, timings });
      if (!preflightOnly) observations.shutdown = { processes_stopped: stopped };
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
      'work.json': { interventions, denials, lead_checks: leadChecks },
      'timings.json': timings,
      'clone-git.txt': cloneGit || 'Clone not created\n',
    };
  }
}
