import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStatus } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  read: { state: 'loading' } as unknown,
  refresh: vi.fn(),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({
    read: mock.read,
    runtimes: [],
    unavailable: {},
    refresh: mock.refresh,
  }),
}));

import { compareRuntimes } from '@/components/RuntimeGlyph';
import { getSetupDone } from '@/data/personal-settings';
import { SetupScreen, useShowsSetup } from '@/screens/setup/SetupScreen';
import { useProjectsView } from '@/screens/projects/view';
import { useShell } from '@/store';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const [openProject, recheck] = [zh('projects.open.title'), zh('setup.recheck')];

const status = (runtime: string, extra: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  runtime,
  enabled: true,
  installed: true,
  version: '2.4.1',
  min_version: '1.0.0',
  version_ok: true,
  auth: { state: 'ok', plan: 'max' },
  checked_at: '2026-11-11T00:00:00.000Z',
  ...extra,
});
const missing = (runtime: string) =>
  status(runtime, { installed: false, version: null, auth: { state: 'unknown' } });

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  mock.read = { state: 'loading' };
  mock.refresh.mockReset();
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const panel = (tree: unknown) => find(tree as never, (n) => 'aria-busy' in n.props);
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n).startsWith(label));
const rows = (tree: unknown) =>
  nodes(tree as never).filter(
    (n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes('su-row'),
  );

// The screen with each runtime row drawn, since the host draws only the screen's own function.
const drawn = (tree: unknown): never =>
  [
    tree,
    ...nodes(tree as never)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'RuntimeRow')
      .map((r) => (r.type as (props: unknown) => unknown)(r.props)),
  ] as never;

describe('when first-time setup shows', () => {
  it('shows only once the board is loaded with no project and setup was never finished', () => {
    expect(getSetupDone()).toBe(false);
    expect(mount(() => useShowsSetup(false, 0)).value).toBe(false);
    expect(mount(() => useShowsSetup(true, 0)).value).toBe(true);
  });

  it('never shows to someone who already has a project, even after removing it', () => {
    expect(mount(() => useShowsSetup(true, 1)).value).toBe(false);
    expect(getSetupDone()).toBe(true);
    expect(stored.get('pantheon.setup-done.v1')).toBe('true');
    expect(mount(() => useShowsSetup(true, 0)).value).toBe(false);
  });
});

