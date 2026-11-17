import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';
import type { LocalCommand } from '../../packages/control/src/local-command.js';

const pull = { number: 24, url: 'https://github.com/owner/project/pull/24' };
async function setup(existing = false) {
  const run: LocalCommand = vi.fn(async (_file, args) => ({
    stdout:
      args[1] === 'list'
        ? JSON.stringify(existing ? [pull] : [])
        : args[1] === 'create'
          ? `${pull.url}\n`
          : JSON.stringify(pull),
    stderr: '',
    exit_code: 0,
  }));
  const f = await workbenchFixture({ localCommand: run });
  const origin = path.join(f.root, 'origin.git');
  git(f.source, 'init', '--bare', '--quiet', origin);
  git(f.source, 'remote', 'add', 'origin', origin);
  const session = await f.create('Fix the total');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  return { ...f, session, workspace, run, origin };
}

it('pushes the session branch and opens a draft PR against its source branch with the session title', async () => {
  const f = await setup();
  const branch = `pantheon/${f.session.id.slice(0, 8)}`;
  const request = command(user.id, 'github.pr.create', { session_id: f.session.id, draft: true });
  expect(await f.control.execute(user, request)).toEqual(pull);
  expect(git(f.origin, 'rev-parse', `refs/heads/${branch}`)).toBe(
    git(f.workspace.path, 'rev-parse', 'HEAD'),
  );
  expect(f.run).toHaveBeenCalledWith(
    'gh',
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      'Fix the total',
      '--body',
      '',
      '--draft',
    ],
    f.workspace.path,
    60_000,
  );
  expect(f.store.events(0).filter((event) => event.kind === 'session.pr_created')).toMatchObject([
    { aggregate_id: f.session.id, payload: pull },
  ]);
  const calls = vi.mocked(f.run).mock.calls.length;
  expect(await f.control.execute(user, request)).toEqual(pull);
  expect(vi.mocked(f.run).mock.calls).toHaveLength(calls);
});

it('keeps the opened pull request on the session and its listed row', async () => {
  const f = await setup();
  await f.call('github.pr.create', { session_id: f.session.id });
  expect(f.store.must<Session>('sessions', f.session.id).pull_request).toEqual(pull);
  expect(f.list().find((row) => row.id === f.session.id)?.pull_request).toEqual(pull);
});

it('returns the existing open pull request without pushing or creating', async () => {
  const f = await setup(true);
  expect(
    await f.call('github.pr.create', { session_id: f.session.id, title: 'Custom title' }),
  ).toEqual(pull);
  expect(vi.mocked(f.run).mock.calls.map(([, args]) => args[1])).toEqual(['list']);
  expect(git(f.origin, 'for-each-ref', '--format=%(refname)')).toBe('');
});

it('refuses dirty worktrees, sessions without a worktree, and non-user principals', async () => {
  const f = await setup();
  writeFileSync(path.join(f.workspace.path, 'untracked.txt'), 'not committed');
  await expect(f.call('github.pr.create', { session_id: f.session.id })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  const plain = f.store.insert<Session>('sessions', {
    id: 'plain-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  await expect(f.call('github.pr.create', { session_id: plain.id })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  await expect(
    f.call('github.pr.create', { session_id: f.session.id }, null, { id: 'agent', role: 'lead' }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.run).not.toHaveBeenCalled();
});

/** Puts an executable script first on PATH until the returned function restores it. */
function onPath(dir: string, name: string, script: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), script);
  chmodSync(path.join(dir, name), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${dir}:${PATH}`;
  return () => {
    process.env.PATH = PATH;
  };
}

it('pushes with the gh login and ignores credential helpers the repository sets', async () => {
  const f = await setup(),
    seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? 'none');
    response.writeHead(request.headers.authorization ? 403 : 401, {
      'www-authenticate': 'Basic realm="origin"',
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const marker = path.join(f.root, 'repository-helper-ran');
  const restore = onPath(
    path.join(f.root, 'bin'),
    'gh',
    '#!/bin/sh\ncat >/dev/null\nif [ "$3" = get ]; then echo username=robin; echo password=token; fi\n',
  );
  try {
    const { port } = server.address() as AddressInfo;
    git(f.source, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/origin.git`);
    git(f.source, 'config', 'credential.helper', `!touch ${marker}`);
    await expect(f.call('github.pr.create', { session_id: f.session.id })).rejects.toMatchObject({
      code: 'git_failed',
    });
    expect(seen).toContain(`Basic ${Buffer.from('robin:token').toString('base64')}`);
    expect(existsSync(marker)).toBe(false);
  } finally {
    restore();
    server.close();
  }
});

it('pushes over ssh with the agent socket, never prompting, whatever ssh command the repository sets', async () => {
  const f = await setup(),
    record = path.join(f.root, 'ssh-call'),
    socket = process.env.SSH_AUTH_SOCK;
  const restore = onPath(
    path.join(f.root, 'bin'),
    'ssh',
    `#!/bin/sh\necho "SSH_AUTH_SOCK=$SSH_AUTH_SOCK $*" > ${record}\nexit 1\n`,
  );
  process.env.SSH_AUTH_SOCK = path.join(f.root, 'agent.sock');
  try {
    git(f.source, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/origin.git');
    git(f.source, 'config', 'core.sshCommand', 'ssh -o RepositoryCommand=yes');
    await expect(f.call('github.pr.create', { session_id: f.session.id })).rejects.toMatchObject({
      code: 'git_failed',
    });
    expect(readFileSync(record, 'utf8')).toMatch(
      `SSH_AUTH_SOCK=${path.join(f.root, 'agent.sock')} -o BatchMode=yes`,
    );
  } finally {
    restore();
    if (socket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = socket;
  }
});
