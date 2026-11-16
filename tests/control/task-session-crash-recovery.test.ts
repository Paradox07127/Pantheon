import { expect, it, vi } from 'vitest';
import type { Principal, Project, Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { crashBench, type BenchDaemon } from './crash-harness.js';

const script = (steps: unknown[]) => `fixture-script\n${JSON.stringify(steps)}`;
const session = (daemon: BenchDaemon, id: string) => daemon.store.must<Session>('sessions', id);
const turns = (daemon: BenchDaemon, sessionId: string) =>
  daemon.store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === sessionId);
const nativeStarts = (daemon: BenchDaemon, sessionId: string) =>
  daemon.store
    .events(0, undefined, 10000)
    .filter((event) => event.aggregate_id === sessionId && event.kind === 'agent.session.started')
    .map((event) => (event.payload as { native_session_id: string }).native_session_id);

/** A project whose lead has planned task a; the daemon that set it up is stopped. */
async function plannedProject(bench: ReturnType<typeof crashBench>) {
  const setup = bench.start();
  const project = setup.call<Project>('project.open', {
    name: 'Crash project',
    roots: [bench.source],
  });
  const lead = setup.call<Session>('session.create', {
    project_id: project.id,
    runtime: 'fixture',
    input: script([{ say: 'Plan the export feature' }]),
  });
  await awaitWorkspaceReady(setup.control, lead.workspace_id!);
  await eventually(
    () =>
      session(setup, lead.id).state === 'open' &&
      turns(setup, lead.id).every((turn) => turn.state === 'completed'),
    () => setup.control.tick(),
  );
  const leadPrincipal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: project.id,
    session_id: lead.id,
    expires_at: setup.store.now() + 600000,
  };
  setup.call(
    'board.plan.update',
    {
      project_id: project.id,
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
    leadPrincipal,
  );
  await setup.stop();
  return { project, lead };
}

/** Kills the daemon at the failpoint while it runs task a, then restarts on the data it left. */
async function crashWhileRunningTask(failpoint: string, input: string) {
  const bench = crashBench();
  const { project, lead } = await plannedProject(bench);
  await bench.crash({
    failpoint,
    commands: [
      {
        type: 'session.create',
        input: { project_id: project.id, runtime: 'fixture', input, task_id: `${lead.id}:a` },
      },
    ],
  });
  const after = await bench.restart();
  const worker = after.store
    .list<Session>('sessions')
    .find((candidate) => candidate.task?.id === 'a')!;
  const adapter = after.control.adapters.get('fixture')!;
  return {
    after,
    worker,
    start: vi.spyOn(adapter, 'start'),
    resume: vi.spyOn(adapter, 'resume'),
  };
}

it('queues exactly one continuation turn that resumes the stored native id after a kill mid-turn', async () => {
  const { after, worker, start, resume } = await crashWhileRunningTask(
    'turn_running_with_process',
    'Build it',
  );
  const [started] = nativeStarts(after, worker.id);
  expect(session(after, worker.id).native_id).toBe(started);
  // The killed daemon's fixture process may outlive it briefly.
  await eventually(
    () => session(after, worker.id).state !== 'reconciling',
    () => after.control.reconcile(),
  );
  expect(turns(after, worker.id)).toMatchObject([
    { state: 'failed', delivery_reason: 'Interrupted by a daemon restart' },
    { state: 'queued', origin: 'continuation' },
  ]);
  await eventually(
    () => turns(after, worker.id)[1]!.state === 'completed',
    () => after.control.tick(),
    10000,
  );
  expect(start).not.toHaveBeenCalled();
  expect(resume.mock.calls.map((call) => call[1])).toEqual([started]);
  expect(turns(after, worker.id).filter((turn) => turn.origin === 'continuation')).toHaveLength(1);
  expect(new Set(nativeStarts(after, worker.id))).toEqual(new Set([started]));
}, 60000);

it('does not start a second native thread when the daemon was killed between the native start and saving the session handle', async () => {
  const { after, worker, start, resume } = await crashWhileRunningTask(
    'native_started_before_handle_saved',
    'Build it',
  );
  const [started] = nativeStarts(after, worker.id);
  expect(started).toBeDefined();
  expect(session(after, worker.id).native_id).toBe(started);
  // No process identity was saved, so nothing proves the old process ended and the session waits for the user.
  for (let index = 0; index < 3; index++) {
    await after.control.reconcile();
    await after.control.tick();
  }
  expect(session(after, worker.id).state).toBe('reconciling');
  expect(
    after.control
      .needsYou(user, worker.project_id)
      .items.filter((item) => item.source.id === worker.id),
  ).toMatchObject([
    {
      kind: 'session.reconciling',
      actions: [
        {
          command: 'session.resolve',
          allowed: false,
          disabled_reason: 'termination_unconfirmed',
        },
        { command: 'session.discard', allowed: true },
      ],
    },
  ]);
  expect(() =>
    after.call(
      'session.resolve',
      { session_id: worker.id, choice: 'resume_session' },
      session(after, worker.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'termination_unconfirmed' }));
  await after.control.tick();
  expect(start).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(session(after, worker.id).native_id).toBe(started);
  expect(nativeStarts(after, worker.id)).toEqual([started]);
  expect(turns(after, worker.id)).toMatchObject([{ state: 'queued', delivery: 'pending' }]);
}, 60000);

it('discards a session a restart left reconciling without a process identity once the user asks', async () => {
  const { after, worker, start, resume } = await crashWhileRunningTask(
    'native_started_before_handle_saved',
    'Build it',
  );
  await after.control.reconcile();
  expect(session(after, worker.id).state).toBe('reconciling');
  expect(session(after, worker.id).process_identity).toBeUndefined();

  after.call('session.discard', { session_id: worker.id }, session(after, worker.id).revision);

  expect(session(after, worker.id)).toMatchObject({
    state: 'closed',
    outcome: 'discarded',
    stop_requested: { by: 'user' },
  });
  expect(turns(after, worker.id)).toMatchObject([{ state: 'failed', delivery: 'failed' }]);
  expect(
    after.store
      .pending()
      .some(
        (job) =>
          job.kind === 'workspace.remove' &&
          JSON.parse(job.payload).workspace_id === worker.workspace_id,
      ),
  ).toBe(true);
  expect(
    after.control
      .needsYou(user, worker.project_id)
      .items.filter((item) => item.source.id === worker.id),
  ).toEqual([]);
  await after.control.tick();
  expect(start).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
}, 60000);
