import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { Project, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, registerWorkspace } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

// The mount root WSL reads from /etc/wsl.conf; one per process, since the root is cached.
const cache = path.join(process.cwd(), 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const mountRoot = `${realpathSync(mkdtempSync(path.join(cache, 'pantheon-wsl-mount-')))}/`;
const readFile = fs.readFileSync;
vi.spyOn(fs, 'readFileSync').mockImplementation(((
  file: fs.PathOrFileDescriptor,
  options?: never,
) =>
  file === '/etc/wsl.conf'
    ? `[automount]\nroot = ${mountRoot}\n`
    : readFile(file, options)) as typeof fs.readFileSync);

const distro = process.env.WSL_DISTRO_NAME;
afterEach(() => {
  if (distro === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = distro;
});
afterAll(() => rmSync(mountRoot, { recursive: true, force: true }));

/** A fixture with a second project whose repository lies on drive D below the mount root. */
function driveProject(name: string) {
  const f = workbenchFixture();
  const root = path.join(mountRoot, 'd', name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  writeFileSync(path.join(root, 'notes.txt'), 'first\nsecond\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial notes');
  const project = f.call<Project>('project.open', { name: `Drive ${name}`, roots: [root] });
  return { f, root, project };
}

it.each([
  { wsl: true, stored: 'first\nsecond\nthird\n' },
  { wsl: false, stored: 'first\r\nsecond\r\nthird\r\n' },
])(
  'commits a CRLF file on a drive with LF line endings only under WSL (wsl $wsl)',
  async ({ wsl, stored }) => {
    const { f, root, project } = driveProject(`commit-${wsl}`);
    writeFileSync(path.join(root, 'notes.txt'), 'first\r\nsecond\r\nthird\r\n');
    if (wsl) process.env.WSL_DISTRO_NAME = 'Fixture';
    await f.call<Promise<unknown>>('repo.commit', {
      project_id: project.id,
      paths: ['notes.txt'],
      message: 'Add the third note',
    });
    delete process.env.WSL_DISTRO_NAME;
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Add the third note');
    const blob = execFileSync('git', ['cat-file', 'blob', 'HEAD:notes.txt'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(JSON.stringify(blob)).toBe(JSON.stringify(stored));
  },
);

it.each([{ wsl: true }, { wsl: false }])(
  'locks a session worktree of a drive repository only under WSL and still removes it (wsl $wsl)',
  async ({ wsl }) => {
    const { f, root, project } = driveProject(`worktree-${wsl}`);
    if (wsl) process.env.WSL_DISTRO_NAME = 'Fixture';
    const registered = registerWorkspace(f.control, {
      project_id: project.id,
      kind: 'linked_worktree',
      source: root,
      base_ref: 'HEAD',
    });
    const workspace = await awaitWorkspaceReady(f.control, registered);
    const listing = git(root, 'worktree', 'list', '--porcelain');
    const entry = listing.split('\n\n').find((block) => block.includes(workspace.path));
    expect(entry).toBeDefined();
    if (wsl) expect(entry).toContain('locked Pantheon session worktree');
    else expect(entry).not.toContain('locked');

    f.store.enqueue('workspace.remove', { workspace_id: workspace.id, reason: 'discarded' });
    await f.control.tick();
    expect(f.store.must<Workspace>('workspaces', workspace.id).removed_at).toBeDefined();
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path);
  },
);
