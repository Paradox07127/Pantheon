import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AlertDialog } from '../../apps/web/node_modules/@base-ui/react/alert-dialog/index.mjs';
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
  board: {} as any,
  command: vi.fn(),
  candidates: [] as any[] | null,
  reload: () => {},
  view: {} as any,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'ap' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => ({ ...mock.board, refresh() {} }),
  }),
}));
vi.mock('@/screens/projects/view', () => {
  const state = () => mock.view;
  return {
    useProjectsView: Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
    }),
  };
});
vi.mock('@/data/import', () => ({
  useImportCandidates: () => ({
    data: mock.candidates && { candidates: mock.candidates, indexing: null },
    reload: mock.reload,
  }),
}));
import { FolderFields, VariableFields } from '@/screens/projects/EnvironmentFields';
import { AddProject, Setup } from '@/screens/projects/AddProject';
import { ProjectsScreen } from '@/screens/projects/ProjectsScreen';
import { useProjectsView } from '@/screens/projects/view';
import { runShortcut } from '@/lib/shortcuts';
import { zh, zhf } from './i18n-setup.js';

const opened = { id: 'opened', name: 'app', roots: ['/work/app'], revision: 2 };
const savedBrief = {
  id: 'opened',
  revision: 3,
  project_id: 'opened',
  goal: 'Ship the importer',
  goals: ['CSV input'],
  non_goals: ['Exports'],
  created_at: 1,
  updated_by: 'user',
};
const payments = {
  id: 'payments',
  name: 'Payments service',
  roots: ['/home/me/work/payments'],
  revision: 1,
};
const folder = (parent: string, name: string) => ({
  name,
  path: `${parent}/${name}`,
  hidden: name.startsWith('.'),
});
const FOLDERS: Record<string, { path: string; parent: string | null; entries: any[] }> = {
  '~': { path: '/home/me', parent: '/home', entries: [folder('/home/me', 'work')] },
  '~/work': {
    path: '/home/me/work',
    parent: '/home/me',
    entries: ['ledger', 'payments', 'payroll', '.scratch'].map((n) => folder('/home/me/work', n)),
  },
  '~/work/payroll': { path: '/home/me/work/payroll', parent: '/home/me/work', entries: [] },
};
let keydown: ((e: any) => void)[] = [];
const browseDirectory = vi.fn(async (path: string) =>
  FOLDERS[path]
    ? { ok: true as const, value: FOLDERS[path] }
    : { ok: false as const, error: { code: 'not_a_directory', message: `${path} is not one` } },
);

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], project_briefs: [] },
    events: [],
    status: { state: 'live' },
  };
  mock.candidates = [];
  mock.reload = () => {};
  mock.command.mockReset();
  mock.command.mockResolvedValue({ ok: true, value: opened });
  browseDirectory.mockClear();
  keydown = [];
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('document', { activeElement: null, getElementById: () => null });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: any) => type === 'keydown' && keydown.push(fn),
    removeEventListener: (type: string, fn: any) => {
      if (type === 'keydown') keydown = keydown.filter((l) => l !== fn);
    },
    pantheon: {
      command: mock.command,
      query: vi.fn(async () => ({ ok: true, value: null })),
      browseDirectory,
      chooseDirectories: vi.fn(async () => ({ ok: true, value: [] })),
    },
  });
  mock.view = {
    opening: false,
    query: '',
    setOpening: (opening: boolean) => (mock.view.opening = opening),
    setQuery: (query: string) => (mock.view.query = query),
  };
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The text a screen reader reads: aria-hidden parts left out. */
function spoken(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(spoken).join('');
  if (tree && typeof tree === 'object' && 'props' in tree) {
    const props = (tree as any).props;
    return props['aria-hidden'] === 'true' || props['aria-hidden'] === true
      ? ''
      : spoken(props.children);
  }
  return tree === null || tree === undefined || typeof tree === 'boolean' ? '' : String(tree);
}

function openPicker(projects: unknown[] = []) {
  const onOpened = vi.fn();
  const h = mount(() => AddProject({ projects: projects as any, onOpened }));
  useProjectsView.getState().setOpening(true);
  h.render();
  return { h, onOpened };
}
const field = (h: HookHost<any>) =>
  find(
    h.value,
    (n) => n.props.role === 'combobox' && n.props['aria-label'] === zh('projects.add.path'),
  );
const options = (h: HookHost<any>) => nodes(h.value).filter((n) => n.props.role === 'option');
const option = (h: HookHost<any>, name: string) =>
  options(h).find((n) => spoken(n).startsWith(name))!;
async function type(h: HookHost<any>, value: string) {
  field(h).props.onChange({ target: { value } });
  h.render();
  vi.advanceTimersByTime(120);
  await h.flush();
}
function press(h: HookHost<any>, key: string, mods: Record<string, unknown> = {}) {
  const e = {
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...mods,
  };
  field(h).props.onKeyDown(e);
  h.render();
  return e;
}

