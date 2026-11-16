import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Project, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, gateFolder, insideSandbox } from '../helpers.js';
import { crashBench, type BenchDaemon } from './crash-harness.js';
import { git } from './workbench-fixture.js';

const session = (daemon: BenchDaemon, id: string) => daemon.store.must<Session>('sessions', id);
const turns = (daemon: BenchDaemon, sessionId: string) =>
  daemon.store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === sessionId);
const payloads = (daemon: BenchDaemon, sessionId: string, kind: string) =>
  daemon.store
    .events(0, undefined, 10000)
    .filter((event) => event.aggregate_id === sessionId && event.kind === kind)
    .map((event) => event.payload);

/** Waits until the session is open with no queued or running turn, its worktree ready. */
async function settle(daemon: BenchDaemon, sessionId: string) {
  await awaitWorkspaceReady(daemon.control, session(daemon, sessionId).workspace_id!);
  await eventually(
    () =>
      session(daemon, sessionId).state === 'open' &&
      turns(daemon, sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => daemon.control.tick(),
  );
}

async function send(daemon: BenchDaemon, sessionId: string, input: string) {
  daemon.call(
    'session.send',
    { session_id: sessionId, input },
    session(daemon, sessionId).revision,
  );
  await settle(daemon, sessionId);
  return turns(daemon, sessionId).at(-1)!;
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

/**
 * Counts the connections gates make; a gate's sandbox can reach loopback but no lasting file.
 * On Linux its loopback is its own, so it connects to a socket in a folder it can read.
 */
async function gateCounter() {
  let count = 0;
  const server = createServer((socket) => {
    count++;
    socket.resume();
  });
  const gate = gateFolder(os.tmpdir());
  if (process.platform === 'linux') server.listen(path.join(gate.dir, 'count.sock'));
  else server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address() as string | { port: number };
  const target =
    typeof address === 'string' ? JSON.stringify(address) : `${address.port}, '127.0.0.1'`;
  return {
    argv: gate.argv(`require('node:net').connect(${target}, function () { this.end(); })`),
    get count() {
      return count;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

it.skipIf(insideSandbox)(
  'completes a merge whose daemon was killed after the fast-forward, recording the range once without gating again',
  async () => {
    const bench = crashBench();
    const counter = await gateCounter();
    try {
      const setup = bench.start();
      const project = setup.call<Project>('project.open', {
        name: 'Crash project',
        roots: [bench.source],
      });
      setup.call(
        'project.gate.set',
        {
          project_id: project.id,
          root: bench.source,
          commands: [{ name: 'Counts its runs', argv: counter.argv }],
        },
        project.revision,
      );
      const created = setup.call<Session>('session.create', {
        project_id: project.id,
        runtime: 'fixture',
        input: 'Add two files',
      });
      await settle(setup, created.id);
      const workspace = setup.store.must<Workspace>('workspaces', created.workspace_id!);
      const sourceHead = git(bench.source, 'rev-parse', 'HEAD');
      commit(workspace.path, 'first.txt', 'first\n');
      const head = commit(workspace.path, 'second.txt', 'second\n');
      await setup.stop();

      await bench.crash({
        failpoint: 'after_fast_forward_before_receipt',
        commands: [
          { type: 'session.merge', input: { session_id: created.id }, revision_of: created.id },
        ],
      });
      expect(git(bench.source, 'rev-parse', 'main')).toBe(head);
      expect(counter.count).toBe(1);

      const after = await bench.restart();
      expect(session(after, created.id).outcome).toBeUndefined();
      await eventually(
        () => after.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
        () => after.control.tick(),
        10000,
      );
      expect(session(after, created.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
      expect(git(bench.source, 'rev-parse', 'main')).toBe(head);
      expect(payloads(after, created.id, 'session.merged')).toEqual([
        {
          branch: 'main',
          source: workspace.source,
          from_sha: sourceHead,
          to_sha: head,
          files: 2,
          additions: 2,
          deletions: 0,
          measured_kind: { domain: 'backend-logic', tier: 't1' },
        },
      ]);
      expect(counter.count).toBe(1);
    } finally {
      await counter.close();
    }
  },
  60000,
);

it('finishes a rollback whose daemon was killed after the files were restored and before the record committed', async () => {
  const bench = crashBench();
  const setup = bench.start();
  const project = setup.call<Project>('project.open', {
    name: 'Crash project',
    roots: [bench.source],
  });
  const created = setup.call<Session>('session.create', {
    project_id: project.id,
    runtime: 'fixture',
    input: 'Start the export',
  });
  await settle(setup, created.id);
  const work = setup.store.must<Workspace>('workspaces', created.workspace_id!).path;
  writeFileSync(path.join(work, '.gitignore'), '*.log\n');
  writeFileSync(path.join(work, 'kept.txt'), 'kept\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'Export started');
  writeFileSync(path.join(work, 'notes.txt'), 'notes\n');
  const head = git(work, 'rev-parse', 'HEAD');
  const second = await send(setup, created.id, 'Add a header row');
  const checkpoint = git(
    work,
    'rev-parse',
    `refs/pantheon/checkpoints/${created.workspace_id}/${created.id}/${second.id}`,
  );
  rmSync(path.join(work, 'kept.txt'));
  writeFileSync(path.join(work, 'answer.txt'), 'header\n');
  mkdirSync(path.join(work, 'build'));
  writeFileSync(path.join(work, 'build/out.txt'), 'out\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'Header added');
  writeFileSync(path.join(work, 'loose.txt'), 'loose\n');
  writeFileSync(path.join(work, 'debug.log'), 'ignored\n');
  await setup.stop();

  await bench.crash({
    failpoint: 'after_rollback_restore_before_record',
    commands: [
      {
        type: 'session.rollback',
        input: { session_id: created.id, turn_id: second.id },
        revision_of: created.id,
      },
    ],
  });

  const after = await bench.restart();
  const recovered = session(after, created.id);
  expect(recovered.rollback_pending).toBeUndefined();
  expect(recovered.handoff_before_turn_id).toBe(second.id);
  expect(payloads(after, created.id, 'session.rolled_back')).toEqual([
    { turn_id: second.id, head },
  ]);
  // The worktree holds the checkpoint's files and no other file that is not ignored.
  const files = git(work, 'ls-tree', '-r', '--name-only', checkpoint).split('\n');
  for (const file of files)
    expect(readFileSync(path.join(work, file), 'utf8')).toBe(
      `${git(work, 'show', `${checkpoint}:${file}`)}\n`,
    );
  expect(
    git(work, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').sort(),
  ).toEqual([...files].sort());
  expect(readFileSync(path.join(work, 'debug.log'), 'utf8')).toBe('ignored\n');
  expect(git(work, 'rev-parse', 'HEAD')).toBe(head);

  const next = await send(after, created.id, 'Add a footer row');
  expect(next).toMatchObject({ input: 'Add a footer row', state: 'completed' });
  expect(next.handoff).toContain('Start the export');
  expect(next.handoff).not.toContain('Add a header row');
}, 60000);
