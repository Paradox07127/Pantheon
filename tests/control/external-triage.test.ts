import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  ExternalEvent,
  LeadNote,
  Principal,
  Project,
  Session,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  receiveExternalEvent,
  type ExternalEventInput,
} from '../../packages/control/dist/external-events.js';
import { dispatchQueue } from '../../packages/control/dist/task-dispatch.js';
import { eventually, user } from '../helpers.js';
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

/** A project that takes external events in the given mode, on a clock the test can move on. */
function triageFixture(mode: 'approve' | 'auto') {
  const f = workbenchFixture({ externalSources: [{ id: 'stub', poll: async () => MINUTE }] }),
    ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  dispatchEveryTier(f);
  f.call(
    'project.externalEvents.set',
    { project_id: f.project.id, mode },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  let reported = 0;
  /** An event that settled already. */
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
  const triages = () =>
    f.store.list<Session>('sessions').filter((session) => session.resident?.kind === 'triage');
  const settleTriage = (sessionId: string) =>
    eventually(
      () =>
        f.store.must<Session>('sessions', sessionId).state === 'open' &&
        f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
      () => f.control.tick(),
    );
  /** Hands the settled events on and lets the triage session take its wake. */
  const handOn = async () => {
    await f.control.tick();
    const [triage] = triages();
    await settleTriage(triage!.id);
    return triage!;
  };
  const notes = (leadId: string) =>
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => event.aggregate_id === leadId)
      .map((event) => event.payload as LeadNote);
  const wakes = (leadId: string) => f.turns(leadId).filter((turn) => turn.origin === 'tracker');
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
  return {
    ...f,
    later: (ms: number) => (skew += ms),
    report,
    triages,
    settleTriage,
    handOn,
    notes,
    wakes,
    as,
    writePlan,
    waits,
    needs,
  };
}

it('hands an issue to the project triage session as a note that wakes it, opening no lead', async () => {
  const f = triageFixture('auto');
  f.report();
  const triage = await f.handOn();
  expect(f.triages()).toHaveLength(1);
  expect(f.store.list<Session>('sessions').map((session) => session.id)).toEqual([triage.id]);
  expect(f.notes(triage.id)).toMatchObject([
    {
      kind: 'external',
      text: expect.stringContaining('https://github.com/acme/reports/issues/12'),
    },
  ]);
  const [wake] = f.wakes(triage.id);
  expect(wake!.input).toContain('external: External request from github: Totals are wrong');
  expect(wake!.input).toContain('The weekly total counts refunds twice.');
  expect(f.store.list<ExternalEvent>('external_events')).toMatchObject([
    { state: 'handled', session_id: triage.id },
  ]);
});

it('sends a later batch about the same issue to the same triage session without the text it already sent', async () => {
  const f = triageFixture('auto');
  f.report();
  const triage = await f.handOn();
  f.later(MINUTE);
  f.report({ kind: 'mention', actor: 'robin', actor_trust: 'write', texts: [OWN, THEIRS] });
  expect((await f.handOn()).id).toBe(triage.id);
  expect(f.triages()).toHaveLength(1);
  const later = f.notes(triage.id)[1]!;
  expect(later.kind).toBe('external');
  expect(later.text).toContain('It also breaks the monthly export.');
  expect(later.text).not.toContain('The weekly total counts refunds twice.');
  expect(f.wakes(triage.id).at(-1)!.input).toContain('It also breaks the monthly export.');
});

it('holds the tasks of a request the user has not approved and starts them once the user approves', async () => {
  const f = triageFixture('approve');
  f.report();
  const triage = await f.handOn();
  expect(f.needs()).toMatchObject([
    {
      source: { table: 'board_plans', id: triage.id },
      request_id: SUBJECT,
      reason: 'external_approval',
      actions: [{ command: 'external.approve', allowed: true }],
    },
  ]);
  f.writePlan(triage.id, [task({ external_subject: SUBJECT })]);
  expect(() =>
    f.call('task.start', { project_id: f.project.id, task_ids: ['fix'] }, null, f.as(triage.id)),
  ).toThrow(/approve/i);
  f.call('task.start', { project_id: f.project.id, lead_session_id: triage.id, task_ids: ['fix'] });
  expect(f.waits()).toEqual(['approval']);

  f.call('external.approve', { project_id: f.project.id, subject_key: SUBJECT });
  expect(f.needs()).toEqual([]);
  expect(f.waits()).toEqual([undefined]);
  expect(f.notes(triage.id).at(-1)).toMatchObject({
    kind: 'external',
    text: expect.stringMatching(/approved/i),
  });
  await eventually(
    () =>
      f.store
        .list<Session>('sessions')
        .some(
          (session) => session.task?.lead_session_id === triage.id && session.task.id === 'fix',
        ),
    () => f.control.tick(),
  );
});
