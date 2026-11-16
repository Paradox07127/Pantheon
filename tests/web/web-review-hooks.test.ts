import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  HookHost,
  deferred,
  find,
  named,
  nodes,
  text,
  mount,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: { board: null as any, events: [] as any[], status: { state: 'live' }, cursor: 0 },
  refresh: vi.fn(),
  command: vi.fn(),
  listeners: new Set<() => void>(),
  page: 'extensions',
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => ({ ...mock.board, refresh: mock.refresh }),
    subscribe: (listener: () => void) => {
      mock.listeners.add(listener);
      return () => mock.listeners.delete(listener);
    },
  }),
}));
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSession() {} }),
}));
vi.mock('@/screens/settings/view', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettingsView: (select: any) =>
    select({
      runtime: 'codex',
      setRuntime() {},
      page: mock.page,
      setPage() {},
      detail: 'project',
      setDetail() {},
      query: '',
    }),
}));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('@/screens/projects/view', () => ({
  useProjectsView: (select: any = (value: any) => value) =>
    select({
      query: '',
      selected: null,
      opening: false,
      setQuery() {},
      select() {},
      setOpening() {},
    }),
}));
import { useEventHistory } from '@/data/logs';
import { IdText } from '@/components/IdText';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SessionDefaults } from '@/screens/settings/SessionDefaultsPage';
import { EditorPicker } from '@/screens/settings/EditorPicker';
import { FolderFields } from '@/screens/projects/EnvironmentFields';
import { runCommand } from '@/data/commands';
import { RUNTIMES } from '@/data/extensions';
import { zh, zhf } from './i18n-setup.js';

const button = (tree: any, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);

function child(node: any) {
  return mount(() => node.type(node.props));
}
// The extensions are a part of the open project's page on the projects page.
const extensionsPage = (screen: HookHost<any>) =>
  child(named(child(child(named(screen.value, 'ProjectListPage')).value).value, 'ExtensionsPage'));