describe('first-time setup checks', () => {
  it('marks the panel busy, shows each runtime row as checking and holds the open button while the first check runs', () => {
    const h = mount(() => SetupScreen());
    expect(panel(h.value).props['aria-busy']).toBe(true);
    const runtimeRows = rows(drawn(h.value)).filter((r) => text(r).includes(zh('setup.checking')));
    expect(runtimeRows).toHaveLength(2);
    expect(() => named(runtimeRows[0]!, 'Elapsed')).not.toThrow();
    expect(button(h.value, openProject).props['aria-disabled']).toBe(true);
    expect(button(h.value, recheck).props['aria-disabled']).toBe(true);
  });

  it('counts the seconds a check has taken', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const h = mount(() => SetupScreen());
    const elapsed = named(drawn(h.value), 'Elapsed');
    vi.spyOn(Date, 'now').mockReturnValue(12_000);
    const e = mount(() => (elapsed.type as (props: unknown) => never)(elapsed.props));
    expect(text(e.value)).toBe('2 秒');
    vi.restoreAllMocks();
  });

  it('shows a signed-in runtime with its plan and version, and a missing one with its install command', () => {
    mock.read = { state: 'ready', statuses: [status('claude'), missing('codex')] };
    const h = mount(() => SetupScreen());
    expect(panel(h.value).props['aria-busy']).toBe(false);
    const all = text(drawn(h.value));
    expect(all).toContain(zh('settings.runtimes.signedIn'));
    expect(all).toContain('max');
    expect(all).toContain('2.4.1');
    expect(all).toContain(
      t({ id: 'setup.notFound', defaultMessage: '{command} not found' }, { command: 'codex' }),
    );
    expect(all).toContain('npm install -g @openai/codex');
    expect(all).not.toContain('npm install -g @anthropic-ai/claude-code');
    const copyLabel = t(
      { id: 'setup.copyCommand', defaultMessage: 'Copy {command}' },
      { command: 'npm install -g @openai/codex' },
    );
    const copy = find(drawn(h.value), (n) => n.props['aria-label'] === copyLabel);
    expect(text(copy)).toBe(zh('setup.copy'));
    expect(button(h.value, openProject).props['aria-disabled']).toBeUndefined();
  });

  it('lists the installed runtimes first, then the missing ones setup can install', () => {
    mock.read = {
      state: 'ready',
      statuses: [
        missing('agy'),
        missing('codex'),
        status('grok', { auth: { state: 'unknown' } }),
        status('claude'),
      ],
    };
    const h = mount(() => SetupScreen());
    const shown = nodes(h.value)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'RuntimeRow')
      .map((n) => n.props.runtime);
    expect(shown).toEqual([...['claude', 'grok'].sort(compareRuntimes), 'codex']);
    const all = text(drawn(h.value));
    expect(all).toContain(zh('setup.installed'));
    expect(all).toContain(
      t({ id: 'setup.notFound', defaultMessage: '{command} not found' }, { command: 'codex' }),
    );
  });

  it('lets a project open when only an ACP runtime is installed', () => {
    mock.read = {
      state: 'ready',
      statuses: [missing('claude'), missing('codex'), status('grok')],
    };
    const h = mount(() => SetupScreen());
    expect(button(h.value, openProject).props['aria-disabled']).toBeUndefined();
  });

  it('shows each version as the runtimes page does, the number alone', () => {
    mock.read = {
      state: 'ready',
      statuses: [
        status('claude', { version: '2.1.325 (Claude Code)' }),
        status('codex', { version: 'codex-cli 0.169.0' }),
      ],
    };
    const all = text(drawn(mount(() => SetupScreen()).value));
    expect(all).toContain('2.1.325');
    expect(all).toContain('0.169.0');
    expect(all).not.toContain('(Claude Code)');
    expect(all).not.toContain('codex-cli');
  });

  it('names the page once, in the bar', () => {
    mock.read = { state: 'ready', statuses: [status('claude'), status('codex')] };
    const h = mount(() => SetupScreen());
    const title = zh('setup.title');
    expect(named(h.value, 'TopBar').props.title).toBe(title);
    expect(nodes(h.value).filter((n) => typeof n.type === 'string' && text(n) === title)).toEqual(
      [],
    );
  });

  it('marks a usable and a missing runtime with the dots the connection rows use', () => {
    mock.read = { state: 'ready', statuses: [status('claude'), missing('codex')] };
    const h = mount(() => SetupScreen());
    const dots = nodes(drawn(h.value)).filter((n) => 'data-s' in n.props);
    expect(dots.map((n) => n.props['data-s'])).toEqual(['ok', 'idle']);
  });

  it('holds the open button when neither runtime is installed', () => {
    mock.read = { state: 'ready', statuses: [missing('claude'), missing('codex')] };
    const h = mount(() => SetupScreen());
    expect(text(drawn(h.value))).toContain('npm install -g @anthropic-ai/claude-code');
    const open = button(h.value, openProject);
    expect(open.props['aria-disabled']).toBe(true);
    useProjectsView.setState({ opening: false });
    useShell.setState({ screen: 'board' });
    open.props.onClick();
    expect(useProjectsView.getState().opening).toBe(false);
    expect(useShell.getState().screen).toBe('board');
  });

  it('checks again and shows the rows as checking until the new read lands', () => {
    mock.read = { state: 'ready', statuses: [status('claude'), status('codex')] };
    const h = mount(() => SetupScreen());
    button(h.value, recheck).props.onClick();
    h.render();
    expect(mock.refresh).toHaveBeenCalledTimes(1);
    expect(panel(h.value).props['aria-busy']).toBe(true);
    mock.read = { state: 'ready', statuses: [status('claude'), status('codex')] };
    h.render();
    expect(panel(h.value).props['aria-busy']).toBe(false);
  });

  it('shows the GitHub connection and its state with the row the connections page draws', async () => {
    mock.read = { state: 'ready', statuses: [status('claude'), status('codex')] };
    const query = vi.fn(async () => ({
      ok: true,
      value: {
        github: { state: 'signed_in', installed: true, signed_in: true, account: 'octo-dev' },
      },
    }));
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query },
    });
    const h = mount(() => SetupScreen());
    await h.flush();
    expect(query).toHaveBeenCalledWith('connections.status', {});
    const group = find(h.value, (n) => n.props['aria-labelledby'] === 'su-g-cn');
    expect(text(group)).toContain(zh('settings.pages.connections'));
    const github = named(group, 'GithubRow');
    const row = (github.type as (props: unknown) => never)(github.props);
    expect(find(row, (n) => n.props.className === 'hp-dot').props['data-s']).toBe('ok');
    expect(text(row)).toContain('已连接octo-dev');
  });

  it('asks for the editor and the terminal', () => {
    mock.read = { state: 'ready', statuses: [status('claude'), status('codex')] };
    const h = mount(() => SetupScreen());
    const pickers = nodes(h.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'EditorPicker',
    );
    expect(pickers.map((p) => p.props.list)).toEqual(['editors', 'terminals']);
  });

  it('finishes setup and opens the project dialog over the screen shown', () => {
    mock.read = { state: 'ready', statuses: [status('claude'), missing('codex')] };
    useShell.setState({ screen: 'board' });
    useProjectsView.setState({ opening: false });
    const h = mount(() => SetupScreen());
    button(h.value, openProject).props.onClick();
    expect(getSetupDone()).toBe(true);
    expect(useShell.getState().screen).toBe('board');
    expect(useProjectsView.getState().opening).toBe(true);
  });
});
