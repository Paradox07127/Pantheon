import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '工作台闭环(fixture)';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 60000;
const MCP_TOOLS = new Set(['update_board', 'report', 'project_read', 'milestone_accept']);
const REPORT_A = 'Task A is finished';
const MERGED_NOTE = 'merged: The session merged into its source.';
const FAIL_REASON = 'Task C cannot start';
const FAILED_NOTE = `turn_failed: The latest turn of the session failed. Reason: ${FAIL_REASON}`;
const BLOCKED_NOTE = 'blocked: The merge of the session is blocked. Reason: gate_failed';
/** Ticks the event cursor must stay still for before the daemon counts as settled. */
const QUIET_TICKS = 20;
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
const failingGate = [{ name: 'Fails', argv: [process.execPath, '-e', 'process.exit(1)'] }];
const plan = {
  base_version: 0,
  headline: 'Workbench loop',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'A',
      title: 'Task A',
      goal: 'Add a.txt',
      lane: 'main',
      milestone: 'M',
      depends_on: [],
      source: ['Add a.txt'],
      scope: ['a.txt'],
      acceptance: ['test -f a.txt'],
    },
    {
      id: 'B',
      title: 'Task B',
      goal: 'Add b.txt',
      lane: 'main',
      milestone: 'M',
      depends_on: ['A'],
      source: ['Add b.txt'],
      scope: ['b.txt'],
      acceptance: ['test -f b.txt'],
    },
  ],
  milestones: [
    { id: 'M', title: 'Milestone M', criteria: ['A and B are merged'], tasks: ['A', 'B'] },
  ],
  risks: [],
  assumptions: [],
};
const retoldPlan = {
  ...plan,
  // The lead's first plan is at version 1.
  base_version: 1,
  tasks: [
    ...plan.tasks,
    {
      id: 'C',
      title: 'Task C',
      goal: 'Add c.txt',
      lane: 'main',
      depends_on: [],
      source: ['Add c.txt'],
      scope: ['c.txt'],
      acceptance: ['test -f c.txt'],
    },
  ],
};

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const adapter = new FixtureAdapter();
  const options = { intervalMs: 50, workspaceRoot: path.join(workspace, 'workspaces') };
  let fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], options);
  let { daemon } = fixture;
  const receipts = [],
    views = {},
    heads = {},
    gates = {},
    observations = {};
  let projectId, failure, evidence;

  const send = async (step, type, input, revision = null) => {
    const result = await fixture.submit(command(USER_PRINCIPAL_ID, type, input, revision));
    receipts.push({ step, type, input, expected_revision: revision, ...result });
    return result;
  };
  const call = async (step, type, input, revision = null) => {
    const result = await send(step, type, input, revision);
    if (result.status !== 200) throw new Error(`${step} ${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const snapshot = () => get('board', { project_id: projectId });
  const view = async (moment) =>
    (views[moment] = await get('board.view', { project_id: projectId, days: '14' }));
  const head = async (moment) =>
    (heads[moment] = await get('project.head', { project_id: projectId }));
  const sessionGates = async (label, sessionId) => {
    try {
      gates[label] = await get('session.gates', { session_id: sessionId });
    } catch (error) {
      gates[label] = { error: error.message };
    }
  };
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  const turnsOf = (board, sessionId) =>
    board.session_turns.filter((turn) => turn.session_id === sessionId);
  /** Waits until the session is open with at least `count` turns, every one ended. */
  const settled = (sessionId, count, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = board.sessions.find((row) => row.id === sessionId);
        const turns = turnsOf(board, sessionId);
        return session?.state === 'open' && turns.length >= count && turns.every(ended)
          ? { board, session, turns }
          : false;
      },
      description,
      WAIT_MS,
    );
  /** Waits until the session is open with every turn ended; each turn must have completed. */
  const idle = async (sessionId, description) => {
    const found = await settled(sessionId, 1, description);
    const failed = found.turns.filter((turn) => turn.state !== 'completed');
    if (failed.length) throw new Error(`${description}: turn ended ${failed[0].state}`);
    return found;
  };
  const outcome = (sessionId, expected, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = board.sessions.find((row) => row.id === sessionId);
        return session?.outcome === expected ? { board, session } : false;
      },
      description,
      WAIT_MS,
    );
  let leadId;
  /** Waits for the lead's tracker turns to reach the count, all ended, and the lead to be open. */
  const leadSettled = (count, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const lead = board.sessions.find((row) => row.id === leadId);
        const turns = turnsOf(board, leadId);
        const tracker = turns.filter((turn) => turn.origin === 'tracker');
        return lead?.state === 'open' && tracker.length >= count && turns.every(ended)
          ? { board, lead, tracker }
          : false;
      },
      description,
      WAIT_MS,
    );
  const planTasks = (model) => model.tasks.filter((task) => task.owner_session_id === leadId);
  const task = (model, id) => planTasks(model).find((row) => row.id === `${leadId}:${id}`);
  const edge = (model, from, to) =>
    model.edges.find((row) => row.from === `${leadId}:${from}` && row.to === `${leadId}:${to}`);
  const leadMilestone = (model) => model.milestones.find((row) => row.owner_session_id === leadId);
  const milestoneRow = (board) =>
    board.milestones.find((row) => row.owner_session_id === leadId && row.key === 'M');
  const trackerTurns = (board) =>
    turnsOf(board, leadId).filter((turn) => turn.origin === 'tracker');
  const projectRow = (board) => board.projects.find((row) => row.id === projectId);
  /** Waits until the event cursor has not moved for QUIET_TICKS daemon ticks. */
  const quiet = (description) => {
    let cursor = -1,
      movedAt = 0;
    return waitFor(
      async () => {
        const latest = (await events()).at(-1)?.sequence ?? 0;
        if (latest !== cursor) {
          cursor = latest;
          movedAt = Date.now();
          return false;
        }
        return Date.now() - movedAt >= QUIET_TICKS * options.intervalMs;
      },
      description,
      WAIT_MS,
    );
  };
  /** What a restart must not change, recorded under the moment's name. */
  const steady = async (moment, sessionId) => {
    const board = await snapshot(),
      all = await events();
    // Left out: the clock, and the waits that are still open and run up to it.
    const {
      now,
      counts: { wait_by_reason_ms, ...counts },
      ...rest
    } = await view(moment);
    const model = { ...rest, counts };
    const count = (kind) => all.filter((event) => event.kind === kind).length;
    return {
      model,
      milestones: board.milestones.filter((row) => row.project_id === projectId),
      merge: board.sessions.find((row) => row.id === sessionId)?.merge ?? null,
      head: (await head(moment)).sha,
      counts: {
        merged: count('session.merged'),
        gate_checked: count('session.gate_checked'),
        tracker: board.session_turns.filter((turn) => turn.origin === 'tracker').length,
      },
    };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  try {
    // Open the project with a passing gate.
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Workbench Loop');
    git(repo, 'config', 'user.email', 'workbench-loop@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Workbench loop\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', { name: 'Workbench loop', roots: [repo] });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );
    await head('opened');

    // The lead writes the plan through its update_board tool.
    const lead = await call('plan', 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      input: script({ tool: { name: 'update_board', arguments: plan } }),
    });
    leadId = lead.id;
    await idle(leadId, 'the lead to write the plan');
    const planned = await view('planned');
    const leadDiff = await get('session.diff', { session_id: leadId });
    observations.plan = {
      tasks: planTasks(planned).map((row) => row.id.slice(leadId.length + 1)),
      edges: planned.edges
        .filter((row) => row.from.startsWith(`${leadId}:`))
        .map((row) => `${row.from.slice(leadId.length + 1)}->${row.to.slice(leadId.length + 1)}`),
      milestone_status: leadMilestone(planned)?.status ?? null,
      lead_committed: leadDiff.head_sha !== leadDiff.base_sha,
    };

    // A session from task A commits its work and reports it done.
    const sessionA = await call('report', 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      task_id: `${leadId}:A`,
      input: script(
        { write: { path: 'a.txt', text: 'Task A\n' } },
        { commit: 'Add a.txt for task A' },
        { tool: { name: 'report', arguments: { kind: 'done', text: REPORT_A } } },
      ),
    });
    const reportedA = await idle(sessionA.id, 'the session of task A to report');
    const reported = await view('reported');
    observations.report = {
      task_done: task(reported, 'A')?.status === 'done',
      edge_met: edge(reported, 'A', 'B')?.state === 'met',
      reported_event: (await events()).some(
        (event) => event.kind === 'task.reported' && event.payload.session_id === sessionA.id,
      ),
      lead_tracker_turns: turnsOf(reportedA.board, leadId).filter(
        (turn) => turn.origin === 'tracker',
      ).length,
    };

    // The user merges A; the lead hears of the report and the merge in one tracker turn.
    const diffA = await get('session.diff', { session_id: sessionA.id });
    const headBefore = await head('before_manual_merge');
    await call(
      'manual_merge',
      'session.merge',
      { session_id: sessionA.id },
      reportedA.session.revision,
    );
    await outcome(sessionA.id, 'merged', 'the session of task A to merge');
    const wokenA = await leadSettled(1, 'the lead tracker turn after the merge of A');
    const mergedHead = await head('after_manual_merge');
    const merged = await view('manual_merge');
    await sessionGates('task_a', sessionA.id);
    const trackerA = wokenA.tracker[0];
    observations.manual_merge = {
      merged: (await events()).some(
        (event) => event.kind === 'session.merged' && event.aggregate_id === sessionA.id,
      ),
      head_at_session_commit:
        mergedHead.sha === diffA.head_sha && mergedHead.sha !== headBefore.sha,
      task_done: task(merged, 'A')?.status === 'done',
      edge_met: edge(merged, 'A', 'B')?.state === 'met',
      lead_tracker_turns: wokenA.tracker.length,
      lead_woken_with_notes:
        trackerA.input.includes(`done: ${REPORT_A}`) && trackerA.input.includes(MERGED_NOTE),
    };

    // Accepting M before B merges is refused.
    const early = await send(
      'early_accept',
      'milestone.accept',
      { milestone_id: milestoneRow(wokenA.board).id, evidence_refs: [`session:${sessionA.id}`] },
      milestoneRow(wokenA.board).revision,
    );

    // B1 is discarded; B2 commits and merges automatically.
    const sessionB1 = await call('auto_merge', 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      task_id: `${leadId}:B`,
      input: script({ say: 'Starting task B' }),
    });
    const idleB1 = await idle(sessionB1.id, 'the first session of task B to start');
    await call(
      'auto_merge',
      'session.discard',
      { session_id: sessionB1.id },
      idleB1.session.revision,
    );
    const discardedB1 = await outcome(sessionB1.id, 'discarded', 'the first session of B to go');
    const current = discardedB1.board.projects.find((row) => row.id === projectId);
    await call(
      'auto_merge',
      'project.autoMerge.set',
      { project_id: projectId, enabled: true },
      current.revision,
    );
    const sessionB2 = await call('auto_merge', 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      task_id: `${leadId}:B`,
      input: script(
        { write: { path: 'b.txt', text: 'Task B\n' } },
        { commit: 'Add b.txt for task B' },
      ),
    });
    await outcome(sessionB2.id, 'merged', 'the second session of task B to merge');
    const wokenB = await leadSettled(2, 'the lead tracker turn after the merge of B');
    await head('after_auto_merge');
    const autoMerged = await view('auto_merge');
    await sessionGates('task_b', sessionB2.id);
    const autoEvents = await events();
    const trackerB = wokenB.tracker.find((turn) => turn.id !== trackerA.id);
    observations.auto_merge = {
      merge_started: autoEvents
        .filter(
          (event) => event.kind === 'session.merge_started' && event.aggregate_id === sessionB2.id,
        )
        .map((event) => event.payload),
      merged: autoEvents.some(
        (event) => event.kind === 'session.merged' && event.aggregate_id === sessionB2.id,
      ),
      task_done: task(autoMerged, 'B')?.status === 'done',
      lead_woken: Boolean(trackerB?.input.includes(MERGED_NOTE)),
    };

    // The user accepts M once, with the current revision and evidence.
    const ready = milestoneRow(wokenB.board);
    const stale = await send(
      'accept',
      'milestone.accept',
      {
        milestone_id: ready.id,
        evidence_refs: [`session:${sessionA.id}`, `session:${sessionB2.id}`],
      },
      ready.revision - 1,
    );
    const empty = await send(
      'accept',
      'milestone.accept',
      { milestone_id: ready.id, evidence_refs: [] },
      ready.revision,
    );
    const accepted = await call(
      'accept',
      'milestone.accept',
      {
        milestone_id: ready.id,
        evidence_refs: [`session:${sessionA.id}`, `session:${sessionB2.id}`],
      },
      ready.revision,
    );
    const completed = await view('accepted');
    const again = await send(
      'accept',
      'milestone.accept',
      {
        milestone_id: ready.id,
        evidence_refs: [`session:${sessionA.id}`, `session:${sessionB2.id}`],
      },
      accepted.revision,
    );
    const acceptedRow = milestoneRow(await snapshot());
    observations.milestone = {
      ready: leadMilestone(autoMerged)?.status ?? null,
      early_accept_rejected: early.data.error ?? null,
      stale_revision_rejected: stale.data.error ?? null,
      empty_evidence_rejected: empty.data.error ?? null,
      after_accept: leadMilestone(completed)?.status ?? null,
      evidence_recorded:
        JSON.stringify(acceptedRow?.acceptance?.evidence_refs) ===
        JSON.stringify([`session:${sessionA.id}`, `session:${sessionB2.id}`]),
      second_accept_rejected: again.data.error ?? null,
    };

    // Told by the user, the lead sends the whole plan again with a task C outside M.
    const toldLead = await leadSettled(trackerTurns(wokenB.board).length, 'the lead to be open');
    await call(
      'retell',
      'session.send',
      {
        session_id: leadId,
        input: script({ tool: { name: 'update_board', arguments: retoldPlan } }),
      },
      toldLead.lead.revision,
    );
    await idle(leadId, 'the lead to send the plan again');
    const retold = await view('retold');
    observations.retell = {
      task_added: Boolean(task(retold, 'C')),
      milestone_status: leadMilestone(retold)?.status ?? null,
      acceptance_kept: same(milestoneRow(await snapshot())?.acceptance, acceptedRow?.acceptance),
    };

    // The first turn of a session from task C fails.
    const trackedBeforeC = trackerTurns(await snapshot()).length;
    const sessionC = await call('turn_failure', 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      task_id: `${leadId}:C`,
      input: script({ fail: FAIL_REASON }),
    });
    await settled(sessionC.id, 1, 'the first turn of the session of task C to end');
    const wokenC = await leadSettled(
      trackedBeforeC + 1,
      'the lead tracker turn after the failed turn of C',
    );
    const failedC = wokenC.board.sessions.find((row) => row.id === sessionC.id);
    observations.turn_failure = {
      session_open: failedC?.state === 'open',
      merged: (await events()).some(
        (event) =>
          ['session.merge_started', 'session.merged'].includes(event.kind) &&
          event.aggregate_id === sessionC.id,
      ),
      lead_notified: wokenC.tracker.some((turn) => turn.input.includes(FAILED_NOTE)),
    };

    // With auto_merge off and a failing gate, the user's merge of C is blocked.
    await call(
      'gate_failure',
      'project.autoMerge.set',
      { project_id: projectId, enabled: false },
      projectRow(wokenC.board).revision,
    );
    await call(
      'gate_failure',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: failingGate },
      projectRow(await snapshot()).revision,
    );
    await call(
      'gate_failure',
      'session.send',
      {
        session_id: sessionC.id,
        input: script(
          { write: { path: 'c.txt', text: 'Task C\n' } },
          { commit: 'Add c.txt for task C' },
        ),
      },
      failedC.revision,
    );
    const committedC = await settled(sessionC.id, 2, 'the second turn of task C to end');
    if (committedC.turns.at(-1).state !== 'completed')
      throw new Error(`the second turn of task C ended ${committedC.turns.at(-1).state}`);
    const headBeforeBlock = await head('before_blocked_merge');
    await call(
      'gate_failure',
      'session.merge',
      { session_id: sessionC.id },
      committedC.session.revision,
    );
    const blockedC = await waitFor(
      async () => {
        const session = (await snapshot()).sessions.find((row) => row.id === sessionC.id);
        return session?.merge?.state === 'blocked' ? session : false;
      },
      'the merge of task C to be blocked',
      WAIT_MS,
    );
    const wokenBlocked = await leadSettled(
      trackerTurns(wokenC.board).length + 1,
      'the lead tracker turn after the blocked merge of C',
    );
    const headAfterBlock = await head('after_blocked_merge');
    await sessionGates('task_c', sessionC.id);
    observations.gate_failure = {
      merge_state: blockedC.merge.state,
      reason: blockedC.merge.reason ?? null,
      head_unchanged: headAfterBlock.sha === headBeforeBlock.sha,
      lead_notified: wokenBlocked.tracker.some((turn) => turn.input.includes(BLOCKED_NOTE)),
    };

    // A restart on the same directory and options keeps the settled state and merges nothing again.
    await quiet('the daemon to settle before the restart');
    const before = await steady('before_restart', sessionC.id);
    await fixture.close();
    fixture = await startFixtureDaemon(
      path.join(workspace, 'daemon'),
      [new FixtureAdapter()],
      options,
    );
    ({ daemon } = fixture);
    const restarted = await steady('after_restart', sessionC.id);
    await quiet('the daemon to settle after the restart');
    const later = await steady('after_restart_ticks', sessionC.id);
    observations.restart = {
      board_unchanged: same(restarted.model, before.model) && same(later.model, before.model),
      milestones_unchanged:
        same(restarted.milestones, before.milestones) && same(later.milestones, before.milestones),
      blocked_kept: restarted.merge?.state === 'blocked' && same(restarted.merge, before.merge),
      head_stable: restarted.head === before.head && later.head === before.head,
      counts_stable: same(restarted.counts, before.counts) && same(later.counts, before.counts),
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await fixture.close();
  }
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: [`${adapter.name}@${adapter.report.version}`],
  };

  async function collectEvidence() {
    if (!projectId) return { 'receipts.json': receipts };
    const board = await snapshot(),
      all = await events();
    const started = all.filter(
      (event) => event.kind === 'agent.tool.started' && MCP_TOOLS.has(event.payload.name),
    );
    const mcp = started.map((event) => ({
      session_id: event.aggregate_id,
      name: event.payload.name,
      input: event.payload.input,
      result:
        all.find(
          (other) =>
            other.kind === 'agent.tool.completed' &&
            other.payload.tool_call_id === event.payload.tool_call_id,
        )?.payload ?? null,
    }));
    await view('final');
    await head('final');
    return {
      'receipts.json': receipts,
      'events.json': all,
      'board.json': { sessions: board.sessions, session_turns: board.session_turns },
      'board-views.json': views,
      'project-heads.json': heads,
      'session-gates.json': gates,
      'mcp-results.json': mcp,
    };
  }
}