const blank = () => ({
  cursor: 0,
  projects: [],
  sessions: [],
  session_turns: [],
  workspaces: [],
});
const project = {
  id: 'project',
  name: 'Project name',
  roots: ['/work/project'],
  revision: 1,
};
const session = {
  id: 'session',
  project_id: project.id,
  state: 'open',
  runtime: 'codex',
  revision: 1,
  turn_count: 0,
};
const inventory = {
  runtime: 'codex',
  mcp_servers: [],
  plugins: [],
  skills: [],
  apps: true,
  connectors: [],
  hooks: [],
};
const event = (n: number) => ({
  sequence: n,
  event_id: `event-${n}`,
  project_id: project.id,
  aggregate_id: session.id,
  kind: 'agent.message.delta',
  created_at: n,
  payload: { text: String(n) },
});
beforeEach(() => {
  project.revision = 1;
  mock.page = 'extensions';
  mock.board = { board: blank(), events: [], status: { state: 'live' }, cursor: 0 };
  mock.command.mockReset();
  mock.command.mockResolvedValue({ ok: true, value: {} });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    pantheon: {
      command: mock.command,
      query: vi.fn(async (method: string) => ({
        ok: true,
        value: method === 'events' ? { events: [], cursor: 0 } : inventory,
      })),
      editors: async () => ({ ok: true, value: { editors: [], selected: null } }),
      chooseEditor: vi.fn(async () => ({ ok: true, value: null })),
      terminals: async () => ({ ok: true, value: { terminals: [], selected: null } }),
      chooseTerminal: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('lists the bridge terminals in settings, saves the choice, and reports a removed terminal', async () => {
  mock.page = 'editor';
  const terminals = [
    { id: 'Terminal', name: 'Terminal' },
    { id: 'Ghostty', name: 'Ghostty' },
    { id: 'iTerm', name: 'iTerm' },
  ];
  window.pantheon!.terminals = vi.fn(async () => ({
    ok: true as const,
    value: { terminals, selected: 'Terminal' },
  }));
  const chooseTerminal = vi.fn(async (id: string) =>
    id === 'iTerm'
      ? { ok: false as const, error: { code: 'terminal_unavailable', message: 'gone' } }
      : { ok: true as const, value: null },
  );
  window.pantheon!.chooseTerminal = chooseTerminal;
  const screen = mount(() => ProjectSettingsScreen());
  const app = child(named(screen.value, 'AppPage'));
  const page = child(named(app.value, 'EditorPage'));
  const pickers = nodes(page.value).filter(
    (node) => typeof node.type === 'function' && node.type.name === 'EditorPicker',
  );
  expect(pickers.map((picker) => picker.props.label)).toEqual([
    zh('settings.editor.editor'),
    zh('settings.editor.terminal'),
  ]);
  const picker = child(pickers[1]!);
  await picker.flush();
  expect(window.pantheon!.terminals).toHaveBeenCalledOnce();
  expect(
    find(
      picker.value,
      (node) => node.props['aria-label'] === zh('settings.editor.externalTerminal'),
    ),
  ).toBeDefined();
  const select = () => find(picker.value, (node) => Array.isArray(node.props.items));
  expect(select().props.items).toEqual(
    terminals.map(({ id, name }) => ({ value: id, label: name })),
  );
  expect(text(picker.value)).toContain('Ghostty');
  expect(select().props.value).toBe('Terminal');
  select().props.onValueChange('Ghostty');
  await picker.flush();
  expect(chooseTerminal).toHaveBeenCalledWith('Ghostty');
  expect(window.pantheon!.chooseEditor).not.toHaveBeenCalled();
  expect(select().props.value).toBe('Ghostty');
  select().props.onValueChange('iTerm');
  await picker.flush();
  expect(chooseTerminal).toHaveBeenCalledWith('iTerm');
  expect(text(find(picker.value, (node) => node.props.role === 'alert'))).toBe(
    zhf('settings.editor.gone', { label: zh('settings.editor.terminal') }),
  );
  expect(select().props.value).toBe('Ghostty');
});

it('handles unavailable and denied clipboard writes with a visible failure', async () => {
  for (const clipboard of [undefined, { writeText: () => Promise.reject(new Error('denied')) }]) {
    vi.stubGlobal('navigator', { clipboard });
    const h = mount(() => IdText({ id: 'identity' }));
    await find(h.value, (n) => n.type === 'button').props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(
      zh('components.idText.copyFailed'),
    );
  }
});

it('archives live history beyond the rolling board buffer and resets on replacement', async () => {
  const h = mount(() => useEventHistory({ key: 'logs', project_id: null, after: 0 }));
  await h.flush();
  mock.board.events = [event(1)];
  mock.listeners.forEach((f) => f());
  h.render();
  await h.flush();
  mock.board.events = [event(2)];
  mock.listeners.forEach((f) => f());
  h.render();
  await h.flush();
  expect(h.value.events?.map((e) => e.sequence)).toEqual([1, 2]);
  let calls = 0;
  window.pantheon!.query = vi.fn(async () => ({
    ok: true as const,
    value:
      calls++ === 0
        ? { events: [], cursor: 0, snapshot_required: true }
        : { events: [], cursor: 0 },
  }));
  mock.board.events = [];
  h.value.reload();
  h.render();
  await h.flush();
  expect(h.value.events).toEqual([]);
});

it('turns rejected commands into failed bridge results', async () => {
  mock.command.mockRejectedValue(new Error('IPC disconnected'));
  await expect(
    runCommand('session.interrupt', { session_id: 'session' }, 1),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'ipc_failed' },
  });
});

it('preserves settings edits made during save when the board revision arrives', async () => {
  mock.board.board.projects = [project];
  const screen = mount(() => ProjectSettingsScreen());
  const h = extensionsPage(screen);
  await h.flush();
  const groups = () => named(h.value, 'Groups');
  groups().props.onEdit({ ...groups().props.draft, enabled_user_connectors: ['calendar'] });
  h.render();
  const pending = deferred<any>();
  mock.command.mockReturnValue(pending.promise);
  button(h.value, zh('settings.common.save')).props.onClick();
  h.render();
  groups().props.onEdit({ ...groups().props.draft, disable_hooks: true });
  h.render();
  pending.resolve({ ok: true, value: { ...project, revision: 2 } });
  await h.flush();
  Object.assign(project, { revision: 2 });
  h.render();
  expect(groups().props.draft.disable_hooks).toBe(true);
});

it('offers an inventory retry after a query failure', async () => {
  window.pantheon!.query = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'inventory_timeout', message: 'deadline' },
  }));
  mock.board.board.projects = [project];
  const screen = mount(() => ProjectSettingsScreen());
  const h = extensionsPage(screen);
  await h.flush();
  const retry = find(
    h.value,
    (n) => n.type === 'button' && text(n).includes(zh('components.retry')),
  );
  retry.props.onClick();
  h.render();
  await h.flush();
  expect(window.pantheon!.query).toHaveBeenCalledTimes(2 * RUNTIMES.length);
});

