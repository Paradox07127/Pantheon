import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type {
  BoardPlan,
  BoardPlanView,
  Principal,
  ProjectRead,
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

async function setup() {
  const f = await fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

const REQUEST = 'Ship the export API and a download button this week.';

function said(
  f: Awaited<ReturnType<typeof setup>>,
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

function leadOf(f: Awaited<ReturnType<typeof setup>>, request: string | null = REQUEST): Principal {
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

function writePlan(f: Awaited<ReturnType<typeof setup>>, principal: Principal, value = plan()) {
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

it('keeps each lead to its own plan', async () => {
  const f = await setup();
  const first = leadOf(f),
    second = leadOf(f);
  writePlan(f, first);
  writePlan(f, second, plan({ headline: 'Second lead plan' }));
  const secondPlan = f.store.must<BoardPlan>('board_plans', second.session_id!);

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
  expect(failure(() => writePlan(f, user)).code).toBe('permission_denied');
});

it('refuses a plan whose tasks or lanes do not line up', async () => {
  const f = await setup();
  const lead = leadOf(f);
  const base = plan();
  const refusal = (value: Record<string, unknown>) =>
    failure(() => writePlan(f, lead, plan(value) as ReturnType<typeof plan>));
  const [api, ui] = base.tasks as [(typeof base.tasks)[number], (typeof base.tasks)[number]];
  const cases: [Record<string, unknown>, string][] = [
    [{ tasks: [{ ...api, lane: 'missing' }, ui] }, 'missing'],
    [{ tasks: [{ ...api, depends_on: ['ui'] }, ui] }, 'api -> ui -> api'],
    [{ tasks: [api, api] }, 'api'],
    [{ lanes: [base.lanes[0], base.lanes[0]] }, 'core'],
    [{ tasks: [api, { ...ui, scope: ['apps/web/../../secrets'] }] }, 'apps/web/../../secrets'],
    [{ tasks: [api, { ...ui, path: 'parallel', flow_reason: 'Two parts' }] }, 'ui'],
    [
      {
        iterations: [{ id: 'typo', title: 'Typo', starts_on: '1900-01-01', ends_on: '2026-01-01' }],
      },
      'typo',
    ],
  ];
  for (const [value, named] of cases) {
    const error = refusal(value);
    expect(error.code, JSON.stringify(value)).toBe('invalid_input');
    expect(error.message).toContain(named);
  }
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});

it("keeps a lane's depth and stops and an assumption's tasks through a whole-plan write", async () => {
  const f = await setup();
  const lead = leadOf(f);
  const lanes = [
    {
      id: 'core',
      title: 'Core',
      depth: 'plan_first',
      stops: ['plan', 'milestone:m1'],
      depth_reason: 'The export format is still open.',
    },
  ];
  const assumptions = [
    { text: 'Exports are CSV only.', id: 'csv', affects: ['api', 'ui'], milestone: 'm1' },
  ];
  const recorded = plan({ lanes, assumptions });
  writePlan(f, lead, recorded);
  const stored = f.store.must<BoardPlan>('board_plans', lead.session_id!);
  expect(stored.lanes).toEqual(lanes);
  expect(stored.assumptions).toEqual(assumptions);
  const read = f.call<ProjectRead>('project.read', { project_id: f.project.id }, null, lead);
  expect(read.plans[0]).toMatchObject({ lanes, assumptions });

  writePlan(f, lead, recorded);
  expect(f.store.must<BoardPlan>('board_plans', lead.session_id!).plan_version).toBe(1);
});

it('reads and resends a plan written without the new fields unchanged', async () => {
  const f = await setup();
  const lead = leadOf(f);
  const assumptions = [{ text: 'Exports are CSV only.' }];
  writePlan(f, lead, plan({ assumptions }));
  const stored = f.store.must<BoardPlan>('board_plans', lead.session_id!);
  expect(stored.lanes).toStrictEqual([{ id: 'core', title: 'Core' }]);
  expect(stored.assumptions).toStrictEqual(assumptions);
  writePlan(f, lead, plan({ assumptions }));
  expect(f.store.must<BoardPlan>('board_plans', lead.session_id!).plan_version).toBe(1);
});

it.each([
  [
    'a repeated assumption id',
    {
      assumptions: [
        { text: 'Exports are CSV only.', id: 'csv' },
        { text: 'Exports stay under 10 MB.', id: 'csv' },
      ],
    },
    'assumptions: assumption id csv is repeated',
  ],
  [
    'an assumption that affects an unknown task',
    { assumptions: [{ text: 'Exports are CSV only.', id: 'csv', affects: ['api', 'search'] }] },
    'assumptions: assumption csv affects unknown task search',
  ],
  [
    'an assumption without an id that affects an unknown task',
    {
      assumptions: [
        { text: 'Exports are CSV only.' },
        { text: `Exports stay small${' x'.repeat(141)}`, affects: ['search'] },
      ],
    },
    `assumptions: assumption 2 (Exports stay small${' x'.repeat(21)}) affects unknown task search`,
  ],
])('refuses a plan with %s', async (_, extra, message) => {
  const f = await setup();
  const lead = leadOf(f);
  expect(failure(() => writePlan(f, lead, plan(extra)))).toMatchObject({
    code: 'invalid_input',
    message,
  });
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});

type PlanTask = ReturnType<typeof plan>['tasks'][number];

it('refuses a task whose source is not a quote of what the user told a lead', async () => {
  const f = await setup();
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

it('accepts a source quoted from the first user message of any lead in the project', async () => {
  const f = await setup();
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

it('refuses a task that names the fixture runtime, which only tests run on', async () => {
  const f = await setup();
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

it('refuses a task with no scope or no acceptance command in the schema', async () => {
  const f = await setup();
  const lead = leadOf(f);
  const [api, ui] = plan().tasks as [PlanTask, PlanTask];
  for (const field of ['scope', 'acceptance'] as const) {
    const error = failure(() => writePlan(f, lead, plan({ tasks: [api, { ...ui, [field]: [] }] })));
    expect((error as Error).name, field).toBe('ZodError');
    expect(error.message).toContain(field);
  }
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
});
