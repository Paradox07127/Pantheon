import { expect, it } from 'vitest';
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
  const event = (offset: number, kind: string, aggregate: Session | SessionTurn) => {
    clock = base + offset;
    f.store.event(kind, aggregate, aggregate.project_id, {});
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
        role: 'main',
        sessions: 3,
        turns: 3,
        tool_calls: 2,
        input_tokens: 1700,
        cached_input_tokens: 800,
        output_tokens: 420,
        turn_ms: 750,
        turns_without_usage: 1,
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
    ]);
  } finally {
    await f.close();
  }
});

it.each([
  {
    name: 'keeps the usage of a deleted session in the report',
    traceEvents: true,
    usage: { role: 'main', sessions: 1, turns: 1, input_tokens: 10, output_tokens: 5 },
  },
  {
    name: 'counts a turn whose runtime reported no token counts as without usage, also once deleted',
    traceEvents: false,
    usage: { role: 'main', turns: 1, input_tokens: 0, output_tokens: 0, turns_without_usage: 1 },
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
      { role: 'main', sessions: 1 },
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
        role: 'main',
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
