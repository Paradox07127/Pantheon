import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { TraceIndex } from '@pantheon/control';
import type {
  Approval,
  BoardPlan,
  ChangeStory,
  Milestone,
  Principal,
  Project,
  ProjectBoard,
  Retrospective,
  Review,
  ReviewFinding,
  Session,
  SessionTurn,
  StepRun,
  Usage,
  Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, gateFolder, insideSandbox, user } from '../helpers.js';
import { boundTaskSession, git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const DAY = 24 * 60 * 60 * 1000;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A session whose first turn has ended, with the usage and model given. */
async function idleSession(f: Fixture, input: string, usage: Usage, model: string | null) {
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model: model ?? undefined,
    input,
  });
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  const turn = f.turns(session.id)[0]!;
  f.store.update<SessionTurn>('session_turns', { ...turn, usage }, turn.revision);
  return { session, workspace, turn };
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const shift = (f: Fixture, aggregateId: string, ms: number, kind?: string) =>
  f.store.db
    .prepare(
      `UPDATE events SET created_at=created_at-? WHERE aggregate_id=?${kind ? ' AND kind=?' : ''}`,
    )
    .run(ms, aggregateId, ...(kind ? [kind] : []));

const mergedAt = (f: Fixture, sessionId: string) =>
  f.store.db
    .prepare(
      "SELECT created_at, payload FROM events WHERE aggregate_id=? AND kind='session.merged'",
    )
    .get(sessionId) as { created_at: number; payload: string };

it.each([30, 'all'] as const)(
  'fills every local day of the %s range from its start',
  async (days) => {
    const f = await workbenchFixture();
    const now = new Date(2027, 2, 16, 12).getTime(),
      created = new Date(2027, 2, 1, 15).getTime();
    vi.spyOn(f.store, 'now').mockReturnValue(now);
    f.store.db
      .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
      .run(created, f.project.id);
    const board = f.control.boardView(user, f.project.id, days);
    const length = days === 'all' ? 16 : 30,
      first = new Date(2027, 2, 17 - length).getTime();
    expect(board.since).toBe(first);
    const dates = Array.from({ length }, (_, offset) =>
      dayKey(new Date(2027, 2, 17 - length + offset).getTime()),
    );
    expect(board.burnup.map((point) => point.day)).toEqual(dates);
    expect(board.task_progress.daily.map((point) => point.day)).toEqual(dates);
    if (days === 'all') expect(board.counts).not.toHaveProperty('previous');
    expect(board.counts).not.toHaveProperty('cache_read_share');
  },
);

it('moves metrics to a past range while keeping present tasks and dispatch state', async () => {
  const f = await workbenchFixture();
  const rows = [];
  for (const [input_tokens, cached_input_tokens, cost_usd] of [
    [100, 80, 1],
    [200, 20, 2],
    [300, 150, 3],
    [400, 0, 4],
  ] as const)
    rows.push(
      await idleSession(
        f,
        'Measure the range',
        { input_tokens, output_tokens: 10, cached_input_tokens, cost_usd },
        null,
      ),
    );
  const lead = await firstTurnEnded(
    f,
    await leadWithPlan(f, [{ id: 'export', title: 'Build exports', depends_on: [] }]),
  );
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  const leadStarted = new Date(2027, 2, 7, 12).getTime();
  for (const aggregateId of [lead.id, ...f.turns(lead.id).map((turn) => turn.id)])
    f.store.db
      .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
      .run(leadStarted, aggregateId);
  pendingApproval(f, lead.id, { tool: 'Bash' });
  for (const [index, row] of rows.entries()) {
    const at = new Date(2027, 2, [9, 10, 12, 14][index]!, 12).getTime(),
      opened = at - (index + 1) * 1000;
    f.store.db.prepare('UPDATE events SET created_at=? WHERE aggregate_id=?').run(at, row.turn.id);
    f.store.db
      .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
      .run(opened, row.session.id);
    const session = current(f, row.session.id);
    f.store.update<Session>(
      'sessions',
      {
        ...session,
        state: 'closed',
        outcome: 'merged',
        ...(index === 2 ? { task: { lead_session_id: lead.id, id: 'export', generation: 1 } } : {}),
      },
      session.revision,
    );
    f.store.event('session.merged', current(f, row.session.id), f.project.id, {
      to_sha: 'merged-head',
    });
    f.store.db
      .prepare("UPDATE events SET created_at=? WHERE aggregate_id=? AND kind='session.merged'")
      .run(at, row.session.id);
  }
  const present = f.control.boardView(user, f.project.id, 3),
    past = f.control.boardView(user, f.project.id, 3, '2027-03-13');
  expect(past.since).toBe(new Date(2027, 2, 11).getTime());
  expect(past.counts).toMatchObject({
    merged: 1,
    median_ms: 3000,
    tokens: 310,
    cost_usd: 3,
    cache_read_share: 0.5,
  });
  expect(past.counts.previous).toMatchObject({
    merged: 2,
    median_ms: 1500,
    tokens: 320,
    cost_usd: 3,
    cache_read_share: 1 / 3,
  });
  expect(past.merges.map((merge) => merge.session_id)).toEqual([rows[2]!.session.id]);
  expect(past.usage.map((row) => row.day)).toEqual(['2027-03-12']);
  expect(past.task_progress.cycle).toMatchObject({ median_ms: 3000, sample_count: 1 });
  expect(present.task_progress.cycle.sample_count).toBe(0);
  expect(past.burnup).toEqual([
    { day: '2027-03-11', scope: 3, done: 2 },
    { day: '2027-03-12', scope: 4, done: 3 },
    { day: '2027-03-13', scope: 4, done: 3 },
  ]);
  expect(past.task_progress.daily.map((point) => point.day)).toEqual([
    '2027-03-11',
    '2027-03-12',
    '2027-03-13',
  ]);
  expect(past.task_progress.daily.map((point) => point.done)).toEqual([0, 1, 1]);
  expect(present.leads).toHaveLength(1);
  expect(present.lanes).toHaveLength(1);
  expect(present.needs).not.toHaveLength(0);
  for (const key of ['lanes', 'leads', 'slots', 'needs', 'iterations'] as const)
    expect(past[key]).toEqual(present[key]);
  // The past range also keeps the task that merged within it.
  expect(past.tasks.map((task) => task.id)).toContain(`${lead.id}:export`);
  expect(past.tasks.filter((task) => task.id !== `${lead.id}:export`)).toEqual(present.tasks);
});

it('omits cache share without reported cache input and includes reported zero cache reads', async () => {
  const f = await workbenchFixture();
  const { turn } = await idleSession(
    f,
    'Measure cache input',
    { input_tokens: 100, output_tokens: 20 },
    null,
  );
  await idleSession(
    f,
    'Measure input without cache reports',
    { input_tokens: 900, output_tokens: 0 },
    null,
  );
  const counts = () => f.control.boardView(user, f.project.id, 1).counts;
  expect(counts()).not.toHaveProperty('cache_read_share');
  for (const cached_input_tokens of [80, 0]) {
    const stored = f.store.must<SessionTurn>('session_turns', turn.id);
    f.store.update<SessionTurn>(
      'session_turns',
      { ...stored, usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens } },
      stored.revision,
    );
    expect(counts().cache_read_share).toBe(cached_input_tokens / 100);
  }
  expect(counts().previous).not.toHaveProperty('cache_read_share');
  const stored = f.store.must<SessionTurn>('session_turns', turn.id);
  f.store.update<SessionTurn>(
    'session_turns',
    { ...stored, usage: { input_tokens: 0, output_tokens: 20, cached_input_tokens: 0 } },
    stored.revision,
  );
  expect(counts()).not.toHaveProperty('cache_read_share');
});

it('counts first gate passes of the tasks whose newest retrospective is in each range', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.store, 'now').mockReturnValue(new Date(2027, 2, 16, 12).getTime());
  const record = (task_id: string, day: number, gate_passed_on_attempt?: number) =>
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${task_id}-${day}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id,
      session_ids: [],
      outcome: gate_passed_on_attempt ? 'merged' : 'failed',
      recorded_at: new Date(2027, 2, day, 12).getTime(),
      ...(gate_passed_on_attempt ? { gate_passed_on_attempt } : {}),
    });
  record('first', 15, 1);
  record('second', 14, 2);
  record('never', 16);
  record('earlier', 12, 1);
  // An older record of a task that has a newer one counts in neither range.
  record('first', 11, 2);
  const { counts } = f.control.boardView(user, f.project.id, 3);
  expect(counts.gate_first_pass).toEqual({ tasks: 3, passed: 1 });
  expect(counts.previous?.gate_first_pass).toEqual({ tasks: 1, passed: 1 });
  const before = f.control.boardView(user, f.project.id, 1, '2027-03-10').counts;
  expect(before).not.toHaveProperty('gate_first_pass');
  expect(before.previous).not.toHaveProperty('gate_first_pass');
  expect(f.control.boardView(user, f.project.id, 'all').counts.gate_first_pass).toEqual({
    tasks: 4,
    passed: 2,
  });
});

it('counts the sessions that compacted their context within the range', async () => {
  const f = await workbenchFixture();
  const recent = await idleSession(
      f,
      'Compact recently',
      { input_tokens: 1, output_tokens: 1 },
      null,
    ),
    older = await idleSession(f, 'Compact long ago', { input_tokens: 1, output_tokens: 1 }, null);
  vi.spyOn(f.store, 'now').mockReturnValue(new Date(2027, 2, 16, 12).getTime());
  const compacted = (session: Session, day: number) => {
    const event = f.store.event('agent.context.compacted', session, f.project.id, {
      trigger: 'auto',
    });
    f.store.db
      .prepare('UPDATE events SET created_at=? WHERE event_id=?')
      .run(new Date(2027, 2, day, 10).getTime(), event.event_id);
  };
  compacted(recent.session, 16);
  compacted(recent.session, 16);
  compacted(recent.session, 13);
  compacted(older.session, 6);
  const counts = (days: number, until?: string) =>
    f.control.boardView(user, f.project.id, days, until).counts;
  expect(counts(1).compacted_sessions).toBe(1);
  expect(counts(30).compacted_sessions).toBe(2);
  expect(counts(1, '2027-03-13').compacted_sessions).toBe(1);
  expect(counts(1, '2027-03-14')).not.toHaveProperty('compacted_sessions');
});

it('keeps the rows that ended in a past range and leaves them out of the present one', async () => {
  const f = await workbenchFixture();
  const standalone = await idleSession(
      f,
      'Merge in the past week',
      { input_tokens: 1, output_tokens: 1 },
      null,
    ),
    earlier = await idleSession(
      f,
      'Merge before the past week',
      { input_tokens: 1, output_tokens: 1 },
      null,
    ),
    worker = await idleSession(f, 'Build exports', { input_tokens: 1, output_tokens: 1 }, null);
  const lead = await firstTurnEnded(
    f,
    await leadWithPlan(f, [{ id: 'export', title: 'Build exports', depends_on: [] }]),
  );
  vi.spyOn(f.store, 'now').mockReturnValue(new Date(2027, 2, 16, 12).getTime());
  for (const [row, day] of [
    [standalone, 5],
    [earlier, 1],
    [worker, 6],
  ] as const) {
    const session = current(f, row.session.id);
    f.store.update<Session>(
      'sessions',
      {
        ...session,
        state: 'closed',
        outcome: 'merged',
        ...(row === worker
          ? { task: { lead_session_id: lead.id, id: 'export', generation: 1 } }
          : {}),
      },
      session.revision,
    );
    f.store.event('session.merged', current(f, row.session.id), f.project.id, {
      to_sha: 'merged-head',
    });
    f.store.db
      .prepare("UPDATE events SET created_at=? WHERE aggregate_id=? AND kind='session.merged'")
      .run(new Date(2027, 2, day, 12).getTime(), row.session.id);
  }
  f.store.insert<Retrospective>('retrospectives', {
    id: 'retrospective-export',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'export',
    session_ids: [worker.session.id],
    outcome: 'merged',
    recorded_at: new Date(2027, 2, 6, 13).getTime(),
  });
  const ids = (until?: string) =>
    f.control.boardView(user, f.project.id, 7, until).tasks.map((task) => task.id);
  const present = ids(),
    past = f.control.boardView(user, f.project.id, 7, '2027-03-09');
  for (const id of [standalone.session.id, earlier.session.id, `${lead.id}:export`])
    expect(present).not.toContain(id);
  expect(past.tasks.map((task) => task.id)).toContain(standalone.session.id);
  expect(past.tasks.map((task) => task.id)).not.toContain(earlier.session.id);
  expect(past.tasks.find((task) => task.id === `${lead.id}:export`)).toMatchObject({
    status: 'done',
    retrospective: { id: 'retrospective-export', outcome: 'merged' },
  });
  expect(past.counts).toMatchObject({ running: 0, failed: 0, merged: 2 });
});

it('refuses an all-time end day and an end day after today', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.store, 'now').mockReturnValue(new Date(2027, 2, 16, 12).getTime());
  for (const [days, until] of [
    ['all', '2027-03-13'],
    [7, '2027-03-17'],
  ] as const)
    expect(() => f.control.boardView(user, f.project.id, days, until)).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
});

it.each([1, 3, 7, 14, 30])(
  'counts usage in the equally long period before a %i-day range',
  async (days) => {
    const f = await workbenchFixture();
    const sessions = [];
    for (const cost of [undefined, 0, 0.25, 9, 10])
      sessions.push(
        await idleSession(
          f,
          'Measure usage',
          {
            input_tokens: 10,
            output_tokens: 5,
            ...(cost === undefined ? {} : { cost_usd: cost }),
          },
          null,
        ),
      );
    const now = new Date(2026, 10, 4, 12).getTime();
    const since = new Date(2026, 10, 5 - days).getTime();
    const previousSince = new Date(2026, 10, 5 - 2 * days).getTime();
    vi.spyOn(f.store, 'now').mockReturnValue(now);
    const times = [previousSince, previousSince + 1, since - 1, previousSince - 1, since];
    for (const [index, session] of sessions.entries())
      f.store.db
        .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
        .run(times[index]!, session.turn.id);
    const board = f.control.boardView(user, f.project.id, days);
    expect(board.counts.previous).toEqual({
      tokens: 45,
      cost_usd: 0.25,
      merged: 0,
      median_ms: null,
    });
    expect(board.counts).toMatchObject({ tokens: 15, cost_usd: 10 });
    for (const session of sessions.slice(1, 3))
      f.store.db
        .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
        .run(previousSince - 1, session.turn.id);
    expect(f.control.boardView(user, f.project.id, days).counts.previous).toEqual({
      tokens: 15,
      cost_usd: null,
      merged: 0,
      median_ms: null,
    });
    f.store.db
      .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
      .run(previousSince - 1, sessions[0]!.turn.id);
    expect(f.control.boardView(user, f.project.id, days).counts.previous).toEqual({
      tokens: 0,
      cost_usd: null,
      merged: 0,
      median_ms: null,
    });
  },
);

