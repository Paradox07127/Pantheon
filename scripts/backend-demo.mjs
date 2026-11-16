import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import { runGit } from '../packages/control/dist/git.js';

// Managed worktrees refuse temporary directories.
const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
await mkdir(cache, { recursive: true });
const root = await mkdtemp(path.join(cache, 'pantheon-demo-'));
let daemon;
const git = (cwd, args) => {
  const result = runGit(cwd, args);
  if (result.exit_code !== 0) throw new Error(result.error ?? result.stderr.toString());
  return result.stdout.toString().trim();
};
try {
  const source = path.join(root, 'project');
  await mkdir(source);
  git(source, ['init', '--initial-branch=fixture-source']);
  await writeFile(path.join(source, 'README.md'), 'Fixture project\n');
  git(source, ['add', '--', 'README.md']);
  git(source, ['commit', '-m', 'Create fixture project']);
  daemon = await startDaemon({
    directory: path.join(root, 'state'),
    workspaceRoot: path.join(root, 'workspaces'),
    adapters: [new FixtureAdapter()],
    intervalMs: 10,
  });
  const diagnostics = [];
  daemon.control.on('diagnostic', (error) => diagnostics.push(String(error)));
  const call = async (type, input, revision = null) => {
    const response = await fetch(daemon.url + '/v1/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command('local-user', type, input, revision)),
    });
    const data = await response.json();
    if (!response.ok || data.receipt?.error) throw new Error(`${type}: ${JSON.stringify(data)}`);
    return data.receipt;
  };
  const until = async (what, done) => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const value = done();
      if (value) return value;
      if (Date.now() >= deadline || diagnostics.length)
        throw new Error(
          `Demo stopped waiting for ${what}: ${JSON.stringify({
            sessions: daemon.store.list('sessions'),
            turns: daemon.store.list('session_turns'),
            workspaces: daemon.store.list('workspaces'),
            diagnostics,
          })}`,
        );
      await sleep(10);
    }
  };
  const project = await call('project.open', { name: 'Backend demo', roots: [source] });
  console.log('Project opened: temporary git repository; no model calls');
  const created = await call('session.create', {
    project_id: project.id,
    runtime: 'fixture',
    input: 'Demonstrate a merged change through Pantheon',
  });
  console.log('Session created with the fixture runtime in its own worktree');
  const workspace = await until('the worktree', () => {
    const row = daemon.store.get('workspaces', created.workspace_id);
    return row?.provisioning?.state === 'ready' && row;
  });
  await until('the first turn', () => {
    const session = daemon.store.get('sessions', created.id);
    const turns = daemon.store.list('session_turns').filter((t) => t.session_id === created.id);
    if (turns.some((turn) => turn.state === 'failed')) throw new Error('The first turn failed');
    return session.state === 'open' && turns[0]?.state === 'completed';
  });
  console.log('First turn completed');
  await writeFile(path.join(workspace.path, 'CHANGE.md'), 'A change made in the worktree\n');
  git(workspace.path, ['add', '--', 'CHANGE.md']);
  git(workspace.path, ['commit', '-m', 'Add the demo change']);
  const commit = git(workspace.path, ['rev-parse', 'HEAD']);
  console.log(`Committed in the worktree: ${commit}`);
  const session = daemon.store.get('sessions', created.id);
  await call('session.merge', { session_id: session.id }, session.revision);
  await until('the merge', () => {
    const current = daemon.store.get('sessions', created.id);
    if (current.merge?.state === 'blocked')
      throw new Error(`Merge blocked: ${JSON.stringify(current.merge)}`);
    return current.outcome === 'merged';
  });
  const head = git(source, ['rev-parse', 'refs/heads/fixture-source']);
  if (head !== commit || git(source, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error('Source repository does not contain the clean merged commit');
  console.log('Session merged into the source branch');
  console.log(`Source branch head: ${head}`);
} finally {
  try {
    await daemon?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
