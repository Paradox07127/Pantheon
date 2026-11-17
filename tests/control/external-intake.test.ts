import { expect, it } from 'vitest';
import type { BoardPlan, ExternalEvent, Principal, Project, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  receiveExternalEvent,
  type ExternalEventInput,
} from '../../packages/control/dist/external-events.js';
import { dispatchQueue } from '../../packages/control/dist/task-dispatch.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

const MINUTE = 60_000,
  SUBJECT = 'github:acme/reports#12',
  OWN = {
    author: 'taylor',
    own: true,
    text: 'Totals are wrong\n\nThe weekly total counts refunds twice.',
  },
  THEIRS = { author: 'robin', own: false, text: 'It also breaks the monthly export.' };

type PlanTask = BoardPlan['tasks'][number];
const task = (fields: Partial<PlanTask> = {}): PlanTask => ({
  id: 'fix',
  title: 'Fix the weekly total',
  goal: 'Count each refund once',
  lane: 'core',
  depends_on: [],
  source: ['The weekly total counts refunds twice.'],
  scope: ['src/totals'],
  acceptance: ['pnpm test'],
  ...fields,
});

/** A project that takes external events in the given mode, and events that already settled. */
function intakeFixture(mode: 'approve' | 'auto') {
  const f = workbenchFixture({ externalSources: [{ id: 'stub', poll: async () => MINUTE }] }),
    ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  dispatchEveryTier(f);
  const setMode = (next: 'off' | 'approve' | 'auto') =>
    f.call(
      'project.externalEvents.set',
      { project_id: f.project.id, mode: next },
      f.store.must<Project>('projects', f.project.id).revision,
    );
  setMode(mode);
  let reported = 0;
  const report = (fields: Partial<ExternalEventInput> = {}) => {
    const event = receiveExternalEvent(ctx, {
      project_id: f.project.id,
      source: 'github',
      subject_key: SUBJECT,
      dedup_key: `github:501:${reported++}`,
      kind: 'issue_assigned',
      actor: 'taylor',
      actor_trust: 'self',
      title: 'Totals are wrong',
      url: 'https://github.com/acme/reports/issues/12',
      texts: [OWN],
      ...fields,
    });
    f.store.update<ExternalEvent>(
      'external_events',
      { ...event, received_at: event.received_at - 3 * MINUTE },
      event.revision,
    );
  };
  const leads = () => f.store.list<Session>('sessions').filter((s) => s.external_subject);
  const settle = async (sessionId: string) => {
    const session = f.store.must<Session>('sessions', sessionId);
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
      () => f.control.tick(),
    );
  };
  /** Runs the tick that hands the settled events on, and the lead's first turn. */
  const opened = async () => {
    await f.control.tick();
    const [lead] = leads();
    await settle(lead!.id);
    return f.store.must<Session>('sessions', lead!.id);
  };
  const as = (sessionId: string): Principal => ({
    id: `session:${sessionId}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: sessionId,
    expires_at: f.store.now() + 60000,
  });
  const writePlan = (leadId: string, tasks: PlanTask[]) =>
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
        headline: 'Weekly totals are right again',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks,
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      as(leadId),
    );
  const waits = () => dispatchQueue(ctx, f.project.id).map((entry) => entry.wait);
  const needs = () =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.kind === 'external.approval');
  return { ...f, ctx, setMode, report, leads, settle, opened, as, writePlan, waits, needs };
}

it('opens a lead that waits for approval when the project takes events in approve mode', async () => {
  const f = intakeFixture('approve');
  f.report();
  const lead = await f.opened();
  expect(lead).toMatchObject({
    external_subject: SUBJECT,
    external_hold: true,
    title: 'Totals are wrong',
  });
  const [turn] = f.turns(lead.id);
  expect(turn).toMatchObject({ origin: 'external', read_only: true });
  expect(turn!.input).toContain('https://github.com/acme/reports/issues/12');
  expect(turn!.input).toContain('The weekly total counts refunds twice.');
  expect(f.store.list<ExternalEvent>('external_events')).toMatchObject([
    { state: 'handled', session_id: lead.id },
  ]);
  expect(f.needs()).toMatchObject([
    {
      source: { table: 'sessions', id: lead.id },
      reason: 'external_approval',
      actions: [{ command: 'external.approve', allowed: true }],
    },
  ]);
});

it('opens a lead that works at once on an issue the user alone wrote in auto mode', async () => {
  const f = intakeFixture('auto');
  f.report();
  const lead = await f.opened();
  expect(lead.external_hold).toBeUndefined();
  expect(f.turns(lead.id)[0]!.read_only).toBeUndefined();
  expect(f.needs()).toEqual([]);
});

it.each([
  { what: 'someone else wrote part of the text', fields: { texts: [OWN, THEIRS] } },
  { what: 'someone else caused the event', fields: { actor: 'robin', actor_trust: 'write' } },
] as const)('waits for approval in auto mode when $what', async ({ fields }) => {
  const f = intakeFixture('auto');
  f.report({ ...fields, texts: fields.texts ? [...fields.texts] : [OWN] });
  expect((await f.opened()).external_hold).toBe(true);
});

it('opens nothing for a project that stopped taking external events', async () => {
  const f = intakeFixture('approve');
  f.report();
  f.setMode('off');
  await f.control.tick();
  expect(f.leads()).toEqual([]);
  expect(f.store.list<ExternalEvent>('external_events')).toMatchObject([{ state: 'pending' }]);
});

it('opens no task of a held lead until the user approves', async () => {
  const f = intakeFixture('approve');
  f.report();
  const lead = await f.opened();
  f.writePlan(lead.id, [
    task(),
    task({ id: 'own', path: 'direct', flow_reason: 'A one-line fix' }),
  ]);
  f.call('task.start', { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['fix'] });
  expect(f.waits()).toEqual(['approval']);
  expect(() =>
    f.call('task.start', { project_id: f.project.id, task_ids: ['own'] }, null, f.as(lead.id)),
  ).toThrow(/approve/i);
  expect(() => f.call('external.approve', { session_id: lead.id }, null, f.as(lead.id))).toThrow(
    'Action outside session role',
  );

  f.call('external.approve', { session_id: lead.id });
  expect(f.store.must<Session>('sessions', lead.id).external_hold).toBeUndefined();
  expect(f.needs()).toEqual([]);
  expect(f.waits()).toEqual([undefined]);
  expect(f.turns(lead.id).at(-1)).toMatchObject({ origin: 'external' });
  expect(f.turns(lead.id).at(-1)!.input).toMatch(/approved/i);
});

it('sends later events about the same subject to the lead that has it', async () => {
  const f = intakeFixture('auto');
  f.report();
  const lead = await f.opened();
  f.report({ kind: 'mention', actor: 'robin', actor_trust: 'write', texts: [OWN, THEIRS] });
  await f.control.tick();
  await f.settle(lead.id);
  expect(f.leads()).toHaveLength(1);
  const last = f.turns(lead.id).at(-1)!;
  expect(last.origin).toBe('external');
  expect(last.input).toContain('It also breaks the monthly export.');
  expect(last.input).not.toContain('The weekly total counts refunds twice.');
  expect(f.store.must<Session>('sessions', lead.id).external_hold).toBe(true);
});

it('lets a held lead only read, use memory and write its plan until the user approves', async () => {
  const f = intakeFixture('auto');
  f.report();
  const lead = await f.opened();
  f.writePlan(lead.id, [task()]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['fix'] }, null, f.as(lead.id));
  await f.control.tick();
  const worker = f.store
    .list<Session>('sessions')
    .find((session) => session.task?.lead_session_id === lead.id)!;
  await f.settle(worker.id);
  f.report({ kind: 'mention', actor: 'robin', actor_trust: 'write', texts: [OWN, THEIRS] });
  await f.control.tick();
  await f.settle(lead.id);
  expect(f.store.must<Session>('sessions', lead.id).external_hold).toBe(true);

  const message = () =>
    f.call(
      'task.message',
      { project_id: f.project.id, task_id: 'fix', text: 'Also cover the monthly export' },
      null,
      f.as(lead.id),
    );
  const denied = expect.objectContaining({
    code: 'permission_denied',
    message: expect.stringMatching(/approve/i),
  });
  expect(message).toThrow(denied);
  expect(() =>
    f.call(
      'review.request',
      { session_id: worker.id, runtimes: [f.adapter.name] },
      null,
      f.as(lead.id),
    ),
  ).toThrow(denied);
  expect(() =>
    f.call(
      'session.merge',
      { session_id: worker.id },
      f.store.must<Session>('sessions', worker.id).revision,
      f.as(lead.id),
    ),
  ).toThrow(denied);

  expect(f.control.projectRead(f.as(lead.id), f.project.id)).toBeTruthy();
  expect(
    await f.call('board.sync', { project_id: f.project.id }, null, f.as(lead.id)),
  ).toMatchObject({
    brief: expect.any(String),
  });
  const packet = f.call<{ signature: string }>(
    'memory.context',
    { project_id: f.project.id },
    null,
    f.as(lead.id),
  );
  f.call(
    'memory.propose',
    {
      project_id: f.project.id,
      key: 'refunds',
      kind: 'decision',
      text: 'Count refunds once',
      based_on: packet.signature,
    },
    null,
    f.as(lead.id),
  );
  f.writePlan(lead.id, [task({ goal: 'Count each refund once in every export' })]);

  f.call('external.approve', { session_id: lead.id });
  const turns = f.turns(worker.id).length;
  message();
  expect(f.turns(worker.id).length).toBeGreaterThan(turns);
});

it("takes the user's own text of an event as a task source and other people's text only as an external source", async () => {
  const f = intakeFixture('approve');
  f.report({ texts: [OWN, THEIRS] });
  const lead = await f.opened();
  expect(() =>
    f.writePlan(lead.id, [task({ source: ['It also breaks the monthly export.'] })]),
  ).toThrow(/no user message/);
  expect(() => f.writePlan(lead.id, [task({ source: [] })])).toThrow(/source/);
  expect(() =>
    f.writePlan(lead.id, [task({ source: [], external_source: ['Nobody wrote this.'] })]),
  ).toThrow(/external_source/);
  f.writePlan(lead.id, [
    task(),
    task({ id: 'export', source: [], external_source: ['It also breaks the monthly export.'] }),
  ]);
  expect(f.store.must<BoardPlan>('board_plans', lead.id).tasks).toHaveLength(2);
});

it('shows the user how the project takes events, each source and the events newest first', async () => {
  const f = intakeFixture('approve');
  f.report({ kind: 'issue_assigned' });
  f.report({ kind: 'mention', actor: 'spam-bot', actor_trust: 'bot' });
  const read = f.control.externalRead(user, f.project.id);
  expect(read.mode).toBe('approve');
  expect(read.sources).toEqual([{ id: 'stub' }]);
  expect(read.events.map((event) => [event.kind, event.state])).toEqual([
    ['mention', 'dropped'],
    ['issue_assigned', 'pending'],
  ]);
  const session = (await f.opened()).id;
  expect(() => f.control.externalRead(f.as(session), f.project.id)).toThrow(
    'Authenticated user required',
  );
});

it('marks the events failed with the reason when their lead cannot start, and the tick goes on', async () => {
  const f = intakeFixture('auto');
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    { ...project, session_defaults: { runtime: 'absent', permission_mode: 'ask' } },
    project.revision,
  );
  f.report();
  await f.control.tick();
  expect(f.store.list<ExternalEvent>('external_events')).toMatchObject([
    { state: 'failed', error: expect.stringContaining('absent') },
  ]);
  expect(f.leads()).toEqual([]);
  // A later event about the same subject is a new attempt.
  f.store.update<Project>(
    'projects',
    project,
    f.store.must<Project>('projects', project.id).revision,
  );
  f.report();
  await f.control.tick();
  expect(f.leads()).toHaveLength(1);
});