it('computes the board from merged, ready and discarded workbench sessions', async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');

  const mergedInput = `Merge the answer change ${'a'.repeat(240)}`;
  const merged = await idleSession(
    f,
    mergedInput,
    { input_tokens: 100, output_tokens: 50, cost_usd: 0.25 },
    'model-merged',
  );
  const mergedHead = commit(merged.workspace.path, 'answer.txt', 'merged\nsecond\n');
  await f.call<Session>(
    'session.merge',
    { session_id: merged.session.id },
    current(f, merged.session.id).revision,
  );
  await eventually(
    () => f.store.must<Workspace>('workspaces', merged.workspace.id).removed_at !== undefined,
    () => f.control.tick(),
  );

  const discarded = await idleSession(
    f,
    'Try a change that is thrown away',
    { input_tokens: 30, output_tokens: 10 },
    'model-discarded',
  );
  f.call<Session>(
    'session.discard',
    { session_id: discarded.session.id },
    current(f, discarded.session.id).revision,
  );
  await eventually(() => current(f, discarded.session.id).outcome === 'discarded');

  const ready = await idleSession(
    f,
    'Write the notes file',
    { input_tokens: 200, output_tokens: 20 },
    'model-ready',
  );
  commit(ready.workspace.path, 'notes.txt', 'one\ntwo\nthree\n');

  const merge = mergedAt(f, merged.session.id);
  expect(JSON.parse(merge.payload)).toEqual({
    branch: 'main',
    source: f.source,
    from_sha: sourceHead,
    to_sha: mergedHead,
    files: 1,
    additions: 2,
    deletions: 1,
    measured_kind: { domain: 'backend-logic', tier: 't1' },
  });
  await expect(f.control.sessionDiff(user, merged.session.id)).resolves.toMatchObject({
    base_sha: sourceHead,
    head_sha: mergedHead,
    files: [{ path: 'answer.txt', additions: 2, deletions: 1, untracked: false }],
    patch: expect.stringContaining('+merged'),
    truncated: false,
  });

  await f.control.prefetchWorktreeReads(user, f.project.id);
  const today = f.control.boardView(user, f.project.id, 1);
  expect(today.tasks.map((task) => [task.id, task.status])).toEqual([
    [merged.session.id, 'done'],
    [discarded.session.id, 'discarded'],
    [ready.session.id, 'ready'],
  ]);

  // The merged session started and worked yesterday; the discarded one ended long before the range.
  // A calendar day back: 23 or 25 hours across a daylight-saving change.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const back = Date.now() - yesterday.getTime();
  shift(f, merged.session.id, back, 'session.opened');
  shift(f, merged.turn.id, back);
  shift(f, discarded.session.id, 20 * DAY);
  shift(f, discarded.turn.id, 20 * DAY);
  const mergedStart = f.store.eventSpan(merged.session.id)!.first;

  const week = f.control.boardView(user, f.project.id, 7);
  expect(week.since).toBe(
    new Date(new Date().setHours(0, 0, 0, 0)).setDate(new Date().getDate() - 6),
  );
  expect(week.tasks.map((task) => task.id)).toEqual([merged.session.id, ready.session.id]);
  const [doneTask, readyTask] = week.tasks;
  expect(doneTask).toMatchObject({
    title: `${mergedInput.slice(0, 39)}…`,
    goal: mergedInput.slice(0, 200),
    lane_id: null,
    status: 'done',
    blockers: [],
    additions: 2,
    deletions: 1,
    checks: 'none',
    started_at: mergedStart,
    ended_at: merge.created_at,
  });
  expect(doneTask!.segments).toEqual([
    {
      id: merged.session.id,
      session_id: merged.session.id,
      title: `${mergedInput.slice(0, 39)}…`,
      runtime: 'fixture',
      model: 'model-merged',
      status: 'done',
      started_at: mergedStart,
      ended_at: merge.created_at,
      tokens: 150,
      additions: 2,
      deletions: 1,
    },
  ]);
  expect(readyTask).toMatchObject({
    status: 'ready',
    additions: 3,
    deletions: 0,
    ended_at: null,
  });
  expect(week.counts.session_time?.sessions).toBe(1);
  const { session_time, wait_by_reason_ms, ...existingCounts } = week.counts;
  expect(existingCounts).toEqual({
    running: 0,
    waiting: 0,
    ready: 1,
    failed: 0,
    merged: 1,
    reverted: 0,
    median_ms: merge.created_at - mergedStart,
    tokens: 370,
    tokens_by_runtime: { fixture: 370 },
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: 0.25,
  });
  const now = Date.now();
  expect(week.usage).toEqual([
    {
      day: dayKey(yesterday.getTime()),
      runtime: 'fixture',
      model: 'model-merged',
      tokens: 150,
      cost_usd: 0.25,
    },
    { day: dayKey(now), runtime: 'fixture', model: 'model-ready', tokens: 220, cost_usd: null },
  ]);
  expect(week.models.map((model) => model.model)).toEqual([
    'model-discarded',
    'model-merged',
    'model-ready',
  ]);
  expect(week.burnup).toHaveLength(7);
  expect(week.burnup.slice(0, 5).every((point) => point.scope === 0 && point.done === 0)).toBe(
    true,
  );
  expect(week.burnup.slice(5)).toEqual([
    { day: dayKey(yesterday.getTime()), scope: 1, done: 0 },
    { day: dayKey(now), scope: 2, done: 1 },
  ]);
  expect(week.merges).toEqual([
    {
      session_id: merged.session.id,
      title: `${mergedInput.slice(0, 39)}…`,
      merged_at: merge.created_at,
      from_sha: sourceHead,
      sha: mergedHead,
      additions: 2,
      deletions: 1,
      story_id: null,
    },
  ]);
  expect(week).toMatchObject({ headline: null, lanes: [], edges: [], findings: [], risks: [] });

  const day = f.control.boardView(user, f.project.id, 1);
  expect(day.counts).toMatchObject({ merged: 1, tokens: 220, cost_usd: null });
  expect(day.usage).toEqual([
    { day: dayKey(now), runtime: 'fixture', model: 'model-ready', tokens: 220, cost_usd: null },
  ]);
});

it.each(['model-a', null])('keeps usage by turn model after switching from %s', async (model) => {
  const f = await workbenchFixture();
  Object.assign(f.adapter, { setModel: async () => ({ ok: true }) });
  const { session, turn: first } = await idleSession(
    f,
    'Explain the answer file',
    { input_tokens: 100, output_tokens: 50, cost_usd: 0.25 },
    model,
  );
  shift(f, first.id, 1000);
  f.call(
    'session.setModel',
    { session_id: session.id, model: 'model-b' },
    current(f, session.id).revision,
  );
  const second = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Explain the next change' },
    current(f, session.id).revision,
  );
  await eventually(
    () => f.turns(session.id)[1]?.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  const completed = f.store.must<SessionTurn>('session_turns', second.id);
  f.store.update<SessionTurn>(
    'session_turns',
    { ...completed, usage: { input_tokens: 200, output_tokens: 20, cost_usd: 0.5 } },
    completed.revision,
  );
  const firstSeen = f.store.eventSpan(first.id)!.last,
    secondSeen = f.store.eventSpan(second.id)!.last;
  const board = f.control.boardView(user, f.project.id, 7);
  expect(board.usage).toEqual([
    { day: dayKey(firstSeen), runtime: 'fixture', model, tokens: 150, cost_usd: 0.25 },
    { day: dayKey(secondSeen), runtime: 'fixture', model: 'model-b', tokens: 220, cost_usd: 0.5 },
  ]);
  expect(board.models).toEqual([
    { runtime: 'fixture', model, first_seen: firstSeen },
    { runtime: 'fixture', model: 'model-b', first_seen: secondSeen },
  ]);
  expect(board.counts).toMatchObject({ tokens: 370, cost_usd: 0.75 });
  expect(f.turns(session.id)).toMatchObject([{ model }, { model: 'model-b' }]);
});

it('attributes turns recorded without a model to the current session model', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(
    f,
    'Explain the answer file',
    { input_tokens: 100, output_tokens: 50 },
    'model-a',
  );
  const turn = f.turns(session.id)[0]!;
  f.store.update<SessionTurn>('session_turns', { ...turn, model: undefined }, turn.revision);
  expect(f.turns(session.id)[0]).not.toHaveProperty('model');
  f.call(
    'session.setModel',
    { session_id: session.id, model: 'model-b' },
    current(f, session.id).revision,
  );
  const at = f.store.eventSpan(turn.id)!.last;
  const board = f.control.boardView(user, f.project.id, 7);
  expect(board.usage).toEqual([
    { day: dayKey(at), runtime: 'fixture', model: 'model-b', tokens: 150, cost_usd: null },
  ]);
  expect(board.models).toEqual([{ runtime: 'fixture', model: 'model-b', first_seen: at }]);
});

it('links each merge to the newest ready change story of its session', async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const merged = await idleSession(f, 'Merge a change', { input_tokens: 1, output_tokens: 1 }, 'm');
  const mergedHead = commit(merged.workspace.path, 'answer.txt', 'merged\n');
  await f.call<Session>(
    'session.merge',
    { session_id: merged.session.id },
    current(f, merged.session.id).revision,
  );
  await eventually(
    () => current(f, merged.session.id).outcome === 'merged',
    () => f.control.tick(),
  );
  expect(f.control.boardView(user, f.project.id, 1).merges[0]!.story_id).toBeNull();

  const story = (
    id: string,
    sessionId: string,
    state: ChangeStory['state'],
    created_at: number,
  ): ChangeStory => ({
    id,
    revision: 1,
    project_id: f.project.id,
    workbench_session_id: sessionId,
    source: f.source,
    from_sha: sourceHead,
    to_sha: mergedHead,
    state,
    created_at,
  });
  const now = Date.now();
  f.store.insert('change_stories', story('story-old-ready', merged.session.id, 'ready', now - 3));
  f.store.insert('change_stories', story('story-new-ready', merged.session.id, 'ready', now - 2));
  f.store.insert('change_stories', story('story-running', merged.session.id, 'running', now - 1));
  f.store.insert('change_stories', story('story-failed', merged.session.id, 'failed', now));
  f.store.insert('change_stories', story('story-other', 'another-session', 'ready', now + 1));

  expect(f.control.boardView(user, f.project.id, 1).merges).toMatchObject([
    {
      session_id: merged.session.id,
      from_sha: sourceHead,
      sha: mergedHead,
      story_id: 'story-new-ready',
    },
  ]);
});

it('fills milestones from the project facts and risks from the written project board', async () => {
  const f = await workbenchFixture();
  const merged = await f.create('Merge the first half'),
    open = await f.create('Write the second half');
  const ended = current(f, merged.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'merged' },
    ended.revision,
  );
  const milestone = f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship both halves',
    required_sessions: [merged.id, open.id],
    criteria: ['Both halves land'],
  });
  f.store.insert<ProjectBoard>('project_boards', {
    id: f.project.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Second half is open',
    workstreams: [],
    findings: [
      {
        text: 'The second half may slip',
        evidence_refs: [`session:${open.id}`],
        basis: 'inferred',
        severity: 'risk',
      },
      {
        text: 'The first half is merged',
        evidence_refs: [`session:${merged.id}`],
        basis: 'measured',
        severity: 'risk',
      },
    ],
    assumptions: [{ text: 'The project keeps its name' }],
    updated_at: f.store.now(),
    updated_by: user.id,
  });

  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.milestones).toEqual([
    {
      id: milestone.id,
      title: 'Ship both halves',
      session_ids: [merged.id, open.id],
      merged: 1,
      status: 'active',
      criteria: [{ text: 'Both halves land', accepted: false }],
    },
  ]);
  expect(board.risks).toEqual([
    { text: 'The second half may slip', kind: 'risk' },
    { text: 'The first half is merged', kind: 'risk' },
    { text: 'The project keeps its name', kind: 'assumption' },
  ]);
});

it('marks milestone criteria accepted only while their acceptance holds', async () => {
  const f = await workbenchFixture();
  const merged = await f.create('Merge the export');
  const ended = current(f, merged.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'merged' },
    ended.revision,
  );
  const input = {
    title: 'Ship export',
    required_sessions: [merged.id],
    criteria: ['Exports download', 'Docs name the format'],
  };
  const milestone = f.call<Milestone>('milestone.create', { project_id: f.project.id, ...input });
  const criteria = () => f.control.boardView(user, f.project.id, 1).milestones[0]?.criteria;
  expect(criteria()).toEqual([
    { text: 'Exports download', accepted: false },
    { text: 'Docs name the format', accepted: false },
  ]);
  const accepted = f.call<Milestone>(
    'milestone.accept',
    {
      milestone_id: milestone.id,
      evidence_refs: [`session:${merged.id}`],
      criteria_checked: [0, 1],
    },
    milestone.revision,
  );
  expect(criteria()).toEqual([
    { text: 'Exports download', accepted: true },
    { text: 'Docs name the format', accepted: true },
  ]);
  f.call(
    'milestone.revise',
    { milestone_id: milestone.id, ...input, criteria: ['Exports download', 'Docs list fields'] },
    accepted.revision,
  );
  expect(criteria()).toEqual([
    { text: 'Exports download', accepted: false },
    { text: 'Docs list fields', accepted: false },
  ]);
});

it('marks every criterion accepted when the acceptance covers the whole milestone', async () => {
  const f = await workbenchFixture();
  const merged = await f.create('Merge the export');
  const ended = current(f, merged.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'merged' },
    ended.revision,
  );
  const milestone = f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship export',
    required_sessions: [merged.id],
    criteria: ['Exports download', 'Docs name the format'],
  });
  f.call(
    'milestone.accept',
    { milestone_id: milestone.id, evidence_refs: [`session:${merged.id}`] },
    milestone.revision,
  );
  expect(f.control.boardView(user, f.project.id, 1).milestones[0]?.criteria).toEqual([
    { text: 'Exports download', accepted: true },
    { text: 'Docs name the format', accepted: true },
  ]);
});

