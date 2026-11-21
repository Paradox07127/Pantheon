import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult, StaleWorkspaces } from '@pantheon/protocol';
import {
  HookHost,
  deferred,
  find,
  mount as host,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const toasts = vi.hoisted(() => [] as { title: string }[]);
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: { title: string }) => {
    toasts.push(options);
    return '';
  },
}));
import { useBoard } from '@/data/board';
import {
  argvLine,
  copyPathProblem,
  sizeText,
  splitArgv,
  STALE_SIZE_RETRY_MS,
  worktreeRequest,
} from '@/data/worktree-setup';
import { Section } from '@/screens/settings/ProjectSettingsScreen';
import { revealText } from '@/lib/platform-text';
import { searchSettings } from '@/screens/settings/settings-search';
import { WorktreesPage } from '@/screens/settings/WorktreesPage';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Project = Parameters<typeof WorktreesPage>[0]['project'];

const GB = 2 ** 30;
let made = 0;
let project: Project;

const bridge = {
  commands: [] as Command[],
  answers: [] as (BridgeResult<unknown> | Promise<BridgeResult<unknown>>)[],
  queries: [] as { method: string; input: unknown }[],
  stale: { count: 3, size_bytes: 1.2 * GB, worktree_root: '/data/Pantheon Workspaces' } as
    StaleWorkspaces | undefined,
  async query(method: string, input: unknown): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, input });
    if (method === 'workspace.stale' && bridge.stale) return { ok: true, value: bridge.stale };
    return { ok: false, error: { code: 'unknown_route', message: 'none' } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return (await bridge.answers.shift()) ?? { ok: true, value: { revision: 2 } };
  },
  async revealPath(): Promise<BridgeResult<null>> {
    return { ok: true, value: null };
  },
};
const sent = () =>
  bridge.commands.map(({ type, input, expected_revision }) => ({ type, input, expected_revision }));
const staleReads = () => bridge.queries.filter((q) => q.method === 'workspace.stale').length;

const say = (id: string) => zh(`settings.worktreeSetup.${id}`);
const [command, newPath, addPath] = [say('command'), say('newPath'), say('addPath')];
const removeEnv = () =>
  t(
    { id: 'settings.worktreeSetup.removePath', defaultMessage: 'Stop copying {path}' },
    { path: '.env' },
  );

async function mount(start: Project) {
  const shown = { project: start };
  const h = host(() => WorktreesPage({ project: shown.project }));
  await h.flush();
  return { h, shown };
}
const tree = (h: HookHost<any>) => h.value as never;
const byLabel = (h: HookHost<any>, label: string) =>
  find(tree(h), (n) => n.props['aria-label'] === label);
const hasLabel = (h: HookHost<any>, label: string) =>
  nodes(tree(h)).some((n) => n.props['aria-label'] === label);
const sections = (h: HookHost<any>) => nodes(tree(h)).filter((n) => n.type === Section);
const section = (h: HookHost<any>, title: string) =>
  sections(h).find((n) => n.props.title === title)!;
const rowIds = (node: never) =>
  nodes(node)
    .map((n) => n.props.settingId ?? n.props['data-setting-id'])
    .filter((id): id is string => typeof id === 'string');
/** What follows the row in its group's list, where a message about the row goes. */
const underRow = (h: HookHost<any>, id: string) => {
  const rows = nodes(tree(h)).find(
    (n) => n.props.className === 'ps-rows' && rowIds(n as never).includes(id),
  )!;
  const children = [rows.props.children].flat(2).filter(Boolean) as { props: any }[];
  const at = children.findIndex((n) => (n.props.settingId ?? n.props['data-setting-id']) === id);
  return children[at + 1];
};
const cleanupButton = (h: HookHost<any>) =>
  find(tree(h), (n) => n.type === 'button' && text(n) === say('prune'));
const confirmButton = (h: HookHost<any>) =>
  find(tree(h), (n) => n.type === 'button' && text(n) === say('pruneConfirm'));
const alerts = (h: HookHost<any>) => nodes(tree(h)).filter((n) => n.props.role === 'alert');

