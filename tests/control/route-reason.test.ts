import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type { BoardPlan, Principal, Project, Session } from '@pantheon/domain';
import type { DeviceStatus } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/src/context.js';
import { fixture, registerWorkspace } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

const codex = { runtime: 'codex', model: 'gpt-fixture', effort: 'high' } as const;

/** A terminal-bench board whose only aliased row makes codex the first choice of every backend-logic cell. */
const leaderboards = {
  fetched_at: '2026-11-09T08:00:00.000Z',
  sources: [{ source: 'terminal-bench', fetched_at: '2026-11-09T08:00:00.000Z' }],
  rows: [
    {
      source: 'terminal-bench',
      board_name: 'GPT Fixture / Codex / high',
      score: 70,
      unit: 'accuracy_pct',
      alias: codex,
    },
  ],
};

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

async function setup(withLeaderboards = true) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-route-reason-'));
  const giveLeaderboards = () =>
    writeFileSync(path.join(configDir, 'leaderboards.json'), JSON.stringify(leaderboards));
  if (withLeaderboards) giveLeaderboards();
  const f = await fixture({
    adapter: new FixtureAdapter(100),
    managedWorkspaces: true,
    controlOptions: { userConfigDir: configDir },
  });
  // The routing table only picks a registered runtime.
  const codexAdapter = new FixtureAdapter(100);
  codexAdapter.name = codex.runtime;
  f.control.adapters.set(codexAdapter.name, codexAdapter);
  cleanups.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  return { f, lead: leadOf(f), giveLeaderboards };
}

const REQUEST = 'Ship the export API and a download button this week.';

function leadOf(f: Fixture): Principal {
  const workspace = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.store.must<Project>('projects', f.project.id).roots[0]!,
    base_ref: 'HEAD',
  });
  const lead = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
}

const task = (fields: Record<string, unknown> = {}) => ({
  id: 'api',
  title: 'API',
  goal: 'Serve exports',
  lane: 'core',
  depends_on: [],
  source: ['Ship the export API'],
  scope: ['packages/export/src/index.ts'],
  acceptance: ['pnpm test'],
  ...fields,
});

const planOf = (f: Fixture, lead: Principal) =>
  f.store.get<BoardPlan>('board_plans', lead.session_id!);
const taskOf = (f: Fixture, lead: Principal, taskId = 'api') =>
  planOf(f, lead)?.tasks.find((entry) => entry.id === taskId);

function write(f: Fixture, lead: Principal, tasks: unknown[], headline = 'Export ships') {
  return f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead)?.plan_version ?? 0,
      headline,
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
}

it('fills in the kind of a task whose scope is all under the web app source', async () => {
  const { f, lead } = await setup();
  write(f, lead, [task({ scope: ['apps/web/src/export.tsx'] })]);
  expect(taskOf(f, lead)?.kind).toEqual({ domain: 'frontend-ui', tier: 't1' });
});

it('keeps the domain the lead wrote and takes the higher tier of a scope across packages', async () => {
  const { f, lead } = await setup();
  write(f, lead, [
    task({
      kind: { domain: 'review', tier: 't1' },
      scope: ['packages/export/src/a.ts', 'packages/web/src/b.ts'],
    }),
  ]);
  expect(taskOf(f, lead)?.kind).toEqual({ domain: 'review', tier: 't3' });
});

it('rates a task t3 when its goal names a risk', async () => {
  const { f, lead } = await setup();
  write(f, lead, [task({ goal: 'Move the token store to a new migration' })]);
  expect(taskOf(f, lead)?.kind?.tier).toBe('t3');
});

