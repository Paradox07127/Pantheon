import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type {
  BoardPlan,
  BoardPlanView,
  Milestone,
  Principal,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

function setup() {
  const f = fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

const REQUEST = 'Ship the export API and a download button this week.';

function said(
  f: ReturnType<typeof setup>,
  sessionId: string,
  input: string,
  origin?: SessionTurn['origin'],
) {
  f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: sessionId,
    input,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    ...(origin ? { origin } : {}),
  });
}

function leadOf(f: ReturnType<typeof setup>, request: string | null = REQUEST): Principal {
  const lead = insertSession(f);
  if (request) said(f, lead.id, request);
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
}

function plan(extra: Record<string, unknown> = {}) {
  return {
    headline: 'Export ships this week',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'api',
        title: 'API',
        goal: 'Serve exports',
        lane: 'core',
        milestone: 'm1',
        depends_on: [],
        source: ['Ship the export API'],
        scope: ['packages/export'],
        acceptance: ['pnpm test'],
      },
      {
        id: 'ui',
        title: 'UI',
        goal: 'Download button',
        lane: 'core',
        milestone: 'm1',
        depends_on: ['api'],
        source: ['a download button'],
        scope: ['apps/web/src/export'],
        acceptance: ['pnpm build', 'pnpm test'],
      },
    ],
    milestones: [
      { id: 'm1', title: 'Export', criteria: ['Exports download'], tasks: ['api', 'ui'] },
    ],
    risks: [],
    assumptions: [],
    ...extra,
  };
}

function writePlan(f: ReturnType<typeof setup>, principal: Principal, value = plan()) {
  return f.call<BoardPlanView>(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version:
        f.store.get<BoardPlan>('board_plans', principal.session_id ?? '')?.plan_version ?? 0,
      ...value,
    },
    null,
    principal,
  );
}

it('keeps each lead to its own plan and milestones', () => {
  const f = setup();
  const first = leadOf(f),
    second = leadOf(f);
  writePlan(f, first);
  writePlan(f, second, plan({ headline: 'Second lead plan' }));
  const secondPlan = f.store.must<BoardPlan>('board_plans', second.session_id!);
  const secondMilestones = () =>
    f.store.list<Milestone>('milestones').filter((m) => m.owner_session_id === second.session_id);
  const before = secondMilestones();
  expect(before).toHaveLength(1);

  const rewritten = writePlan(
    f,
    first,
    plan({
      headline: 'First lead rewrote its plan',
      tasks: [{ ...plan().tasks[0]!, milestone: undefined }],
      milestones: [],
    }),
  );
  expect(rewritten).toMatchObject({
    lead_session_id: first.session_id,
    headline: 'First lead rewrote its plan',
    tasks: [{ id: 'api', session_ids: [], state: 'todo' }],
  });
  expect(f.store.must<BoardPlan>('board_plans', second.session_id!)).toEqual(secondPlan);
  expect(secondMilestones()).toEqual(before);
  expect(
    f.store.list<Milestone>('milestones').find((m) => m.owner_session_id === first.session_id)
      ?.removed_at,
  ).toBeDefined();

  expect(
    failure(() =>
      f.call('milestone.accept', { milestone_id: 'm1', evidence_refs: ['x'] }, null, first),
    ).code,
  ).toBe('not_found');
  expect(failure(() => writePlan(f, user)).code).toBe('permission_denied');
});

it('refuses a plan whose tasks, lanes or milestones do not line up', () => {
  const f = setup();
  const lead = leadOf(f);
  const base = plan();
  const refusal = (value: Record<string, unknown>) =>
    failure(() => writePlan(f, lead, plan(value) as ReturnType<typeof plan>));
  const [api, ui] = base.tasks as [(typeof base.tasks)[number], (typeof base.tasks)[number]];
  const cases: [Record<string, unknown>, string][] = [
    [{ tasks: [{ ...api, lane: 'missing' }, ui] }, 'missing'],
    [{ tasks: [{ ...api, milestone: undefined }, ui] }, 'api'],
    [{ tasks: [api, { ...ui, milestone: 'm2' }] }, 'm2'],
    [{ tasks: [{ ...api, depends_on: ['ui'] }, ui] }, 'api -> ui -> api'],
    [{ tasks: [api, api] }, 'api'],
    [{ lanes: [base.lanes[0], base.lanes[0]] }, 'core'],
    [{ tasks: [api, { ...ui, scope: ['apps/web/../../secrets'] }] }, 'apps/web/../../secrets'],
  ];
  for (const [value, named] of cases) {
    const error = refusal(value);
    expect(error.code, JSON.stringify(value)).toBe('invalid_input');
    expect(error.message).toContain(named);
  }
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});

type PlanTask = ReturnType<typeof plan>['tasks'][number];

it('refuses a task whose source is not a quote of what the user told a lead', () => {
  const f = setup();
  const lead = leadOf(f);
  said(f, lead.session_id!, 'Pantheon: ship the CSV export too', 'tracker');
  const worker = insertSession(f);
  f.store.update<Session>(
    'sessions',
    { ...worker, task: { lead_session_id: lead.session_id!, id: 'api' } },
    worker.revision,
  );
  said(f, worker.id, 'Also ship the PDF export');
  const [api, ui] = plan().tasks as [PlanTask, PlanTask];
  for (const quote of ['Ship the export API by Friday', 'ship the CSV export', 'the PDF export']) {
    const error = failure(() =>
      writePlan(f, lead, plan({ tasks: [api, { ...ui, source: ['a download button', quote] }] })),
    );
    expect(error.code, quote).toBe('invalid_input');
    expect(error.message).toContain('ui');
    expect(error.message).toContain(quote);
    expect(error.message).toContain('verbatim');
  }
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});

it('accepts a source quoted from the first user message of any lead in the project', () => {
  const f = setup();
  const first = leadOf(f);
  expect(writePlan(f, first).tasks.map((task) => task.id)).toEqual(['api', 'ui']);
  const successor = leadOf(f, null);
  expect(writePlan(f, successor).lead_session_id).toBe(successor.session_id);
  expect(f.store.must<BoardPlan>('board_plans', first.session_id!).tasks[0]).toMatchObject({
    source: ['Ship the export API'],
    scope: ['packages/export'],
    acceptance: ['pnpm test'],
  });
});

it('refuses a task that names the fixture runtime, which only tests run on', () => {
  const f = setup();
  const lead = leadOf(f);
  const [api, ui] = plan().tasks as [PlanTask, PlanTask];
  const error = failure(() =>
    writePlan(f, lead, plan({ tasks: [api, { ...ui, runtime: f.adapter.name }] })),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('ui');
  expect(error.message).toContain('fixture');
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});

it('refuses a task with no scope or no acceptance command in the schema', () => {
  const f = setup();
  const lead = leadOf(f);
  const [api, ui] = plan().tasks as [PlanTask, PlanTask];
  for (const field of ['scope', 'acceptance'] as const) {
    const error = failure(() => writePlan(f, lead, plan({ tasks: [api, { ...ui, [field]: [] }] })));
    expect((error as Error).name, field).toBe('ZodError');
    expect(error.message).toContain(field);
  }
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});