it('lists the folders of a path ending in a slash, the parent first and hidden ones last', async () => {
  const { h } = openPicker();
  field(h).props.onChange({ target: { value: '~/work/' } });
  h.render();
  expect(browseDirectory).not.toHaveBeenCalledWith('~/work');
  vi.advanceTimersByTime(120);
  await h.flush();
  expect(options(h).map(spoken)).toEqual(['..', 'ledger', 'payments', 'payroll', '.scratch']);
  expect(option(h, 'ledger').props['aria-selected']).toBe(true);
});

it('reads the history folders again on each opening, so a failed first read does not stay empty', () => {
  mock.candidates = null;
  mock.reload = () => {
    mock.candidates = [
      {
        root: '/home/me/work/payments',
        name: 'payments',
        git: true,
        remote: null,
        sessions: 3,
        runtimes: ['codex'],
        last_active_at: '2026-11-14T10:00:00Z',
        preselected: false,
      },
    ];
  };
  const { h } = openPicker();
  h.render();
  expect(option(h, 'payments')).toBeDefined();
});

it('keeps only the folders whose name starts with the last segment, read once per folder', async () => {
  const { h } = openPicker();
  await type(h, '~/work/');
  await type(h, '~/work/pa');
  expect(options(h).map(spoken)).toEqual(['payments', 'payroll']);
  expect(browseDirectory.mock.calls.filter(([p]) => p === '~/work')).toHaveLength(1);
});

it('completes the highlighted folder on Tab and browses it', async () => {
  const { h } = openPicker([payments]);
  await type(h, '~/work/pa');
  const e = press(h, 'Tab');
  expect(e.preventDefault).toHaveBeenCalled();
  expect(field(h).props.value).toBe('~/work/payroll/');
  vi.advanceTimersByTime(120);
  await h.flush();
  expect(browseDirectory).toHaveBeenCalledWith('~/work/payroll');
});

it('opens the highlighted folder as a project named after it on Enter', async () => {
  const { h } = openPicker([payments]);
  await type(h, '~/work/pa');
  press(h, 'Enter');
  await h.flush();
  expect(mock.command).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'project.open',
      input: { name: 'payroll', roots: ['/home/me/work/payroll'] },
    }),
  );
  expect(named(h.value, 'Setup').props.project_id).toBe('opened');
});

it('marks a folder that is already a project and offers to open that project instead', async () => {
  const { h, onOpened } = openPicker([payments]);
  await type(h, '~/work/');
  const row = option(h, 'payments');
  expect(row.props['aria-disabled']).toBe(true);
  expect(spoken(row)).toContain('Payments service');
  row.props.onClick();
  expect(mock.command).not.toHaveBeenCalled();
  find(row, (n) => n.type === 'button' && text(n) === zh('projects.open.title')).props.onClick({
    stopPropagation() {},
  });
  expect(onOpened).toHaveBeenCalledWith('payments');
  expect(useProjectsView.getState().opening).toBe(false);
});

it('says so under the field when the folder part does not exist', async () => {
  const { h } = openPicker();
  await type(h, '~/nope/');
  const alert = find(h.value, (n) => n.props.role === 'alert');
  expect(spoken(alert)).toBe(zhf('projects.add.notFolder', { path: '~/nope' }).replace(/\s/g, ''));
});

it('gives the focus back to the button that opened it when closed', () => {
  const entry = { tagName: 'BUTTON' };
  (document as any).activeElement = entry;
  const { h } = openPicker();
  (document as any).activeElement = field(h);
  find(h.value, (n) => typeof n.props.onOpenChange === 'function').props.onOpenChange(false);
  h.render();
  expect(useProjectsView.getState().opening).toBe(false);
  expect(find(h.value, (n) => typeof n.props.finalFocus === 'function').props.finalFocus()).toBe(
    entry,
  );
});

it('opens on ⌘O and from the menu with no projects screen mounted', () => {
  delete (window as any).pantheon;
  const h = mount(() => AddProject({ projects: [], onOpened() {} }));
  const e = { key: 'o', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  for (const listener of [...keydown])
    listener({ ...e, target: { tagName: 'BODY' }, preventDefault() {} });
  expect(useProjectsView.getState().opening).toBe(true);
  useProjectsView.getState().setOpening(false);
  h.render();
  expect(runShortcut('open-project')).toBe(true);
  expect(useProjectsView.getState().opening).toBe(true);
});

async function goalStep(onEnter = () => {}) {
  vi.useRealTimers();
  const h = mount(() => Setup({ project_id: 'opened', path: '~/work/app', onEnter }));
  await h.flush();
  return h;
}

const textButton = (tree: any, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);
const button = (h: HookHost<any>, label: string) =>
  find(h.value, (n) => n.props.label === label).props;

it('starts the goal step from the saved brief and sets it at its revision', async () => {
  mock.board.board.project_briefs = [savedBrief];
  const h = await goalStep();
  const area = find(h.value, (n) => n.type === 'textarea');
  expect(area.props.value).toBe('Ship the importer');
  area.props.onChange({ target: { value: 'Ship every importer' } });
  h.render();
  button(h, zh('projects.open.enter')).onPress();
  await h.flush();
  expect(mock.command).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'project.brief.set',
      input: {
        project_id: 'opened',
        goal: 'Ship every importer',
        goals: ['CSV input'],
        non_goals: ['Exports'],
      },
      expected_revision: 3,
    }),
  );
});

