import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportCandidate, RuntimeStatus } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  command: vi.fn(),
  query: vi.fn(),
  candidates: [] as unknown[],
  indexing: null as unknown,
  statuses: [] as unknown[],
  refresh: vi.fn(),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => ({ ...mock.board, refresh() {} }),
  }),
}));
vi.mock('@/screens/projects/view', () => ({
  useProjectsView: () => ({ query: '', opening: false, setQuery() {}, setOpening() {} }),
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({
    read: { state: 'ready', statuses: mock.statuses },
    unavailable: {},
    refresh: mock.refresh,
  }),
}));
vi.mock('@/data/import', () => ({
  useImportCandidates: () => ({
    data: { indexing: mock.indexing, candidates: mock.candidates },
    loading: false,
    error: null,
    reload() {},
  }),
}));
import { keyText, shortcutKeys } from '@/lib/shortcuts';
import { ProjectsScreen } from '@/screens/projects/ProjectsScreen';
import { Welcome } from '@/screens/projects/Welcome';
import { zh } from './i18n-setup.js';

const welcomeCss = readFileSync(
  fileURLToPath(new URL('../../apps/web/src/screens/projects/welcome.css', import.meta.url)),
  'utf8',
);

const candidate = (name: string, extra: Partial<ImportCandidate> = {}): ImportCandidate => ({
  root: `/work/${name}`,
  name,
  git: true,
  remote: null,
  sessions: 3,
  runtimes: ['claude'],
  last_active_at: '2026-11-10T00:00:00.000Z',
  preselected: false,
  ...extra,
});

const status = (runtime: string, extra: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  runtime,
  enabled: true,
  installed: true,
  version: '1.0.0',
  min_version: '1.0.0',
  version_ok: true,
  auth: { state: 'ok', email: `${runtime}@example.com`, plan: 'max' },
  checked_at: '2026-11-11T00:00:00.000Z',
  ...extra,
});

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], project_briefs: [] },
    events: [],
    status: { state: 'live' },
  };
  mock.candidates = [
    candidate('alpha'),
    candidate('beta', { preselected: true }),
    candidate('scratch', { excluded: 'temporary' }),
  ];
  mock.indexing = null;
  mock.statuses = [status('claude'), status('codex', { auth: { state: 'logged_out' } })];
  mock.refresh.mockReset();
  mock.command.mockReset();
  mock.query.mockReset();
  mock.query.mockResolvedValue({ ok: true, value: null });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      command: mock.command,
      query: mock.query,
      runtimeLogin: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const welcome = (onOpened = vi.fn()) =>
  mount(() => Welcome({ onOpenFolder() {}, onOpened, onHold() {} }));
const boxes = (tree: unknown) =>
  nodes(tree as never).filter((n) => n.type === 'input' && n.props.type === 'checkbox');
const dropZone = (tree: unknown) =>
  find(tree as never, (n) => n.props['aria-label'] === zh('projects.import.openFolder'));
const importButton = (tree: unknown) =>
  find(tree as never, (n) => n.type === 'button' && text(n).startsWith('导入'));

describe('projects screen first run', () => {
  it('shows the welcome when no project is visible', () => {
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    expect(() => named(h.value, 'Welcome')).not.toThrow();
  });

  it('shows the project table, not the welcome, once a project is open', () => {
    mock.board.board.projects = [
      { id: 'alpha', name: 'Alpha', roots: ['/work/alpha'], revision: 1 },
    ];
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    expect(() => named(h.value, 'Welcome')).toThrow();
  });
});

