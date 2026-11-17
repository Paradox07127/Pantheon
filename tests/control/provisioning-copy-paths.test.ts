import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Workspace } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

// Each copied file takes a moment, so a stop can land in the middle of one copy path.
const paced = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: ((from, to, options) =>
      actual.cp(
        from,
        to,
        paced.on
          ? {
              ...options,
              filter: async (source, destination) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return options?.filter ? options.filter(source, destination) : true;
              },
            }
          : options,
      )) as typeof actual.cp,
  };
});

it('stops copying a large copy path when provisioning is stopped', async () => {
  const f = await workbenchFixture();
  mkdirSync(path.join(f.source, 'large'));
  for (let index = 0; index < 200; index++)
    writeFileSync(path.join(f.source, 'large', `file-${index}`), 'content\n');
  f.call(
    'project.worktree.set',
    { project_id: f.project.id, copy_paths: ['large'] },
    f.project.revision,
  );
  paced.on = true;
  try {
    const session = await f.create();
    const workspace = () => f.store.must<Workspace>('workspaces', session.workspace_id!);
    await eventually(
      () => workspace().provisioning?.phase === 'copy',
      () => f.control.tick(),
    );
    const { stopWorkspaceProvisioning } =
      await import('../../packages/control/dist/provisioning.js');
    stopWorkspaceProvisioning((f.control as unknown as { ctx: ControlContext }).ctx);
    await eventually(
      () => !['queued', 'running'].includes(workspace().provisioning!.state),
      undefined,
      20000,
    );
    expect(workspace().provisioning?.state).toBe('cancelled');
    const copied = path.join(workspace().path, 'large');
    expect(existsSync(copied) ? readdirSync(copied).length : 0).toBeLessThan(200);
  } finally {
    paced.on = false;
  }
});
