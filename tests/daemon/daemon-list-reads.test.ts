import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Project, Session, SessionTurn } from '@pantheon/domain';
import { startFixtureDaemon } from '../acceptance/lib/daemon.mjs';
import { git } from '../control/workbench-fixture.js';
import { awaitWorkspaceReady, eventually } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('answers the session list, board and summary before the worktree reads finish, and emits once they do', async () => {
  const root = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/pantheon-list-reads-'));
  const source = path.join(root, 'source'),
    managed = path.join(root, 'managed');
  mkdirSync(source);
  mkdirSync(managed);
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'init', '--quiet', '--initial-branch=main');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial files');
  const f = await startFixtureDaemon(root, [new FixtureAdapter()], {
    workspaceRoot: managed,
    protectionPaths: {
      dataDir: path.join(root, 'state'),
      desktopUserDataDir: path.join(root, 'desktop'),
      backupDir: path.join(root, 'backups'),
      home: path.join(root, 'home'),
      codexHome: path.join(root, 'codex'),
    },
  });
  let release = () => {};
  try {
    const project: Project = await f.call('project.open', { name: 'List reads', roots: [source] });
    const session: Session = await f.call('session.create', {
      project_id: project.id,
      runtime: 'fixture',
      input: 'Read the answer file',
    });
    const workspace = await awaitWorkspaceReady(f.daemon.control, session.workspace_id!);
    await eventually(
      () =>
        f.daemon.store.must<Session>('sessions', session.id).state === 'open' &&
        f.daemon.store
          .list<SessionTurn>('session_turns')
          .filter((turn) => turn.session_id === session.id)
          .every((turn) => turn.state === 'completed'),
      () => f.daemon.control.tick(),
    );
    writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');

    const gitModule = await import('../../packages/control/dist/git.js');
    const runGit = gitModule.runGit;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi
      .spyOn(gitModule, 'runGit')
      .mockImplementation(((...args: Parameters<typeof runGit>) =>
        args[3] === true ? gate.then(() => runGit(...args)) : runGit(...args)) as never);
    const syncCalls = () =>
      spy.mock.calls.filter(([cwd, , , asynchronous]) => cwd === workspace.path && !asynchronous)
        .length;
    const get = async (method: string, query = `?project_id=${project.id}`) => {
      const response = await fetch(`${f.daemon.url}/v1/${method}${query}`, {
        headers: { Authorization: `Bearer ${f.daemon.token}` },
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const row = async () =>
      ((await get('session.list')) as { id: string }[]).find((each) => each.id === session.id);
    const changed = () =>
      f.daemon.store.kindEvents(project.id, ['workspace.repository_changed']).length;

    const unread = await row();
    expect(unread).toMatchObject({ state: 'idle', changes: null });
    expect(unread).not.toHaveProperty('branch');
    await get('board.view', `?project_id=${project.id}&days=14`);
    await get('projects.summary', '');
    expect(syncCalls()).toBe(0);
    expect(changed()).toBe(0);

    release();
    // Held past the read cache age, the reads are started again, and each start may emit.
    await eventually(() => changed() >= 1);
    const read = await row();
    expect(read).toMatchObject({ changes: { files: 1 } });
    expect(read).toHaveProperty('branch');
    expect(syncCalls()).toBe(0);
  } finally {
    release();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports a query that holds the event loop longer than half a second', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-blocked-query-'));
  mkdirSync(path.join(root, 'project'));
  const f = await startFixtureDaemon(root, [new FixtureAdapter()]);
  try {
    const project: Project = await f.call('project.open', {
      name: 'Blocked query',
      roots: [path.join(root, 'project')],
    });
    const diagnostics: string[] = [];
    f.daemon.control.on('diagnostic', (error) => diagnostics.push(String(error)));
    vi.spyOn(f.daemon.control, 'sessionList').mockImplementation(() => {
      const end = performance.now() + 600;
      while (performance.now() < end);
      return [];
    });
    const response = await fetch(`${f.daemon.url}/v1/session.list?project_id=${project.id}`, {
      headers: { Authorization: `Bearer ${f.daemon.token}` },
    });
    expect(response.status).toBe(200);
    const line = diagnostics.find((each) => each.includes('session.list'));
    expect(line).toMatch(/\b(6\d\d|[7-9]\d\d|\d{4,}) ms\b/);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