it('adds every picked folder at once and names the ones it skips', async () => {
  const onChange = vi.fn();
  window.pantheon!.chooseDirectories = vi.fn(async () => ({
    ok: true as const,
    value: ['/work/docs', '/work/app/src', '/work/site'],
  }));
  const h = mount(() => FolderFields({ value: ['/work/app'], onChange }));
  button(h.value, zh('projects.folders.add')).props.onClick();
  await h.flush();
  expect(onChange).toHaveBeenCalledWith(['/work/app', '/work/docs', '/work/site']);
  expect(text(h.value)).toContain(zh('projects.folders.insideListed'));
  expect(text(h.value)).toContain('/work/app/src');
});

it('offers one large picker while no folder is chosen', () => {
  const h = mount(() => FolderFields({ value: [], onChange() {} }));
  expect(
    nodes(h.value)
      .filter((n) => n.type === 'button')
      .map(text),
  ).toEqual([zh('projects.folders.choose')]);
});

it('lets a saved override be removed while its inventory item is machine-disabled', async () => {
  const p = {
    ...project,
    extension_overrides: {
      codex: {
        disabled_mcp_servers: ['server'],
        disabled_plugins: [],
        disabled_skills: [],
        disable_apps: false,
        disable_hooks: false,
      },
    },
  };
  window.pantheon!.query = vi.fn(async () => ({
    ok: true as const,
    value: { ...inventory, mcp_servers: [{ name: 'server', enabled: false }] },
  }));
  mock.board.board.projects = [p];
  const screen = mount(() => ProjectSettingsScreen());
  const h = extensionsPage(screen);
  await h.flush();
  const groups = child(named(h.value, 'Groups'));
  const entry = child(named(groups.value, 'Entry'));
  const remove = button(entry.value, zh('settings.extensions.removeOverride'));
  remove.props.onClick();
  h.render();
  expect(named(h.value, 'Groups').props.draft.disabled_mcp_servers).toEqual([]);
});

it('shows a user-level MCP server and skill off until the project opens them, then saves the opening', async () => {
  window.pantheon!.query = vi.fn(async () => ({
    ok: true as const,
    value: {
      ...inventory,
      mcp_servers: [
        { name: 'personal', enabled: true, user: true },
        { name: 'repository', enabled: true },
      ],
      skills: [{ id: '/home/skills/notes/SKILL.md', name: 'notes', enabled: true, user: true }],
    },
  }));
  mock.board.board.projects = [project];
  const screen = mount(() => ProjectSettingsScreen());
  const h = extensionsPage(screen);
  await h.flush();
  const entries = () =>
    nodes(child(named(h.value, 'Groups')).value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Entry',
    );
  const [personal, repository, notes] = entries();
  expect([personal, repository, notes].map((entry) => entry!.props.loaded)).toEqual([
    false,
    true,
    false,
  ]);
  personal!.props.onChange(true);
  h.render();
  entries()[2]!.props.onChange(true);
  h.render();
  expect(
    entries()
      .slice(0, 3)
      .map((entry) => entry.props.loaded),
  ).toEqual([true, true, true]);
  button(h.value, zh('settings.common.save')).props.onClick();
  await h.flush();
  expect(mock.command).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'project.extensions.set',
      input: {
        project_id: project.id,
        runtime: 'codex',
        overrides: {
          disabled_mcp_servers: [],
          disabled_plugins: [],
          disabled_skills: [],
          disable_apps: false,
          disable_hooks: false,
          enabled_user_mcp_servers: ['personal'],
          enabled_user_skills: ['/home/skills/notes/SKILL.md'],
        },
      },
    }),
  );
});

