import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project, Session, Workspace } from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { eventually, settle } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

afterEach(() => {
  vi.restoreAllMocks();
});

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);

function validationResult(exit_code = 0): validation.ValidationResult {
  return {
    exit_code,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: exit_code ? 'acceptance failed' : '',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
  };
}

/** An idle session of a project with one gate command. */
async function gatedSession() {
  const f = await workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [{ name: 'Check', argv: ['true'] }] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const session = await f.create('Export the report');
  await settle(f, session);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  return { f, session, workspace };
}

function commit(repository: string, name: string) {
  writeFileSync(path.join(repository, name), `${name}\n`);
  git(repository, 'add', name);
  git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

it('counts only its own commits as the change of a session rebased for a gate that failed', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult(1));
  const { f, session, workspace } = await gatedSession();
  commit(workspace.path, 'session.txt');
  // Another session landed first.
  const landed = commit(f.source, 'source.txt');
  await f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.merge_blocked'])
        .some((e) => (e.payload as { reason: string }).reason === 'gate_failed'),
    () => f.control.tick(),
    10000,
  );
  const base = f.store.must<Workspace>('workspaces', workspace.id).base_sha!;
  expect(base).toBe(landed);
  expect(git(workspace.path, 'diff', '--name-only', base, 'HEAD')).toBe('session.txt');
});
