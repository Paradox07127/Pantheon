import { expect, it, vi } from 'vitest';
import type { BoardPlan, Principal, Session, SessionTurn } from '@pantheon/domain';
import { queuedTurn } from '../../packages/control/dist/session.js';
import { awaitWorkspaceReady, eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const CONTINUE_TEXT =
  '[Pantheon] A daemon restart interrupted your last turn. Before you redo anything, check whether your last actions took effect (files, git status, git log, commands that were running). Then continue your work.';

const oldIdentity = { pid: 4000001, start_time_us: 1700000000123456 };

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const planTasks = [
  {
    id: 'a',
    title: 'Serve exports over HTTP',
    goal: 'Exports download',
    lane: 'core',
    depends_on: [] as string[],
    source: ['Plan the export feature'],
    scope: ['src/export'],
    acceptance: ['pnpm test'],
  },
];

function writePlan(f: Fixture, leadId: string) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: planTasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );
}

const startTask = (f: Fixture, leadId: string, taskId: string) =>
  f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:${taskId}`,
  });

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const continuations = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'continuation');
const active = (turn: SessionTurn) => turn.state === 'queued' || turn.state === 'running';

/** Delivers the next turn without a fixture process, so it stays running with a recorded identity. */
function holdNextTurn(f: Fixture) {
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = oldIdentity;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
}

/** Waits until the session's held turn runs under a recorded process identity. */
async function heldRunning(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => current(f, session.id).process_identity !== undefined,
    () => f.control.tick(),
  );
}

async function leadWithPlan(f: Fixture) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  return lead;
}

/** A task session whose turn runs when the daemon stops. */
async function interruptedTask(f: Fixture) {
  const lead = await leadWithPlan(f);
  holdNextTurn(f);
  const worker = startTask(f, lead.id, 'a');
  await heldRunning(f, worker);
  return { lead, worker };
}

it('gives an interrupted task session one turn that tells it to check and continue', async () => {
  const f = workbenchFixture();
  const { worker } = await interruptedTask(f);
  await f.restart(() => undefined);
  const turns = f.turns(worker.id);
  expect(turns[0]).toMatchObject({
    state: 'failed',
    delivery_reason: 'Interrupted by a daemon restart',
  });
  expect(turns.filter(active)).toMatchObject([{ origin: 'continuation', input: CONTINUE_TEXT }]);
  expect(current(f, worker.id).state).toBe('running');
});

it('leaves an interrupted session a person drives failed and waiting for the next message', async () => {
  const f = workbenchFixture();
  holdNextTurn(f);
  const session = f.create();
  await heldRunning(f, session);
  await f.restart(() => undefined);
  expect(current(f, session.id).state).toBe('open');
  expect(f.turns(session.id)).toMatchObject([
    { state: 'failed', delivery_reason: 'Interrupted by a daemon restart' },
  ]);
});

it('delivers a message queued behind an exited process after a restart instead of reconciling', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await settle(f, session);
  // The adapter dropped the identity of its process once the process group was empty.
  const exited = current(f, session.id);
  f.store.update('sessions', { ...exited, process_identity: undefined }, exited.revision);
  expect(current(f, session.id).native_id).toBeDefined();
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Go on' },
    current(f, session.id).revision,
  );
  await f.restart(() => undefined);
  expect(current(f, session.id).state).toBe('running');
  await settle(f, session);
  expect(f.store.must<SessionTurn>('session_turns', turn.id)).toMatchObject({
    state: 'completed',
    delivery: 'delivered',
  });
});

it('hands an interrupted lead the board updates its never-started turn carried', async () => {
  const f = workbenchFixture();
  holdNextTurn(f);
  const lead = f.create('Plan the export feature');
  await heldRunning(f, lead);
  writePlan(f, lead.id);
  const worker = startTask(f, lead.id, 'a');
  await settle(f, worker);
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text: 'Which export format ships first?' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  const waiting = f.turns(lead.id).find((turn) => turn.origin === 'tracker')!;
  expect(waiting).toMatchObject({ state: 'queued', delivery: 'pending' });
  await f.restart(() => undefined);
  const [continuation] = f.turns(lead.id).filter(active);
  expect(continuation).toMatchObject({ origin: 'continuation' });
  expect(continuation!.input).toBe(
    `${CONTINUE_TEXT}\n\nMessages that arrived but were not delivered:\n${waiting.input}`,
  );
  expect(continuation!.input).toContain('Which export format ships first?');
});

it('carries the attachments and skills of a never-started turn into the continuation', async () => {
  const f = workbenchFixture();
  const { worker } = await interruptedTask(f);
  const attachments = [
    { id: 'screen-shot', name: 'screen shot.png', mime: 'image/png', path: '/tmp/screen shot.png' },
  ];
  const skills = [{ name: 'review', path: '/skills/review/SKILL.md' }];
  f.store.transaction(() => {
    f.store.insert(
      'session_turns',
      queuedTurn(current(f, worker.id), 'Look at the screenshot', 'send', { attachments, skills }),
    );
  });
  await f.restart(() => undefined);
  const [continuation] = f.turns(worker.id).filter(active);
  expect(continuation).toMatchObject({ origin: 'continuation', attachments, skills });
  expect(continuation!.input).toContain('Look at the screenshot');
});

it('continues an interrupted session at most three times within five minutes', async () => {
  const f = workbenchFixture();
  const { worker } = await interruptedTask(f);
  for (let restart = 0; restart < 4; restart++) {
    if (restart > 0) {
      holdNextTurn(f);
      await heldRunning(f, worker);
    }
    await f.restart(() => undefined);
  }
  expect(continuations(f, worker.id)).toHaveLength(3);
  expect(current(f, worker.id).state).toBe('open');
  expect(f.turns(worker.id).filter(active)).toEqual([]);
});

it('keeps the board updates of a never-started turn for the lead when the restart does not continue it', async () => {
  const f = workbenchFixture();
  holdNextTurn(f);
  const lead = f.create('Plan the export feature');
  await heldRunning(f, lead);
  writePlan(f, lead.id);
  const worker = startTask(f, lead.id, 'a');
  await settle(f, worker);
  for (let restart = 0; restart < 3; restart++) {
    await f.restart(() => undefined);
    holdNextTurn(f);
    await heldRunning(f, lead);
  }
  expect(continuations(f, lead.id)).toHaveLength(3);
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text: 'Which export format ships first?' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  expect(f.turns(lead.id).find((turn) => turn.origin === 'tracker')).toMatchObject({
    state: 'queued',
    delivery: 'pending',
  });
  await f.restart(() => undefined);
  expect(continuations(f, lead.id)).toHaveLength(3);
  const waiting = [
    ...f.store.must<BoardPlan>('board_plans', lead.id).inbox.map((note) => note.text),
    ...f
      .turns(lead.id)
      .filter(active)
      .map((turn) => turn.input),
  ];
  expect(waiting.join('\n')).toContain('Which export format ships first?');
});

it('does not tell the lead a turn failed when the restart continues the task session', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await interruptedTask(f);
  await f.restart(() => undefined);
  expect(continuations(f, worker.id)).toHaveLength(1);
  await f.control.tick();
  await settle(f, worker);
  await f.control.tick();
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  expect(plan.inbox.filter((note) => note.kind === 'turn_failed')).toEqual([]);
  expect(plan.notified[worker.id]).not.toBe('turn_failed');
  expect(
    f
      .turns(lead.id)
      .filter((turn) => turn.origin === 'tracker' && turn.input.includes('turn_failed')),
  ).toEqual([]);
});
