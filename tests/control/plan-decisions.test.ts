import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type {
  BoardPlan,
  MemoryRecord,
  MemorySummary,
  Milestone,
  Principal,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { sourceSignature } from '../../packages/control/dist/memory-access.js';
import { fixture, insertSession, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup() {
  const f = await fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

function leadOf(f: Fixture): Principal {
  const lead = insertSession(f);
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: 'Ship the export API and a download button this week.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000_000,
  };
}

const TASKS = [
  {
    id: 'api',
    title: 'API',
    goal: 'Serve exports',
    lane: 'core',
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
    depends_on: [],
    source: ['a download button'],
    scope: ['apps/web/src/export'],
    acceptance: ['pnpm test'],
    milestone: 'release',
  },
];
const CSV = { id: 'csv', text: 'Exports are CSV only.', affects: ['ui'], milestone: 'release' };
const LOOSE = { id: 'size', text: 'Exports stay under 10 MB.' };

function writePlan(
  f: Fixture,
  lead: Principal,
  { assumptions = [CSV, LOOSE], risks = [] }: { assumptions?: unknown[]; risks?: unknown[] } = {},
) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: TASKS,
      milestones: [
        { id: 'release', title: 'Release', criteria: ['Exports download'], tasks: ['ui'] },
      ],
      risks,
      assumptions,
    },
    null,
    lead,
  );
}

const planOf = (f: Fixture, lead: Principal) =>
  f.store.get<BoardPlan>('board_plans', lead.session_id!);
const plan = (f: Fixture, lead: Principal) => planOf(f, lead)!;

function edit(f: Fixture, principal: Principal, lead: Principal, ops: unknown[]) {
  return f.call<{ edit_id: string; applied: boolean }>(
    'board.plan.edit',
    {
      project_id: f.project.id,
      ...(principal.role === 'user' ? { lead_session_id: lead.session_id } : {}),
      base_version: plan(f, lead).plan_version,
      ops,
    },
    null,
    principal,
  );
}

const refute = (assumption_id: string, instead = 'Exports are CSV and JSON.') => ({
  type: 'refute_assumption',
  assumption_id,
  instead,
});

const resolve = (
  f: Fixture,
  lead: Principal,
  editId: string,
  decision: 'apply' | 'reject',
  reason?: string,
) =>
  edit(f, lead, lead, [
    { type: 'resolve_edit', edit_id: editId, decision, ...(reason ? { reason } : {}) },
  ]);

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const entries = (f: Fixture, filters: Record<string, unknown> = {}): MemorySummary[] =>
  f.control.memoryRead(user, f.project.id, { origin: 'plan', state: 'all', ...filters }).records;
const stored = (f: Fixture, memoryId: string) =>
  f.store.must<MemoryRecord>('memory_records', memoryId);
const release = (f: Fixture, lead: Principal) =>
  f.store
    .list<Milestone>('milestones')
    .find((row) => row.owner_session_id === lead.session_id && row.key === 'release')!;
const budgetItems = (f: Fixture) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.kind === 'memory.decision_budget');

it('writes a refuted decision when the lead applies a refute and a confirmed one when it rejects', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const applied = edit(f, user, lead, [refute('csv')]);
  resolve(f, lead, applied.edit_id, 'apply');

  const [first, ...others] = entries(f);
  expect(others).toEqual([]);
  expect(first).toMatchObject({
    key: `plan:${lead.session_id}:assumption:csv`,
    kind: 'decision',
    state: 'active',
    authority: 'agent_reported',
    tags: ['plan-decision', 'assumption'],
    origin: {
      kind: 'plan',
      lead_session_id: lead.session_id,
      milestone_id: release(f, lead).id,
      subject: 'assumption',
      subject_id: 'csv',
      outcome: 'refuted',
      edit_id: applied.edit_id,
      plan_version: plan(f, lead).plan_version,
    },
  });
  expect(stored(f, first!.id).author).toBe('pantheon:plan');

  const rejected = edit(f, user, lead, [refute('size', 'Exports reach 1 GB.')]);
  resolve(f, lead, rejected.edit_id, 'reject', 'Exports are capped at 10 MB');

  const size = entries(f).find((entry) => entry.origin?.subject_id === 'size')!;
  expect(size).toMatchObject({
    kind: 'decision',
    authority: 'agent_reported',
    origin: { outcome: 'confirmed', edit_id: rejected.edit_id },
  });
  expect(size.origin).not.toHaveProperty('milestone_id');
  expect(entries(f)).toHaveLength(2);
});

it('adds no version when the lead rejects the same refute again', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  for (let round = 0; round < 2; round++) {
    const { edit_id } = edit(f, user, lead, [refute('csv')]);
    resolve(f, lead, edit_id, 'reject', 'JSON waits for the next release');
  }

  expect(entries(f)).toHaveLength(1);
});

