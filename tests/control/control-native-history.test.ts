import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, SessionSpec } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { managedSessionSpec } from '../../packages/control/dist/native-session.js';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';
import { git } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});

/** Worktree sessions branch from a commit of the project root. */
function commitProjectRoot(root: string) {
  git(root, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

function setup() {
  const f = fixture({ managedWorkspaces: true });
  cleanups.push(() => f.close());
  commitProjectRoot(f.projectRoot);
  // The first turn waits for the worktree, so the session is not launched yet.
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: '{"facts":{"opaque":true}}',
  });
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const spec: SessionSpec = {
    platform_session_id: session.id,
    project_id: f.project.id,
    runtime: f.adapter.name,
    role: 'planner',
    device_id: 'local',
    cwd: f.projectRoot,
    env_allowlist: [],
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
  return { ...f, session, ctx, spec };
}

it('selects a protected managed store before launch and reuses it without changing the session revision', () => {
  const f = setup();
  f.spec.sandbox = { writable_roots: [], protected_entries: [] };
  const first = managedSessionSpec(f.ctx, f.spec);
  const selected = f.store.must<Session>('sessions', f.session.id);
  expect(selected.native_state_dir).toBe(
    path.join(f.root, 'state/native-sessions', f.project.id, f.adapter.name),
  );
  expect(first.native_state_dir).toBe(selected.native_state_dir);
  expect(first.native_title).toBe('fixture · Project conversation');
  expect(first.sandbox?.protected_entries).toContainEqual({
    path: path.join(f.root, 'state/native-sessions'),
    deny: 'read_write',
  });
  managedSessionSpec(f.ctx, f.spec);
  expect(f.store.must<Session>('sessions', f.session.id).revision).toBe(selected.revision);
  expect(f.store.events().filter((e) => e.kind === 'session.native_history_selected')).toHaveLength(
    1,
  );
});

it('keeps a tool-free session tool-free while selecting its isolated history', () => {
  const f = setup();
  const spec = managedSessionSpec(f.ctx, f.spec);
  expect(spec.native_state_dir).toContain('/native-sessions/');
  expect(spec).not.toHaveProperty('sandbox');
});

it('never relocates a legacy native ID implicitly during resume', () => {
  const f = setup();
  f.store.update('sessions', { ...f.session, native_id: 'old-global-native' }, f.session.revision);
  const resumed = managedSessionSpec(f.ctx, f.spec);
  expect(resumed.native_state_dir).toBeUndefined();
  expect(f.store.must<Session>('sessions', f.session.id).native_id).toBe('old-global-native');
  expect(
    f.store.events().find((e) => e.kind === 'session.native_history_selected')?.payload,
  ).toMatchObject({ mode: 'legacy' });
});

it('passes the managed store and readable title through actual control startup before an adapter receives input', async () => {
  const f = setup();
  const start = f.adapter.start.bind(f.adapter);
  const seen: SessionSpec[] = [];
  vi.spyOn(f.adapter, 'start').mockImplementation(async (spec, sink) => {
    seen.push(spec);
    expect(f.store.must<Session>('sessions', spec.platform_session_id).native_state_dir).toBe(
      spec.native_state_dir,
    );
    return start(spec, sink);
  });
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  await awaitWorkspaceReady(f.control, f.session.workspace_id!);
  await eventually(
    () => seen.length > 0,
    () => f.control.tick(),
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.native_title).toBe('fixture · Project conversation');
  expect(seen[0]?.native_state_dir).toContain('/native-sessions/');
});
