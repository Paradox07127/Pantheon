import { afterEach, expect, it, vi } from 'vitest';
import { id, type Principal, type ProjectPlan, type Session } from '@pantheon/domain';
import type { ProjectPlanResult } from '@pantheon/protocol';
import { settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanInput = { milestones: { id: string; title: string }[]; items: Record<string, unknown>[] };

afterEach(() => {
  vi.restoreAllMocks();
});

const principalOf = (f: Fixture, sessionId: string, role: Principal['role']): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

async function openConductor(f: Fixture) {
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  await settle(f, session);
  return session;
}

/** The error a command throws, whether it runs at once or after reading git. */
async function refusal(run: () => unknown): Promise<{ code?: string; message?: string }> {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

const exportPlan: PlanInput = {
  milestones: [{ id: 'export', title: 'Export ships' }],
  items: [
    { id: 'parser', title: 'Parse the export format', milestone: 'export' },
    {
      id: 'writer',
      title: 'Write the export file',
      milestone: 'export',
      depends_on: ['parser'],
      acceptance: ['The file opens in the viewer'],
    },
  ],
};

async function planFixture() {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const write = (plan: PlanInput, session: Session = conductor) =>
    f.call<Promise<ProjectPlanResult>>(
      'conductor.plan_set',
      plan,
      null,
      principalOf(f, session.id, 'conductor'),
    );
  const readState = (session: Session = conductor) =>
    f.call<Promise<{ plan: ProjectPlan | null }>>(
      'conductor.state',
      {},
      null,
      principalOf(f, session.id, 'conductor'),
    );
  const stored = () => f.store.get<ProjectPlan>('project_plans', f.project.id);
  const accept = (itemId: string, accepted = true, principal: Principal = user) =>
    f.call<Promise<ProjectPlanResult>>(
      'project.plan.accept',
      { project_id: f.project.id, item_id: itemId, accepted },
      stored()?.revision ?? null,
      principal,
    );
  /** A session row of the project, spawned by the given session when there is one. */
  const sessionRow = (spawner?: Session, extra: Partial<Session> = {}) =>
    f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 0,
      ...(spawner ? { spawned_by: { session_id: spawner.id } } : {}),
      ...extra,
    });
  return { f, conductor, write, readState, stored, accept, sessionRow };
}

it('stores the plan a main agent writes and gives the same plan back through read_state', async () => {
  const { f, conductor, write, readState } = await planFixture();
  expect((await readState()).plan).toBeNull();

  const receipt = await write(exportPlan);

  expect(receipt.revision).toBe(1);
  expect(receipt.plan).toEqual({
    id: f.project.id,
    revision: 1,
    project_id: f.project.id,
    session_id: conductor.id,
    milestones: exportPlan.milestones,
    items: exportPlan.items,
    updated_at: expect.any(String),
  });
  expect((await readState()).plan).toEqual(receipt.plan);
  expect(
    f.store.kindEvents(f.project.id, ['project.plan_updated']).map((event) => event.payload),
  ).toEqual([{ session_id: conductor.id, items: 2, revision: 1 }]);
});

it('takes two writes without a revision and the later one wins', async () => {
  const { write, stored } = await planFixture();

  await write(exportPlan);
  const second = await write({ ...exportPlan, items: [exportPlan.items[0]!] });

  expect(second.revision).toBe(2);
  expect(stored()).toMatchObject({ revision: 2, items: [exportPlan.items[0]] });
});

it.each(['user', 'writer session'] as const)(
  'refuses conductor.plan_set from the %s',
  async (caller) => {
    const { f } = await planFixture();
    const principal =
      caller === 'user' ? user : principalOf(f, (await f.create('Write the parser')).id, 'writer');

    const refused = await refusal(() => f.call('conductor.plan_set', exportPlan, null, principal));

    expect(refused.code).toBe('permission_denied');
    expect(f.store.get('project_plans', f.project.id)).toBeUndefined();
  },
);

it.each([
  [
    'an item id twice',
    {
      milestones: [],
      items: [
        { id: 'parser', title: 'One' },
        { id: 'parser', title: 'Two' },
      ],
    },
    'parser',
  ],
  [
    'a milestone id twice',
    {
      milestones: [
        { id: 'export', title: 'One' },
        { id: 'export', title: 'Two' },
      ],
      items: [],
    },
    'export',
  ],
  [
    'a milestone the plan does not have',
    { milestones: [], items: [{ id: 'parser', title: 'Parse', milestone: 'import' }] },
    'import',
  ],
  [
    'a dependency the plan does not have',
    { milestones: [], items: [{ id: 'parser', title: 'Parse', depends_on: ['lexer'] }] },
    'lexer',
  ],
  [
    'a dependency cycle',
    {
      milestones: [],
      items: [
        { id: 'parser', title: 'Parse', depends_on: ['writer'] },
        { id: 'writer', title: 'Write', depends_on: ['checker'] },
        { id: 'checker', title: 'Check', depends_on: ['parser'] },
      ],
    },
    'parser',
  ],
] satisfies [string, PlanInput, string][])(
  'refuses a plan with %s and names the id',
  async (_case, plan, named) => {
    const { write, stored } = await planFixture();

    const refused = await refusal(() => write(plan));

    expect(refused).toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining(named),
    });
    expect(stored()).toBeUndefined();
  },
);

it('refuses an item that names one session twice', async () => {
  const { conductor, write, stored } = await planFixture();

  const refused = await refusal(() =>
    write({
      milestones: [],
      items: [{ id: 'parser', title: 'Parse', session_ids: [conductor.id, conductor.id] }],
    }),
  );

  expect(refused).toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining(`session ${conductor.id} twice`),
  });
  expect(stored()).toBeUndefined();
});