it('lists each account connector off until the project opens it, then saves the opening', async () => {
  window.pantheon!.query = vi.fn(async () => ({
    ok: true as const,
    value: {
      ...inventory,
      connectors: [
        { name: 'calendar', title: 'Calendar', enabled: true },
        { name: 'drive', title: 'Drive', enabled: true },
      ],
    },
  }));
  mock.board.board.projects = [project];
  const screen = mount(() => ProjectSettingsScreen());
  const h = extensionsPage(screen);
  await h.flush();
  const entries = () =>
    nodes(child(named(h.value, 'Groups')).value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Entry',
    );
  expect(entries().map((entry) => [entry.props.name, entry.props.loaded])).toEqual([
    ['Calendar', false],
    ['Drive', false],
    ['Hooks', true],
  ]);
  entries()[0]!.props.onChange(true);
  h.render();
  expect(entries().map((entry) => entry.props.loaded)).toEqual([true, false, true]);
  button(h.value, zh('settings.common.save')).props.onClick();
  await h.flush();
  expect(mock.command).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'project.extensions.set',
      input: {
        project_id: project.id,
        runtime: 'codex',
        overrides: {
          disabled_mcp_servers: [],
          disabled_plugins: [],
          disabled_skills: [],
          disable_apps: false,
          disable_hooks: false,
          enabled_user_connectors: ['calendar'],
        },
      },
    }),
  );
});

const editorPicker = () =>
  mount(() =>
    EditorPicker({
      label: '编辑器',
      list: 'editors',
      choose: 'chooseEditor',
      unavailable: 'editor_unavailable',
    }),
  );
const pickerSelect = (h: HookHost<any>) => find(h.value, (n) => Array.isArray(n.props.items));

it('shows a rejected editor list read and a rejected editor choice as failures', async () => {
  window.pantheon!.editors = vi.fn(async () => {
    throw new Error('list read failed');
  });
  const failed = editorPicker();
  await failed.flush();
  expect(find(failed.value, (n) => n.props.content !== undefined).props.content).toBe(
    zhf('settings.editor.readFailed', {
      label: '编辑器',
      message: 'Error: list read failed',
    }),
  );

  window.pantheon!.editors = vi.fn(async () => ({
    ok: true as const,
    value: { editors: [{ id: 'zed', name: 'Zed' }], selected: null },
  }));
  window.pantheon!.chooseEditor = vi.fn(async () => {
    throw new Error('disk full');
  });
  const h = editorPicker();
  await h.flush();
  pickerSelect(h).props.onValueChange('zed');
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(
    zhf('settings.editor.chooseFailed', { label: '编辑器', message: 'Error: disk full' }),
  );
});

it('reads the editor list again when the window regains focus', async () => {
  const listeners = new Map<string, () => void>();
  window.addEventListener = ((type: string, listener: () => void) =>
    listeners.set(type, listener)) as never;
  let editors: { id: string; name: string }[] = [];
  window.pantheon!.editors = vi.fn(async () => ({
    ok: true as const,
    value: { editors, selected: null },
  }));
  const h = editorPicker();
  await h.flush();
  expect(nodes(h.value).some((n) => Array.isArray(n.props.items))).toBe(false);
  editors = [{ id: 'zed', name: 'Zed' }];
  listeners.get('focus')!();
  await h.flush();
  expect(pickerSelect(h).props.items).toEqual([{ value: 'zed', label: 'Zed' }]);
});

