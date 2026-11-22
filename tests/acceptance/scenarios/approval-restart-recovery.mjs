import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
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
const CRASH_TIMEOUT_MS = 20000;
const HOUR_MS = 3600000;
const lostChild = fileURLToPath(
  new URL('../fixtures/daemon-lost-at-approval.mjs', import.meta.url),
);

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
/** What approval.respond answers for a request that is no longer pending. */
const NOT_PENDING = 'approval_not_pending';
const ask = (text) => script({ ask: { tool: 'Bash', input: { command: `echo ${text}` } } });

export async function run({ workspace, evidenceDir }) {
  const dataDir = path.join(workspace, 'daemon');
  const managed = createWorkspaceRoot('approval-restart-recovery');
  const options = { intervalMs: INTERVAL_MS, workspaceRoot: managed.root };
  let fixture, daemon;
  const receipts = [],
    restarts = [],
    approvalsSeen = {},
    timersSeen = {},
    ids = {},
    observations = {};
  let projectId, failure, evidence;

  let clock;
  const start = async (reason) => {
    fixture = await startFixtureDaemon(dataDir, [new FixtureAdapter()], {
      ...options,
      now: clock?.now,
    });
    daemon = fixture.daemon;
    restarts.push({ reason, at: new Date().toISOString() });
  };
  const stop = async () => {
    await fixture?.close();
    fixture = undefined;
  };
  const restart = async (reason) => {
    await stop();
    await start(reason);
  };
  /** Runs the commands on a daemon process that is killed while an approval is pending. */
  const loseDaemon = async (step, body) => {
    await stop();
    const marker = randomUUID();
    const child = spawn(
      process.execPath,
      [
        lostChild,
        JSON.stringify({
          directory: dataDir,
          workspaceRoot: managed.root,
          commands: [body],
          timeoutMs: CRASH_TIMEOUT_MS,
        }),
        `--lost-daemon-marker=${marker}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    // 'close' comes once the pipes are drained, so all the child wrote has been read.
    const [code, signal] = await once(child, 'close');
    const lost = { step, pid: child.pid, marker, code, signal, stdout, stderr };
    restarts.push({ reason: `daemon process lost: ${step}`, ...lost });
    if (signal !== 'SIGKILL' || !stdout.endsWith('\n'))
      throw new Error(`The daemon was not lost after a full line: ${JSON.stringify(lost)}`);
    return JSON.parse(stdout.slice(0, -1).split('\n').at(-1));
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

    // A session waits for the user's approval of a tool call when its daemon process is lost.
    const create = command(
      USER_PRINCIPAL_ID,
      'session.create',
      {
        project_id: projectId,
        runtime: 'fixture',
        input: ask('before restart'),
      },
      null,
    );
    approvalsSeen.before_restart = await loseDaemon('ask', create);
    ids.voided_approval = approvalsSeen.before_restart.id;

    // The next daemon recovers the lost request; it stays in "needs you".
    await start('start after the lost daemon');
    // The resend answers with the receipt the lost daemon committed.
    const created = await submitBody('ask', create);
    ids.asking = created.data.receipt?.id;
    if (!ids.asking || approvalsSeen.before_restart.session_id !== ids.asking)
      throw new Error(`The asking session was not recovered: ${JSON.stringify(created)}`);
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
    // The lost process cannot confirm its own end, so that session waits on the user; another asks.
    approvalsSeen.lost_session = sessionRow(await snapshot(), ids.asking) ?? null;
    ids.live_session = (
      await call('ask again', 'session.create', {
        project_id: projectId,
        runtime: 'fixture',
        input: ask('after restart'),
      })
    ).id;
    const live = await pendingRequest(ids.live_session);
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
      ids.live_session,
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
      answers[2].status === 400 &&
      answers[2].data.error === NOT_PENDING &&
      liveRow?.state === 'approved' &&
      eventsOf('approval.approved', (event) => event.aggregate_id === ids.live_approval).length ===
        1 &&
      eventsOf(
        'agent.permission.resolved',
        (event) => event.payload.request_id === liveRow?.request_id,
      ).length === 1 &&
      eventsOf(
        'agent.permission.resolved',
        (event) =>
          event.payload.request_id === liveRow?.request_id && event.payload.decision === 'allow',
      ).length === 1 &&
      answersFor(ids.live_approval).length === 1;
    observations.approvals.invalid_request_reused =
      voidedAnswer.status !== 400 ||
      voidedAnswer.data.error !== NOT_PENDING ||
      approvalRow(ids.voided_approval)?.state !== 'void' ||
      liveAfterVoidedAnswer?.state !== 'pending' ||
      ids.live_approval === ids.voided_approval ||
      // A void request may still be denied to the runtime; it must never be allowed.
      answersFor(ids.voided_approval).some((job) => job.payload.decision !== 'deny') ||
      later.some(
        (event) => event.kind.startsWith('approval.') && event.aggregate_id === ids.voided_approval,
      );

    // A session stops at a usage limit that resets in an hour; a virtual clock crosses the reset.
    clock = createVirtualClock(Date.now());
    await restart('restart on the virtual clock');
    const resetsAt = clock.now() + HOUR_MS;
    ids.limited = (
      await call('limit', 'session.create', {
        project_id: projectId,
        runtime: 'fixture',
        input: script({
          fail: { message: 'Usage limit reached', error_code: 'usage_limit', resets_at: resetsAt },
        }),
      })
    ).id;
    const limitItem = await waitFor(
      async () =>
        (await needsYou()).items.find(
          (item) => item.source?.id === ids.limited && item.reason === 'usage_limit_reached',
        ) ?? false,
      'the usage limit in "needs you"',
      WAIT_MS,
    );
    // Nothing else in this project schedules a timer, so every timer belongs to the limit.
    const timersOf = () =>
      daemon.store.list('timers').filter((timer) => timer.project_id === projectId);
    timersSeen.before_reset = timersOf();
    // Just short of the reset, then across it with a restart in between.
    clock.advance(HOUR_MS - 60000);
    await sleepTicks(IDLE_TICKS);
    timersSeen.before_due = timersOf();
    await restart('restart just before the reset time');
    clock.advance(2 * 60000);
    await sleepTicks(IDLE_TICKS);
    timersSeen.after_reset = timersOf();
    const fired = (await events()).filter((event) => event.kind === 'timer.fired');
    timersSeen.fired = fired;
    const pending = (rows) => rows.length > 0 && rows.every((timer) => timer.state === 'pending');
    const lost = timersSeen.before_reset.filter(
      (timer) => !timersSeen.after_reset.some((row) => row.id === timer.id),
    );
    const counts = {
      limit_resets_at: limitItem.resets_at ?? null,
      timers_before_reset: timersSeen.before_reset.length,
      timers_after_reset: timersSeen.after_reset.length,
      timer_fired_events: fired.length,
    };
    observations.timers = {
      fired_once_logically:
        !timersSeen.before_reset.length && !timersSeen.after_reset.length && !fired.length
          ? {
              supported: false,
              reason: 'No timer is scheduled for the usage limit reset of a plain session',
              ...counts,
            }
          : lost.length
            ? { lost: lost.map((timer) => timer.id), ...counts }
            : pending(timersSeen.before_reset) &&
              pending(timersSeen.before_due) &&
              fired.length === 1 &&
              fired[0].payload.fired_at >= resetsAt &&
              timersSeen.after_reset.every((timer) => timer.state !== 'pending'),
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
    const all = await events();
    return {
      'approval-ledger.json': {
        ids,
        approvals: daemon.store
          .list('approvals')
          .filter((row) => [ids.asking, ids.live_session].includes(row.session_id)),
        seen: approvalsSeen,
        commands: receipts.filter((receipt) => receipt.type === 'approval.respond'),
        events: all.filter(
          (event) =>
            event.kind.startsWith('approval.') || event.kind.startsWith('agent.permission.'),
        ),
        observations,
      },
      'timer-ledger.json': {
        restarts,
        clock_now: clock?.now() ?? null,
        limited_session: ids.limited ?? null,
        seen: timersSeen,
        timers: daemon.store.list('timers'),
        timer_events: all.filter((event) => event.kind.startsWith('timer.')),
      },
      'observations.json': observations,
    };
  }
}