it('keeps two versions with one current when an applied assumption is kept later', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const applied = edit(f, user, lead, [refute('csv')]);
  resolve(f, lead, applied.edit_id, 'apply');
  const rejected = edit(f, user, lead, [refute('csv', 'Exports are JSON only.')]);
  resolve(f, lead, rejected.edit_id, 'reject', 'CSV stays');

  const versions = entries(f);
  expect(versions).toHaveLength(2);
  expect(versions.filter((entry) => entry.state === 'active')).toMatchObject([
    { origin: { outcome: 'confirmed' } },
  ]);
  expect(versions.find((entry) => entry.state === 'archived')).toMatchObject({
    reason: 'superseded',
    origin: { outcome: 'refuted' },
  });
});

it('writes nothing for a pending or withdrawn refute, or for a rewrite of the plan text', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const { edit_id } = edit(f, user, lead, [refute('csv')]);
  expect(entries(f)).toEqual([]);

  f.call('board.plan.edit.withdraw', {
    project_id: f.project.id,
    lead_session_id: lead.session_id,
    edit_id,
  });
  expect(entries(f)).toEqual([]);

  writePlan(f, lead, { assumptions: [{ ...CSV, text: 'Exports are CSV or TSV.' }] });
  expect(entries(f)).toEqual([]);
});

it('writes a closed decision for each risk that leaves the plan, and none when four leave at once', async () => {
  const f = await setup();
  const lead = leadOf(f);
  const PERF = { id: 'perf', text: 'Large exports time out.', milestone: 'release' };
  const LOGIN = { text: 'Exports  need a  sign-in.' };
  writePlan(f, lead, { risks: [PERF, LOGIN] });

  writePlan(f, lead, { risks: [{ text: 'exports need a sign-in.' }] });
  expect(entries(f)).toMatchObject([
    {
      key: `plan:${lead.session_id}:risk:perf`,
      kind: 'decision',
      tags: ['plan-decision', 'risk'],
      origin: {
        subject: 'risk',
        subject_id: 'perf',
        outcome: 'closed',
        milestone_id: release(f, lead).id,
      },
    },
  ]);

  writePlan(f, lead, { risks: [] });
  const login = entries(f).find((entry) => entry.origin?.subject_id !== 'perf')!;
  expect(login.origin).toMatchObject({ subject: 'risk', outcome: 'closed' });
  expect(login.origin!.subject_id).toMatch(/^[0-9a-f]{12}$/);
  expect(login.key).toBe(`plan:${lead.session_id}:risk:${login.origin!.subject_id}`);

  const four = ['one', 'two', 'three', 'four'].map((name) => ({ id: name, text: `Risk ${name}` }));
  writePlan(f, lead, { risks: four });
  writePlan(f, lead, { risks: [{ text: 'A new risk.' }] });
  expect(entries(f)).toHaveLength(2);
});

it('refuses an origin in a proposal', async () => {
  const f = await setup();

  expect(() =>
    f.call('memory.propose', {
      project_id: f.project.id,
      key: 'plan/forged',
      kind: 'decision',
      text: 'A forged plan decision.',
      origin: { kind: 'plan' },
    }),
  ).toThrow(/origin/);
});

it('keeps a plan decision that does not fit the budget as a lasting note and asks the user', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const draft = f.call<MemoryRecord>('memory.propose', {
    project_id: f.project.id,
    key: 'rules/long',
    kind: 'decision',
    text: 'x'.repeat(11_000),
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const { edit_id } = edit(f, user, lead, [refute('csv')]);

  resolve(f, lead, edit_id, 'apply');

  expect(plan(f, lead).assumptions[0]!.text).toBe('Exports are CSV and JSON.');
  const [note] = entries(f);
  expect(note).toMatchObject({
    kind: 'note',
    state: 'active',
    authority: 'agent_reported',
    origin: { outcome: 'refuted' },
  });
  expect(budgetItems(f)).toMatchObject([
    {
      source: { table: 'memory_records', id: note!.id },
      reason: 'plan_decisions_over_budget',
      decision: 'budget',
      memory_notes: { count: 1, memory_ids: [note!.id] },
    },
  ]);

  const later = f.store.now() + 100 * 24 * 60 * 60 * 1000;
  vi.spyOn(f.store, 'now').mockImplementation(() => later);
  expect(entries(f, { state: 'active' }).map((entry) => entry.id)).toEqual([note!.id]);

  f.call('memory.archive', { memory_id: note!.id }, stored(f, note!.id).revision);
  expect(budgetItems(f)).toEqual([]);
});

it("leaves the reports' sources alone for a plan decision, not for a user decision", async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const before = sourceSignature(ctxOf(f), f.project.id);
  const { edit_id } = edit(f, user, lead, [refute('csv')]);
  resolve(f, lead, edit_id, 'reject', 'CSV stays');
  expect(entries(f)).toHaveLength(1);

  expect(sourceSignature(ctxOf(f), f.project.id)).toBe(before);

  const draft = f.call<MemoryRecord>('memory.propose', {
    project_id: f.project.id,
    key: 'rules/csv',
    kind: 'decision',
    text: 'Exports stay CSV.',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  expect(sourceSignature(ctxOf(f), f.project.id)).not.toBe(before);
});
