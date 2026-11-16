import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const script = (steps: unknown[]) => `fixture-script\n${JSON.stringify(steps)}`;
const HANG = script([{ say: 'Working' }, { hang: true }]);

const principal = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const row = (f: Fixture, turn: SessionTurn) => f.store.must<SessionTurn>('session_turns', turn.id);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

/** Waits until the session's latest turn runs and returns it. */
async function running(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  return f.turns(session.id).at(-1)!;
}

/** The note the lead gets when the user opens the session on its task from the board. */
const openedNote = (session: Session) => ({
  kind: 'user_edit',
  session_id: '',
  task_id: 'a',
  text: `The user opened the session ${session.id} for task a from the board; it works on the task now.`,
});

/** Plain turns outlast each test, so only script turns end on their own. */
async function planned() {
  const f = workbenchFixture({ delay: 30000 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = f.create(script([{ say: 'Plan the export feature' }]));
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports over HTTP',
          goal: 'Exports download',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    principal(f, lead.id, 'lead'),
  );
  const openTask = (input: string) =>
    f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input,
      task_id: `${lead.id}:a`,
    });
  const send = (session: Session, input: string) =>
    f.call<SessionTurn>(
      current(f, session.id).state === 'running' ? 'session.steer' : 'session.send',
      { session_id: session.id, input },
      current(f, session.id).revision,
    );
  const interrupt = (session: Session) =>
    f.call<Session>(
      'session.interrupt',
      { session_id: session.id },
      current(f, session.id).revision,
    );
  const fromLead = (text: string) =>
    f.call<SessionTurn>(
      'task.message',
      { project_id: f.project.id, task_id: 'a', text },
      null,
      principal(f, lead.id, 'lead'),
    );
  const interruptTask = () =>
    f.call(
      'task.interrupt',
      { project_id: f.project.id, task_id: 'a' },
      null,
      principal(f, lead.id, 'lead'),
    );
  return { f, lead, openTask, send, interrupt, fromLead, interruptTask };
}

it('keeps a queued lead message when the user interrupts a task session', async () => {
  const { f, openTask, send, interrupt, fromLead } = await planned();
  const worker = openTask(HANG);
  const first = await running(f, worker);
  const leadMessage = fromLead('Keep the CSV header as it is');
  const userMessage = send(worker, 'Also add a footer');
  await f.control.tick();
  expect(row(f, leadMessage)).toMatchObject({ state: 'queued', origin: 'lead' });

  interrupt(worker);
  await eventually(() => row(f, first).state === 'cancelled');
  expect(row(f, userMessage)).toMatchObject({
    state: 'cancelled',
    delivery_reason: 'interrupted',
  });
  await eventually(
    () => row(f, leadMessage).state === 'running',
    () => f.control.tick(),
  );
  expect(row(f, leadMessage).delivery).toBe('delivered');
  expect(current(f, worker.id).state).toBe('running');
});

it('keeps the queued tracker digest when the user interrupts the lead', async () => {
  const { f, lead, openTask, send, interrupt } = await planned();
  const worker = openTask(script([{ say: 'Started' }]));
  await settle(f, worker);
  await settle(f, lead);
  send(lead, HANG);
  const leadTurn = await running(f, lead);
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text: 'The user asked for CSV, not JSON' },
    null,
    principal(f, worker.id, 'worker'),
  );
  const digest = f
    .turns(lead.id)
    .find((turn) => turn.origin === 'tracker' && turn.state === 'queued')!;
  expect(digest.input).toContain('The user asked for CSV, not JSON');

  interrupt(lead);
  await eventually(() => row(f, leadTurn).state === 'cancelled');
  await eventually(
    () => row(f, digest).state === 'running',
    () => f.control.tick(),
  );
  expect(row(f, digest).delivery).toBe('delivered');
});

it("tells the lead that the user interrupted its task's turn", async () => {
  const { f, lead, openTask, interrupt } = await planned();
  const worker = openTask(HANG);
  const first = await running(f, worker);
  const leadTurns = f.turns(lead.id).length;

  interrupt(worker);
  await eventually(() => row(f, first).state === 'cancelled');
  await eventually(() =>
    planOf(f, lead.id).inbox.some(
      (note) => note.kind === 'user_edit' && note.session_id === worker.id,
    ),
  );
  expect(planOf(f, lead.id).inbox).toMatchObject([
    openedNote(worker),
    {
      kind: 'user_edit',
      task_id: 'a',
      session_id: worker.id,
      text: 'The user interrupted the current turn of task a.',
    },
  ]);
  await f.control.tick();
  expect(f.turns(lead.id)).toHaveLength(leadTurns);
  expect(current(f, lead.id).state).toBe('open');
});

it("lets the lead interrupt a running task turn and keep the session's commits", async () => {
  const { f, lead, openTask, fromLead, interruptTask } = await planned();
  const worker = openTask(
    script([
      { write: { path: 'src/export/serve.txt', text: 'serve\n' } },
      { commit: 'Serve exports' },
      { hang: true },
    ]),
  );
  const first = await running(f, worker);
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  await eventually(() => git(workspace.path, 'log', '-1', '--format=%s') === 'Serve exports');
  const head = git(workspace.path, 'rev-parse', 'HEAD');
  const leadMessage = fromLead('Switch to the new model now');

  expect(interruptTask()).toMatchObject({ task_id: 'a', session_id: worker.id });
  await eventually(() => row(f, first).state === 'cancelled');
  await eventually(
    () => row(f, leadMessage).state === 'running',
    () => f.control.tick(),
  );
  expect(current(f, worker.id)).toMatchObject({ native_id: expect.any(String) });
  expect(current(f, worker.id).outcome).toBeUndefined();
  expect(f.store.must<Workspace>('workspaces', workspace.id).removed_at).toBeUndefined();
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(
    f.start.mock.calls.filter(([spec]) => spec.platform_session_id === worker.id),
  ).toHaveLength(1);
  expect(planOf(f, lead.id).inbox.filter((note) => note.kind === 'user_edit')).toEqual([
    expect.objectContaining(openedNote(worker)),
  ]);
});

it('rejects a task interrupt when no turn runs', async () => {
  const { f, openTask, interruptTask } = await planned();
  const worker = openTask(script([{ say: 'Done' }]));
  await settle(f, worker);
  expect(() => interruptTask()).toThrow(expect.objectContaining({ code: 'resource_busy' }));
});
