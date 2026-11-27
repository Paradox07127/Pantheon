import { expect, it, vi } from 'vitest';
import { StatementSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type { Principal, Project, RoleUsage, Session, SessionTurn, Usage } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

async function usageFixture() {
  let clock = Date.now();
  const f = await fixture({ now: () => clock });
  const base = clock;
  const session = (id: string, projectId: string, tags: Partial<Session> = {}) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: projectId,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 0,
      ...tags,
    });
  const turn = (id: string, owner: Session, usage?: Usage) =>
    f.store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id: owner.project_id,
      session_id: owner.id,
      input: 'Usage fixture turn',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
      ...(usage ? { usage } : {}),
    });
  const event = (
    offset: number,
    kind: string,
    aggregate: Session | SessionTurn,
    payload: object = {},
  ) => {
    clock = base + offset;
    f.store.event(kind, aggregate, aggregate.project_id, payload);
  };
  return { ...f, session, turn, event };
}

it('groups project sessions by role and sums their tokens, tool calls and turn time', async () => {
  const f = await usageFixture();
  try {
    const otherRoot = path.join(f.root, 'other');
    mkdirSync(otherRoot);
    const other = await f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
    const writerA = f.session('writer-a', f.project.id);
    const reviewer = f.session('reviewer', f.project.id, { review_id: 'some-review' });
    f.session('main', f.project.id);
    const baselineSession = f.session('baseline', f.project.id, {
      baseline: { baseline_id: 'baseline' },
    });
    const storySession = f.session('story', f.project.id, { change_story: { story_id: 'story' } });
    const writerB = f.session('writer-b', f.project.id);
    const foreign = f.session('foreign-writer', other.id);

    const writerA1 = f.turn('writer-a-1', writerA, {
      input_tokens: 1200,
      cached_input_tokens: 800,
      output_tokens: 300,
    });
    const writerA2 = f.turn('writer-a-2', writerA, { input_tokens: 500, output_tokens: 120 });
    const writerB1 = f.turn('writer-b-1', writerB);
    const reviewer1 = f.turn('reviewer-1', reviewer, { input_tokens: 900, output_tokens: 60 });
    const baseline1 = f.turn('baseline-1', baselineSession, {
      input_tokens: 40,
      cached_input_tokens: 0,
      output_tokens: 4,
    });
    f.turn('story-1', storySession, {
      input_tokens: 10,
      cached_input_tokens: 10,
      output_tokens: 2,
    });
    const foreign1 = f.turn('foreign-1', foreign, {
      input_tokens: 99999,
      cached_input_tokens: 99999,
      output_tokens: 99999,
    });

    f.event(0, 'turn.running', writerA1);
    f.event(10, 'agent.tool.started', writerA);
    f.event(20, 'agent.tool.completed', writerA);
    f.event(30, 'agent.tool.started', writerA);
    f.event(400, 'turn.completed', writerA1);
    f.event(1000, 'turn.running', writerA2);
    f.event(1250, 'turn.failed', writerA2);
    f.event(2000, 'turn.running', writerB1);
    f.event(2100, 'turn.cancelled', writerB1);
    f.event(3000, 'turn.running', reviewer1);
    f.event(3010, 'agent.tool.started', reviewer);
    f.event(4000, 'turn.running', baseline1);
    f.event(4030, 'turn.completed', baseline1);
    f.event(5000, 'turn.running', foreign1);
    f.event(5010, 'agent.tool.started', foreign);
    f.event(9000, 'turn.completed', foreign1);

    const empty = { tool_calls: 0, turn_ms: 0, turns_without_usage: 0 };
    expect(f.control.projectUsageRead(user, f.project.id)).toEqual<RoleUsage[]>([
      {
        ...empty,
        role: 'baseline',
        sessions: 1,
        turns: 1,
        input_tokens: 40,
        cached_input_tokens: 0,
        output_tokens: 4,
        turn_ms: 30,
      },
      {
        ...empty,
        role: 'reviewer',
        sessions: 1,
        turns: 1,
        tool_calls: 1,
        input_tokens: 900,
        cached_input_tokens: null,
        output_tokens: 60,
      },
      {
        ...empty,
        role: 'story',
        sessions: 1,
        turns: 1,
        input_tokens: 10,
        cached_input_tokens: 10,
        output_tokens: 2,
      },
      {
        role: 'user',
        sessions: 3,
        turns: 3,
        tool_calls: 2,
        input_tokens: 1700,
        cached_input_tokens: 800,
        output_tokens: 420,
        turn_ms: 750,
        turns_without_usage: 1,
      },
    ]);
  } finally {
    await f.close();
  }
});