it('computes tasks, edges and milestones from lead plans and their sessions', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports',
          goal: 'Exports download',
          lane: 'core',
          milestone: 'm1',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
        {
          id: 'b',
          title: 'Add a download button',
          goal: 'Users can click it',
          lane: 'core',
          milestone: 'm1',
          depends_on: ['a'],
          source: ['the export feature'],
          scope: ['src/ui'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [
        {
          id: 'm1',
          title: 'Export',
          criteria: ['Exports download'],
          tasks: ['a', 'b'],
          due_on: '2027-03-20',
        },
      ],
      risks: [{ text: 'The export format may change' }],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  const fromTask = (taskId: string) =>
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      task_id: `${lead.id}:${taskId}`,
    });
  const a = await fromTask('a');
  await awaitWorkspaceReady(f.control, a.workspace_id!);
  const done = current(f, a.id);
  f.store.update<Session>(
    'sessions',
    { ...done, state: 'closed', outcome: 'merged' },
    done.revision,
  );
  // b depends on a, so the board opens it once a merged.
  const b = await fromTask('b'),
    other = await f.create('Fix an unrelated typo');
  await awaitWorkspaceReady(f.control, b.workspace_id!);

  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.lanes).toEqual([{ id: `${lead.id}:core`, title: 'Core' }]);
  expect(board.tasks.map((task) => [task.id, task.status])).toEqual([
    [`${lead.id}:a`, 'done'],
    [`${lead.id}:b`, 'running'],
    [other.id, expect.any(String)],
  ]);
  const milestone = f.store.list<Milestone>('milestones')[0]!;
  expect(board.tasks[0]).toMatchObject({
    owner_session_id: lead.id,
    title: 'Serve exports',
    goal: 'Exports download',
    lane_id: `${lead.id}:core`,
    milestone_id: milestone.id,
  });
  expect(board.tasks[0]!.segments.map((segment) => segment.session_id)).toEqual([a.id]);
  expect(board.tasks[2]).not.toHaveProperty('owner_session_id');
  expect(board.edges).toEqual([{ from: `${lead.id}:a`, to: `${lead.id}:b`, state: 'met' }]);
  expect(board.tasks.slice(0, 2).map((task) => task.depends_on)).toEqual([[], ['a']]);
  expect(board.tasks[2]).not.toHaveProperty('depends_on');
  expect(board.milestones).toEqual([
    {
      id: milestone.id,
      title: 'Export',
      session_ids: [a.id, b.id],
      merged: 1,
      status: 'active',
      criteria: [{ text: 'Exports download', accepted: false }],
      owner_session_id: lead.id,
      tasks: { done: 1, total: 2 },
      due_on: '2027-03-20',
    },
  ]);
  expect(board.headline).toMatchObject({
    text: 'Export ships this week',
    by_session: lead.id,
  });
  expect(board.risks).toEqual([{ text: 'The export format may change', kind: 'risk' }]);
});

it('counts a task done and its dependents unblocked only once every live session of it merged', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports',
          goal: 'Exports download',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
        {
          id: 'b',
          title: 'Add a download button',
          goal: 'Users can click it',
          lane: 'core',
          depends_on: ['a'],
          source: ['the export feature'],
          scope: ['src/ui'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  const fromA = () =>
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      task_id: `${lead.id}:a`,
    });
  const mark = (session: Session, fields: Partial<Session>) => {
    const stored = current(f, session.id);
    f.store.update<Session>('sessions', { ...stored, ...fields }, stored.revision);
  };
  const merged = await fromA();
  await awaitWorkspaceReady(f.control, merged.workspace_id!);
  mark(merged, { state: 'closed', outcome: 'merged' });
  // A merged task takes a follow-up session from the board.
  const running = await fromA();
  await awaitWorkspaceReady(f.control, running.workspace_id!);
  mark(running, { state: 'running' });

  const board = f.control.boardView(user, f.project.id, 1);
  const task = (taskId: string) => board.tasks.find((each) => each.id === `${lead.id}:${taskId}`)!;
  expect(task('a').status).toBe('running');
  expect(board.task_progress.totals).toMatchObject({ done: 0, running: 1, not_started: 1 });
  expect(task('b').blocked_since).not.toBeNull();
});

it('dates a blocked task from the first stored plan version that held its dependency', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'b', title: 'Ship exports', depends_on: ['a'] },
  ]);
  f.store.db
    .prepare("UPDATE events SET created_at=1000 WHERE aggregate_id=? AND kind='board.plan_updated'")
    .run(lead.id);
  const b = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((each) => each.id === `${lead.id}:b`)!;
  expect(b.blocked_since).toBe(1000);
});

it('lists the valid findings of the project reviews, unresolved ones first', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Review the answer change');
  const finding = (
    id: string,
    location: string,
    extra: Partial<ReviewFinding> = {},
  ): ReviewFinding => ({
    id,
    review_id: 'answer-review',
    runtime: 'reviewer-one',
    round: 1,
    location,
    quote: 'return 41;',
    evidence: 'The answer is off by one',
    impact: `Impact of ${id}`,
    status: 'open',
    blocking: false,
    ...extra,
  });
  const resolution = (outcome: 'adopted' | 'dismissed') => ({
    outcome,
    resolved_at: Date.now(),
    resolved_by: user.id,
  });
  const review = (id: string, extra: Partial<Review>): Review => ({
    id,
    revision: 1,
    project_id: f.project.id,
    round: 1,
    runtimes: ['reviewer-one'],
    state: 'completed',
    session_ids: [],
    findings: [],
    ...extra,
  });
  f.store.insert<Review>(
    'reviews',
    review('answer-review', {
      session_id: session.id,
      findings: [
        finding('adopted-finding', 'src/answer.ts:12-14', { resolution: resolution('adopted') }),
        finding('rejected-finding', 'src/answer.ts:20', {
          status: 'rejected',
          reason: 'quote_not_in_artifact',
        }),
        finding('dismissed-finding', 'src/other.ts:3', { resolution: resolution('dismissed') }),
        finding('open-finding', 'the whole change', { blocking: true }),
      ],
    }),
  );
  f.store.insert<Review>(
    'reviews',
    review('sessionless-review', { findings: [finding('sessionless-finding', 'a.ts:1')] }),
  );

  expect(f.control.boardView(user, f.project.id, 1).findings).toEqual([
    {
      id: 'open-finding',
      review_id: 'answer-review',
      review_revision: 1,
      session_id: session.id,
      reviewer: 'reviewer-one',
      text: 'Impact of open-finding',
      severity: 'blocker',
      path: 'the whole change',
      line: null,
      state: 'open',
    },
    {
      id: 'adopted-finding',
      review_id: 'answer-review',
      review_revision: 1,
      session_id: session.id,
      reviewer: 'reviewer-one',
      text: 'Impact of adopted-finding',
      severity: 'minor',
      path: 'src/answer.ts',
      line: 12,
      state: 'adopted',
    },
    {
      id: 'dismissed-finding',
      review_id: 'answer-review',
      review_revision: 1,
      session_id: session.id,
      reviewer: 'reviewer-one',
      text: 'Impact of dismissed-finding',
      severity: 'minor',
      path: 'src/other.ts',
      line: 3,
      state: 'dismissed',
    },
  ]);
});

it('lists the findings of a plan review under the lead whose plan it reviewed', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the release');
  f.store.insert<Review>('reviews', {
    id: 'plan-review',
    revision: 1,
    project_id: f.project.id,
    round: 1,
    runtimes: ['reviewer-one'],
    state: 'completed',
    session_ids: [],
    requester: { lead_session_id: lead.id },
    plan: { tasks: [] },
    findings: [
      {
        id: 'plan-finding',
        review_id: 'plan-review',
        runtime: 'reviewer-one',
        round: 1,
        location: 'plan.json',
        quote: 'depends_on: []',
        evidence: 'The deploy task runs before the build',
        impact: 'Deploy may ship an unbuilt bundle',
        status: 'open',
        blocking: true,
      },
    ],
  });

  const listed = f.control.boardView(user, f.project.id, 1).findings;
  const [matrix] = f.control.projectReviewMetrics(user, f.project.id);
  expect(listed.filter((each) => each.state === 'open')).toHaveLength(matrix!.unresolved);
  expect(listed).toEqual([
    expect.objectContaining({ id: 'plan-finding', session_id: lead.id, state: 'open' }),
  ]);
});

it.skipIf(insideSandbox)("shows an unmerged session's newest gate run in its checks", async () => {
  const f = await workbenchFixture();
  // The gate fails in a worktree that holds fail.txt.
  const fails = "process.exit(require('node:fs').existsSync('fail.txt') ? 1 : 0)";
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Checks', argv: [process.execPath, '-e', fails] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const run = async (sessionId: string) => {
    await f.call('session.gates.run', { session_id: sessionId }, current(f, sessionId).revision);
    await eventually(
      () => !f.control.sessionGates(user, sessionId).running,
      () => f.control.tick(),
      10000,
    );
  };
  const usage = { input_tokens: 1, output_tokens: 1 };
  const passing = await idleSession(f, 'Write the passing file', usage, null);
  commit(passing.workspace.path, 'pass.txt', 'pass\n');
  const failing = await idleSession(f, 'Write the failing file', usage, null);
  commit(failing.workspace.path, 'fail.txt', 'fail\n');
  await run(passing.session.id);
  await run(failing.session.id);

  const checks = new Map(
    f.control.boardView(user, f.project.id, 1).tasks.map((task) => [task.id, task.checks]),
  );
  expect([checks.get(passing.session.id), checks.get(failing.session.id)]).toEqual([
    'pass',
    'fail',
  ]);
});

it("measures a running task's progress from no earlier than its current turn's start", async () => {
  const f = await workbenchFixture();
  const { session, turn } = await idleSession(
    f,
    'Write the slow file',
    { input_tokens: 1, output_tokens: 1 },
    null,
  );
  shift(f, turn.id, 60 * 60 * 1000);
  const started = f.store.event('turn.running', turn, f.project.id, {});
  const task = f.control.boardView(user, f.project.id, 1).tasks.find((t) => t.id === session.id);
  expect(task?.last_progress_at).toBe(started.created_at);
});