beforeEach(() => {
  project = {
    id: `beta-${++made}`,
    revision: 1,
    name: 'Beta app',
    roots: ['/work/beta'],
    worktree: {
      copy_paths: ['.env', '.env.local'],
      command: { argv: ['pnpm', 'install', '--frozen-lockfile'], timeout_ms: 60000 },
    },
  };
  bridge.commands = [];
  bridge.answers = [];
  bridge.queries = [];
  bridge.stale = { count: 3, size_bytes: 1.2 * GB, worktree_root: '/data/Pantheon Workspaces' };
  toasts.length = 0;
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('command line splitting', () => {
  it('splits at spaces and keeps quoted text together', () => {
    expect(splitArgv('pnpm install --frozen-lockfile')).toEqual([
      'pnpm',
      'install',
      '--frozen-lockfile',
    ]);
    expect(splitArgv('  sh   -c "make all"  ')).toEqual(['sh', '-c', 'make all']);
    expect(splitArgv(`echo 'a "b"' x"y z"`)).toEqual(['echo', 'a "b"', 'xy z']);
    expect(splitArgv('   ')).toEqual([]);
  });

  it('writes argv back as a line that splits the same', () => {
    for (const argv of [
      ['pnpm', 'test'],
      ['sh', '-c', 'make all'],
      ['echo', 'say "hi"'],
    ])
      expect(splitArgv(argvLine(argv))).toEqual(argv);
  });

  it('writes an argument holding both quote kinds back so it splits the same', () => {
    const argv = ['node', '-e', `console.log("it's ready")`];
    expect(splitArgv(argvLine(argv))).toEqual(argv);
  });
});

describe('copied path checks', () => {
  it('refuses empty, repeated, absolute and parent paths', () => {
    expect(copyPathProblem('', ['.env'])).toBe('empty');
    expect(copyPathProblem('.env', ['.env'])).toBe('duplicate');
    expect(copyPathProblem('/etc/hosts', [])).toBe('absolute');
    expect(copyPathProblem('config/../../secret', [])).toBe('parent');
    expect(copyPathProblem('config/local.json', ['.env'])).toBeNull();
  });

  it('names sizes in the largest whole unit', () => {
    expect(sizeText(1.2 * GB)).toBe('1.2 GB');
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(340 * 2 ** 20)).toBe('340 MB');
  });
});

describe('worktree group', () => {
  it('holds the location, the copied files and the setup command, in that order', async () => {
    const { h } = await mount(project);
    expect(sections(h).map((s) => s.props.title)).toEqual([say('title'), say('cleanup')]);
    expect(rowIds(section(h, say('title')) as never)).toEqual([
      'worktrees.location',
      'worktrees.copyPaths',
      'worktrees.setupCommand',
    ]);
    const location = find(tree(h), (n) => n.props['data-setting-id'] === 'worktrees.location');
    expect(find(location as never, (n) => n.props.path !== undefined).props.path).toBe(
      '/data/Pantheon Workspaces',
    );
    expect(text(find(location as never, (n) => n.type === 'button'))).toBe(revealText());
    expect(byLabel(h, command).props.value).toBe('pnpm install --frozen-lockfile');
  });

  it('leaves the location out without a worktree folder', async () => {
    bridge.stale = { count: 0, size_bytes: 0 };
    const { h } = await mount(project);
    expect(rowIds(section(h, say('title')) as never)).toEqual([
      'worktrees.copyPaths',
      'worktrees.setupCommand',
    ]);
  });

  it('leaves the location and its reveal button out without the desktop bridge', async () => {
    vi.stubGlobal('window', {});
    const { h } = await mount(project);
    expect(rowIds(section(h, say('title')) as never)).not.toContain('worktrees.location');
  });
});

describe('copied files', () => {
  it('removes a chip by sending the shorter list', async () => {
    const { h } = await mount(project);
    expect(hasLabel(h, removeEnv())).toBe(true);
    byLabel(h, removeEnv()).props.onClick();
    await h.flush();
    h.render();
    expect(sent()).toEqual([
      worktreeRequest(project, { ...project.worktree!, copy_paths: ['.env.local'] }),
    ]);
    expect(hasLabel(h, removeEnv())).toBe(false);
  });

  it('adds the typed path on enter, keeping the command', async () => {
    const { h } = await mount(project);
    byLabel(h, addPath).props.onClick();
    h.render();
    byLabel(h, newPath).props.onChange({ target: { value: ' config/local.json ' } });
    h.render();
    byLabel(h, newPath).props.onKeyDown({ key: 'Enter' });
    await h.flush();
    expect(sent()).toEqual([
      worktreeRequest(project, {
        ...project.worktree!,
        copy_paths: ['.env', '.env.local', 'config/local.json'],
      }),
    ]);
    expect(sent()[0]!.input.command).toEqual(project.worktree!.command);
    expect(hasLabel(h, newPath)).toBe(false);
  });

  it.each([
    ['', 'pathEmpty'],
    ['.env', 'pathDuplicate'],
    ['/etc/hosts', 'pathAbsolute'],
    ['../secret', 'pathParent'],
  ])('refuses %j under the input', async (typed, reason) => {
    const { h } = await mount(project);
    byLabel(h, addPath).props.onClick();
    h.render();
    byLabel(h, newPath).props.onChange({ target: { value: typed } });
    h.render();
    byLabel(h, newPath).props.onKeyDown({ key: 'Enter' });
    await h.flush();
    expect(sent()).toEqual([]);
    const wrap = find(tree(h), (n) =>
      nodes(n.props.children).some((c) => c.props['aria-label'] === newPath),
    );
    expect(text(find(wrap as never, (n) => n.props.role === 'alert'))).toContain(say(reason));
  });
});

describe('setup command', () => {
  const edit = async (h: HookHost<any>, value: string, end: 'blur' | 'enter') => {
    byLabel(h, command).props.onChange({ target: { value } });
    h.render();
    if (end === 'blur') byLabel(h, command).props.onBlur();
    else byLabel(h, command).props.onKeyDown({ key: 'Enter' });
    await h.flush();
    h.render();
  };

  it('saves the split command on blur, keeping its timeout', async () => {
    const { h } = await mount(project);
    await edit(h, 'sh -c "make all"', 'blur');
    expect(sent()).toEqual([
      worktreeRequest(project, {
        copy_paths: ['.env', '.env.local'],
        command: { argv: ['sh', '-c', 'make all'], timeout_ms: 60000 },
      }),
    ]);
    expect(byLabel(h, command).props.value).toBe('sh -c "make all"');
  });

  it('removes the command when cleared and saves on enter', async () => {
    const { h } = await mount(project);
    await edit(h, '  ', 'enter');
    expect(sent()).toEqual([worktreeRequest(project, { copy_paths: ['.env', '.env.local'] })]);
    expect(sent()[0]!.input).not.toHaveProperty('command');
  });

  it('sends nothing when the line splits the same', async () => {
    const { h } = await mount(project);
    await edit(h, 'pnpm  install --frozen-lockfile', 'blur');
    expect(sent()).toEqual([]);
  });

  it('writes a refused save under its own row', async () => {
    bridge.answers = [{ ok: false, error: { code: 'scope_violation', message: 'no such file' } }];
    const { h } = await mount(project);
    await edit(h, 'make', 'blur');
    const under = underRow(h, 'worktrees.setupCommand');
    expect(under?.props.role).toBe('alert');
    expect(text(under as never)).toContain('no such file');
    expect(text(underRow(h, 'worktrees.copyPaths') as never)).not.toContain('no such file');
    expect(toasts).toEqual([]);
  });
});

describe('stale worktree cleanup', () => {
  const cleanupRow = (h: HookHost<any>) =>
    find(tree(h), (n) => n.props.settingId === 'worktrees.cleanup');

  it('shows the count and size beside the button', async () => {
    const { h } = await mount(project);
    expect(section(h, say('cleanup'))).toBeDefined();
    expect(text(cleanupRow(h))).toContain('3 个');
    expect(text(cleanupRow(h))).toContain('1.2 GB');
    expect(cleanupButton(h).props.disabled).toBe(false);
  });

  it('shows only the count while the size is measured, then reads it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.stale = { count: 2 };
    const { h } = await mount(project);
    expect(text(cleanupRow(h))).toContain('2 个');
    expect(text(cleanupRow(h))).not.toContain(' B');
    const before = staleReads();
    bridge.stale = { count: 2, size_bytes: 512 };
    vi.advanceTimersByTime(STALE_SIZE_RETRY_MS);
    h.render();
    await h.flush();
    expect(staleReads()).toBe(before + 1);
    expect(text(cleanupRow(h))).toContain('512 B');
  });

  it('reads again while a worktree of an open session is still measured', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.stale = {
      count: 0,
      size_bytes: 0,
      worktree_disk: { count: 2, size_bytes: 512, unmeasured: 1 },
    };
    const { h } = await mount(project);
    const before = staleReads();
    bridge.stale = {
      count: 0,
      size_bytes: 0,
      worktree_disk: { count: 2, size_bytes: 1024, unmeasured: 0 },
    };
    vi.advanceTimersByTime(STALE_SIZE_RETRY_MS);
    h.render();
    await h.flush();
    expect(staleReads()).toBe(before + 1);
    vi.advanceTimersByTime(STALE_SIZE_RETRY_MS);
    h.render();
    await h.flush();
    expect(staleReads()).toBe(before + 1);
  });

  it('disables the button with nothing to clean up', async () => {
    bridge.stale = { count: 0, size_bytes: 0 };
    const { h } = await mount(project);
    expect(text(cleanupRow(h))).toContain(say('nothingStale'));
    expect(cleanupButton(h).props.disabled).toBe(true);
  });

  it('asks first, naming the count, the size and what is kept', async () => {
    const { h } = await mount(project);
    cleanupButton(h).props.onClick();
    h.render();
    const dialog = find(tree(h), (n) => n.props.open !== undefined && n.props.onOpenChange);
    expect(dialog.props.open).toBe(true);
    expect(text(dialog)).toContain(
      t(
        {
          id: 'settings.worktreeSetup.pruneBodySize',
          defaultMessage:
            '{count, plural, one {# worktree} other {# worktrees}} taking {size} will be removed. Worktrees left by archived sessions are deleted; commits are not affected.',
        },
        { count: 3, size: '1.2 GB' },
      ),
    );
    expect(text(dialog)).toContain('3 个工作树');
    expect(sent()).toEqual([]);
  });

  it('prunes on confirm, holds the buttons meanwhile, then notifies and reads again', async () => {
    const answer = deferred<BridgeResult<unknown>>();
    bridge.answers = [answer.promise];
    const { h } = await mount(project);
    cleanupButton(h).props.onClick();
    h.render();
    confirmButton(h).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      { type: 'workspace.prune_stale', input: { project_id: project.id }, expected_revision: null },
    ]);
    expect(cleanupButton(h).props.disabled).toBe(true);
    expect(confirmButton(h).props.disabled).toBe(true);

    const before = staleReads();
    bridge.stale = { count: 0, size_bytes: 0, worktree_root: '/data/Pantheon Workspaces' };
    answer.resolve({ ok: true, value: { removed: 3 } });
    await h.flush();
    h.render();
    await h.flush();
    expect(toasts).toEqual([{ title: '清理了 3 个工作树' }]);
    expect(staleReads()).toBeGreaterThan(before);
    expect(text(cleanupRow(h))).toContain(say('nothingStale'));
    expect(
      find(tree(h), (n) => n.props.open !== undefined && n.props.onOpenChange).props.open,
    ).toBe(false);
  });

  it('writes a refused prune under its row', async () => {
    bridge.answers = [{ ok: false, error: { code: 'busy', message: 'session running' } }];
    const { h } = await mount(project);
    cleanupButton(h).props.onClick();
    h.render();
    confirmButton(h).props.onClick();
    await h.flush();
    expect(text(underRow(h, 'worktrees.cleanup') as never)).toContain('session running');
    expect(alerts(h)).toHaveLength(1);
    expect(toasts).toEqual([]);
  });
});

describe('worktree settings search', () => {
  it('lands the setup command and cleanup on this page', () => {
    expect(searchSettings('准备命令')[0]).toMatchObject({
      id: 'worktrees.setupCommand',
      page: 'worktrees',
    });
    expect(searchSettings('清理').map((hit) => hit.id)).toContain('worktrees.cleanup');
    expect(searchSettings('带上').map((hit) => hit.id)).toContain('worktrees.copyPaths');
  });
});