it('shows rejected data directory reads and reveals as failures', async () => {
  mock.page = 'data';
  window.pantheon!.daemon = vi.fn(async () => {
    throw new Error('daemon gone');
  });
  const pageOf = () => {
    const screen = mount(() => ProjectSettingsScreen());
    const app = child(named(screen.value, 'AppPage'));
    return child(named(app.value, 'DataPage'));
  };
  const failed = pageOf();
  await failed.flush();
  expect(text(find(failed.value, (n) => n.props.role === 'alert'))).toBe(
    zhf('settings.data.readFailed', { message: 'Error: daemon gone' }),
  );

  window.pantheon!.daemon = vi.fn(async () => ({
    ok: true as const,
    value: { data_dir: '/data/pantheon' },
  })) as never;
  window.pantheon!.revealPath = vi.fn(async () => {
    throw new Error('finder gone');
  });
  const h = pageOf();
  await h.flush();
  button(h.value, zh('lib.reveal.fileManager')).props.onClick();
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(
    zhf('settings.data.revealFailed', { message: 'Error: finder gone' }),
  );
});

it('leaves the zoom setting out when the zoom read is rejected', async () => {
  mock.page = 'appearance';
  const zoomFactor = vi.fn(async () => {
    throw new Error('zoom gone');
  });
  window.pantheon!.zoomFactor = zoomFactor;
  const screen = mount(() => ProjectSettingsScreen());
  const app = child(named(screen.value, 'AppPage'));
  const h = child(named(app.value, 'AppearancePage'));
  await h.flush();
  expect(zoomFactor).toHaveBeenCalled();
  expect(nodes(h.value).some((n) => n.props.title === zh('settings.appearance.zoom'))).toBe(false);
});

it('keeps an unavailable saved runtime when only the permission mode changes', async () => {
  const p = {
    ...project,
    session_defaults: { runtime: 'codex', permission_mode: 'auto_edit' },
  };
  window.pantheon!.query = vi.fn(async (method: string) => ({
    ok: true as const,
    value:
      method === 'capabilities'
        ? [{ runtime: 'claude', capabilities: { write_isolation: { status: 'supported' } } }]
        : inventory,
  }));
  mock.board.board.projects = [p];
  const h = mount(() => SessionDefaults({ project: p as never }));
  await h.flush();
  expect(named(h.value, 'ModelMenu').props.value.runtime).toBe('codex');
  find(
    h.value,
    (n) => n.props['aria-label'] === zh('settings.defaults.permissionMode'),
  ).props.onValueChange('plan');
  await h.flush();
  expect(mock.command).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'project.sessionDefaults.set',
      input: { project_id: p.id, runtime: 'codex', permission_mode: 'plan' },
    }),
  );
});

async function hooksEntryWithMachineOff() {
  const p = {
    ...project,
    extension_overrides: {
      codex: {
        disabled_mcp_servers: [],
        disabled_plugins: [],
        disabled_skills: [],
        disable_apps: false,
        disable_hooks: true,
      },
    },
  };
  window.pantheon!.query = vi.fn(async () => ({
    ok: true as const,
    value: { ...inventory, hooks_enabled: false },
  }));
  mock.board.board.projects = [p];
  const screen = mount(() => ProjectSettingsScreen());
  const h = extensionsPage(screen);
  await h.flush();
  const groups = child(named(h.value, 'Groups'));
  const hooks = nodes(groups.value).find(
    (n) => typeof n.type === 'function' && n.type.name === 'Entry' && n.props.name === 'Hooks',
  );
  return { h, entry: child(hooks) };
}

it('lets a saved hooks override be removed while the machine has hooks off', async () => {
  const { h, entry } = await hooksEntryWithMachineOff();
  button(entry.value, zh('settings.extensions.removeOverride')).props.onClick();
  h.render();
  expect(named(h.value, 'Groups').props.draft.disable_hooks).toBe(false);
});

it('keeps the remove button of a locked entry outside its switch label', async () => {
  const { entry } = await hooksEntryWithMachineOff();
  expect(nodes(entry.value).some((n) => n.type === 'button')).toBe(true);
  const input = find(entry.value, (n) => n.type === 'input');
  expect(input.props['aria-label']).toBe(zhf('settings.extensions.load', { name: 'Hooks' }));
  const labels = nodes(entry.value).filter((n) => n.type === 'label');
  expect(labels.some((l) => nodes(l.props.children).some((n) => n.type === 'button'))).toBe(false);
});