it.each([
  ['itself', 'accepted'],
  ['a session it spawned', 'accepted'],
  ['another main agent', 'accepted'],
  ['a session another main agent spawned', 'accepted'],
  ['a session the user opened', 'invalid_input'],
  ['a session of another project', 'invalid_input'],
  ['a session that does not exist', 'invalid_input'],
] as const)('lets a plan item name %s: %s', async (named, outcome) => {
  const { f, conductor, write, sessionRow } = await planFixture();
  const otherConductor = sessionRow(undefined, { conductor: true });
  const sessionId = {
    itself: () => conductor.id,
    'a session it spawned': () => sessionRow(conductor).id,
    'another main agent': () => otherConductor.id,
    'a session another main agent spawned': () => sessionRow(otherConductor).id,
    'a session the user opened': () => sessionRow().id,
    'a session of another project': () =>
      sessionRow(conductor, { project_id: 'another-project' }).id,
    'a session that does not exist': () => 'missing-session',
  }[named]();
  const plan = {
    milestones: [],
    items: [{ id: 'parser', title: 'Parse', session_ids: [sessionId] }],
  };

  if (outcome === 'accepted') {
    expect((await write(plan)).plan.items[0]!.session_ids).toEqual([sessionId]);
    return;
  }
  const refused = await refusal(() => write(plan));
  expect(refused).toMatchObject({ code: outcome, message: expect.stringContaining(sessionId) });
  expect(f.store.get('project_plans', f.project.id)).toBeUndefined();
});

it('keeps an item the user accepted: a plan without it is refused, one marking it dropped is stored and the acceptance stays', async () => {
  const { write, accept, stored } = await planFixture();
  await write(exportPlan);
  await accept('parser');
  const acceptedAt = stored()!.items[0]!.accepted;
  expect(acceptedAt).toEqual({ at: expect.any(String) });

  const refused = await refusal(() =>
    write({ ...exportPlan, items: [{ id: 'writer', title: 'Write the export file' }] }),
  );
  expect(refused).toMatchObject({
    code: 'invalid_input',
    message: expect.stringMatching(/parser.*dropped/),
  });
  expect(stored()!.revision).toBe(2);

  const renamed = await write({
    ...exportPlan,
    items: [{ id: 'parser', title: 'Parse the new export format' }, exportPlan.items[1]!],
  });
  expect(renamed.plan.items[0]).toEqual({
    id: 'parser',
    title: 'Parse the new export format',
    accepted: acceptedAt,
  });

  const dropped = await write({
    ...exportPlan,
    items: [{ id: 'parser', title: 'Parse the export format', dropped: true }],
  });
  expect(dropped.plan.items).toEqual([
    { id: 'parser', title: 'Parse the export format', dropped: true, accepted: acceptedAt },
  ]);
});

it('keeps the time a session was first named on an item and times a newly named one', async () => {
  const { f, conductor, write, sessionRow } = await planFixture();
  const spawned = sessionRow(conductor);
  const first = Date.parse('2026-11-23T10:00:00.000Z');
  vi.spyOn(f.store, 'now').mockReturnValue(first);
  await write({
    milestones: [],
    items: [{ id: 'parser', title: 'Parse', session_ids: [conductor.id] }],
  });

  vi.spyOn(f.store, 'now').mockReturnValue(first + 60_000);
  const { plan } = await write({
    milestones: [],
    items: [{ id: 'parser', title: 'Parse', session_ids: [conductor.id, spawned.id] }],
  });

  expect(plan.items[0]!.named_at).toEqual({
    [conductor.id]: '2026-11-23T10:00:00.000Z',
    [spawned.id]: '2026-11-23T10:01:00.000Z',
  });
  expect(plan.updated_at).toBe('2026-11-23T10:01:00.000Z');
});

it('lets only the user accept an item, records it and takes the acceptance back', async () => {
  const { f, conductor, write, accept, stored } = await planFixture();
  await write(exportPlan);

  const byAgent = await refusal(() =>
    accept('parser', true, principalOf(f, conductor.id, 'conductor')),
  );
  expect(byAgent.code).toBe('permission_denied');
  expect((await refusal(() => accept('lexer'))).code).toBe('not_found');

  const accepted = await accept('parser');
  expect(accepted.revision).toBe(2);
  expect(accepted.plan.items[0]).toMatchObject({
    id: 'parser',
    accepted: { at: expect.any(String) },
  });
  const withdrawn = await accept('parser', false);
  expect(withdrawn.plan.items[0]).not.toHaveProperty('accepted');
  expect(stored()).toEqual(withdrawn.plan);
  expect(
    f.store.kindEvents(f.project.id, ['project.plan_accepted']).map((event) => event.payload),
  ).toEqual([
    { item_id: 'parser', accepted: true },
    { item_id: 'parser', accepted: false },
  ]);
});

it('refuses an acceptance without a plan', async () => {
  const { accept } = await planFixture();

  expect((await refusal(() => accept('parser'))).code).toBe('not_found');
});

it('keeps the plan after its main agent closes, and another main agent writes it on', async () => {
  const { f, conductor, write, readState } = await planFixture();
  await write(exportPlan);
  f.store.update(
    'sessions',
    { ...f.store.must<Session>('sessions', conductor.id), state: 'closed' },
    f.store.must<Session>('sessions', conductor.id).revision,
  );
  const next = await openConductor(f);

  expect((await readState(next)).plan).toMatchObject({
    session_id: conductor.id,
    items: exportPlan.items,
  });
  const { plan } = await write({ ...exportPlan, items: [exportPlan.items[0]!] }, next);

  expect(plan).toMatchObject({ session_id: next.id, revision: 2, items: [exportPlan.items[0]] });
});
