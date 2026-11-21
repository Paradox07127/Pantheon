import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, mount as host, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
}));
const runCommand = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: null })));
vi.mock('@/data/commands', () => ({ runCommand }));
import { Sidebar } from '@/components/Sidebar';
import { SessionListRow, SessionRowButton } from '@/screens/sessions/SessionRow';

const session = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-13T10:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-13T10:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

type Listener = (e: KeyboardEvent) => void;
let listeners: Listener[] = [];
let project = 0;

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  listeners = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
  });
  vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'hidden' });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  mock.board = {
    board: { sessions: [{ id: 'a', revision: 4 }], workspaces: [] },
    events: [],
    status: { state: 'live' },
  };
  mock.shell = {
    screen: 'board',
    sessionId: null,
    sessionGroup: null,
    renaming: null,
    setScreen: vi.fn((next: string) => (mock.shell.screen = next)),
    openSession: vi.fn(),
  };
  runCommand.mockClear();
  project++;
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function mount(sessions: WorkbenchSession[]) {
  return host(() =>
    Sidebar({
      layout: {
        collapsed: false,
        width: 264,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: [{ id: `project-${project}`, name: 'Alpha' }],
      currentProjectId: `project-${project}`,
      onChooseProject: () => {},
      list: { data: sessions, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
    }),
  );
}

const rowsOf = (h: HookHost<any>) => nodes(h.value).filter((n) => n.type === SessionListRow);
const rowOf = (h: HookHost<any>, id: string) => rowsOf(h).find((n) => n.props.session.id === id)!;

/** Presses a plain key on the list with focus on the row of `id`; returns the row focused after. */
function pressOnRow(h: HookHost<any>, id: string, key: string) {
  const focused: string[] = [];
  const els = rowsOf(h).map((row) => ({
    dataset: { session: row.props.session.id },
    focus: () => focused.push(row.props.session.id),
  }));
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { dataset: { session: id } },
    currentTarget: { querySelectorAll: () => els },
    preventDefault: vi.fn(),
  };
  find(h.value, (n) => n.props.className === 'ss-list').props.onKeyDown(e);
  h.render();
  return { focused, handled: e.preventDefault };
}

const pressWindow = (key: string, target: object = { tagName: 'BODY' }) => {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
  for (const listener of [...listeners]) listener(e);
};

describe('session list keys', () => {
  it('lists a session stored with a field the list no longer reads as a plain row the keys step to', () => {
    const h = mount([
      session('a', { last_activity_at: '2026-11-13T10:30:00.000Z' }),
      session('b', {
        last_activity_at: '2026-11-13T10:20:00.000Z',
        ...({ resident: { kind: 'assistant' } } as object),
      }),
    ]);
    expect(rowsOf(h).map((r) => r.props.session.id)).toEqual(['a', 'b']);
    expect(pressOnRow(h, 'a', 'j').focused).toEqual(['b']);
  });

  it('moves the highlight down with J and up with K', () => {
    const h = mount([
      session('a', { last_activity_at: '2026-11-13T10:30:00.000Z' }),
      session('b', { last_activity_at: '2026-11-13T10:20:00.000Z' }),
    ]);
    expect(rowsOf(h).map((r) => r.props.session.id)).toEqual(['a', 'b']);
    expect(pressOnRow(h, 'a', 'j').focused).toEqual(['b']);
    expect(pressOnRow(h, 'b', 'k').focused).toEqual(['a']);
  });

  it('selects and deselects the highlighted row with X without moving the highlight', () => {
    const h = mount([session('a'), session('b')]);
    const { focused, handled } = pressOnRow(h, 'a', 'x');
    expect(handled).toHaveBeenCalled();
    expect(focused).toEqual([]);
    expect(rowOf(h, 'a').props.selected).toBe(true);
    expect(rowOf(h, 'b').props.selected).toBe(false);
    pressOnRow(h, 'a', 'x');
    expect(rowOf(h, 'a').props.selected).toBe(false);
  });

  it('marks the highlighted row unread with U and read again', () => {
    const h = mount([session('a')]);
    expect(rowOf(h, 'a').props.unread).toBe(false);
    pressOnRow(h, 'a', 'u');
    expect(rowOf(h, 'a').props.unread).toBe(true);
    pressOnRow(h, 'a', 'u');
    expect(rowOf(h, 'a').props.unread).toBe(false);
  });

  it('snoozes the highlighted row with H, and wakes a snoozed one', () => {
    const h = mount([session('a'), session('b', { snoozed_at: '2026-11-13T09:00:00.000Z' })]);
    pressOnRow(h, 'a', 'h');
    pressOnRow(h, 'b', 'h');
    expect(runCommand.mock.calls).toEqual([
      ['session.snooze', { session_id: 'a', snoozed: true }, 4],
      ['session.snooze', { session_id: 'b', snoozed: false }, null],
    ]);
  });

  it('goes to no screen on G then B, which had led to the project board', () => {
    mount([session('a')]);
    pressWindow('g');
    pressWindow('b');
    expect(mock.shell.setScreen).not.toHaveBeenCalled();
  });
});

describe('session row marks', () => {
  const row = (s: WorkbenchSession, selected = false) =>
    renderToStaticMarkup(
      createElement(SessionRowButton, {
        session: s,
        on: false,
        selected,
        now: Date.parse('2026-11-13T10:40:00.000Z'),
        onSelect() {},
      }),
    );

  it('marks a selected row apart from the current one, and says so in its name', () => {
    expect(row(session('a'), true)).toMatch(/data-selected="true"[^>]*>/);
    expect(row(session('a'), true)).toMatch(/aria-label="[^"]*已选中/);
    expect(row(session('a'))).not.toContain('data-selected');
  });

  it('names the device of a session on another device, and none on this one', () => {
    const remote = row(session('a', { device_id: 'workstation' }));
    expect(remote).toContain('<span class="chip mono ss-dev">workstation</span>');
    expect(remote).toMatch(/aria-label="[^"]*在 workstation 上/);
    expect(row(session('a', { device_id: 'local' }))).not.toContain('ss-dev');
    expect(row(session('a'))).not.toContain('ss-dev');
  });
});
