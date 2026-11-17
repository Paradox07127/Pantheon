import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Session, SessionTurn } from '@pantheon/domain';
import { buildHandoff } from '../../packages/control/dist/handoff.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const planTask = (fields: Partial<PlanTask> = {}): PlanTask => ({
  id: 'a',
  title: 'Serve exports over HTTP',
  goal: 'Exports download',
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src/export'],
  acceptance: ['pnpm test'],
  ...fields,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** A settled lead with a one-task plan and the settled session of that task. */
async function leadWithTask(task: PlanTask = planTask()) {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build the export endpoint',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);
  return { f, lead, worker };
}

const report = (f: Fixture, workerId: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'risk', text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

async function tellTask(f: Fixture, leadId: string, worker: Session, text: string) {
  f.call(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text },
    null,
    sessionOf(f, leadId, 'lead'),
  );
  await settle(f, worker);
}

/** A finished turn stored the way a run stores its input and answer. */
function storeTurn(f: Fixture, session: Session, input: string, answer: string) {
  const turn: SessionTurn = {
    id: `turn-${input.slice(0, 8)}-${f.turns(session.id).length}`,
    revision: 1,
    project_id: session.project_id,
    session_id: session.id,
    input,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  };
  f.store.insert('session_turns', turn);
  f.store.event('turn.queued', turn, session.project_id, turn);
  f.store.event('turn.running', turn, session.project_id, {});
  f.store.event('agent.message.delta', session, session.project_id, {
    key: `${turn.id}-answer`,
    turn_id: turn.id,
    text: answer,
  });
}

const handoffOf = (f: Fixture, session: Session) =>
  buildHandoff({ store: f.store } as unknown as ControlContext, current(f, session.id));

const count = (text: string, part: string) => text.split(part).length - 1;

it('keeps the whole current contract at the start when the history exceeds the budget', async () => {
  const { f, worker } = await leadWithTask();
  for (const letter of ['p', 'q', 'r', 's'])
    storeTurn(f, worker, letter.repeat(5000), letter.toUpperCase().repeat(5000));

  const handoff = handoffOf(f, worker);
  const contract = [
    "The user's words (verbatim):",
    '- "Plan the export feature"',
    'Goal: Exports download',
    'Scope (the paths you may change):',
    '- src/export',
    'Acceptance commands:',
    '- pnpm test',
  ].join('\n');
  expect(handoff).toContain(contract);
  expect(handoff.indexOf(contract)).toBeLessThan(handoff.indexOf('User:\n'));
});

it('keeps small history entries that come after one too large to fit', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Start the export');
  await settle(f, lead);
  storeTurn(f, lead, 'Middle input', 'Small early note');
  storeTurn(f, lead, 'Paste the log', 'z'.repeat(20000));
  storeTurn(f, lead, 'Latest input', 'Latest answer');

  const handoff = handoffOf(f, lead);
  for (const text of ['Start the export', 'Middle input', 'Small early note', 'Latest answer'])
    expect(handoff).toContain(text);
  expect(handoff).not.toContain('z'.repeat(20000));
});

it('puts the reports and lead messages of the task before the history, once each', async () => {
  const { f, lead, worker } = await leadWithTask();
  report(f, worker.id, 'The export header may change');
  await tellTask(f, lead.id, worker, 'Keep the CSV header');
  storeTurn(f, worker, 'Run the export tests', 'Tests pass');

  const handoff = handoffOf(f, worker);
  const history = handoff.indexOf('User:\n');
  for (const text of ['The export header may change', '[Lead] Keep the CSV header']) {
    expect(count(handoff, text)).toBe(1);
    expect(handoff.indexOf(text)).toBeLessThan(history);
  }
  expect(handoff).toContain('Tests pass');
});

it('keeps the contract, reports and lead messages whole and no history when they alone exceed the budget', async () => {
  const goal = 'g'.repeat(400),
    acceptance = ['1', '2', '3', '4'].map((digit) => digit.repeat(400));
  const { f, lead, worker } = await leadWithTask(planTask({ goal, acceptance }));
  const reported = 'h'.repeat(400);
  report(f, worker.id, reported);
  const messages = ['k', 'm', 'n', 'o', 'u', 'v', 'w', 'y'].map((letter) => letter.repeat(2000));
  for (const message of messages) await tellTask(f, lead.id, worker, message);

  const handoff = handoffOf(f, worker);
  for (const text of [`Goal: ${goal}`, ...acceptance, reported, ...messages])
    expect(count(handoff, text)).toBe(1);
  expect(handoff).not.toContain('Build the export endpoint');
  expect(handoff).not.toContain('User:\n');
  expect(handoff).not.toContain('Assistant:\n');
});