/** A lead whose plan holds the tasks given, each in one lane and its own directory. */
async function leadWithPlan(
  f: Fixture,
  tasks: { id: string; title: string; depends_on: string[] }[],
) {
  const lead = await f.create('Plan the export feature');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: tasks.map((task) => ({
        ...task,
        goal: task.title,
        lane: 'core',
        source: ['Plan the export feature'],
        scope: [`src/${task.id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  return lead;
}

/** A session opened from a plan task whose first turn has ended. */
async function idleTaskSession(f: Fixture, leadId: string, taskId: string) {
  return firstTurnEnded(
    f,
    await f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      task_id: `${leadId}:${taskId}`,
    }),
  );
}

/** Waits until the session's first turn has ended and returns it. */
async function firstTurnEnded(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return session;
}

/** Marks the session's newest turn failed with the error given. */
function failLatestTurn(f: Fixture, sessionId: string, error: string) {
  const turn = f.turns(sessionId).at(-1)!;
  const failed = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'failed' },
    turn.revision,
  );
  f.store.event('turn.failed', failed, f.project.id, { error });
}

it('counts a task whose session ended its turn without changes as idle, not waiting, on its card, in the totals and in the counts', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');

  const board = f.control.boardView(user, f.project.id, 1);
  const task = board.tasks.find((each) => each.id === `${lead.id}:a`)!;
  expect(task.status).toBe('idle');
  expect(task.segments.map((segment) => [segment.session_id, segment.status])).toEqual([
    [session.id, 'idle'],
  ]);
  expect(board.task_progress.totals).toMatchObject({ running: 0, waiting: 0, idle: 1 });
  expect(board.counts).toMatchObject({ waiting: 0 });
});

it("carries its session's recap on a plan task row and on a row of a session without a task", async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const bound = await idleTaskSession(f, lead.id, 'a');
  const own = await firstTurnEnded(f, await f.create('Fix an unrelated typo'));
  const row = (id: string) =>
    f.control.boardView(user, f.project.id, 1).tasks.find((each) => each.id === id)!;
  expect(row(`${lead.id}:a`)).not.toHaveProperty('recap');
  expect(row(own.id)).not.toHaveProperty('recap');
  const recaps = [
    [bound.id, { headline: 'Exports served', needs_you: 'Pick a format', happened: 'Added CSV' }],
    [own.id, { headline: 'Typo fixed', happened: 'Edited the readme' }],
  ] as const;
  for (const [id, recap] of recaps) {
    const stored = current(f, id);
    f.store.update<Session>(
      'sessions',
      { ...stored, recap: { ...recap, at: f.store.now() } },
      stored.revision,
    );
  }
  expect(row(`${lead.id}:a`).recap).toMatchObject(recaps[0][1]);
  expect(row(own.id).recap).toMatchObject(recaps[1][1]);
});

it('marks a task failed with the error text while its newest turn has failed', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  const other = await idleSession(
    f,
    'Fix an unrelated typo',
    { input_tokens: 1, output_tokens: 1 },
    null,
  );
  const error = `The runtime exited ${'x'.repeat(200)}`;
  failLatestTurn(f, session.id, error);
  failLatestTurn(f, other.session.id, 'The runtime exited');

  const board = f.control.boardView(user, f.project.id, 1);
  const task = board.tasks.find((each) => each.id === `${lead.id}:a`)!;
  expect(task.status).toBe('failed');
  expect(task.segments.map((segment) => segment.status)).toEqual(['failed']);
  expect(task.blockers).toEqual([`Turn failed: ${error.slice(0, 120)}`]);
  expect(board.task_progress.totals).toMatchObject({ running: 0, waiting: 0, failed: 1 });
  expect(board.tasks.find((each) => each.id === other.session.id)).toMatchObject({
    status: 'failed',
    ended_at: null,
    blockers: ['Turn failed: The runtime exited'],
  });
  expect(board.counts.failed).toBe(2);
});

it('lists unfinished upstream tasks and a blocked merge as blockers', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'b', title: 'Write the export format', depends_on: [] },
    { id: 'c', title: 'Add a download button', depends_on: ['a', 'b'] },
  ]);
  // The board opens no session for c before a and b are done.
  const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'c'));
  const stored = current(f, session.id);
  f.store.update<Session>(
    'sessions',
    {
      ...stored,
      merge: { state: 'blocked', reason: 'conflict', conflicts: ['src/a.ts', 'src/b.ts'] },
    },
    stored.revision,
  );

  const board = f.control.boardView(user, f.project.id, 1);
  const task = (taskId: string) => board.tasks.find((each) => each.id === `${lead.id}:${taskId}`)!;
  expect(task('c').blockers).toEqual([
    'Dependency “Serve exports” is not finished',
    'Dependency “Write the export format” is not finished',
    'Merge blocked: conflict, 2 conflicting files',
  ]);
  expect(task('c').blocker_codes).toEqual([
    { code: 'upstream', title: 'Serve exports' },
    { code: 'upstream', title: 'Write the export format' },
    { code: 'merge_blocked', reason: 'conflict', conflicts: 2 },
  ]);
  expect(task('a').blockers).toEqual([]);
});

const leadPrincipal = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

/** Marks the session's newest turn running from now, as when the runtime started it. */
function runLatestTurn(f: Fixture, sessionId: string) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, state: 'running' }, session.revision);
  const turn = f.turns(sessionId).at(-1)!;
  const running = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'running' },
    turn.revision,
  );
  const started = f.store.event('turn.running', running, f.project.id, {});
  return { turn: running, at: started.created_at };
}

function toolEvent(
  f: Fixture,
  sessionId: string,
  turnId: string,
  kind: 'started' | 'completed',
  call: string,
  fields: Record<string, unknown> = {},
) {
  return f.store.event(`agent.tool.${kind}`, current(f, sessionId), f.project.id, {
    kind: `tool.${kind}`,
    turn_id: turnId,
    tool_call_id: call,
    ...fields,
  });
}

function pendingApproval(f: Fixture, sessionId: string, fields: Partial<Approval>) {
  return f.store.insert<Approval>('approvals', {
    id: `approval-${sessionId}-${fields.tool}`,
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: sessionId,
    request_id: `request-${fields.tool}`,
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
    ...fields,
  });
}

function patchPlan(f: Fixture, leadId: string, fields: Partial<BoardPlan>) {
  const plan = f.store.must<BoardPlan>('board_plans', leadId);
  return f.store.update<BoardPlan>('board_plans', { ...plan, ...fields }, plan.revision);
}

const activityOf = (f: Fixture, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((each) => each.id === taskId)?.activity;

it('tells for each plan task whether it is queued, in a tool call, waiting, merging or ended with a failed turn', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'tool', title: 'Run the tests', depends_on: [] },
    { id: 'approval', title: 'Edit the parser', depends_on: [] },
    { id: 'question', title: 'Ask about the format', depends_on: [] },
    { id: 'failed', title: 'Write the exporter', depends_on: [] },
    { id: 'merging', title: 'Merge the docs', depends_on: [] },
    { id: 'later', title: 'Ship it', depends_on: ['tool'] },
  ]);
  const sessions = new Map<string, Session>();
  for (const id of ['tool', 'approval', 'question', 'failed', 'merging'])
    sessions.set(id, await idleTaskSession(f, lead.id, id));
  const sessionOf = (id: string) => sessions.get(id)!.id;

  const tool = runLatestTurn(f, sessionOf('tool'));
  toolEvent(f, sessionOf('tool'), tool.turn.id, 'started', 'read', {
    name: 'Read',
    input: { file_path: 'src/a.ts' },
  });
  toolEvent(f, sessionOf('tool'), tool.turn.id, 'completed', 'read', { ok: true });
  const bash = toolEvent(f, sessionOf('tool'), tool.turn.id, 'started', 'bash', {
    name: 'Bash',
    input: { command: 'pnpm   test\n--reporter=dot', description: 'Run the tests' },
  });

  runLatestTurn(f, sessionOf('approval'));
  const edit = pendingApproval(f, sessionOf('approval'), {
    tool: 'Edit',
    input_summary: `file_path=src/a.ts, old_string=${'a'.repeat(200)}`,
  });
  runLatestTurn(f, sessionOf('question'));
  const ask = pendingApproval(f, sessionOf('question'), {
    tool: 'AskUserQuestion',
    input_summary: 'questions=Which format?',
    questions: [{ question: 'Which format?', header: 'Format', options: [], multiSelect: false }],
  });

  const error = `The runtime exited ${'x'.repeat(300)}`;
  failLatestTurn(f, sessionOf('failed'), error);

  const merging = current(f, sessionOf('merging'));
  f.store.update<Session>(
    'sessions',
    { ...merging, merge: { state: 'running' } },
    merging.revision,
  );
  const mergeStarted = f.store.event(
    'session.merge_started',
    current(f, sessionOf('merging')),
    f.project.id,
    {},
  );

  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['later'] },
    null,
    leadPrincipal(f, lead.id),
  );
  const requested = f.store.must<BoardPlan>('board_plans', lead.id).dispatch!.later!.requested_at;

  const board = f.control.boardView(user, f.project.id, 1);
  const activity = (id: string) =>
    board.tasks.find((each) => each.id === `${lead.id}:${id}`)!.activity;
  expect(activity('tool')).toEqual({
    phase: 'tool',
    since: bash.created_at,
    tool: { name: 'Bash', target: 'pnpm test --reporter=dot' },
    health: 'fresh',
    attempt: 1,
  });
  expect(activity('approval')).toEqual({
    phase: 'waiting_approval',
    since: edit.created_at,
    waiting: {
      kind: 'approval',
      summary: edit.input_summary!.slice(0, 140),
      approval_id: edit.id,
      since: edit.created_at,
    },
    health: 'fresh',
    attempt: 1,
  });
  expect(activity('question')).toMatchObject({
    phase: 'waiting_input',
    waiting: { kind: 'input', summary: 'questions=Which format?', approval_id: ask.id },
  });
  expect(activity('failed')).toMatchObject({
    phase: 'idle',
    turn_error: error.slice(0, 200),
    health: 'fresh',
  });
  expect(activity('merging')).toMatchObject({ phase: 'merging', since: mergeStarted.created_at });
  expect(activity('later')).toEqual({
    phase: 'queued',
    since: requested,
    health: 'fresh',
    attempt: 1,
  });
});

it.skipIf(insideSandbox)('tells a task is in its gate while the gate runs', async () => {
  const f = await workbenchFixture();
  // The gate sandbox lets the step read its gate folder, where the release marker goes; the step also ends on its own after 8 s.
  const gate = gateFolder(f.root),
    release = path.join(gate.dir, 'release-gate');
  const waits = `const fs=require('node:fs');const end=Date.now()+8000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})||Date.now()>end)clearInterval(t)},20)`;
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Checks', argv: gate.argv(waits) }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  await f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
  const gateStarted = () => f.store.kindEvents(f.project.id, ['session.gate_started']).at(-1);
  await eventually(
    () => f.control.sessionGates(user, session.id).running && !!gateStarted(),
    () => f.control.tick(),
    10000,
  );
  const started = gateStarted()!;
  expect(activityOf(f, `${lead.id}:a`)).toMatchObject({ phase: 'gate', since: started.created_at });
  writeFileSync(release, '');
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
    20000,
  );
});

it('reports a running turn quiet after two minutes without progress and stalled once the tracker alerted it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  const { turn, at } = runLatestTurn(f, session.id);
  const clock = vi.spyOn(f.store, 'now');
  clock.mockReturnValue(at + 2 * 60_000);
  expect(activityOf(f, `${lead.id}:a`)).toMatchObject({
    phase: 'thinking',
    since: at,
    health: 'fresh',
  });
  clock.mockReturnValue(at + 2 * 60_000 + 1);
  expect(activityOf(f, `${lead.id}:a`)?.health).toBe('quiet');
  patchPlan(f, lead.id, { alerted: { [turn.id]: ['stalled'] } });
  expect(activityOf(f, `${lead.id}:a`)?.health).toBe('stalled');
  patchPlan(f, lead.id, { alerted: { [turn.id]: ['stalled', 'looping'] } });
  expect(activityOf(f, `${lead.id}:a`)?.health).toBe('looping');
  patchPlan(f, lead.id, { alerted: {} });
  toolEvent(f, session.id, turn.id, 'started', 'bash', { name: 'Bash', input: {} });
  expect(activityOf(f, `${lead.id}:a`)).toMatchObject({ phase: 'tool', health: 'fresh' });
});

it('counts every session of a task in its attempts and lists the problems handed back to the newest', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const first = await idleTaskSession(f, lead.id, 'a');
  const stored = current(f, first.id);
  f.store.update<Session>(
    'sessions',
    { ...stored, state: 'closed', outcome: 'discarded' },
    stored.revision,
  );
  const second = await idleTaskSession(f, lead.id, 'a');
  patchPlan(f, lead.id, {
    handed_back: { [first.id]: ['gate_failed'], [second.id]: ['no_changes'] },
  });

  expect(activityOf(f, `${lead.id}:a`)).toMatchObject({
    phase: 'idle',
    attempt: 2,
    handed_back: ['no_changes'],
  });
});

it('lists each lead that wrote a plan with its state, unread notes and request', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  await eventually(
    () =>
      current(f, lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const note = { at: f.store.now(), session_id: lead.id, task_id: 'a', text: 'Noted' };
  const plan = patchPlan(f, lead.id, {
    inbox: [
      { ...note, kind: 'risk' },
      { ...note, kind: 'task' },
    ],
  });
  const leads = () => f.control.boardView(user, f.project.id, 1).leads!;
  expect(leads()).toEqual([
    {
      session_id: lead.id,
      title: current(f, lead.id).title ?? '',
      state: 'idle',
      inbox: 2,
      messages_today: [],
      updated_at: plan.updated_at,
      plan_version: plan.plan_version,
      pending_edits: [],
      pending_proposals: [],
      recent_edits: [],
      rejected_edits: [],
      activity: expect.objectContaining({ phase: 'idle' }),
    },
  ]);
  const approval = pendingApproval(f, lead.id, { tool: 'Bash', input_summary: 'command=git log' });
  expect(leads()[0]).toMatchObject({
    state: 'waiting',
    waiting: {
      kind: 'approval',
      summary: 'command=git log',
      approval_id: approval.id,
      since: approval.created_at,
    },
  });
});

it('shows a lead as failed while its latest turn failed and no turn followed', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  await eventually(
    () =>
      current(f, lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const turn = f.turns(lead.id).at(-1)!;
  f.store.update<SessionTurn>('session_turns', { ...turn, state: 'failed' }, turn.revision);
  const leadState = () => f.control.boardView(user, f.project.id, 1).leads![0]!.state;
  expect(leadState()).toBe('failed');
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Try the plan again' },
    current(f, lead.id).revision,
  );
  expect(leadState()).not.toBe('failed');
});

it.each<[string, (f: Fixture, leadId: string) => void]>([
  ['idle', () => {}],
  [
    'waiting',
    (f, id) => void pendingApproval(f, id, { tool: 'Bash', input_summary: 'command=ls' }),
  ],
  ['failed', (f, id) => failLatestTurn(f, id, 'The runtime exited')],
  [
    'running',
    (f, id) => {
      const lead = current(f, id);
      f.store.update<Session>('sessions', { ...lead, state: 'running' }, lead.revision);
    },
  ],
  [
    'closed',
    (f, id) => {
      const lead = current(f, id);
      f.store.update<Session>(
        'sessions',
        { ...lead, state: 'closed', outcome: 'discarded' },
        lead.revision,
      );
    },
  ],
])('shows a lead as %s from its listed state', async (state, setup) => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  await eventually(
    () =>
      current(f, lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  setup(f, lead.id);
  expect(f.control.boardView(user, f.project.id, 1).leads![0]!.state).toBe(state);
});

it('keeps a lead shown as failed after a steer delivered into its failed turn', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  await eventually(
    () =>
      current(f, lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const turn = f.turns(lead.id).at(-1)!;
  f.store.update<SessionTurn>('session_turns', { ...turn, state: 'failed' }, turn.revision);
  f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'steer-into-failed-turn',
    revision: 1,
    input: 'Also look at the import path',
    kind: 'steer',
    delivery: 'delivered',
    state: 'completed',
  });
  expect(f.control.boardView(user, f.project.id, 1).leads![0]!.state).toBe('failed');
});

it('marks a task failed with the error text when its turn fails after a steer was delivered into it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  const { turn } = runLatestTurn(f, session.id);
  f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'steer-into-running-turn',
    revision: 1,
    input: 'Also handle empty exports',
    kind: 'steer',
    delivery: 'delivered',
    state: 'completed',
  });
  const running = f.store.must<SessionTurn>('session_turns', turn.id);
  f.store.event(
    'turn.failed',
    f.store.update<SessionTurn>('session_turns', { ...running, state: 'failed' }, running.revision),
    f.project.id,
    { error: 'The runtime exited' },
  );
  const stored = current(f, session.id);
  f.store.update<Session>('sessions', { ...stored, state: 'open' }, stored.revision);

  const board = f.control.boardView(user, f.project.id, 1);
  const task = board.tasks.find((each) => each.id === `${lead.id}:a`)!;
  expect(task.status).toBe('failed');
  expect(task.blockers).toEqual(['Turn failed: The runtime exited']);
  expect(task.activity).toMatchObject({ phase: 'idle', turn_error: 'The runtime exited' });
  expect(board.counts.failed).toBe(1);
});

it('keeps a running session on its task card while a changed contract has yet to reach it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  runLatestTurn(f, session.id);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: plan.tasks.map((task) => ({ ...task, goal: 'Serve exports as CSV' })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  expect(f.store.must<BoardPlan>('board_plans', lead.id).contract_changed).toContain(session.id);

  const board = f.control.boardView(user, f.project.id, 1);
  const task = board.tasks.find((each) => each.id === `${lead.id}:a`)!;
  expect(task.status).toBe('running');
  expect(task.segments.map((segment) => [segment.session_id, segment.status])).toEqual([
    [session.id, 'running'],
  ]);
  expect(board.tasks.some((each) => each.id === session.id)).toBe(false);
  expect(board.task_progress.totals).toMatchObject({ running: 1, not_started: 0 });
});

it('ties each request for the user to its task and puts the ones that unblock the most tasks first', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'b', title: 'Add a download button', depends_on: ['a'] },
    { id: 'c', title: 'Document the export', depends_on: ['a'] },
    { id: 'd', title: 'Fix an unrelated typo', depends_on: [] },
  ]);
  const a = await idleTaskSession(f, lead.id, 'a'),
    d = await idleTaskSession(f, lead.id, 'd');
  const older = pendingApproval(f, d.id, { tool: 'Edit', created_at: f.store.now() - 1000 }),
    newer = pendingApproval(f, a.id, { tool: 'Bash' });

  const needs = f.control.boardView(user, f.project.id, 1).needs!;
  expect(needs.map((item) => [item.source.id, item.task_id, item.unblocks])).toEqual([
    [newer.id, `${lead.id}:a`, 2],
    [older.id, `${lead.id}:d`, 0],
  ]);
  expect(needs[0]).toMatchObject({
    kind: 'permission',
    actions: [{ command: 'approval.respond', allowed: true }],
  });
});

it('leaves a request of a removed task worker off the new task that reuses its id', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'b', title: 'Add a download button', depends_on: ['a'] },
  ]);
  const old = await idleTaskSession(f, lead.id, 'a');
  const request = pendingApproval(f, old.id, { tool: 'Bash' });
  patchPlan(f, lead.id, {
    retired: { a: 1 },
    generations: {
      ...f.store.must<BoardPlan>('board_plans', lead.id).generations,
      a: { generation: 2, contract: 'reused' },
    },
  });

  const item = f.control
    .boardView(user, f.project.id, 1)
    .needs!.find((each) => each.source.id === request.id)!;
  expect(item.task_id).not.toBe(`${lead.id}:a`);
  expect(item.unblocks).toBe(0);
});

it('ties a dispatch failure and a lead request on its direct task to their tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'd', title: 'Fix the parser', depends_on: [] },
    { id: 'b', title: 'Add a download button', depends_on: ['a', 'd'] },
  ]);
  const now = f.store.now();
  patchPlan(f, lead.id, {
    dispatch: {
      a: {
        requested_at: now,
        error: { code: 'workspace_failed', message: 'No worktree', at: now, attempts: 1 },
      },
    },
  });
  const stored = current(f, lead.id);
  f.store.update<Session>(
    'sessions',
    { ...stored, direct_task: { id: 'd', generation: 1 } },
    stored.revision,
  );
  const request = pendingApproval(f, lead.id, { tool: 'Bash' });

  const needs = f.control.boardView(user, f.project.id, 1).needs!;
  expect(needs.map((item) => [item.source.id, item.task_id, item.unblocks])).toEqual(
    expect.arrayContaining([
      [lead.id, `${lead.id}:a`, 1],
      [request.id, `${lead.id}:d`, 1],
    ]),
  );
});

it('keeps the usage of turns that ran before a runtime change on the runtime they ran on', async () => {
  const f = await workbenchFixture();
  const { session, turn } = await idleSession(
    f,
    'Explain the answer file',
    { input_tokens: 100, output_tokens: 50 },
    'model-a',
  );
  shift(f, turn.id, 60 * 60 * 1000);
  const stored = current(f, session.id);
  const moved = f.store.update<Session>(
    'sessions',
    { ...stored, runtime: 'codex' },
    stored.revision,
  );
  f.store.event('session.runtime_changed', moved, f.project.id, { from: 'fixture', to: 'codex' });
  shift(f, session.id, 30 * 60 * 1000, 'session.runtime_changed');
  const later = f.store.insert<SessionTurn>('session_turns', {
    ...f.turns(session.id)[0]!,
    id: 'turn-after-runtime-change',
    revision: 1,
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  f.store.event('turn.completed', later, f.project.id, {});

  const board = f.control.boardView(user, f.project.id, 7);
  expect(board.counts.tokens_by_runtime).toEqual({ fixture: 150, codex: 10 });
  expect(board.usage.map((row) => [row.runtime, row.model, row.tokens])).toEqual([
    ['fixture', 'model-a', 150],
    ['codex', 'model-a', 10],
  ]);
  expect(board.models.map((row) => [row.runtime, row.model])).toEqual([
    ['fixture', 'model-a'],
    ['codex', 'model-a'],
  ]);
  expect(board.tasks.find((each) => each.id === session.id)!.segments[0]!.runtime).toBe('codex');
});

it('does not count a turn cancelled before it ran as one that reported no token counts', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(
    f,
    'Explain the answer file',
    { input_tokens: 100, output_tokens: 50 },
    'model-a',
  );
  const queued = f.store.insert<SessionTurn>('session_turns', {
    id: 'queued-turn',
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: 'Rename the answer file',
    kind: 'send',
    delivery: 'failed',
    state: 'cancelled',
  });
  f.store.event('turn.queued', queued, f.project.id, {});
  f.store.event('turn.cancelled', queued, f.project.id, {});

  const board = f.control.boardView(user, f.project.id, 7);
  expect(board.counts.tokens).toBe(150);
  expect(board.counts.sessions_without_usage ?? 0).toBe(0);
});

it('counts the sessions with an ended turn in the range that reported no token counts', async () => {
  const f = await workbenchFixture();
  await idleSession(
    f,
    'Explain the answer file',
    { input_tokens: 100, output_tokens: 50 },
    'model-a',
  );
  await idleSession(
    f,
    'Rename the answer file',
    { input_tokens: 0, output_tokens: 0, tokens_unreported: true },
    'model-a',
  );
  const bare = await idleSession(
    f,
    'Delete the answer file',
    { input_tokens: 0, output_tokens: 0 },
    null,
  );
  const turn = f.turns(bare.session.id)[0]!;
  const { usage: _usage, ...withoutUsage } = turn;
  f.store.update<SessionTurn>('session_turns', withoutUsage, turn.revision);

  const board = f.control.boardView(user, f.project.id, 7);
  expect(board.counts).toMatchObject({
    tokens: 150,
    tokens_by_runtime: { fixture: 150 },
    sessions_without_usage: 2,
    sessions_without_usage_by_runtime: { fixture: 2 },
  });
  expect(
    board.usage.map((row) => [row.model, row.tokens, row.sessions_without_usage ?? 0]),
  ).toEqual([
    ['model-a', 150, 1],
    [null, 0, 1],
  ]);
});

it('leaves the merges of a removed task out of the trend and cycles of a new task reusing its id', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'b', title: 'Add a download button', depends_on: [] },
  ]);
  const session = await idleTaskSession(f, lead.id, 'a');
  const stored = current(f, session.id);
  const merged = f.store.update<Session>(
    'sessions',
    { ...stored, state: 'closed', outcome: 'merged' },
    stored.revision,
  );
  f.store.event('session.merged', merged, f.project.id, { to_sha: 'merged-sha' });
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  const replan = (tasks: BoardPlan['tasks']) =>
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
        headline: plan.headline,
        lanes: plan.lanes,
        tasks,
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadPrincipal(f, lead.id),
    );
  replan(plan.tasks.filter((task) => task.id !== 'a'));
  replan(plan.tasks.map((task) => (task.id === 'a' ? { ...task, goal: 'Export as CSV' } : task)));
  expect(f.store.must<BoardPlan>('board_plans', lead.id).retired).toEqual({ a: 1 });

  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.find((each) => each.id === `${lead.id}:a`)!.status).toBe('todo');
  expect(board.task_progress.daily.at(-1)).toMatchObject({ scope: 2, done: 0 });
  expect(board.task_progress.cycle.sample_count).toBe(0);
});

it('leaves a task merged in an earlier generation out of the daily trend once a goal change starts the next', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Serve exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  const stored = current(f, session.id);
  const merged = f.store.update<Session>(
    'sessions',
    { ...stored, state: 'closed', outcome: 'merged' },
    stored.revision,
  );
  f.store.event('session.merged', merged, f.project.id, { to_sha: 'merged-sha' });
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: plan.tasks.map((task) => ({ ...task, goal: 'Export as CSV' })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  expect(f.store.must<BoardPlan>('board_plans', lead.id).generations?.a?.generation).toBe(2);

  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.find((each) => each.id === `${lead.id}:a`)!.status).toBe('todo');
  expect(board.task_progress.daily.at(-1)).toMatchObject({ scope: 1, done: 0 });
});

/** A plan of tasks a and b set two days ago, with a merged yesterday, replanned today to the tasks given. */
async function mergedYesterdayThenReplanned(
  f: Fixture,
  tasks: (plan: BoardPlan) => BoardPlan['tasks'][],
) {
  const lead = await leadWithPlan(f, [
    { id: 'a', title: 'Serve exports', depends_on: [] },
    { id: 'b', title: 'Add a download button', depends_on: [] },
  ]);
  const session = await idleTaskSession(f, lead.id, 'a');
  const stored = current(f, session.id);
  const merged = f.store.update<Session>(
    'sessions',
    { ...stored, state: 'closed', outcome: 'merged' },
    stored.revision,
  );
  f.store.event('session.merged', merged, f.project.id, { to_sha: 'merged-sha' });
  shift(f, lead.id, 2 * DAY, 'board.plan_updated');
  shift(f, session.id, DAY);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  for (const next of tasks(plan))
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
        headline: plan.headline,
        lanes: plan.lanes,
        tasks: next,
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadPrincipal(f, lead.id),
    );
  return lead;
}

it('keeps a task merged on an earlier day done in that day of the trend after the lead removes it', async () => {
  const f = await workbenchFixture();
  await mergedYesterdayThenReplanned(f, (plan) => [plan.tasks.filter((task) => task.id !== 'a')]);

  const daily = f.control.boardView(user, f.project.id, 7).task_progress.daily;
  expect(daily.find((day) => day.day === dayKey(f.store.now() - DAY))).toMatchObject({
    scope: 2,
    done: 1,
  });
  expect(daily.at(-1)).toMatchObject({ scope: 1, done: 0, removed: 1 });
});

it('counts the merge of a removed task on its own day but not for a new task reusing its id', async () => {
  const f = await workbenchFixture();
  const lead = await mergedYesterdayThenReplanned(f, (plan) => [
    plan.tasks.filter((task) => task.id !== 'a'),
    plan.tasks.map((task) => (task.id === 'a' ? { ...task, goal: 'Export as CSV' } : task)),
  ]);
  expect(f.store.must<BoardPlan>('board_plans', lead.id).retired).toEqual({ a: 1 });

  const board = f.control.boardView(user, f.project.id, 7);
  expect(board.tasks.find((each) => each.id === `${lead.id}:a`)!.status).toBe('todo');
  expect(
    board.task_progress.daily.find((day) => day.day === dayKey(f.store.now() - DAY)),
  ).toMatchObject({ scope: 2, done: 1 });
  expect(board.task_progress.daily.at(-1)).toMatchObject({ scope: 2, done: 0 });
});

it('counts an accepted report task in the daily trend and the cycle times', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'a', title: 'Survey the exports', depends_on: [] }]);
  const session = await idleTaskSession(f, lead.id, 'a');
  shift(f, session.id, 60 * 60 * 1000);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  patchPlan(f, lead.id, {
    tasks: plan.tasks.map((task) => ({ ...task, done_when: 'report' as const })),
    accepted: { a: { at: f.store.now(), evidence: 'The survey is in the report' } },
  });

  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.find((each) => each.id === `${lead.id}:a`)!.status).toBe('done');
  expect(board.task_progress.totals.done).toBe(1);
  expect(board.task_progress.daily.at(-1)).toMatchObject({ scope: 1, done: 1 });
  expect(board.task_progress.cycle.sample_count).toBe(1);
});

it('times a steer queued after the running turn ended from when it was queued', async () => {
  const f = await workbenchFixture();
  const { session, turn } = await idleSession(
    f,
    'Explain the answer file',
    { input_tokens: 1, output_tokens: 1 },
    null,
  );
  shift(f, turn.id, 60 * 60 * 1000);
  const stored = current(f, session.id);
  f.store.update<Session>('sessions', { ...stored, state: 'running' }, stored.revision);
  const steer = f.call<SessionTurn>(
    'session.steer',
    { session_id: session.id, input: 'Also explain the history' },
    current(f, session.id).revision,
  );
  expect(f.turns(session.id).at(-1)).toMatchObject({ id: steer.id, state: 'queued' });

  expect(activityOf(f, session.id)).toMatchObject({
    phase: 'starting',
    since: f.store.eventSpan(steer.id)!.first,
  });
});

it('exposes plan priority, kind, routing reason and array order on task rows', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'exports', title: 'Export data', depends_on: [] },
    { id: 'download', title: 'Download data', depends_on: [] },
  ]);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  patchPlan(f, lead.id, {
    tasks: plan.tasks.map<BoardPlan['tasks'][number]>((task) => ({
      ...task,
      priority: 'high',
      kind: { domain: 'backend-logic', tier: 't2' },
      route_reason: 'Use the configured runtime',
    })),
  });
  const rows = f.control.boardView(user, f.project.id, 1).tasks;
  for (const [order, task] of rows.entries())
    expect(task).toMatchObject({
      order,
      priority: 'high',
      kind: { domain: 'backend-logic', tier: 't2' },
      route_reason: 'Use the configured runtime',
    });
});

it('gives each plan task row the flow path it takes in effect and other rows none', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'own', title: 'Own path', depends_on: [] },
    { id: 'tier', title: 'Tier path', depends_on: [] },
    { id: 'report', title: 'Report task', depends_on: [] },
  ]);
  const t1 = { domain: 'backend-logic', tier: 't1' } as const;
  const fields: Record<string, Partial<BoardPlan['tasks'][number]>> = {
    own: { path: 'review_loop', flow_reason: 'Needs a second look' },
    tier: {},
    report: { done_when: 'report', path: 'direct' },
  };
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  patchPlan(f, lead.id, {
    tasks: plan.tasks.map((task) => ({ ...task, kind: t1, ...fields[task.id] })),
  });
  await f.create('Tidy the readme');
  const rows = f.control.boardView(user, f.project.id, 1).tasks;
  const pathOf = (taskId: string) => rows.find((row) => row.id === `${lead.id}:${taskId}`)?.path;
  expect(pathOf('own')).toBe('review_loop');
  // The default workflow policy has t1 tasks done directly.
  expect(pathOf('tier')).toBe('direct');
  expect(pathOf('report')).toBe('dispatch');
  const others = rows.filter((row) => !row.owner_session_id);
  expect(others.length).toBeGreaterThan(0);
  for (const row of others) expect(row).not.toHaveProperty('path');
});

it('returns the full project history including removed tasks and days with no work', async () => {
  const f = await workbenchFixture();
  const first = new Date(2026, 9, 1, 10).getTime();
  let now = first;
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  f.store.db.prepare('UPDATE events SET created_at=? WHERE project_id=?').run(first, f.project.id);
  const lead = await leadWithPlan(f, [
    { id: 'exports', title: 'Export data', depends_on: [] },
    { id: 'obsolete', title: 'Old approach', depends_on: [] },
  ]);
  const original = f.store.must<BoardPlan>('board_plans', lead.id);
  const worker = f.store.insert<Session>('sessions', {
    id: 'export-worker',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: lead.workspace_id,
    state: 'closed',
    outcome: 'merged',
    turn_count: 2,
    task: { lead_session_id: lead.id, id: 'exports' },
  });
  const discarded = f.store.insert<Session>('sessions', {
    ...worker,
    id: 'discarded-export-worker',
    outcome: 'discarded',
  });
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: 'export-turn',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    input: 'Export data',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  now = new Date(2026, 9, 2, 12).getTime();
  f.store.event('session.opened', worker, f.project.id, worker);
  f.store.event('session.opened', discarded, f.project.id, {
    ...discarded,
    state: 'running',
    outcome: undefined,
  });
  f.store.event('session.discarded', discarded, f.project.id, {});
  f.store.event('turn.running', turn, f.project.id, turn);
  now += 60 * 60 * 1000;
  f.store.event('turn.completed', turn, f.project.id, turn);
  f.store.event('turn.queued', { id: 'retry-turn', revision: 1 }, f.project.id, {
    ...turn,
    id: 'retry-turn',
    origin: 'tracker',
  });
  now += 60 * 60 * 1000;
  f.store.event('session.merged', worker, f.project.id, { to_sha: 'merged-head' });
  const revised = patchPlan(f, lead.id, {
    tasks: original.tasks.filter((task) => task.id !== 'obsolete'),
    retired: { obsolete: 1 },
    handed_back: { [worker.id]: ['gate_failed'] },
  });
  f.store.event('board.plan_updated', revised, f.project.id, revised);
  now = new Date(2026, 9, 5, 12).getTime();
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.started_at).toBe(first);
  expect(history.truncated).toBe(false);
  expect(history.tasks).toEqual([
    {
      id: `${lead.id}:exports`,
      owner_session_id: lead.id,
      session_id: worker.id,
      title: 'Export data',
      depends_on: [],
      runtime: f.adapter.name,
      lane_id: `${lead.id}:core`,
      milestone_id: null,
      state: 'merged',
      created_at: first,
      started_at: new Date(2026, 9, 2, 12).getTime(),
      merged_at: new Date(2026, 9, 2, 14).getTime(),
      commit: 'merged-head',
      additions: 0,
      deletions: 0,
      attempts: 2,
      handbacks: 1,
      handback_reasons: { gate: 0, review: 0, other: 1 },
    },
    {
      id: `${lead.id}:obsolete`,
      owner_session_id: lead.id,
      session_id: null,
      title: 'Old approach',
      depends_on: [],
      lane_id: `${lead.id}:core`,
      milestone_id: null,
      state: 'removed',
      created_at: first,
      started_at: null,
      merged_at: null,
      commit: null,
      additions: null,
      deletions: null,
      attempts: 0,
      handbacks: 0,
    },
  ]);
  expect(history.days).toEqual([
    { date: '2026-10-01', merged: 0, handbacks: 0, decisions: 1, failed: 0, waited: 0 },
    { date: '2026-10-02', merged: 1, handbacks: 1, decisions: 1, failed: 0, waited: 0 },
    { date: '2026-10-03', merged: 0, handbacks: 0, decisions: 0, failed: 0, waited: 0 },
    { date: '2026-10-04', merged: 0, handbacks: 0, decisions: 0, failed: 0, waited: 0 },
    { date: '2026-10-05', merged: 0, handbacks: 0, decisions: 0, failed: 0, waited: 0 },
  ]);
  expect(history.idle).toEqual([
    { from: first, to: new Date(2026, 9, 2, 12).getTime() },
    { from: new Date(2026, 9, 2, 13).getTime(), to: now },
  ]);
  f.store.remove('sessions', discarded.id, discarded.revision);
  f.store.event('session.deleted', discarded, f.project.id, { title: 'Discarded attempt' });
  expect(f.control.boardHistory(user, f.project.id).tasks).toEqual(history.tasks);

  f.store.insert<Session>('sessions', { ...lead, id: 'successor', revision: 1 });
  f.store.remove('board_plans', lead.id, revised.revision);
  const moved = f.store.insert<BoardPlan>('board_plans', {
    ...revised,
    id: 'successor',
    revision: 1,
  });
  f.store.event('board.plan_transferred', moved, f.project.id, { from: lead.id });
  expect(f.control.boardHistory(user, f.project.id).tasks).toEqual(
    history.tasks.map((task) => ({
      ...task,
      id: task.id.replace(lead.id, 'successor'),
      owner_session_id: 'successor',
      lane_id: 'successor:core',
    })),
  );
});

it('gives a merged history task its own session, commit and changed lines, and an unstarted one none', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'exports', title: 'Export data', depends_on: [] },
    { id: 'imports', title: 'Import data', depends_on: [] },
  ]);
  const worker = f.store.insert<Session>('sessions', {
    id: 'export-worker',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: lead.workspace_id,
    state: 'closed',
    outcome: 'merged',
    turn_count: 1,
    task: { lead_session_id: lead.id, id: 'exports' },
  });
  f.store.event('session.opened', worker, f.project.id, worker);
  f.store.event('session.merged', worker, f.project.id, {
    from_sha: 'base-head',
    to_sha: 'merged-head',
    additions: 12,
    deletions: 3,
  });
  const rows = f.control.boardHistory(user, f.project.id).tasks;
  expect(
    rows.map((row) => [
      row.id,
      row.state,
      row.session_id,
      row.commit,
      row.additions,
      row.deletions,
    ]),
  ).toEqual([
    [`${lead.id}:exports`, 'merged', worker.id, 'merged-head', 12, 3],
    [`${lead.id}:imports`, 'todo', null, null, null, null],
  ]);
});

it('keeps accepted report and direct task completion times and milestone history', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'report', title: 'Research exports', depends_on: [] },
    { id: 'direct', title: 'Implement exports', depends_on: [] },
  ]);
  const at = f.store.now();
  patchPlan(f, lead.id, {
    tasks: f.store
      .must<BoardPlan>('board_plans', lead.id)
      .tasks.map<BoardPlan['tasks'][number]>((task) => ({
        ...task,
        ...(task.id === 'report' ? { done_when: 'report', milestone: 'release' } : {}),
      })),
    accepted: { report: { at, evidence: 'Report reviewed' } },
    direct_merged: {
      direct: { generation: 1, at, session_id: lead.id, from_sha: 'before', to_sha: 'after' },
    },
  });
  const milestone = f.store.insert<Milestone>('milestones', {
    id: 'release-milestone',
    revision: 1,
    project_id: f.project.id,
    owner_session_id: lead.id,
    key: 'release',
    title: 'Research complete',
    criteria: ['Report reviewed'],
    task_ids: ['report'],
    required_sessions: [],
    created_at: at,
    updated_by: user.id,
    removed_at: at,
  });
  f.store.event('milestone.accepted', milestone, f.project.id, milestone);
  const reachedAt = f.store.events(0, f.project.id, Number.MAX_SAFE_INTEGER).at(-1)!.created_at;
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.tasks.map((task) => [task.state, task.merged_at])).toEqual([
    ['merged', at],
    ['merged', at],
  ]);
  expect(history.tasks[0]!.milestone_id).toBe(milestone.id);
  expect(history.milestones).toEqual([
    { id: milestone.id, title: milestone.title, state: 'removed', reached_at: reachedAt },
  ]);
});

it('caps history task rows without truncating daily totals', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'exports', title: 'Export data', depends_on: [] }]);
  const original = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.transaction(() => {
    for (let index = 0; index < 2001; index++) {
      const plan = { ...original, tasks: [{ ...original.tasks[0]!, id: `export-${index}` }] };
      f.store.event('board.plan_updated', plan, f.project.id, plan);
    }
  });
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.tasks).toHaveLength(2000);
  expect(history.truncated).toBe(true);
  expect(history.decisions).toHaveLength(2000);
  expect(history.days.reduce((sum, day) => sum + day.decisions, 0)).toBe(2002);
});

it('carries history dependencies, task type and the newest retained session runtime and model', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'exports', title: 'Export data', depends_on: [] },
    { id: 'download', title: 'Download data', depends_on: ['exports'] },
  ]);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  patchPlan(f, lead.id, {
    tasks: plan.tasks.map<BoardPlan['tasks'][number]>((task) =>
      task.id === 'download' ? { ...task, task_type: 'feature' } : task,
    ),
  });
  for (const [id, extra] of [
    ['older-worker', { requested_model: 'older-model' }],
    ['newest-worker', { requested_model: 'requested-model', reported_model: 'reported-model' }],
    ['discarded-worker', { outcome: 'discarded', reported_model: 'discarded-model' }],
  ] as const) {
    const session = f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: id,
      workspace_id: lead.workspace_id,
      state: 'closed',
      turn_count: 1,
      task: { lead_session_id: lead.id, id: 'download' },
      ...extra,
    });
    f.store.event('session.opened', session, f.project.id, session);
  }
  const [unstarted, started] = f.control.boardHistory(user, f.project.id).tasks;
  expect(started).toMatchObject({
    depends_on: ['exports'],
    task_type: 'feature',
    session_id: 'newest-worker',
    runtime: 'newest-worker',
    model: 'reported-model',
  });
  expect(unstarted).toHaveProperty('depends_on', []);
  for (const field of [
    'task_type',
    'runtime',
    'model',
    'handback_reasons',
    'gate_passed_on_attempt',
  ])
    expect(unstarted).not.toHaveProperty(field);
  const latest = current(f, 'newest-worker');
  f.store.update<Session>('sessions', { ...latest, reported_model: undefined }, latest.revision);
  expect(f.control.boardHistory(user, f.project.id).tasks[1]).toHaveProperty(
    'model',
    'requested-model',
  );
});

it('caps history decisions even when the task list fits and keeps complete daily counts', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'exports', title: 'Export data', depends_on: [] }]);
  f.store.transaction(() => {
    for (let index = 0; index < 2000; index++)
      f.store.event('task.start_requested', lead, f.project.id, { task_ids: ['exports'] });
  });
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.tasks).toHaveLength(1);
  expect(history.decisions).toHaveLength(2000);
  expect(history.truncated).toBe(true);
  expect(history.days.reduce((sum, day) => sum + day.decisions, 0)).toBe(2001);
});

it('divides history handbacks by gate, external review, user review rejection and other causes', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'exports', title: 'Export data', depends_on: [] }]);
  const worker = f.store.insert<Session>('sessions', {
    id: 'export-worker',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: lead.workspace_id,
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: lead.id, id: 'exports' },
  });
  f.store.event('session.opened', worker, f.project.id, worker);
  const queue = (id: string, input: string) => {
    const turn: SessionTurn = {
      id,
      revision: 1,
      project_id: f.project.id,
      session_id: worker.id,
      input,
      kind: 'send',
      delivery: 'pending',
      state: 'queued',
      origin: 'tracker',
    };
    f.store.event('turn.queued', turn, f.project.id, turn);
  };
  f.store.event('session.gate_checked', worker, f.project.id, {
    results: [{ name: 'Tests', exit_code: 1 }],
  });
  f.store.event('session.merge_blocked', worker, f.project.id, { reason: 'gate_failed' });
  queue('gate-repair', 'Fix the failed gate');
  f.store.event('session.gate_checked', worker, f.project.id, {
    results: [{ name: 'Tests', exit_code: 0 }],
  });
  queue(
    'review-repair',
    '[Pantheon] The workflow review “Code review” found problems to fix before the merge:',
  );
  f.store.event('task.handed_back', lead, f.project.id, {
    task_id: 'exports',
    session_id: worker.id,
    reason: 'The user rejected the implementation',
  });
  f.store.event('session.merge_blocked', worker, f.project.id, { reason: 'rebase_conflict' });
  queue('conflict-repair', 'Resolve the rebase conflict');
  const run = f.store.insert<StepRun>('workflow_step_runs', {
    id: 'export-prompt',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'exports',
    generation: 1,
    definition_version: 1,
    slot: 'before_dispatch',
    step: {
      id: 'prepare',
      title: 'Prepare',
      kind: { type: 'prompt', target: 'lead', prompt: 'Prepare exports' },
    },
    state: 'failed',
    created_at: f.store.now(),
  });
  f.store.event('workflow.step_changed', run, f.project.id, {
    state: 'failed',
    task_id: 'exports',
    slot: run.slot,
    step_id: run.step.id,
  });
  f.store.event('task.handed_back', lead, f.project.id, {
    task_id: 'exports',
    reason: 'Preparation failed',
  });
  const row = f.control.boardHistory(user, f.project.id).tasks[0]!;
  expect(row.handback_reasons).toEqual({ gate: 1, review: 2, other: 2 });
  expect(row.handbacks).toBe(5);
  expect(Object.values(row.handback_reasons!).reduce((sum, count) => sum + count, 0)).toBe(
    row.handbacks,
  );
});

it('records the first passing gate attempt for first, retried and never passing tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(
    f,
    ['first', 'retry', 'never'].map((id) => ({ id, title: id, depends_on: [] })),
  );
  for (const task of ['first', 'retry', 'never']) {
    const worker = f.store.insert<Session>('sessions', {
      id: `${task}-worker`,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      workspace_id: lead.workspace_id,
      state: 'open',
      turn_count: 0,
      task: { lead_session_id: lead.id, id: task },
    });
    f.store.event('session.opened', worker, f.project.id, worker);
    for (const exit_code of task === 'first' ? [0, 1, 0] : task === 'retry' ? [1, 0, 0] : [1, 1])
      f.store.event('session.gate_checked', worker, f.project.id, {
        results: [{ name: 'Tests', exit_code }],
      });
  }
  const [first, retry, never] = f.control.boardHistory(user, f.project.id).tasks;
  expect(first).toHaveProperty('gate_passed_on_attempt', 1);
  expect(retry).toHaveProperty('gate_passed_on_attempt', 2);
  expect(never).not.toHaveProperty('gate_passed_on_attempt');
});

it('counts the gate attempts of the current task generation only', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'exports', title: 'Export', depends_on: [] }]);
  const gates = (generation: number, exitCodes: number[]) => {
    const worker = f.store.insert<Session>('sessions', {
      id: `exports-worker-${generation}`,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      workspace_id: lead.workspace_id,
      state: 'open',
      turn_count: 0,
      task: { lead_session_id: lead.id, id: 'exports', generation },
    });
    f.store.event('session.opened', worker, f.project.id, worker);
    for (const exit_code of exitCodes)
      f.store.event('session.gate_checked', worker, f.project.id, {
        results: [{ name: 'Tests', exit_code }],
      });
  };
  gates(1, [0]);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'exports',
          title: 'Export',
          goal: 'Export as CSV too',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/exports'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  expect(f.store.must<BoardPlan>('board_plans', lead.id).generations?.exports?.generation).toBe(2);
  gates(2, [1, 1, 0]);
  const [row] = f.control.boardHistory(user, f.project.id).tasks;
  expect(row).toHaveProperty('gate_passed_on_attempt', 3);
});

it('counts failed task attempts and opened user requests over two history days and locates decisions', async () => {
  const f = await workbenchFixture();
  const first = new Date(2026, 9, 1, 10).getTime();
  let now = first;
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  f.store.db.prepare('UPDATE events SET created_at=? WHERE project_id=?').run(first, f.project.id);
  const lead = await leadWithPlan(f, [{ id: 'exports', title: 'Export data', depends_on: [] }]);
  const worker = f.store.insert<Session>('sessions', {
    id: 'export-worker',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: lead.workspace_id,
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: lead.id, id: 'exports' },
  });
  f.store.event('session.opened', worker, f.project.id, worker);
  const approval = f.store.insert<StepRun>('workflow_step_runs', {
    id: 'export-approval',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'exports',
    generation: 1,
    definition_version: 1,
    slot: 'before_dispatch',
    step: { id: 'approve-export', title: 'Approve export', kind: { type: 'approval' } },
    state: 'waiting',
    created_at: now,
  });
  for (const day of [0, 1]) {
    now = first + day * DAY;
    const turn: SessionTurn = {
      id: `failed-export-${day}`,
      revision: 1,
      project_id: f.project.id,
      session_id: worker.id,
      input: 'Export data',
      kind: 'send',
      delivery: 'delivered',
      state: 'failed',
    };
    f.store.event('turn.queued', turn, f.project.id, turn);
    f.store.event('turn.failed', turn, f.project.id, { error: 'Could not finish' });
    f.store.event('approval.requested', { id: `permission-${day}`, revision: 1 }, f.project.id, {
      kind: 'permission',
    });
    f.store.event('lead.question_asked', lead, f.project.id, {
      question: 'Choose the export format',
    });
    f.store.event('workflow.step_changed', approval, f.project.id, {
      state: day === 0 ? 'waiting' : 'rejected',
      task_id: 'exports',
      slot: approval.slot,
      step_id: approval.step.id,
    });
    if (day === 1) {
      f.store.event('task.handed_back', lead, f.project.id, {
        task_id: 'exports',
        reason: 'The user rejected the export',
      });
      f.store.event('task.start_requested', lead, f.project.id, { task_ids: ['exports'] });
      f.store.event('task.start_requested', lead, f.project.id, {
        task_ids: ['exports', 'imports'],
      });
      f.store.event('task.stop_requested', lead, f.project.id, {
        task_id: 'exports',
        reason: 'Wait for input',
      });
      f.store.event('task.accepted', lead, f.project.id, {
        task_id: 'exports',
        evidence: 'Reviewed',
      });
      const plan = f.store.must<BoardPlan>('board_plans', lead.id);
      f.store.event('board.plan_updated', plan, f.project.id, {
        ...plan,
        headline: 'Long plan '.repeat(30),
      });
    }
  }
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.days.map(({ failed, waited }) => ({ failed, waited }))).toEqual([
    { failed: 1, waited: 3 },
    { failed: 1, waited: 2 },
  ]);
  expect(history.tasks[0]!.handback_reasons).toEqual({ gate: 0, review: 1, other: 0 });
  expect(history.decisions).toEqual([
    { at: first, lane_id: null, kind: 'plan', title: 'Export ships this week' },
    { at: now, lane_id: `${lead.id}:core`, kind: 'start', title: 'Export data' },
    { at: now, lane_id: null, kind: 'start' },
    { at: now, lane_id: `${lead.id}:core`, kind: 'stop', title: 'Export data' },
    { at: now, lane_id: `${lead.id}:core`, kind: 'accept', title: 'Export data' },
    { at: now, lane_id: null, kind: 'plan', title: 'Long plan '.repeat(30).slice(0, 140) },
  ]);
  for (const day of history.days)
    expect(day.decisions).toBe(
      history.decisions.filter((row) => dayKey(row.at) === day.date).length,
    );
});

it('projects current context, acceptance items, successors and the latest gate run on plan tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'export', title: 'Build exports', depends_on: [] },
    { id: 'download', title: 'Download exports', depends_on: ['export'] },
  ]);
  const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const turn = f.turns(session.id).at(-1)!;
  f.store.update<SessionTurn>(
    'session_turns',
    {
      ...turn,
      usage: {
        input_tokens: 9000,
        output_tokens: 100,
        context_tokens: 700,
        context_window: 200000,
      },
    },
    turn.revision,
  );
  const row = () =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((task) => task.id === `${lead.id}:export`)!;
  expect(row()).toMatchObject({
    context: { used_tokens: 700, window_tokens: 200000 },
    acceptance_checks: [{ text: 'pnpm test', state: 'pending' }],
    successors: 1,
  });
  const commands = ['Lint', 'Test', 'Build'].map((name) => ({ name, argv: ['true'] }));
  f.store.event('session.gate_started', current(f, session.id), f.project.id, { commands });
  expect(row().gate_steps).toEqual(commands.map(({ name }) => ({ name, state: 'pending' })));
  f.store.event('session.gate_checked', current(f, session.id), f.project.id, {
    results: [
      { name: 'Lint', exit_code: 0 },
      { name: 'Test', exit_code: 1 },
    ],
  });
  expect(row().gate_steps).toEqual([
    { name: 'Lint', state: 'passed' },
    { name: 'Test', state: 'failed' },
    { name: 'Build', state: 'pending' },
  ]);
  f.store.event('session.gate_started', current(f, session.id), f.project.id, {
    commands: [{ name: 'Retry', argv: ['true'] }],
  });
  expect(row().gate_steps).toEqual([{ name: 'Retry', state: 'pending' }]);
  const tests = { passed: 41, failed: 0, skipped: 2 };
  f.store.event('session.gate_checked', current(f, session.id), f.project.id, {
    results: [{ name: 'Retry', exit_code: 0, tests, carried: true }],
  });
  expect(row().gate_steps).toEqual([{ name: 'Retry', state: 'passed', tests, carried: true }]);
  patchPlan(f, lead.id, {
    accepted: { export: { at: f.store.now(), evidence: 'Verified exports' } },
  });
  expect(row().acceptance_checks).toEqual([{ text: 'pnpm test', state: 'passed' }]);
  const unused = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((task) => task.id === `${lead.id}:download`)!;
  expect(unused.context).toBeUndefined();
  expect(unused.gate_steps).toBeUndefined();
  expect(unused.successors).toBe(0);
});

it('shows the gate steps a run checked so far, and keeps them once the run is cancelled', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Build exports', depends_on: [] }]);
  const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const steps = () =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((task) => task.id === `${lead.id}:export`)!.gate_steps;
  const commands = ['Lint', 'Test'].map((name) => ({ name, argv: ['true'] }));
  f.store.event('session.gate_started', current(f, session.id), f.project.id, { commands });
  f.store.event('session.gate_step_checked', current(f, session.id), f.project.id, {
    results: [{ name: 'Lint', exit_code: 0 }],
    total: 2,
  });
  const checked = [
    { name: 'Lint', state: 'passed' },
    { name: 'Test', state: 'pending' },
  ];
  expect(steps()).toEqual(checked);
  f.store.event('session.gate_run_cancelled', current(f, session.id), f.project.id, {});
  expect(steps()).toEqual(checked);
});

it('projects external review rounds and verdict without treating a failed reviewer as a pass', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Build exports', depends_on: [] }]);
  const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const row = () =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((task) => task.id === `${lead.id}:export`)!;
  expect(row().external_review).toBeUndefined();
  const review = f.store.insert<Review>('reviews', {
    id: 'export-review',
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    round: 2,
    runtimes: [f.adapter.name],
    session_ids: [session.id],
    findings: [],
    state: 'running',
  });
  expect(row().external_review).toEqual({ rounds: 2, verdict: 'pending' });
  const completed = f.store.update<Review>(
    'reviews',
    { ...review, state: 'completed' },
    review.revision,
  );
  const none = { blocking: 0, other: 0 };
  expect(row().external_review).toEqual({ rounds: 2, verdict: 'passed', findings: none });
  const turn = f.turns(session.id).at(-1)!;
  f.store.update<SessionTurn>('session_turns', { ...turn, state: 'failed' }, turn.revision);
  expect(row().external_review).toEqual({ rounds: 2, verdict: 'failed', findings: none });
  f.store.update<Review>('reviews', { ...completed, state: 'failed' }, completed.revision);
  expect(row().external_review).toEqual({ rounds: 2, verdict: 'failed', findings: none });
});

it('counts the open findings of the newest external review round by whether they block', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Build exports', depends_on: [] }]);
  const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const row = () =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((task) => task.id === `${lead.id}:export`)!;
  const finding = (id: string, round: number, blocking: boolean) => ({
    id,
    review_id: 'export-review',
    runtime: f.adapter.name,
    round,
    location: 'src/export.ts:1',
    quote: 'export',
    evidence: 'evidence',
    impact: 'impact',
    status: 'open' as const,
    blocking,
  });
  const review = f.store.insert<Review>('reviews', {
    id: 'export-review',
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    round: 2,
    runtimes: [f.adapter.name],
    session_ids: [session.id],
    findings: [
      finding('earlier-round', 1, true),
      finding('blocks', 2, true),
      finding('first-note', 2, false),
      finding('second-note', 2, false),
      { ...finding('stale-note', 2, false), status: 'stale' },
      {
        ...finding('dismissed-note', 2, false),
        resolution: { outcome: 'dismissed', resolved_at: 1, resolved_by: 'user' },
      },
    ],
    state: 'running',
  });
  expect(row().external_review).toEqual({ rounds: 2, verdict: 'pending' });
  f.store.update<Review>('reviews', { ...review, state: 'completed' }, review.revision);
  expect(row().external_review).toEqual({
    rounds: 2,
    verdict: 'failed',
    findings: { blocking: 1, other: 2 },
  });
});

it('records edit notes on started lead turns and contract receipts on every affected session', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Build exports', depends_on: [] }]);
  await firstTurnEnded(f, lead);
  const worker = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const other = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const plan = () => f.store.must<BoardPlan>('board_plans', lead.id);
  const edit = f.call<{ edit_id: string }>('board.plan.edit', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    base_version: plan().plan_version,
    ops: [{ type: 'set_task', task_id: 'export', patch: { goal: 'Export the complete history' } }],
  });
  const note = plan().inbox.find((note) => note.edit?.edit_id === edit.edit_id)!;
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Review the requested change' },
    current(f, lead.id).revision,
  );
  expect(turn.lead_note_ids).toContain(note.id);
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: plan().plan_version,
      ops: [{ type: 'resolve_edit', edit_id: edit.edit_id, decision: 'apply' }],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  const application = f.store.kindEvents(f.project.id, ['board.user_edit_applied']).at(-1)!;
  await eventually(
    () =>
      [worker.id, other.id].every((sessionId) =>
        f.store
          .kindEvents(f.project.id, ['session.contract_notified'])
          .some((event) => event.aggregate_id === sessionId),
      ) &&
      f.store
        .kindEvents(f.project.id, ['turn.running'])
        .some((event) => event.aggregate_id === turn.id),
    () => f.control.tick(),
  );
  const receipts = f.store
    .kindEvents(f.project.id, ['session.contract_notified'])
    .filter((event) => [worker.id, other.id].includes(event.aggregate_id));
  const started = f.store
    .kindEvents(f.project.id, ['turn.running'])
    .find((event) => event.aggregate_id === turn.id)!;
  expect(
    f.control.boardView(user, f.project.id, 1).leads!.find((row) => row.session_id === lead.id)!
      .recent_edits,
  ).toEqual([
    {
      id: edit.edit_id,
      created_at: note.at,
      plan_written_at: application.created_at,
      lead_read_at: started.created_at,
      sessions_notified_at: Math.max(...receipts.map((event) => event.created_at)),
    },
  ]);
});

it('weighs iteration scope by its daily plan and completed estimates across local days', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'api', title: 'API', depends_on: [] },
    { id: 'docs', title: 'Docs', depends_on: [] },
  ]);
  await firstTurnEnded(f, lead);
  let now = new Date(2027, 2, 13, 12).getTime();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const edit = (ops: unknown[]) =>
    f.call('board.plan.edit', {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
      ops,
    });
  edit([
    {
      type: 'set_iterations',
      iterations: [
        { id: 'spring', title: 'Spring', starts_on: '2027-03-13', ends_on: '2027-03-15' },
        { id: 'future', title: 'Future', starts_on: '2027-04-01', ends_on: '2027-04-02' },
      ],
    },
    {
      type: 'set_task',
      task_id: 'api',
      patch: { iteration: 'spring', estimate: 5, done_when: 'report' },
    },
  ]);
  now = new Date(2027, 2, 14, 12).getTime();
  edit([{ type: 'set_task', task_id: 'docs', patch: { iteration: 'spring' } }]);
  patchPlan(f, lead.id, {
    accepted: {
      api: {
        at: now,
        evidence: 'Reviewed the report',
        generation: f.store.must<BoardPlan>('board_plans', lead.id).generations!.api!.generation,
      },
    },
  });
  now = new Date(2027, 2, 16, 12).getTime();
  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.iterations).toEqual([
    {
      id: `${lead.id}:spring`,
      title: 'Spring',
      starts_on: '2027-03-13',
      ends_on: '2027-03-15',
      planned: 6,
      done: 5,
      days: [
        { date: '2027-03-13', done: 0, scope: 5 },
        { date: '2027-03-14', done: 5, scope: 6 },
        { date: '2027-03-15', done: 5, scope: 6 },
      ],
    },
    {
      id: `${lead.id}:future`,
      title: 'Future',
      starts_on: '2027-04-01',
      ends_on: '2027-04-02',
      planned: 0,
      done: 0,
      days: [],
    },
  ]);
  expect(
    f.control.boardView(user, f.project.id, 7).tasks.find((row) => row.id === `${lead.id}:api`),
  ).toMatchObject({
    iteration_id: `${lead.id}:spring`,
    estimate: 5,
  });
  expect(board.tasks.find((row) => row.id === `${lead.id}:docs`)).toMatchObject({
    iteration_id: `${lead.id}:spring`,
    estimate: 1,
  });
});

it('shows only the last year of days of an iteration stored with a mistyped start year', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'api', title: 'API', depends_on: [] }]);
  const today = dayKey(f.store.now());
  patchPlan(f, lead.id, {
    iterations: [{ id: 'typo', title: 'Typo', starts_on: '1900-01-01', ends_on: today }],
  });
  const days = f.control.boardView(user, f.project.id, 1).iterations![0]!.days;
  expect(days).toHaveLength(366);
  expect(days.at(-1)!.date).toBe(today);
});

it('reports collaboration messages for today and the used and queued dispatch slots', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'api', title: 'API', depends_on: [] },
    { id: 'docs', title: 'Docs', depends_on: [] },
  ]);
  await firstTurnEnded(f, lead);
  const worker = await idleTaskSession(f, lead.id, 'api');
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  for (const [origin, at] of [
    ['lead', now],
    ['tracker', now],
    ['lead', now - DAY],
  ] as const) {
    const turn: SessionTurn = {
      id: crypto.randomUUID(),
      revision: 1,
      project_id: f.project.id,
      session_id: worker.id,
      input: 'Continue',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
      origin,
    };
    f.store.insert('session_turns', turn);
    f.store.event('turn.queued', turn, f.project.id, turn);
    f.store.db.prepare('UPDATE events SET created_at=? WHERE aggregate_id=?').run(at, turn.id);
  }
  f.call('task.start', { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['docs'] });
  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.slots).toEqual({ limit: 3, used: 1, queued: 1 });
  expect(board.leads?.find((row) => row.session_id === lead.id)?.messages_today).toEqual([
    { session_id: worker.id, lead: 1, tracker: 1, handbacks: 1 },
  ]);
});

it('projects the latest reported lead context and omits context until reported', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, []);
  const row = () =>
    f.control.boardView(user, f.project.id, 1).leads!.find((row) => row.session_id === lead.id)!;
  expect(row()).not.toHaveProperty('context');
  const turn = f.turns(lead.id)[0]!;
  f.store.update<SessionTurn>(
    'session_turns',
    {
      ...turn,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        context_tokens: 700,
        context_window: 200000,
      },
    },
    turn.revision,
  );
  expect(row().context).toEqual({ used_tokens: 700, window_tokens: 200000 });
});

it('keeps explicit task metadata in the plan and board without deriving missing values', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    { id: 'export', title: 'Export data', depends_on: [] },
    { id: 'import', title: 'Import data', depends_on: [] },
  ]);
  await firstTurnEnded(f, lead);
  const plan = () => f.store.must<BoardPlan>('board_plans', lead.id);
  f.call('board.plan.edit', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    base_version: plan().plan_version,
    ops: [
      {
        type: 'set_task',
        task_id: 'export',
        patch: { task_type: 'feature', token_budget: 120000 },
      },
    ],
  });
  expect(plan().tasks[0]).toMatchObject({ task_type: 'feature', token_budget: 120000 });
  const board = f.control.boardView(user, f.project.id, 3);
  expect(board.since).toBe(
    new Date(new Date().setHours(0, 0, 0, 0)).setDate(new Date().getDate() - 2),
  );
  expect(board.tasks.find((row) => row.id === `${lead.id}:export`)).toMatchObject({
    task_type: 'feature',
    token_budget: 120000,
    scope: ['src/export'],
  });
  const legacy = board.tasks.find((row) => row.id === `${lead.id}:import`)!;
  expect(legacy.scope).toEqual(['src/import']);
  expect(legacy).not.toHaveProperty('task_type');
  expect(legacy).not.toHaveProperty('token_budget');
  const standalone = await firstTurnEnded(f, await f.create('Unplanned work'));
  expect(
    f.control.boardView(user, f.project.id, 3).tasks.find((row) => row.id === standalone.id)?.scope,
  ).toEqual([]);
  f.call('board.plan.edit', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    base_version: plan().plan_version,
    ops: [{ type: 'set_task', task_id: 'export', patch: { task_type: null, token_budget: null } }],
  });
  expect(plan().tasks[0]).not.toHaveProperty('task_type');
  expect(plan().tasks[0]).not.toHaveProperty('token_budget');
});

it('counts subagent calls only from the newest attempt that is not discarded', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export data', depends_on: [] }]);
  const first = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const second = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const discarded = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const ended = current(f, discarded.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'discarded' },
    ended.revision,
  );
  const counts = new Map([
    [first.id, 7],
    [second.id, 2],
    [discarded.id, 9],
  ]);
  const read = vi.spyOn(TraceIndex.prototype, 'subagentCounts').mockReturnValue(counts);
  const row = () =>
    f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${lead.id}:export`)!;
  expect(row().subagents).toBe(2);
  expect(read).toHaveBeenCalledExactlyOnceWith(f.project.id);
  counts.set(second.id, 0);
  expect(row().subagents).toBe(0);
  counts.delete(second.id);
  expect(row()).not.toHaveProperty('subagents');
});

