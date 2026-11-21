import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { BoardPlan, Principal, ProjectRead, Session, WorkflowPolicy } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { workflowPolicy } from '../../packages/control/dist/workflow-policy.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

async function setup() {
  const f = await workbenchFixture({ delay: 10 });
  dispatchEveryTier(f);
  const lead = await f.create('Plan a report');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () =>
      f.store.must<Session>('sessions', lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const emit = f.start.mock.calls[0]![1];
  let sequence = 1000;
  const quota = (windows: { window: string; used_percent: number; resets_at?: number }[]) =>
    emit({
      kind: 'quota.updated',
      windows,
      key: String(++sequence),
      provider_sequence: sequence,
    });
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  return { ...f, lead, quota, ctx };
}

it('shares the latest quota across sessions and retains it through a runtime status refresh', async () => {
  const f = await setup();
  const seenAt = f.store.now();
  vi.spyOn(f.store, 'now').mockReturnValue(seenAt);
  const reset = seenAt + 60000;
  f.quota([{ window: 'five_hour', used_percent: 92, resets_at: reset }]);
  const second = await f.create('Read the plan');
  await awaitWorkspaceReady(f.control, second.workspace_id!);
  await eventually(
    () => f.start.mock.calls.length === 2,
    () => f.control.tick(),
  );
  f.start.mock.calls[1]![1]({
    kind: 'quota.updated',
    key: 'weekly-quota',
    provider_sequence: 1000,
    windows: [{ window: 'seven_day', used_percent: 40, resets_at: reset + 60000 }],
  });
  const expected = {
    windows: [
      { window: 'five_hour', used_percent: 92, resets_at: reset },
      { window: 'seven_day', used_percent: 40, resets_at: reset + 60000 },
    ],
    seen_at: seenAt,
  };
  expect(await f.control.runtimeStatus(user)).toEqual([
    expect.objectContaining({ runtime: 'fixture', quota: expected }),
    expect.objectContaining({ runtime: 'claude' }),
    expect.objectContaining({ runtime: 'codex' }),
    expect.objectContaining({ runtime: 'opencode' }),
    expect.objectContaining({ runtime: 'grok' }),
    expect.objectContaining({ runtime: 'agy' }),
    expect.objectContaining({ runtime: 'dsh' }),
    expect.objectContaining({ runtime: 'muse' }),
    expect.objectContaining({ runtime: 'cursor' }),
    expect.objectContaining({ runtime: 'copilot' }),
    expect.objectContaining({ runtime: 'gemini' }),
    expect.objectContaining({ runtime: 'kilo' }),
    expect.objectContaining({ runtime: 'cline' }),
    expect.objectContaining({ runtime: 'qwen' }),
    expect.objectContaining({ runtime: 'kimi' }),
    expect.objectContaining({ runtime: 'goose' }),
    expect.objectContaining({ runtime: 'openhands' }),
    expect.objectContaining({ runtime: 'auggie' }),
    expect.objectContaining({ runtime: 'kiro' }),
    expect.objectContaining({ runtime: 'junie' }),
    expect.objectContaining({ runtime: 'devin' }),
    expect.objectContaining({ runtime: 'vibe' }),
    expect.objectContaining({ runtime: 'hermes' }),
    expect.objectContaining({ runtime: 'omp' }),
    expect.objectContaining({ runtime: 'codebuddy' }),
    expect.objectContaining({ runtime: 'droid' }),
    expect.objectContaining({ runtime: 'qoder' }),
  ]);
  Object.assign(f.adapter, {
    preflight: async () => ({
      installed: true,
      version: '1',
      min_version: null,
      version_ok: true,
      auth: { state: 'unknown' },
    }),
  });
  expect(await f.control.runtimeStatus(user, true)).toEqual([
    expect.objectContaining({ runtime: 'fixture', quota: expected }),
    expect.objectContaining({ runtime: 'claude' }),
    expect.objectContaining({ runtime: 'codex' }),
    expect.objectContaining({ runtime: 'opencode' }),
    expect.objectContaining({ runtime: 'grok' }),
    expect.objectContaining({ runtime: 'agy' }),
    expect.objectContaining({ runtime: 'dsh' }),
    expect.objectContaining({ runtime: 'muse' }),
    expect.objectContaining({ runtime: 'cursor' }),
    expect.objectContaining({ runtime: 'copilot' }),
    expect.objectContaining({ runtime: 'gemini' }),
    expect.objectContaining({ runtime: 'kilo' }),
    expect.objectContaining({ runtime: 'cline' }),
    expect.objectContaining({ runtime: 'qwen' }),
    expect.objectContaining({ runtime: 'kimi' }),
    expect.objectContaining({ runtime: 'goose' }),
    expect.objectContaining({ runtime: 'openhands' }),
    expect.objectContaining({ runtime: 'auggie' }),
    expect.objectContaining({ runtime: 'kiro' }),
    expect.objectContaining({ runtime: 'junie' }),
    expect.objectContaining({ runtime: 'devin' }),
    expect.objectContaining({ runtime: 'vibe' }),
    expect.objectContaining({ runtime: 'hermes' }),
    expect.objectContaining({ runtime: 'omp' }),
    expect.objectContaining({ runtime: 'codebuddy' }),
    expect.objectContaining({ runtime: 'droid' }),
    expect.objectContaining({ runtime: 'qoder' }),
  ]);
});

it.each(['reset', 'snapshot'] as const)(
  'holds a lead task at the threshold and dispatches after a %s',
  async (release) => {
    const f = await setup();
    let clock = f.store.now();
    vi.spyOn(f.store, 'now').mockImplementation(() => clock);
    const threshold = release === 'reset' ? 90 : 80;
    if (release === 'snapshot') {
      const policy = f.store.must<WorkflowPolicy>('workflow_policies', f.project.id);
      f.call(
        'workflow.policy.set',
        { project_id: f.project.id, runtime_quota_threshold: threshold },
        policy.revision,
      );
    }
    const other = new FixtureAdapter(10);
    other.name = 'other';
    f.ctx.adapters.set(other.name, other);
    const principal: Principal = {
      id: `session:${f.lead.id}`,
      role: 'lead',
      session_id: f.lead.id,
      project_id: f.project.id,
      expires_at: clock + 600000,
    };
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Answer',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'answer',
            title: 'Answer',
            lane: 'core',
            goal: 'Explain the result',
            depends_on: [],
            source: ['Plan a report'],
            scope: [],
            acceptance: [],
            done_when: 'report',
          },
          {
            id: 'independent',
            title: 'Independent',
            lane: 'core',
            goal: 'Read the result',
            runtime: 'other',
            depends_on: [],
            source: ['Plan a report'],
            scope: [],
            acceptance: [],
            done_when: 'report',
          },
        ],
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      principal,
    );
    f.quota([
      { window: 'five_hour', used_percent: 20, resets_at: clock + 30000 },
      { window: 'seven_day', used_percent: threshold, resets_at: clock + 60000 },
    ]);
    f.call(
      'task.start',
      { project_id: f.project.id, task_ids: ['answer', 'independent'] },
      null,
      principal,
    );
    await f.control.tick();
    const leadView = f.control.projectRead(principal, f.project.id) as ProjectRead;
    expect(
      leadView.plans
        .find((plan) => plan.lead_session_id === f.lead.id)!
        .tasks.find((task) => task.id === 'answer'),
    ).toHaveProperty('dispatch_wait', 'runtime_limited');
    expect(
      f.store
        .list<Session>('sessions')
        .filter((session) => session.task)
        .map((session) => session.runtime),
    ).toEqual(['other']);
    if (release === 'reset') clock += 60000;
    else {
      clock++;
      f.quota([{ window: 'seven_day', used_percent: threshold - 1, resets_at: clock + 60000 }]);
    }
    await f.control.tick();
    expect(f.store.list<Session>('sessions').filter((session) => session.task)).toHaveLength(2);
    expect(f.store.must<BoardPlan>('board_plans', f.lead.id).dispatch).toEqual({});
  },
);

it('defaults the quota threshold for stored policies and validates user changes as percentages', async () => {
  const f = await setup();
  expect(workflowPolicy(f.ctx, f.project.id)).toHaveProperty('runtime_quota_threshold', 90);
  let policy = f.store.must<WorkflowPolicy>('workflow_policies', f.project.id);
  const { runtime_quota_threshold: _, ...old } = policy;
  f.store.update('workflow_policies', old, policy.revision);
  expect(workflowPolicy(f.ctx, f.project.id)).toHaveProperty('runtime_quota_threshold', 90);
  policy = f.store.must<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, runtime_quota_threshold: 80 },
    policy.revision,
  );
  expect(workflowPolicy(f.ctx, f.project.id)).toHaveProperty('runtime_quota_threshold', 80);
  policy = f.store.must<WorkflowPolicy>('workflow_policies', f.project.id);
  for (const value of [-1, 101])
    expect(() =>
      f.call(
        'workflow.policy.set',
        { project_id: f.project.id, runtime_quota_threshold: value },
        policy.revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
});