it('counts stored range story sessions, kept or deleted, as story', async () => {
  const f = await usageFixture();
  try {
    const kept = f.session('range-story', f.project.id, {
      range_story: { story_id: 'old-story' },
    });
    f.turn('range-story-1', kept, { input_tokens: 30, output_tokens: 3 });
    f.store.event('session.opened', { id: 'deleted-range-story', revision: 1 }, f.project.id, {
      purpose: 'range_story',
    });
    expect(f.control.projectUsageRead(user, f.project.id)).toEqual<RoleUsage[]>([
      {
        role: 'story',
        sessions: 2,
        turns: 1,
        tool_calls: 0,
        input_tokens: 30,
        cached_input_tokens: null,
        output_tokens: 3,
        turn_ms: 0,
        turns_without_usage: 0,
      },
    ]);
  } finally {
    await f.close();
  }
});

it.each([
  {
    name: 'keeps the usage of a deleted session in the report',
    traceEvents: true,
    usage: { role: 'user', sessions: 1, turns: 1, input_tokens: 10, output_tokens: 5 },
  },
  {
    name: 'counts a turn whose runtime reported no token counts as without usage, also once deleted',
    traceEvents: false,
    usage: { role: 'user', turns: 1, input_tokens: 0, output_tokens: 0, turns_without_usage: 1 },
  },
])('$name', async ({ traceEvents, usage }) => {
  const f = await workbenchFixture();
  if (traceEvents) Object.assign(f.adapter, { traceEvents });
  const session = await f.create('Rename the answer file');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]?.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const before = f.control.projectUsageRead(user, f.project.id);
  expect(before).toMatchObject([usage]);
  if (traceEvents) {
    expect(before[0]!.tool_calls).toBeGreaterThan(0);
    expect(before[0]!.turn_ms).toBeGreaterThan(0);
  }

  f.call(
    'session.delete',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => !f.store.get<Session>('sessions', session.id),
    () => f.control.tick(),
  );
  expect(f.turns(session.id)).toEqual([]);
  expect(f.control.projectUsageRead(user, f.project.id)).toEqual(before);
});