it('refuses a lead write that leaves the first choice without route_reason and takes one with it', async () => {
  const { f, lead } = await setup();
  const error = failure(() =>
    write(f, lead, [task({ kind: { domain: 'backend-logic', tier: 't2' }, model: 'other-model' })]),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('api');
  expect(error.message).toContain('gpt-fixture');
  expect(error.message).toContain('route_reason');
  expect(planOf(f, lead)).toBeUndefined();

  write(f, lead, [
    task({
      kind: { domain: 'backend-logic', tier: 't2' },
      model: 'other-model',
      route_reason: 'The user asked for this model',
    }),
  ]);
  expect(taskOf(f, lead)?.model).toBe('other-model');
});

it('asks no route_reason for a cell the routing table has no data for', async () => {
  const { f, lead } = await setup();
  write(f, lead, [task({ kind: { domain: 'review', tier: 't2' }, model: 'other-model' })]);
  expect(taskOf(f, lead)?.model).toBe('other-model');
});

it('does not check again a task the write leaves as it was', async () => {
  const { f, lead, giveLeaderboards } = await setup(false);
  const old = task({ kind: { domain: 'backend-logic', tier: 't2' }, model: 'other-model' });
  write(f, lead, [old]);
  giveLeaderboards();
  write(f, lead, [old], 'Export ships next week');
  expect(planOf(f, lead)?.headline).toBe('Export ships next week');
});

it('asks no route_reason of a user edit that changes the model', async () => {
  const { f, lead } = await setup();
  write(f, lead, [task()]);
  f.call('board.plan.edit', {
    project_id: f.project.id,
    lead_session_id: lead.session_id,
    base_version: planOf(f, lead)!.plan_version,
    ops: [{ type: 'set_task', task_id: 'api', patch: { model: 'other-model' } }],
  });
  expect(taskOf(f, lead)?.model).toBe('other-model');
});

it('refuses a path other than the workflow policy gives without flow_reason and takes one with it', async () => {
  const { f, lead } = await setup();
  const error = failure(() =>
    write(f, lead, [task({ kind: { domain: 'backend-logic', tier: 't2' }, path: 'direct' })]),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('api');
  expect(error.message).toContain('dispatch');
  expect(error.message).toContain('flow_reason');

  write(f, lead, [
    task({
      kind: { domain: 'backend-logic', tier: 't2' },
      path: 'direct',
      flow_reason: 'A one-line rename',
    }),
  ]);
  expect(taskOf(f, lead)?.path).toBe('direct');
});

it('refuses a task that names a runtime this daemon does not have', async () => {
  const { f, lead } = await setup();
  const error = failure(() => write(f, lead, [task({ runtime: 'missing-runtime' })]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('api');
  expect(error.message).toContain('missing-runtime');
});

it('asks flow_reason again when the tier of a task changes or the write drops the reason', async () => {
  const { f, lead } = await setup();
  write(f, lead, [task({ kind: { domain: 'backend-logic', tier: 't1' }, path: 'direct' })]);
  const harder = failure(() =>
    write(f, lead, [task({ kind: { domain: 'backend-logic', tier: 't3' }, path: 'direct' })]),
  );
  expect(harder.code).toBe('invalid_input');
  expect(harder.message).toContain('flow_reason');

  const explained = { kind: { domain: 'backend-logic', tier: 't3' }, path: 'direct' };
  write(f, lead, [task({ ...explained, flow_reason: 'A one-line rename' })]);
  const dropped = failure(() => write(f, lead, [task(explained)]));
  expect(dropped.code).toBe('invalid_input');
  expect(dropped.message).toContain('flow_reason');
});

it('refuses a task off the default runtime without route_reason when the project uses one model', async () => {
  const { f, lead } = await setup();
  const claudeAdapter = new FixtureAdapter(100);
  claudeAdapter.name = 'claude';
  f.control.adapters.set(claudeAdapter.name, claudeAdapter);
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: { ...codex, permission_mode: 'ask', single_model: true },
    },
    project.revision,
  );
  // Only a task without scope has no kind, and only a reported task may go without scope.
  const unkinded = { scope: [], done_when: 'report' };
  const error = failure(() => write(f, lead, [task({ ...unkinded, runtime: 'claude' })]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('api');
  expect(error.message).toContain('route_reason');
  expect(planOf(f, lead)).toBeUndefined();

  write(f, lead, [
    task({ ...unkinded, runtime: 'claude', route_reason: 'The user asked for this runtime' }),
  ]);
  expect(taskOf(f, lead)?.runtime).toBe('claude');
  write(f, lead, [task({ ...unkinded, runtime: codex.runtime, model: codex.model })]);
  expect(taskOf(f, lead)).toMatchObject({ runtime: codex.runtime, model: codex.model });
});

/** Two configured devices with their last probe: the GPU box online, the Mac mini offline. */
function withDevices(f: Fixture) {
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  writeFileSync(
    path.join(ctx.userConfigDir!, 'config.json'),
    JSON.stringify({
      version: 1,
      devices: {
        'gpu-box': { ssh: 'gpu-box', labels: ['cuda'], resources: { gpu: 1 } },
        'mac-mini': { ssh: 'mac-mini', labels: ['xcode'] },
      },
    }),
  );
  const status = (fields: Partial<DeviceStatus> & Pick<DeviceStatus, 'id'>): DeviceStatus => ({
    name: fields.id,
    labels: [],
    resources: {},
    max_sessions: 1,
    online: true,
    checked_at: new Date().toISOString(),
    home: '/home/builder',
    runtimes: {},
    tools: {},
    ...fields,
  });
  ctx.devices!.set(
    'gpu-box',
    status({
      id: 'gpu-box',
      labels: ['cuda'],
      os: 'linux',
      resources: { gpu: 1 },
      // Codex is the routing table's first choice for the tasks these tests write.
      runtimes: { [codex.runtime]: { binary: '/bin/codex', version: '1', logged_in: true } },
    }),
  );
  ctx.devices!.set(
    'mac-mini',
    status({ id: 'mac-mini', labels: ['xcode'], online: false, error: 'unreachable' }),
  );
}

const onGpuBox = { device: 'gpu-box', device_reason: 'Only the GPU box has CUDA' };

it('refuses a task on a device that is not configured and lists the configured ones', async () => {
  const { f, lead } = await setup();
  withDevices(f);
  const error = failure(() =>
    write(f, lead, [task({ device: 'cloud-box', device_reason: 'It is fast' })]),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('cloud-box');
  expect(error.message).toContain('gpu-box');
  expect(error.message).toContain('mac-mini');
  expect(planOf(f, lead)).toBeUndefined();
});

it('refuses a task on another device without device_reason', async () => {
  const { f, lead } = await setup();
  withDevices(f);
  const error = failure(() => write(f, lead, [task({ device: 'gpu-box' })]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('device_reason');
  write(f, lead, [task(onGpuBox)]);
  expect(taskOf(f, lead)?.device).toBe('gpu-box');
});

it('refuses a task whose needs its device lacks and names the devices that have them', async () => {
  const { f, lead } = await setup();
  withDevices(f);
  const error = failure(() => write(f, lead, [task({ needs: ['cuda'] })]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('cuda');
  expect(error.message).toContain('gpu-box');
  const none = failure(() => write(f, lead, [task({ ...onGpuBox, needs: ['cuda', 'tpu'] })]));
  expect(none.message).toContain('tpu');
  expect(none.message).toContain('none');
  write(f, lead, [task({ ...onGpuBox, needs: ['cuda'] })]);
  expect(taskOf(f, lead)?.needs).toEqual(['cuda']);
  // The device's system answers an os= need.
  write(f, lead, [task({ ...onGpuBox, needs: ['cuda', 'os=linux'] })]);
  expect(taskOf(f, lead)?.needs).toEqual(['cuda', 'os=linux']);
  // An offline device's labels are not known, so its needs are not checked.
  write(f, lead, [task({ device: 'mac-mini', device_reason: 'It builds iOS', needs: ['ios'] })]);
  expect(taskOf(f, lead)?.device).toBe('mac-mini');
});

it('refuses a task that uses more of a resource than its device has', async () => {
  const { f, lead } = await setup();
  withDevices(f);
  const error = failure(() => write(f, lead, [task({ ...onGpuBox, uses: { gpu: 2 } })]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('gpu');
  expect(error.message).toContain('has 1');
  const local = failure(() => write(f, lead, [task({ uses: { gpu: 1 } })]));
  expect(local.message).toContain('local');
  write(f, lead, [task({ ...onGpuBox, uses: { gpu: 1 } })]);
  expect(taskOf(f, lead)?.uses).toEqual({ gpu: 1 });
});

it('checks the device for the runtime the task opens on, which the writer choice decides', async () => {
  const { f, lead } = await setup();
  withDevices(f);
  const claudeAdapter = new FixtureAdapter(100);
  claudeAdapter.name = 'claude';
  f.control.adapters.set(claudeAdapter.name, claudeAdapter);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  ctx.devices!.set('gpu-box', {
    ...ctx.devices!.get('gpu-box')!,
    runtimes: { codex: { binary: '/bin/codex', version: '1', logged_in: true } },
  });
  const defaults = (runtime: string, writer: string) => {
    const project = f.store.must<Project>('projects', f.project.id);
    f.store.update<Project>(
      'projects',
      {
        ...project,
        session_defaults: { runtime, permission_mode: 'ask', writer: { runtime: writer } },
      },
      project.revision,
    );
  };
  defaults('claude', 'codex');
  write(f, lead, [task(onGpuBox)]);
  expect(taskOf(f, lead)?.device).toBe('gpu-box');

  defaults('codex', 'claude');
  const error = failure(() => write(f, lead, [task({ ...onGpuBox, needs: ['cuda'] })]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('runs on runtime claude');
});

it('asks route_reason again when the write drops the reason', async () => {
  const { f, lead } = await setup();
  const other = { kind: { domain: 'backend-logic', tier: 't2' }, model: 'other-model' };
  write(f, lead, [task({ ...other, route_reason: 'The user asked for this model' })]);
  const dropped = failure(() => write(f, lead, [task(other)]));
  expect(dropped.code).toBe('invalid_input');
  expect(dropped.message).toContain('route_reason');
});
