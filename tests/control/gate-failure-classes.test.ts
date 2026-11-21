import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Project, Session, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, insideSandbox, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function mergeFixture() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

/** An idle session with its first turn done. */
async function idleSession(f: Fixture) {
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session, workspace, sourceHead };
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);
const removed = (f: Fixture, workspaceId: string) =>
  f.store.must<Workspace>('workspaces', workspaceId).removed_at !== undefined;
const payloads = (f: Fixture, aggregateId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(aggregateId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

function setGate(f: Fixture, commands: { name: string; argv: string[]; timeout_ms?: number }[]) {
  return f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    project(f).revision,
  );
}

/**
 * A gate that hangs on its first run in a candidate and leaves a file there; a run that finds the
 * file prints that it is the rerun, then passes or hangs again.
 */
const hangsFirst = (rerun: 'passes' | 'hangs') => ({
  name: 'Hangs on its first run',
  argv: [
    process.execPath,
    '-e',
    [
      "const fs = require('node:fs');",
      "if (!fs.existsSync('first-run-done')) {",
      "  fs.writeFileSync('first-run-done', '');",
      "  console.log('first run');",
      '  setInterval(() => {}, 1000);',
      '} else {',
      "  console.log('rerun on the same candidate');",
      rerun === 'passes' ? '  process.exit(0);' : '  setInterval(() => {}, 1000);',
      '}',
    ].join('\n'),
  ],
  timeout_ms: 3000,
});

const failing = {
  name: 'Always fails',
  argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
};

const sandboxRefused = {
  name: 'Prints a sandbox refusal',
  argv: [
    process.execPath,
    '-e',
    "process.stderr.write('xcrun: error: unable to load libxcrun (dlopen(/x/libxcrun.dylib, 0x0005): tried: \\'/x/libxcrun.dylib\\' (file system sandbox blocked open())).'); process.exit(1)",
  ],
};

const unstartable = {
  name: 'Cannot start',
  argv: ['/nonexistent/pantheon-gate-tool'],
};

const merge = (f: Fixture, sessionId: string) =>
  f.call('session.merge', { session_id: sessionId }, current(f, sessionId).revision);

it.skipIf(insideSandbox)(
  'reruns a gate that timed out once on the same commit before blocking the merge',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [hangsFirst('hangs')]);
    commit(workspace.path, 'answer.txt', 'gated\n');
    merge(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'gate_failed',
      failure_class: 'environment',
      gate: { name: 'Hangs on its first run' },
    });
    expect(current(f, session.id).merge!.gate!.output).toContain('rerun on the same candidate');
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'merges when a flaky gate passes on its automatic rerun',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, [hangsFirst('passes')]);
    const head = commit(workspace.path, 'answer.txt', 'flaky gate\n');
    merge(f, session.id);
    await eventually(
      () => removed(f, workspace.id) || current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'classifies a failed gate that prints a sandbox refusal as a code failure',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [sandboxRefused]);
    commit(workspace.path, 'answer.txt', 'sandbox\n');
    merge(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'gate_failed',
      failure_class: 'code',
      gate: { name: 'Prints a sandbox refusal' },
    });
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'lists a gate that could not start in needs-you as an environment failure',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, [unstartable]);
    commit(workspace.path, 'answer.txt', 'unstartable\n');
    merge(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id).merge).toMatchObject({
      reason: 'gate_failed',
      failure_class: 'environment',
    });
    expect(f.control.needsYou(user, f.project.id).items).toMatchObject([
      {
        source: { table: 'sessions', id: session.id },
        reason: 'gate_failed',
        failure_class: 'environment',
      },
    ]);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'classifies a gate that exited non-zero as a code failure',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, [failing]);
    commit(workspace.path, 'answer.txt', 'broken\n');
    merge(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(payloads(f, session.id, 'session.merge_blocked')).toMatchObject([
      { reason: 'gate_failed', failure_class: 'code', gate: { name: 'Always fails' } },
    ]);
  },
  20000,
);
