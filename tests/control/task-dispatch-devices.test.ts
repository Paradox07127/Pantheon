import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { BoardPlan, Principal, Project, Session, SessionTurn } from '@pantheon/domain';
import { command, type CommandType, type DeviceStatus } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import type { ControlContext } from '../../packages/control/src/context.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type PlanTask = BoardPlan['tasks'][number];

/** A project with a lead whose task sessions can run on a device that is a directory of this machine. */
async function deviceBoard(config: Record<string, unknown>) {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'pantheon-device-dispatch-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    configDir = path.join(root, 'config'),
    home = path.join(root, 'device-home');
  for (const directory of [source, workspaceRoot, configDir, home])
    mkdirSync(directory, { recursive: true });
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial files');
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, ...config }));
  const adapter = new FixtureAdapter(40),
    store = new Store(path.join(root, 'state/control.sqlite')),
    files = new ArtifactFiles(path.join(root, 'state/artifacts'));
  const control = new Control(store, files, [adapter], undefined, {
    workspaceRoot,
    userConfigDir: configDir,
    deviceLink: () => ({
      transport: ['/bin/sh', '-c'],
      gitUrl: (target) => target,
      withSocket: (localSocket) => ({ transport: ['/bin/sh', '-c'], socket: localSocket }),
    }),
    readProcess: () => undefined,
  });
  cleanups.push(async () => {
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = (control as unknown as { ctx: ControlContext }).ctx;
  const probed = (status: Partial<DeviceStatus> = {}) =>
    ctx.devices!.set('build-box', {
      id: 'build-box',
      name: 'build-box',
      ssh: 'builder@build-box',
      labels: [],
      resources: { gpu: 1 },
      max_sessions: 4,
      online: true,
      checked_at: new Date().toISOString(),
      home,
      path: process.env.PATH,
      runtimes: {
        [adapter.name]: { binary: '/usr/local/bin/fixture', version: '1', logged_in: true },
      },
      tools: {},
      ...status,
    });
  probed();
  const call = <T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null = null,
    principal: Principal = user,
  ) => control.execute(principal, command(principal.id, type, input, revision)) as T;
  const project = call<Project>('project.open', { name: 'Device project', roots: [source] });
  const current = (sessionId: string) => store.must<Session>('sessions', sessionId);
  const settle = async (session: Session) => {
    await awaitWorkspaceReady(control, session.workspace_id!);
    await eventually(
      () =>
        current(session.id).state === 'open' &&
        store
          .list<SessionTurn>('session_turns')
          .filter((turn) => turn.session_id === session.id)
          .every((turn) => !['queued', 'running'].includes(turn.state)),
      () => control.tick(),
      10000,
    );
  };
  const leadSession = call<Session>('session.create', {
    project_id: project.id,
    runtime: adapter.name,
    input: 'Plan the GPU work',
  });
  await settle(leadSession);
  const lead: Principal = {
    id: `session:${leadSession.id}`,
    role: 'lead',
    project_id: project.id,
    session_id: leadSession.id,
    expires_at: store.now() + 600000,
  };
  const plan = (tasks: PlanTask[]) =>
    call(
      'board.plan.update',
      {
        project_id: project.id,
        base_version: store.get<BoardPlan>('board_plans', leadSession.id)?.plan_version ?? 0,
        headline: 'GPU work',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks,
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      lead,
    );
  const start = (taskIds: string[]) =>
    call('task.start', { project_id: project.id, task_ids: taskIds }, null, lead);
  const sessionsOf = (taskId: string) =>
    store
      .list<Session>('sessions')
      .filter(
        (session) => session.task?.lead_session_id === leadSession.id && session.task.id === taskId,
      );
  const row = (taskId: string) =>
    control
      .boardView(user, project.id, 1)
      .tasks.find((entry) => entry.id === `${leadSession.id}:${taskId}`)!;
  const end = (session: Session) =>
    store.update<Session>(
      'sessions',
      { ...current(session.id), state: 'closed', outcome: 'merged' },
      current(session.id).revision,
    );
  return {
    control,
    store,
    call,
    project,
    leadId: leadSession.id,
    current,
    probed,
    plan,
    start,
    sessionsOf,
    row,
    settle,
    end,
  };
}

const reportTask = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Answer task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the GPU work'],
  scope: [],
  acceptance: [],
  done_when: 'report',
  ...fields,
});