it('enters the project without a command when the saved goal is kept', async () => {
  mock.board.board.project_briefs = [savedBrief];
  const onEnter = vi.fn();
  const h = await goalStep(onEnter);
  const calls = mock.command.mock.calls.length;
  expect(button(h, zh('projects.open.enter')).state.enabled).toBe(true);
  button(h, zh('projects.open.enter')).onPress();
  await h.flush();
  expect(onEnter).toHaveBeenCalledOnce();
  expect(mock.command).toHaveBeenCalledTimes(calls);
});

it('creates the first brief without a revision', async () => {
  const h = await goalStep();
  find(h.value, (n) => n.type === 'textarea').props.onChange({ target: { value: 'New goal' } });
  h.render();
  button(h, zh('projects.open.enter')).onPress();
  await h.flush();
  expect(mock.command).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'project.brief.set',
      input: { project_id: 'opened', goal: 'New goal', goals: [], non_goals: [] },
      expected_revision: null,
    }),
  );
});

it('does not enter the project when the goal save returns after the step is gone', async () => {
  const onEnter = vi.fn();
  const h = await goalStep(onEnter);
  find(h.value, (n) => n.type === 'textarea').props.onChange({ target: { value: 'New goal' } });
  h.render();
  const pending = deferred<any>();
  mock.command.mockReturnValue(pending.promise);
  button(h, zh('projects.open.enter')).onPress();
  h.unmount();
  pending.resolve({ ok: true, value: {} });
  await h.flush();
  expect(onEnter).not.toHaveBeenCalled();
});

it('adds picked folders to the folders shown when the picker returns', async () => {
  const picked = deferred<any>();
  (window as any).pantheon.chooseDirectories = vi.fn(() => picked.promise);
  const first = vi.fn();
  const later = vi.fn();
  let props = { value: ['/work/app'], onChange: first };
  const h = mount(() => FolderFields(props));
  textButton(h.value, zh('projects.folders.add')).props.onClick();
  props = { value: ['/work/app', '/work/docs'], onChange: later };
  h.render();
  picked.resolve({ ok: true, value: ['/work/site'] });
  await h.flush();
  expect(first).not.toHaveBeenCalled();
  expect(later).toHaveBeenCalledWith(['/work/app', '/work/docs', '/work/site']);
});

it('hides a variable added in place of a deleted revealed one', () => {
  let value = [
    { id: 0, key: 'A', value: '1' },
    { id: 1, key: 'B', value: '2' },
  ];
  const h = mount(() =>
    VariableFields({
      value,
      onChange: (next) => {
        value = next;
      },
    }),
  );
  const press = (label: string) => {
    find(h.value, (n) => n.props['aria-label'] === label || text(n) === label).props.onClick();
    h.render();
  };
  press(zhf('projects.variables.show', { n: 2 }));
  press(zhf('projects.variables.delete', { n: 2 }));
  press(zh('projects.variables.add'));
  expect(
    find(h.value, (n) => n.props['aria-label'] === zhf('projects.variables.value', { n: 2 })).props
      .type,
  ).toBe('password');
});

it('asks before removing a project in an alert dialog', () => {
  mock.board.status = { state: 'live' };
  const screen = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
  const dialog: any = named(screen.value, 'RemoveProjectDialog');
  const project = { id: 'alpha', name: 'Alpha', roots: ['/work/alpha'], revision: 1 };
  const h = mount(() => dialog.type({ project, onClose() {} }));
  expect(h.value.type).toBe(AlertDialog.Root);
  expect(text(find(h.value, (n) => n.type === AlertDialog.Title))).toContain('Alpha');
});

it.each([
  ['fails', { ok: false, error: { code: 'resource_busy', message: 'busy' } }],
  ['succeeds', { ok: true, value: null }],
])(
  'keeps a removal that %s late away from the dialog opened for another project',
  async (_, outcome) => {
    vi.useRealTimers();
    mock.board.status = { state: 'live' };
    const screen = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    const dialog: any = named(screen.value, 'RemoveProjectDialog');
    let project: any = { id: 'alpha', name: 'Alpha', roots: ['/work/alpha'], revision: 1 };
    const onClose = vi.fn();
    const h = mount(() => dialog.type({ project, onClose }));
    const pending = deferred<any>();
    mock.command.mockReturnValue(pending.promise);
    const remove = () => textButton(h.value, zh('projects.remove.confirm'));
    remove().props.onClick();
    project = null;
    h.render();
    project = { id: 'beta', name: 'Beta', roots: ['/work/beta'], revision: 1 };
    h.render();
    pending.resolve(outcome);
    await h.flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(text(h.value)).not.toContain(zh('data.projects.removeBusy'));
    expect(remove().props['aria-disabled']).toBeUndefined();
  },
);