it.each([
  {
    previous: ['Lint', 'Test'],
    newest: ['Test', 'Lint', 'Test'],
    skipped: [] as string[],
    repeated: true,
  },
  { previous: ['Lint'], newest: ['Test'], skipped: [] as string[], repeated: false },
  { previous: ['Test'], newest: ['Test', 'Lint'], skipped: ['Lint'], repeated: true },
])(
  'compares failed gate step sets across attempts: $previous then $newest, $skipped skipped',
  async ({ previous, newest, skipped, repeated }) => {
    const f = await workbenchFixture();
    const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export data', depends_on: [] }]);
    const row = () =>
      f.control
        .boardView(user, f.project.id, 1)
        .tasks.find((row) => row.id === `${lead.id}:export`)!;
    for (const [index, names] of [previous, newest].entries()) {
      const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
      const currentSession = current(f, session.id);
      f.store.update<Session>(
        'sessions',
        { ...currentSession, merge: { state: 'blocked', reason: 'gate_failed' } },
        currentSession.revision,
      );
      f.store.event('session.gate_checked', current(f, session.id), f.project.id, {
        results: [
          ...names.map((name) =>
            index && skipped.includes(name)
              ? { name, exit_code: 1, timed_out: false, state: 'skipped' }
              : { name, exit_code: 1 },
          ),
          { name: 'Build', exit_code: 0 },
        ],
      });
      if (index === 0) expect(row().activity).not.toHaveProperty('repeated_failure');
    }
    expect(row().activity?.repeated_failure).toBe(repeated);
    for (const name of skipped)
      expect(row().gate_steps?.find((step) => step.name === name)?.state).toBe('skipped');
  },
);