const onBuildBox = { device: 'build-box', device_reason: 'The build box has the GPU' };
const devices = { devices: { 'build-box': { ssh: 'builder@build-box', resources: { gpu: 1 } } } };

it('opens the session of a task that names a device on that device', async () => {
  const f = await deviceBoard(devices);
  f.plan([reportTask('train', onBuildBox)]);
  expect(f.row('train').planned).toMatchObject(onBuildBox);
  f.start(['train']);
  await f.control.tick();
  const [session] = f.sessionsOf('train');
  expect(session?.device_id).toBe('build-box');
  await f.settle(session!);
});

it('opens a session on the device for a small task the lead would otherwise work on itself', async () => {
  const f = await deviceBoard(devices);
  f.plan([
    reportTask('small', {
      ...onBuildBox,
      done_when: 'merged',
      scope: ['notes.txt'],
      acceptance: ['test -s notes.txt'],
    }),
  ]);
  f.start(['small']);
  await f.control.tick();
  const [session] = f.sessionsOf('small');
  expect(session?.device_id).toBe('build-box');
  await f.settle(session!);
});

it('keeps a task queued while its device is offline', async () => {
  const f = await deviceBoard(devices);
  f.plan([reportTask('train', onBuildBox)]);
  f.probed({ online: false, error: 'ssh: connect to host build-box' });
  f.start(['train']);
  expect(f.row('train').dispatch_wait).toBe('device_offline');
  await f.control.tick();
  expect(f.sessionsOf('train')).toEqual([]);
  expect(f.row('train').blockers).toContain('Queued: waiting for the device to come online');
});

it('keeps a task queued while its device has no free session', async () => {
  const f = await deviceBoard(devices);
  f.probed({ max_sessions: 1 });
  f.plan([reportTask('first', onBuildBox), reportTask('second', onBuildBox)]);
  f.start(['first']);
  await f.control.tick();
  const [first] = f.sessionsOf('first');
  await f.settle(first!);
  f.start(['second']);
  expect(f.row('second').dispatch_wait).toBe('device_capacity');
  await f.control.tick();
  expect(f.sessionsOf('second')).toEqual([]);
});

it('holds a resource of the device for one task at a time', async () => {
  const f = await deviceBoard(devices);
  const gpu = { ...onBuildBox, uses: { gpu: 1 } };
  f.plan([reportTask('first', gpu), reportTask('second', gpu)]);
  f.start(['first', 'second']);
  expect(f.row('first').dispatch_wait).toBeUndefined();
  expect(f.row('second').dispatch_wait).toBe('device_resource');
  await f.control.tick();
  const [first] = f.sessionsOf('first');
  expect(f.sessionsOf('second')).toEqual([]);
  await f.settle(first!);
  f.end(first!);
  await f.control.tick();
  const [second] = f.sessionsOf('second');
  expect(second?.device_id).toBe('build-box');
  await f.settle(second!);
});

it('keeps the resource of a task session that waits for an approval before its merge', async () => {
  const f = await deviceBoard(devices);
  const gpu = { ...onBuildBox, uses: { gpu: 1 } };
  f.plan([reportTask('first', gpu), reportTask('second', gpu)]);
  f.start(['first']);
  await f.control.tick();
  const [first] = f.sessionsOf('first');
  await f.settle(first!);
  f.store.update<Session>(
    'sessions',
    {
      ...f.current(first!.id),
      merge: { state: 'blocked', reason: 'workflow_approval' } as Session['merge'],
    },
    f.current(first!.id).revision,
  );
  f.start(['second']);
  expect(f.row('second').dispatch_wait).toBe('device_resource');
});