it('refuses a usage read from a principal of another project', async () => {
  const f = await usageFixture();
  try {
    const otherRoot = path.join(f.root, 'other');
    mkdirSync(otherRoot);
    const other = await f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
    const reading = f.session('usage-reader', other.id);
    const foreign: Principal = {
      id: `session:${reading.id}`,
      role: 'planner',
      session_id: reading.id,
      project_id: other.id,
      expires_at: f.store.now() + 60000,
    };
    f.session('writer', f.project.id);
    expect(f.control.projectUsageRead(user, f.project.id)).toMatchObject([
      { role: 'user', sessions: 1 },
    ]);
    expect(() => f.control.projectUsageRead(foreign, f.project.id)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  } finally {
    await f.close();
  }
});

it('serves role usage at the project.usage.read query', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'usage-read-'));
  const work = path.join(root, 'project');
  mkdirSync(work);
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60000,
  });
  try {
    const project = (await daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Usage query', roots: [work] }, null),
    )) as Project;
    daemon.store.insert<Session>('sessions', {
      id: 'query-writer',
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 1,
    });
    daemon.store.insert<SessionTurn>('session_turns', {
      id: 'query-turn',
      revision: 1,
      project_id: project.id,
      session_id: 'query-writer',
      input: 'Usage query turn',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
      usage: { input_tokens: 70, cached_input_tokens: 20, output_tokens: 7 },
    });
    const response = await fetch(`${daemon.url}/v1/project.usage.read?project_id=${project.id}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        role: 'user',
        sessions: 1,
        turns: 1,
        tool_calls: 0,
        input_tokens: 70,
        cached_input_tokens: 20,
        output_tokens: 7,
        turn_ms: 0,
        turns_without_usage: 0,
      },
    ]);
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('attributes kept and deleted turns to local calendar days and their session roles', async () => {
  const f = await usageFixture();
  try {
    const main = f.session('coordinator', f.project.id, { conductor: true });
    const child = f.session('child', f.project.id, { spawned_by: { session_id: main.id } });
    const report = { input_tokens: 12, cached_input_tokens: 3, output_tokens: 2 };
    const turn = f.turn('child-turn', child, report);
    const userSession = f.session('own', f.project.id);
    const ownTurn = f.turn('own-turn', userSession);
    // New York springs forward on March 8. Midnight on March 9 is 04:00 UTC.
    const now = f.store.now();
    f.event(Date.parse('2026-03-08T04:59:59Z') - now, 'session.opened', main);
    f.store.event('session.opened', child, f.project.id, {});
    f.store.event('session.main_agent_decided', child, f.project.id, {
      action: 'spawn',
      main_agent_session_id: main.id,
    });
    f.store.event('turn.queued', turn, f.project.id, { session_id: child.id });
    f.store.event('agent.usage.updated', child, f.project.id, { turn_id: turn.id, ...report });
    f.event(Date.parse('2026-03-08T04:59:59Z') - now, 'turn.completed', turn);
    f.event(Date.parse('2026-03-09T04:00:00Z') - now, 'turn.completed', ownTurn);
    const read = () => f.control.projectUsageDaily(user, f.project.id, 3, 'America/New_York').days;
    const kept = read();
    expect(kept.map((day) => day.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(kept[0]!.roles.find((row) => row.role === 'spawned')).toMatchObject({
      turns: 1,
      ...report,
    });
    expect(kept[1]!.roles).toHaveLength(6);
    expect(kept[1]!.roles.every((row) => row.turns === 0 && row.input_tokens === 0)).toBe(true);
    expect(kept[2]!.roles.find((row) => row.role === 'user')).toMatchObject({
      turns_without_usage: 1,
    });
    f.store.remove('session_turns', turn.id, turn.revision);
    f.store.remove('sessions', child.id, child.revision);
    expect(read()).toEqual(kept);
    expect(f.control.projectUsageRead(user, f.project.id).map((row) => row.role)).toEqual([
      'conductor',
      'spawned',
      'user',
    ]);
  } finally {
    await f.close();
  }
});

it('attributes a deleted child to its spawner when only the notification identifies the spawn', async () => {
  const f = await usageFixture();
  try {
    const child = f.session('child', f.project.id, { spawned_by: { session_id: 'main' } });
    const turn = f.turn('child-turn', child);
    const today = Date.parse('2026-03-09T12:00:00Z') - f.store.now();
    f.event(today - 86400000, 'session.opened', child);
    f.event(today - 86400000, 'session.spawner_notified', child, {
      session_id: 'main',
      approval_id: 'question',
    });
    f.event(today, 'turn.queued', turn, { session_id: child.id });
    f.event(today, 'turn.completed', turn);
    f.store.remove('session_turns', turn.id, turn.revision);
    f.store.remove('sessions', child.id, child.revision);
    expect(f.control.projectUsageRead(user, f.project.id)).toMatchObject([
      { role: 'spawned', sessions: 1, turns: 1 },
    ]);
    const [day] = f.control.projectUsageDaily(user, f.project.id, 1, 'UTC').days;
    expect(day!.roles.find((r) => r.role === 'spawned')).toMatchObject({ sessions: 0, turns: 1 });
  } finally {
    await f.close();
  }
});

it('counts an injected steer on the day delivery completes it', async () => {
  const f = await usageFixture();
  try {
    const session = f.session('writer', f.project.id);
    const queued = f.turn('steer', session);
    const steer = f.store.update<SessionTurn>(
      'session_turns',
      { ...queued, kind: 'steer' },
      queued.revision,
    );
    const midnight = Date.parse('2026-03-09T00:00:00Z') - f.store.now();
    f.event(midnight - 2, 'session.opened', session);
    f.event(midnight - 1, 'turn.queued', steer, { ...steer, state: 'queued', delivery: 'pending' });
    f.event(midnight, 'session.turn.delivery', steer, { delivery: 'delivered' });
    const read = () =>
      f.control
        .projectUsageDaily(user, f.project.id, 2, 'UTC')
        .days.map((day) => day.roles.find((row) => row.role === 'user')!.turns);
    expect(read()).toEqual([0, 1]);
    f.store.remove('session_turns', steer.id, steer.revision);
    f.store.remove('sessions', session.id, session.revision);
    expect(read()).toEqual([0, 1]);
  } finally {
    await f.close();
  }
});

it.each([
  {
    purpose: 'baseline',
    tags: { baseline: { baseline_id: 'baseline' } },
    role: 'baseline',
    failsBeforeRuntime: false,
  },
  {
    purpose: 'change_story',
    tags: { change_story: { story_id: 'story' } },
    role: 'story',
    failsBeforeRuntime: false,
  },
  { purpose: 'intro', tags: { intro: true as const }, role: 'user', failsBeforeRuntime: false },
  {
    purpose: 'baseline',
    tags: { baseline: { baseline_id: 'baseline' } },
    role: 'baseline',
    failsBeforeRuntime: true,
  },
])(
  'preserves running time after deleting a $purpose session (fails before runtime: $failsBeforeRuntime)',
  async ({ purpose, tags, role, failsBeforeRuntime }) => {
    const f = await usageFixture();
    try {
      const helper = f.session('helper', f.project.id, tags);
      const usage = failsBeforeRuntime ? undefined : { input_tokens: 4, output_tokens: 1 };
      const turn = f.turn('helper-turn', helper, usage);
      const midnight = Date.parse('2026-03-09T00:00:00Z') - f.store.now();
      f.event(midnight - 20, 'session.opened', helper, { purpose });
      f.event(midnight - 15, 'turn.queued', turn, { purpose });
      f.event(midnight - 12, 'turn.prepare_started', turn, { session_id: helper.id });
      f.event(midnight - 10, 'turn.running', turn);
      if (usage)
        f.event(midnight - 5, 'agent.usage.updated', helper, { turn_id: turn.id, ...usage });
      f.event(midnight + 10, failsBeforeRuntime ? 'turn.failed' : 'turn.completed', turn);
      const read = () => [
        ...f.control.projectUsageRead(user, f.project.id),
        f.control
          .projectUsageDaily(user, f.project.id, 1, 'UTC')
          .days[0]!.roles.find((r) => r.role === role),
      ];
      const before = read();
      const tokens = usage ? { input_tokens: 4 } : { turns_without_usage: 1 };
      expect(before).toMatchObject([
        { role, sessions: 1, turns: 1, turn_ms: 20, ...tokens },
        { role, sessions: 0, turns: 1, turn_ms: 20, ...tokens },
      ]);
      f.store.remove('session_turns', turn.id, turn.revision);
      f.store.remove('sessions', helper.id, helper.revision);
      expect(read()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it('bounds one day of usage reads independently of historical events and foreign turns', async () => {
  const rowsRead = async (historicalTurns: number) => {
    const f = await usageFixture();
    try {
      const session = f.session('writer', f.project.id);
      const foreign = f.session('foreign-writer', 'other-project');
      const today = Date.parse('2026-03-09T12:00:00Z') - f.store.now();
      const yesterday = today - 86400000;
      f.event(yesterday, 'session.opened', session);
      for (let i = 0; i < historicalTurns; i++) {
        const turn = f.turn('old-' + i, session);
        f.turn('foreign-' + i, foreign);
        f.event(yesterday, 'turn.completed', turn);
        f.event(yesterday, 'agent.message.delta', session, { turn_id: turn.id, text: 'old' });
        f.event(today, 'agent.message.delta', session, { turn_id: turn.id, text: 'late' });
      }
      const turn = f.turn('current', session);
      f.event(today, 'turn.completed', turn);
      f.event(today, 'agent.tool.started', session, { turn_id: turn.id });
      const reads = vi.spyOn(StatementSync.prototype, 'all');
      const iterators = vi.spyOn(StatementSync.prototype, 'iterate').mockImplementation(function (
        this: StatementSync,
        ...args
      ) {
        return this.all(...args).values();
      });
      try {
        const [day] = f.control.projectUsageDaily(user, f.project.id, 1, 'UTC').days;
        expect(day!.roles.find((r) => r.role === 'user')).toMatchObject({
          sessions: 0,
          turns: 1,
          tool_calls: 1,
        });
        return reads.mock.results.reduce((sum, result) => sum + result.value.length, 0);
      } finally {
        iterators.mockRestore();
        reads.mockRestore();
      }
    } finally {
      await f.close();
    }
  };
  const withoutHistory = await rowsRead(0);
  expect(await rowsRead(100)).toBe(withoutHistory);
});