it.each([
  { previous: 'runtime_exited', newest: 'runtime_exited', repeated: true },
  { previous: 'runtime_exited', newest: 'usage_limit', repeated: false },
])(
  'compares turn error codes across attempts: $previous then $newest',
  async ({ previous, newest, repeated }) => {
    const f = await workbenchFixture();
    const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export data', depends_on: [] }]);
    const row = () =>
      f.control
        .boardView(user, f.project.id, 1)
        .tasks.find((row) => row.id === `${lead.id}:export`)!;
    for (const [index, error_code] of [previous, newest].entries()) {
      const session = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
      failLatestTurn(f, session.id, index ? 'Different error text' : 'First error text');
      f.store.event('agent.turn.completed', current(f, session.id), f.project.id, {
        turn_id: f.turns(session.id).at(-1)!.id,
        error_code,
      });
      if (index === 0) expect(row().activity).not.toHaveProperty('repeated_failure');
    }
    expect(row().activity?.repeated_failure).toBe(repeated);
    await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
    expect(row().activity).not.toHaveProperty('repeated_failure');
  },
);

it.each(['single', 'multiple', 'two', 'approval'] as const)(
  'offers answer labels only for a single-select question: %s',
  async (kind) => {
    const f = await workbenchFixture();
    const session = await firstTurnEnded(f, await f.create('Choose an export format'));
    const question = {
      question: 'Which format?',
      header: 'Format',
      multiSelect: kind === 'multiple',
      options: Array.from({ length: 8 }, (_, index) => ({
        label: `${index}${'x'.repeat(70)}`,
        description: 'Export format',
      })),
    };
    pendingApproval(f, session.id, {
      tool: kind === 'approval' ? 'Bash' : 'AskUserQuestion',
      questions: kind === 'two' ? [question, question] : [question],
    });
    const waiting = f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((row) => row.id === session.id)!.activity!.waiting!;
    if (kind === 'single')
      expect(waiting.options).toEqual(
        question.options.slice(0, 6).map(({ label }) => label.slice(0, 60)),
      );
    else expect(waiting).not.toHaveProperty('options');
  },
);