it('holds a resource configured for this machine for one task at a time', async () => {
  const f = await deviceBoard({ local_device: { resources: { display: 1 } } });
  const display = { uses: { display: 1 } };
  f.plan([reportTask('first', display), reportTask('second', display)]);
  f.start(['first', 'second']);
  expect(f.row('second').dispatch_wait).toBe('device_resource');
  await f.control.tick();
  const [first] = f.sessionsOf('first');
  expect(first?.device_id).toBe('local');
  expect(f.sessionsOf('second')).toEqual([]);
  await f.settle(first!);
});

it('names the task sessions occupying a known device resource', async () => {
  const f = await deviceBoard(devices);
  f.plan([reportTask('train', { ...onBuildBox, uses: { gpu: 1 } })]);
  f.start(['train']);
  await f.control.tick();
  const [session] = f.sessionsOf('train');
  await f.settle(session!);
  const device = (await f.control.listDevices(user)).find((item) => item.id === 'build-box')!;
  expect(device.load.active_sessions.map((item) => item.id)).toEqual([session!.id]);
  expect(device.load.resource_sessions).toEqual({ gpu: [session!.id] });
  expect(device.load.uses).toEqual({ gpu: 1 });
});

it('does not open a task on a device that came online without a label it needs', async () => {
  const f = await deviceBoard(devices);
  f.probed({ online: false, error: 'ssh: connect to host build-box' });
  f.plan([reportTask('train', { ...onBuildBox, needs: ['cuda'] })]);
  f.start(['train']);
  expect(f.row('train').dispatch_wait).toBe('device_offline');
  f.probed();
  await f.control.tick();
  expect(f.sessionsOf('train')).toEqual([]);
  const [plan] = f.store.list<BoardPlan>('board_plans');
  expect(plan!.dispatch!.train!.error?.message).toContain('cuda');
});

it('refuses a session in the project folder on another device', async () => {
  const f = await deviceBoard(devices);
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: 'fixture',
      workspace: 'in_place',
      device_id: 'build-box',
      input: 'Work here',
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(f.store.list<Session>('sessions').filter((s) => s.device_id === 'build-box')).toEqual([]);
});

it('counts a device resource named like an object property', async () => {
  const f = await deviceBoard(devices);
  f.probed({ resources: { constructor: 1 } });
  f.plan([reportTask('train', { ...onBuildBox, uses: { constructor: 1 } })]);
  f.start(['train']);
  await f.control.tick();
  const [session] = f.sessionsOf('train');
  const device = (await f.control.listDevices(user)).find((item) => item.id === 'build-box')!;
  expect(device.load.resource_sessions).toEqual({ constructor: [session!.id] });
  expect(device.load.uses).toEqual({ constructor: 1 });
  await f.settle(session!);
});

const userOpens = (f: Awaited<ReturnType<typeof deviceBoard>>, taskId: string) =>
  f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'fixture',
    task_id: `${f.leadId}:${taskId}`,
    input: `Work on task ${taskId}`,
  });

it('opens the session the user starts for a task on the task device', async () => {
  const f = await deviceBoard(devices);
  f.plan([reportTask('train', onBuildBox)]);
  const session = userOpens(f, 'train');
  expect(session.device_id).toBe('build-box');
  await f.settle(session);
});

it('refuses the session the user starts for a task while its device is offline', async () => {
  const f = await deviceBoard(devices);
  f.plan([reportTask('train', onBuildBox)]);
  f.probed({ online: false, error: 'ssh: connect to host build-box' });
  expect(() => userOpens(f, 'train')).toThrow(
    expect.objectContaining({
      code: 'invalid_input',
      message: expect.stringContaining('build-box'),
    }),
  );
  expect(f.sessionsOf('train')).toEqual([]);
});

it('refuses the session the user starts for a task while another task holds its device resource', async () => {
  const f = await deviceBoard(devices);
  const gpu = { ...onBuildBox, uses: { gpu: 1 } };
  f.plan([reportTask('first', gpu), reportTask('second', gpu)]);
  f.start(['first']);
  await f.control.tick();
  const [first] = f.sessionsOf('first');
  await f.settle(first!);
  expect(() => userOpens(f, 'second')).toThrow(
    expect.objectContaining({ message: expect.stringContaining('gpu') }),
  );
  expect(f.sessionsOf('second')).toEqual([]);
});
