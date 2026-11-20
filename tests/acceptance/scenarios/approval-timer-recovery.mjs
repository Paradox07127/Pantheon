import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { createVirtualClock } from '../lib/clock.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '持久等待与审批恢复';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 30000;
const INTERVAL_MS = 50;
/** Daemon ticks to run while nothing should change. */
const IDLE_TICKS = 20;
const MINUTE = 60_000;
/** When the usage limit resets, after the scenario's virtual start, in ms. */
const RESET_AFTER_MS = 2 * 60 * MINUTE;
const RESUME_PREFIX = '[Pantheon] Your last turn stopped because the usage limit was used up.';
const plan = {
  base_version: 0,
  headline: 'Durable waits',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'U',
      title: 'Task U',
      goal: 'Add u.txt',
      lane: 'main',
      depends_on: [],
      source: ['Add u.txt'],
      scope: ['u.txt'],
      acceptance: ['test -f u.txt'],
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const ask = (text) => script({ ask: { tool: 'Bash', input: { command: `echo ${text}` } } });

export async function run({ workspace, evidenceDir }) {
  const dataDir = path.join(workspace, 'daemon');
  const managed = createWorkspaceRoot('approval-timer-recovery');
  const clock = createVirtualClock(Date.now());
  const startedAt = clock.now();
  const resetsAt = startedAt + RESET_AFTER_MS;
  const options = { intervalMs: INTERVAL_MS, workspaceRoot: managed.root, now: clock.now };
  let fixture, daemon;
  const receipts = [],
    restarts = [],
    clockLog = [],
    approvalsSeen = {},
    ids = {},
    observations = {};
  let projectId, failure, evidence;

  const start = async (reason) => {
    fixture = await startFixtureDaemon(dataDir, [new FixtureAdapter()], options);
    daemon = fixture.daemon;
    restarts.push({ reason, virtual_now: clock.now(), at: new Date().toISOString() });
  };
  const stop = async () => {
    await fixture?.close();
    fixture = undefined;
  };
  const restart = async (reason) => {
    await stop();
    await start(reason);
  };
  const advance = (ms, reason) => {
    clock.advance(ms);
    clockLog.push({ reason, advanced_ms: ms, virtual_now: clock.now() });
  };
  const submitBody = async (step, body) => {
    const result = await fixture.submit(body);
    receipts.push({
      step,
      type: body.type,
      command_id: body.command_id,
      input: body.input,
      ...result,
    });
    return result;
  };
  const submit = (step, type, input, revision = null) =>
    submitBody(step, command(USER_PRINCIPAL_ID, type, input, revision));
  const call = async (step, type, input, revision = null) => {
    const result = await submit(step, type, input, revision);
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
  const needsYou = () => get('needs_you.list', { project_id: projectId });
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
  const sessionRow = (board, id) => board.sessions.find((row) => row.id === id);
  const turnsOf = (board, id) => board.session_turns.filter((turn) => turn.session_id === id);
  const settled = (id, check, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const turns = turnsOf(board, id);
        return sessionRow(board, id)?.state === 'open' &&
          turns.length &&
          turns.every(ended) &&
          check(turns)
          ? board
          : false;
      },
      description,
      WAIT_MS,
    );
  /** The approval item of the session's pending permission request, once "needs you" shows one. */
  const pendingRequest = (sessionId, except = []) =>
    waitFor(
      async () =>
        (await needsYou()).items.find(
          (item) =>
            item.source?.table === 'approvals' &&
            item.session_id === sessionId &&
            item.status === 'pending' &&
            !except.includes(item.source.id),
        ) ?? false,
      'a pending permission request',
      WAIT_MS,
    );
  /** Read-only probes of the rows behind the commands. */
  const approvalRow = (id) => daemon.store.get('approvals', id);
  const resumeTimers = () =>
    daemon.store
      .list('timers')
      .filter((timer) => timer.kind === 'usage-limit-resume' && timer.subject_id === ids.usage);
  const answersFor = (approvalId) =>
    daemon.store.db
      .prepare(
        "SELECT id, state, payload FROM outbox WHERE kind='permission.answer' AND json_extract(payload,'$.approval_id')=?",
      )
      .all(approvalId)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  const sleepTicks = (ticks) => new Promise((resolve) => setTimeout(resolve, ticks * INTERVAL_MS));

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Durable Waits');
    git(repo, 'config', 'user.email', 'durable-waits@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Durable waits\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    await start('first start');
    projectId = (await call('open', 'project.open', { name: 'Durable waits', roots: [repo] })).id;
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: 'fixture',
        purpose: 'lead',
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await settled(ids.lead, () => true, 'the lead to write the plan');

    // A session waits for the user's approval of a tool call.
    ids.asking = (
      await call('ask', 'session.create', {
        project_id: projectId,
        runtime: 'fixture',
        input: ask('before restart'),
      })
    ).id;
    const voided = await pendingRequest(ids.asking);
    ids.voided_approval = voided.source.id;
    approvalsSeen.before_restart = approvalRow(ids.voided_approval);

    // A daemon-driven task session fails on a used-up usage limit that resets in two hours.
    ids.usage = (
      await call('usage limit', 'session.create', {
        project_id: projectId,
        runtime: 'fixture',
        task_id: `${ids.lead}:U`,
        input: script({
          fail: { message: 'Usage limit reached', error_code: 'usage_limit', resets_at: resetsAt },
        }),
      })
    ).id;
    await settled(
      ids.usage,
      (turns) => turns[0].state === 'failed',
      'the task session to fail on its usage limit',
    );
    const [timer] = resumeTimers();
    if (!timer) throw new Error('No usage-limit resume timer was scheduled');
    ids.timer = timer.id;

    // After a restart the lost request stays in "needs you".
    await restart('restart with a pending approval and a pending timer');
    const afterRestart = await needsYou();
    const voidedItem =
      afterRestart.items.find((item) => item.source?.id === ids.voided_approval) ?? null;
    approvalsSeen.after_restart = approvalRow(ids.voided_approval);
    approvalsSeen.needs_you_after_restart = afterRestart.items;
    observations.approvals = {
      voided_kept_in_needs_you:
        voidedItem?.reason === 'permission_voided' &&
        voidedItem.status === 'void' &&
        approvalsSeen.after_restart?.state === 'void',
    };

    // The session asks again; the void request is answered, then the live one twice over.
    const asking = await settled(ids.asking, () => true, 'the asking session to take input');
    await call(
      'ask again',
      'session.send',
      { session_id: ids.asking, input: ask('after restart') },
      sessionRow(asking, ids.asking).revision,
    );
    const live = await pendingRequest(ids.asking, [ids.voided_approval]);
    ids.live_approval = live.source.id;
    const voidedBefore = approvalRow(ids.voided_approval);
    const cursor = (await events()).at(-1)?.sequence ?? 0;
    // Each answer names the revision "needs you" showed for its request.
    const voidedAnswer = await submit(
      'answer the void request',
      'approval.respond',
      { approval_id: ids.voided_approval, decision: 'approve' },
      voidedItem?.source.revision ?? voidedBefore.revision,
    );
    const liveAfterVoidedAnswer = approvalRow(ids.live_approval);
    const first = command(
      USER_PRINCIPAL_ID,
      'approval.respond',
      { approval_id: ids.live_approval, decision: 'approve' },
      live.source.revision,
    );
    const answers = [
      await submitBody('answer the live request', first),
      await submitBody('deliver the same answer again', first),
      await submit(
        'answer the live request again',
        'approval.respond',
        { approval_id: ids.live_approval, decision: 'approve' },
        live.source.revision,
      ),
    ];
    await settled(
      ids.asking,
      (turns) => turns.at(-1).state === 'completed',
      'the asked turn to end',
    );
    await sleepTicks(IDLE_TICKS);
    const afterAnswers = await events();
    const liveRow = approvalRow(ids.live_approval);
    const later = afterAnswers.filter((event) => event.sequence > cursor);
    const eventsOf = (kind, check) => later.filter((event) => event.kind === kind && check(event));
    approvalsSeen.answers = {
      voided_before: voidedBefore,
      voided_answer: { status: voidedAnswer.status, data: voidedAnswer.data },
      voided_after: approvalRow(ids.voided_approval),
      live_after_voided_answer: liveAfterVoidedAnswer,
      live_answers: answers.map(({ status, data }) => ({ status, data })),
      live_after: liveRow,
      live_answer_jobs: answersFor(ids.live_approval),
      voided_answer_jobs: answersFor(ids.voided_approval),
      approval_events: later.filter((event) => event.kind.startsWith('approval.')),
      permission_resolutions: later.filter((event) => event.kind === 'agent.permission.resolved'),
    };
    observations.approvals.duplicate_response_idempotent =
      answers[0].status === 200 &&
      answers[1].status === 200 &&
      JSON.stringify(answers[1].data.receipt) === JSON.stringify(answers[0].data.receipt) &&
      answers[2].status !== 200 &&
      liveRow?.state === 'approved' &&
      eventsOf('approval.approved', (event) => event.aggregate_id === ids.live_approval).length ===
        1 &&
      eventsOf(
        'agent.permission.resolved',
        (event) => event.payload.request_id === liveRow?.request_id,
      ).length === 1 &&
      answersFor(ids.live_approval).length === 1;
    observations.approvals.invalid_request_reused =
      voidedAnswer.status === 200 ||
      approvalRow(ids.voided_approval)?.state !== 'void' ||
      liveAfterVoidedAnswer?.state !== 'pending' ||
      ids.live_approval === ids.voided_approval ||
      // A void request may still be denied to the runtime; it must never be allowed.
      answersFor(ids.voided_approval).some((job) => job.payload.decision !== 'deny') ||
      later.some(
        (event) => event.kind.startsWith('approval.') && event.aggregate_id === ids.voided_approval,
      );

    // The virtual clock passes the reset; the daemon restarts before the resume is due and once after it ran.
    const dueAt = resumeTimers().find((row) => row.id === ids.timer)?.due_at;
    advance(resetsAt + 30_000 - clock.now(), 'past the reset, before the resume is due');
    await sleepTicks(IDLE_TICKS);
    const beforeDue = resumeTimers().find((row) => row.id === ids.timer)?.state;
    await stop();
    advance(MINUTE, 'past the resume due time while the daemon is down');
    await start('restart after the resume fell due');
    await waitFor(
      () => resumeTimers().find((row) => row.id === ids.timer)?.state === 'fired',
      'the usage-limit resume to fire',
      WAIT_MS,
    );
    await settled(
      ids.usage,
      (turns) => turns.some((turn) => turn.origin === 'continuation'),
      'the resumed turn to end',
    );
    await restart('restart after the resume ran');
    await sleepTicks(IDLE_TICKS);
    advance(60 * MINUTE, 'an hour later');
    await sleepTicks(IDLE_TICKS);
    const all = await events();
    const board = await snapshot();
    const fired = all.filter(
      (event) => event.kind === 'timer.fired' && event.aggregate_id === ids.timer,
    );
    const resumed = turnsOf(board, ids.usage).filter(
      (turn) => turn.origin === 'continuation' && turn.input.startsWith(RESUME_PREFIX),
    );
    const timerRow = resumeTimers().find((row) => row.id === ids.timer);
    observations.timers = {
      fired_once_logically:
        beforeDue === 'pending' &&
        fired.length === 1 &&
        resumed.length === 1 &&
        timerRow?.state === 'fired' &&
        timerRow.fired_at >= dueAt,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (!fixture && projectId) await start('evidence collection');
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await stop();
    managed.remove();
  }
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return { observations, evidence, adapters: ['fixture@1'] };

  async function collectEvidence() {
    if (!projectId) return { 'approval-ledger.json': { commands: receipts } };
    const board = await snapshot(),
      all = await events();
    return {
      'approval-ledger.json': {
        ids,
        approvals: daemon.store.list('approvals').filter((row) => row.session_id === ids.asking),
        seen: approvalsSeen,
        commands: receipts.filter((receipt) => receipt.type === 'approval.respond'),
        events: all.filter(
          (event) =>
            event.kind.startsWith('approval.') || event.kind.startsWith('agent.permission.'),
        ),
        observations,
      },
      'timer-ledger.json': {
        ids,
        virtual_start: startedAt,
        resets_at: resetsAt,
        clock: clockLog,
        restarts,
        timers: daemon.store.list('timers'),
        timer_events: all.filter((event) => event.kind.startsWith('timer.')),
        usage_session_turns: turnsOf(board, ids.usage ?? '').map(
          ({ id, origin, state, delivery_reason, input }) => ({
            id,
            origin,
            state,
            delivery_reason,
            input: input.slice(0, 200),
          }),
        ),
        observations,
      },
      'observations.json': observations,
    };
  }
}