it('uses existing session diff data for attempt sizes and omits missing diff sizes', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export data', depends_on: [] }]);
  const first = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const firstSession = current(f, first.id);
  f.store.update<Session>(
    'sessions',
    { ...firstSession, state: 'closed', outcome: 'merged' },
    firstSession.revision,
  );
  f.store.event('session.merged', current(f, first.id), f.project.id, {
    to_sha: 'merged-head',
    additions: 12,
    deletions: 3,
  });
  const second = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const secondWorkspace = f.store.must<Workspace>('workspaces', second.workspace_id!);
  writeFileSync(path.join(secondWorkspace.path, 'answer.txt'), 'replacement\nextra\n');
  const missing = await firstTurnEnded(f, await boundTaskSession(f, lead.id, 'export'));
  const missingSession = current(f, missing.id);
  f.store.update<Session>(
    'sessions',
    { ...missingSession, state: 'closed', outcome: 'discarded' },
    missingSession.revision,
  );
  await f.control.prefetchWorktreeReads(user, f.project.id);
  const row = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((row) => row.id === `${lead.id}:export`)!;
  expect(row.segments.find((segment) => segment.session_id === first.id)).toMatchObject({
    additions: 12,
    deletions: 3,
  });
  expect(row.segments.find((segment) => segment.session_id === second.id)).toMatchObject({
    additions: 2,
    deletions: 1,
  });
  const absent = row.segments.find((segment) => segment.session_id === missing.id)!;
  expect(absent).not.toHaveProperty('additions');
  expect(absent).not.toHaveProperty('deletions');
});

