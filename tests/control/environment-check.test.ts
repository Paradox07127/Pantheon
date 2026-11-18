import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startEnvironmentCheck } from '@pantheon/control';
import type { EnvironmentCheck, Project, Workspace } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { eventually, gateFolder, insideSandbox } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Input = Parameters<typeof startEnvironmentCheck>[1];

const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const rowOf = (f: Fixture, id: string) => f.store.must<EnvironmentCheck>('environment_checks', id);
const workspaceOf = (f: Fixture, row: EnvironmentCheck) =>
  f.store.must<Workspace>('workspaces', row.workspace_id!);

function setWorktree(f: Fixture, worktree: { copy_paths: string[]; command?: { argv: string[] } }) {
  f.call(
    'project.worktree.set',
    { project_id: f.project.id, ...worktree },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

function start(f: Fixture, input: Partial<Input>): EnvironmentCheck {
  const ctx = contextOf(f);
  return ctx.store.transaction(() =>
    startEnvironmentCheck(ctx, {
      project_id: f.project.id,
      root: f.project.roots[0]!,
      commands: [],
      base_ref: 'HEAD',
      cause: { kind: 'user' },
      ...input,
    }),
  );
}

async function ended(f: Fixture, row: EnvironmentCheck): Promise<EnvironmentCheck> {
  await eventually(
    () => rowOf(f, row.id).state !== 'running',
    () => f.control.tick(),
    20000,
  );
  return rowOf(f, row.id);
}

/** Ticks until the check's worktree is removed, and returns its last row. */
async function removed(f: Fixture, row: EnvironmentCheck): Promise<Workspace> {
  await eventually(
    () => workspaceOf(f, row).removed_at !== undefined,
    () => f.control.tick(),
    20000,
  );
  return workspaceOf(f, row);
}

it
  .skipIf(insideSandbox)
  .each<
    [string, { worktree?: string[]; setup?: string[]; gate: string[] }, Partial<EnvironmentCheck>]
  >([
    [
      'passes after the project worktree command',
      { worktree: ['sh', '-c', 'touch ok'], gate: ['sh', '-c', 'test -f ok'] },
      {
        state: 'passed',
        commands: [
          expect.objectContaining({ name: 'setup', argv: ['sh', '-c', 'touch ok'], exit_code: 0 }),
          expect.objectContaining({ name: 'Gate', argv: ['sh', '-c', 'test -f ok'], exit_code: 0 }),
        ],
      },
    ],
    [
      'passes after its own setup command when the project has none',
      { setup: ['sh', '-c', 'touch ok'], gate: ['sh', '-c', 'test -f ok'] },
      {
        state: 'passed',
        commands: [
          expect.objectContaining({ name: 'setup', argv: ['sh', '-c', 'touch ok'], exit_code: 0 }),
          expect.objectContaining({ name: 'Gate', exit_code: 0 }),
        ],
      },
    ],
    [
      'fails with the exit code and output of a failing gate',
      { gate: ['sh', '-c', 'echo broken test >&2; exit 3'] },
      {
        state: 'failed',
        reason_code: 'checks_failed',
        commands: [
          expect.objectContaining({
            name: 'Gate',
            exit_code: 3,
            output_tail: expect.stringContaining('broken test'),
            failure_class: 'code',
          }),
        ],
      },
    ],
    [
      'fails with the provisioning output of a failing setup and runs no gate',
      { worktree: ['sh', '-c', 'echo no registry here; exit 4'], gate: ['sh', '-c', 'true'] },
      {
        state: 'failed',
        reason_code: 'setup_failed',
        commands: [
          expect.objectContaining({
            name: 'setup',
            exit_code: 4,
            output_tail: expect.stringContaining('no registry here'),
          }),
        ],
      },
    ],
  ])('%s and leaves no worktree behind', async (_, commands, expected) => {
  const f = await workbenchFixture();
  if (commands.worktree) setWorktree(f, { copy_paths: [], command: { argv: commands.worktree } });
  const row = start(f, {
    commands: [{ name: 'Gate', argv: commands.gate }],
    ...(commands.setup ? { setup: { argv: commands.setup } } : {}),
  });
  expect(row).toMatchObject({ state: 'running', workspace_id: expect.any(String) });
  const end = await ended(f, row);
  expect(end).toMatchObject({ ...expected, finished_at: expect.any(Number) });
  expect(end.commands).toHaveLength(expected.commands!.length);
  if (end.state === 'passed') expect(end.commit).toBe(git(f.source, 'rev-parse', 'HEAD'));
  const workspace = await removed(f, row);
  expect(existsSync(workspace.path)).toBe(false);
});

it.skipIf(insideSandbox)(
  'copies the project copy paths into the worktree before the gate runs',
  async () => {
    const f = await workbenchFixture();
    writeFileSync(path.join(f.source, 'settings.local'), 'local settings\n');
    setWorktree(f, { copy_paths: ['settings.local'] });
    const row = start(f, {
      commands: [{ name: 'Gate', argv: ['sh', '-c', 'grep -q "local settings" settings.local'] }],
    });
    expect(await ended(f, row)).toMatchObject({
      state: 'passed',
      commands: [expect.objectContaining({ name: 'Gate', exit_code: 0 })],
    });
  },
);

it.skipIf(insideSandbox)(
  'ends a check that was running at a restart inconclusive and removes its worktree',
  async () => {
    const f = await workbenchFixture();
    // The gate waits for the release file, and ends on its own after 8 s.
    const gate = gateFolder(f.root);
    const release = path.join(gate.dir, 'release');
    const row = start(f, {
      commands: [
        {
          name: 'Gate',
          argv: gate.argv(
            `const fs=require('node:fs');const end=Date.now()+8000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})||Date.now()>end)clearInterval(t)},20)`,
          ),
        },
      ],
    });
    // The restart leaves the old control's check running; it must end before the store closes.
    const { completions } = contextOf(f);
    const checking = [...completions];
    await eventually(
      () => workspaceOf(f, row).provisioning?.state === 'ready',
      () => f.control.tick(),
      20000,
    );
    await f.restart();
    expect(rowOf(f, row.id)).toMatchObject({
      state: 'inconclusive',
      reason_code: 'daemon_restart',
      finished_at: expect.any(Number),
    });
    const workspace = await removed(f, row);
    expect(existsSync(workspace.path)).toBe(false);
    writeFileSync(release, '');
    await Promise.allSettled(checking);
  },
);