describe('welcome runtimes', () => {
  it("shows a usable runtime's account and offers a logged-out one its login", async () => {
    const rows = named(welcome().value, 'RuntimeRows');
    const h = mount(() => (rows.type as (props: unknown) => never)(rows.props));
    const all = text(h.value);
    expect(all).toContain('claude@example.com');
    expect(all).toContain(zh('data.runtimeStatus.loggedOut'));
    const login = find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('projects.runtimes.login'),
    );
    login.props.onClick();
    await h.flush();
    expect(window.pantheon!.runtimeLogin).toHaveBeenCalledWith('codex');
    expect(mock.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('welcome layout', () => {
  const runtimeCells = () => {
    const rows = named(welcome().value, 'RuntimeRows');
    const h = mount(() => (rows.type as (props: unknown) => never)(rows.props));
    return nodes(h.value).filter((n) => n.type === 'li');
  };

  it('lists the repositories found on this computer before the runtimes', () => {
    const all = nodes(welcome().value);
    const found = all.findIndex((n) => text(n) === zh('projects.import.label'));
    const runtimes = all.findIndex(
      (n) => typeof n.type === 'function' && n.type.name === 'RuntimeRows',
    );
    expect(found).toBeGreaterThan(-1);
    expect(runtimes).toBeGreaterThan(found);
  });

  it('shows the version and the sign-in state of each installed runtime, leaving out a missing one without an install guide', () => {
    mock.statuses = [
      status('claude'),
      status('codex', { auth: { state: 'logged_out' } }),
      status('grok', { installed: false, version: null }),
    ];
    const [claude, codex, ...rest] = runtimeCells().map(text);
    expect(claude).toContain('1.0.0');
    expect(claude).toContain(zh('projects.runtimes.signedIn'));
    expect(codex).toContain(zh('data.runtimeStatus.loggedOut'));
    expect(codex).not.toContain(zh('projects.runtimes.signedIn'));
    expect(rest).toEqual([]);
  });

  it('says under the title what opening a repository does', () => {
    expect(nodes(welcome().value).map(text)).toContain(
      zh('projects.welcome.title') + zh('welcome.intro'),
    );
  });

  it('opens a folder from the drop zone, which shows the keys of the open-project shortcut', () => {
    const onOpenFolder = vi.fn();
    const h = mount(() => Welcome({ onOpenFolder, onOpened() {}, onHold() {} }));
    const zone = dropZone(h.value);
    const keys = shortcutKeys('open-project');
    expect(zone.type).toBe('button');
    expect(zone.props['aria-keyshortcuts']).toBe(keys);
    expect(text(zone)).toBe(zh('welcome.drop') + zh('welcome.orPress') + keyText(keys));
    zone.props.onClick();
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it('opens a folder dropped on the drop zone as a project and enters it', async () => {
    mock.command.mockImplementation(async (c: any) => ({
      ok: true,
      value: { id: `id-${c.input.name}` },
    }));
    (window.pantheon as any).pathForFile = (file: { name: string }) => `/dropped/${file.name}`;
    const onOpened = vi.fn();
    const h = welcome(onOpened);
    const zone = () => dropZone(h.value);
    const over = { preventDefault: vi.fn(), dataTransfer: { types: ['Files'], dropEffect: '' } };
    zone().props.onDragOver(over);
    h.render();
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(zone().props['data-over']).toBe('');
    zone().props.onDrop({
      preventDefault() {},
      dataTransfer: { types: ['Files'], files: [{ name: 'gamma' }] },
    });
    await h.flush();
    expect(mock.command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
      ['project.open', { name: 'gamma', roots: ['/dropped/gamma'] }],
    ]);
    expect(onOpened).toHaveBeenCalledWith('id-gamma');
    expect(zone().props['data-over']).toBeUndefined();
  });

  it('keeps the first-run column narrow and spaced like the board', () => {
    const rule = /\.wel\s*\{([^}]*)\}/.exec(welcomeCss)?.[1] ?? '';
    expect(rule).toContain('max-width: 520px');
    expect(rule).toContain('margin: calc(var(--sp-8) * 3) auto 0');
    expect(rule).toContain('gap: var(--sp-6)');
  });
});

describe('welcome runtime install guide', () => {
  it('offers the install guide of a runtime that is not installed and opens it', async () => {
    mock.statuses = [status('claude'), status('codex', { installed: false, version: null })];
    const openLink = vi.fn(async () => ({ ok: true, value: null }));
    (window.pantheon as any).openLink = openLink;
    const rows = named(welcome().value, 'RuntimeRows');
    const h = mount(() => (rows.type as (props: unknown) => never)(rows.props));
    const [claude, codex] = nodes(h.value).filter((n) => n.type === 'li');
    expect(() => find(claude!, (n) => n.type === 'button')).toThrow();
    const guide = find(
      codex!,
      (n) => n.type === 'button' && text(n) === zh('welcome.installGuide'),
    );
    expect(guide.props.className).toBe('btn sm');
    guide.props.onClick();
    await h.flush();
    expect(openLink).toHaveBeenCalledWith('https://github.com/openai/codex');
  });
});

describe('welcome import candidates', () => {
  it('lists preselected candidates first and folds the excluded ones away, unselectable', () => {
    const h = welcome();
    expect(boxes(h.value).map((b) => b.props.value)).toEqual([
      '/work/beta',
      '/work/alpha',
      '/work/scratch',
    ]);
    const fold = find(h.value, (n) => n.props.defaultOpen === false);
    const excluded = boxes(fold)[0]!;
    expect(excluded.props.value).toBe('/work/scratch');
    expect(excluded.props.disabled).toBe(true);
    expect(excluded.props.checked).toBe(false);
    expect(named(fold, 'Tip').props.content).toBe(zh('projects.import.excluded.temporary'));
  });

  it('counts the checked candidates on the import button', () => {
    const h = welcome();
    expect(text(importButton(h.value))).toBe('导入 1 个项目');
    const box = (root: string) => boxes(h.value).find((b) => b.props.value === root)!;
    box('/work/alpha').props.onChange({ target: { checked: true } });
    h.render();
    expect(text(importButton(h.value))).toBe('导入 2 个项目');
    box('/work/beta').props.onChange({ target: { checked: false } });
    box('/work/alpha').props.onChange({ target: { checked: false } });
    h.render();
    expect(text(importButton(h.value))).toBe('导入 0 个项目');
    expect(importButton(h.value).props.disabled).toBe(true);
  });

  it('opens each checked folder as a project and enters the first', async () => {
    mock.command.mockImplementation(async (c: any) => ({
      ok: true,
      value: { id: `id-${c.input.name}` },
    }));
    const onOpened = vi.fn();
    const h = welcome(onOpened);
    boxes(h.value)
      .find((b) => b.props.value === '/work/alpha')!
      .props.onChange({ target: { checked: true } });
    h.render();
    importButton(h.value).props.onClick();
    await h.flush();
    expect(mock.command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
      ['project.open', { name: 'beta', roots: ['/work/beta'] }],
      ['project.open', { name: 'alpha', roots: ['/work/alpha'] }],
    ]);
    expect(onOpened).toHaveBeenCalledWith('id-beta');
  });

  it('names each folder that failed to open and stays', async () => {
    mock.command.mockResolvedValue({
      ok: false,
      error: { code: 'scope_violation', message: 'roots overlap each other' },
    });
    const onOpened = vi.fn();
    const h = welcome(onOpened);
    importButton(h.value).props.onClick();
    await h.flush();
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain('beta');
    expect(text(alert)).toContain(zh('data.projects.foldersNested'));
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('shows a bar while the history is still being indexed', () => {
    mock.indexing = { done_files: 3, total_files: 12 };
    const h = welcome();
    const bar = find(h.value, (n) => n.props.role === 'progressbar');
    expect(bar.props['aria-valuenow']).toBe(3);
    expect(bar.props['aria-valuemax']).toBe(12);
  });
});