function collaborationEvent(
  f: Fixture,
  owner: { id: string; revision: number },
  kind: string,
  payload: unknown,
  at: number,
) {
  const event = f.store.event(kind, owner, f.project.id, payload);
  f.store.db.prepare('UPDATE events SET created_at=? WHERE event_id=?').run(at, event.event_id);
}

it('counts today’s subagent calls, review rounds and gate runs without changing message counts', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export', depends_on: [] }]);
  await firstTurnEnded(f, lead);
  const worker = await idleTaskSession(f, lead.id, 'export');
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  for (const at of [now - DAY, now]) {
    for (const [tool_call_id, name, input] of [
      [`agent-${at}`, 'Agent', {}],
      [`spawn-${at}`, 'collabAgentToolCall', { tool: 'spawnAgent' }],
      [`wait-${at}`, 'collabAgentToolCall', { tool: 'wait' }],
      [`read-${at}`, 'Read', {}],
    ] as const) {
      collaborationEvent(f, worker, 'agent.tool.started', { tool_call_id, name, input }, at);
      collaborationEvent(f, worker, 'agent.tool.completed', { tool_call_id, ok: true }, at);
    }
    collaborationEvent(f, worker, 'session.gate_started', { commands: [] }, at);
    collaborationEvent(f, worker, 'session.gate_checked', { results: [] }, at);
    collaborationEvent(
      f,
      { id: `review-${at}`, revision: 1 },
      'review.requested',
      { session_id: worker.id, round: 1, runtimes: ['fixture', 'other'] },
      at,
    );
  }
  for (const origin of ['lead', 'tracker'] as const) {
    const turn: SessionTurn = {
      id: crypto.randomUUID(),
      revision: 1,
      project_id: f.project.id,
      session_id: worker.id,
      input: 'Continue',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
      origin,
    };
    f.store.insert('session_turns', turn);
    collaborationEvent(f, turn, 'turn.queued', turn, now);
  }
  const row = () => f.control.boardView(user, f.project.id, 7, '2027-03-15').leads![0]!;
  expect(row().messages_today).toEqual([
    {
      session_id: worker.id,
      lead: 1,
      tracker: 1,
      handbacks: 1,
      subagents: 2,
      reviews: 1,
      gates: 1,
    },
  ]);
  vi.mocked(f.store.now).mockReturnValue(now + DAY);
  expect(row().messages_today).toEqual([
    { session_id: worker.id, lead: 0, tracker: 0, handbacks: 0 },
  ]);
});

it('shows moving lines even without today’s counts and clears them when work ends', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export', depends_on: [] }]);
  await firstTurnEnded(f, lead);
  const worker = await idleTaskSession(f, lead.id, 'export');
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  const turn = f.turns(worker.id)[0]!;
  const pending = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'running', delivery: 'pending' },
    turn.revision,
  );
  collaborationEvent(f, lead, 'task.dispatched', { session_id: worker.id }, now - DAY);
  collaborationEvent(
    f,
    worker,
    'agent.tool.started',
    { tool_call_id: 'running-agent', turn_id: turn.id, name: 'Task' },
    now - DAY,
  );
  collaborationEvent(f, worker, 'session.gate_started', { commands: [] }, now - DAY);
  const review = f.store.insert<Review>('reviews', {
    id: 'running-review',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    round: 1,
    runtimes: ['fixture'],
    state: 'running',
    findings: [],
    session_ids: [],
  });
  const rows = () => f.control.boardView(user, f.project.id, 1).leads![0]!.messages_today;
  expect(rows()).toEqual([
    {
      session_id: worker.id,
      lead: 0,
      tracker: 0,
      handbacks: 0,
      in_flight: ['lead', 'subagent', 'review', 'gate'],
    },
  ]);
  const message = f.store.update<SessionTurn>(
    'session_turns',
    { ...pending, origin: 'lead' },
    pending.revision,
  );
  expect(rows()![0]!.in_flight).toContain('lead');
  f.store.update<SessionTurn>(
    'session_turns',
    { ...message, delivery: 'delivered' },
    message.revision,
  );
  collaborationEvent(
    f,
    worker,
    'agent.tool.completed',
    { tool_call_id: 'running-agent', ok: true },
    now,
  );
  collaborationEvent(f, worker, 'session.gate_checked', { results: [] }, now);
  f.store.update<Review>('reviews', { ...review, state: 'completed' }, review.revision);
  expect(rows()).toEqual([{ session_id: worker.id, lead: 0, tracker: 0, handbacks: 0 }]);
  for (const end of ['session.gate_run_cancelled', 'session.gate_run_failed']) {
    collaborationEvent(f, worker, 'session.gate_started', { commands: [] }, now - DAY);
    expect(rows()![0]!.in_flight).toEqual(['gate']);
    collaborationEvent(f, worker, end, {}, now);
    expect(rows()![0]).not.toHaveProperty('in_flight');
  }
});

it('orders today’s handbacks and model changes and leaves out yesterday and unchanged models', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export', depends_on: [] }]);
  await firstTurnEnded(f, lead);
  const worker = await idleTaskSession(f, lead.id, 'export');
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  const row = () => f.control.boardView(user, f.project.id, 1).leads![0]!;
  expect(row()).not.toHaveProperty('events_today');
  collaborationEvent(f, lead, 'task.handed_back', { session_id: worker.id }, now - DAY);
  collaborationEvent(f, worker, 'session.model_changed', { model: 'old-model' }, now - DAY);
  collaborationEvent(f, lead, 'task.handed_back', { session_id: worker.id }, now - 300);
  collaborationEvent(f, worker, 'session.model_changed', { model: 'new-model' }, now - 200);
  collaborationEvent(
    f,
    worker,
    'session.model_changed',
    { model: 'new-model', effort: 'high' },
    now - 150,
  );
  const turn = f.turns(worker.id)[0]!;
  collaborationEvent(f, turn, 'turn.queued', { ...turn, origin: 'tracker' }, now - 100);
  expect(row().events_today).toEqual([
    { at: now - 300, kind: 'handback', session_id: worker.id },
    { at: now - 200, kind: 'model_change', session_id: worker.id },
    { at: now - 100, kind: 'handback', session_id: worker.id },
  ]);
});

it('keeps only the newest two hundred collaboration events in time order', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [{ id: 'export', title: 'Export', depends_on: [] }]);
  await firstTurnEnded(f, lead);
  const worker = await idleTaskSession(f, lead.id, 'export');
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  f.store.transaction(() => {
    for (let index = 0; index < 205; index++)
      collaborationEvent(f, lead, 'task.handed_back', { session_id: worker.id }, now - 205 + index);
  });
  const events = f.control.boardView(user, f.project.id, 1).leads![0]!.events_today!;
  expect(events).toHaveLength(200);
  expect(events[0]).toEqual({ at: now - 200, kind: 'handback', session_id: worker.id });
  expect(events.at(-1)).toEqual({ at: now - 1, kind: 'handback', session_id: worker.id });
});
