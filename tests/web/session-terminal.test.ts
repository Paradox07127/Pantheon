import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { Command, TerminalFrame, WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
// A stand-in for xterm: records what is written and hands out its listeners.
const xt = vi.hoisted(() => ({ made: [] as any[] }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    written: unknown[] = [];
    typed?: (data: string) => void;
    opened?: unknown;
    disposed = false;
    constructor(public options: Record<string, unknown>) {
      xt.made.push(this);
    }
    loadAddon() {}
    open(element: unknown) {
      this.opened = element;
    }
    write(data: unknown) {
      this.written.push(data);
    }
    onData(listener: (data: string) => void) {
      this.typed = listener;
      return { dispose() {} };
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('../../apps/web/node_modules/@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
import { DEFAULT_LOOK, setAppearance, setLook } from '@/data/layout';
import { TerminalPanel } from '@/screens/sessions/TerminalPanel';
import { SessionHeader, SessionsScreen } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

let bridge: Record<string, ReturnType<typeof vi.fn>>;
let stored: Map<string, string>;
let observed: (() => void)[];
let streams: { terminal_id: string; listener: (frame: TerminalFrame) => void; end: () => void }[];
let terminals: number;
const hosts: HookHost<any>[] = [];
const box = { name: 'terminal box' };
// Gives every ref in the tree an element before the effects run.
function mount<T>(body: () => T) {
  const h = new HookHost(body, (tree) => {
    for (const node of nodes(tree as ReactNode))
      if (node.props.ref && typeof node.props.ref === 'object') node.props.ref.current ??= box;
  });
  hosts.push(h);
  h.render();
  return h;
}

beforeEach(() => {
  xt.made.splice(0);
  observed = [];
  streams = [];
  terminals = 0;
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
    events: [],
    status: { state: 'live' },
    cursor: 1,
    resync: 0,
    refresh() {},
  };
  mock.shell = {
    sessionId: 'session-a',
    sessionGroup: null,
    sessionTab: null,
    sessionOpened: 1,
    followed: null,
    openSettings() {},
    openSession: vi.fn(),
    followFirstSession() {},
    follow() {},
  };
  bridge = {
    command: vi.fn(async (command: Command) =>
      command.type === 'terminal.open'
        ? { ok: true, value: { terminal_id: `terminal-${++terminals}` } }
        : { ok: true, value: null },
    ),
    query: vi.fn(async () => ({ ok: true, value: null })),
    terminalSubscribe: vi.fn((terminal_id: string, listener: (frame: TerminalFrame) => void) => {
      const end = vi.fn();
      streams.push({ terminal_id, listener, end });
      return end;
    }),
  };
  stored = new Map();
  vi.stubGlobal('window', {
    innerWidth: 1400,
    innerHeight: 900,
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => `token(${name})`,
  }));
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  setAppearance({ inspector: 'auto', reading_width: 760 });
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  setLook(DEFAULT_LOOK);
  vi.unstubAllGlobals();
});

const sent = (type: string) =>
  bridge
    .command!.mock.calls.map(([command]) => command as Command)
    .filter((command) => command.type === type)
    .map((command) => command.input);
const labelled = (tree: ReactNode, label: string) =>
  nodes(tree).find((n) => n.props['aria-label'] === label);
const button = (tree: ReactNode, label: string): ReactElement<any> =>
  find(tree, (n) => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label));

describe('terminal panel', () => {
  let project = 0;
  // The panel makes its xterm once the dynamic import of xterm lands.
  const drawn = (count = 1) => vi.waitFor(() => expect(xt.made).toHaveLength(count));
  const panel = (props: Partial<Parameters<typeof TerminalPanel>[0]> = {}) => {
    const onClose = vi.fn();
    const projectId = `project-${++project}`;
    const h = mount(() =>
      TerminalPanel({
        projectId,
        sessionId: 'session-a',
        onClose,
        ...props,
      }),
    );
    return { h, onClose };
  };

  it('opens a terminal in the session worktree and writes its output into the terminal', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    expect(sent('terminal.open')).toEqual([
      { project_id: `project-${project}`, session_id: 'session-a', cols: 80, rows: 24 },
    ]);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1']);
    expect(xt.made).toHaveLength(1);
    expect(xt.made[0].opened).toBe(box);
    expect(xt.made[0].options.theme).toMatchObject({
      background: 'token(--term)',
      foreground: 'token(--term-tx)',
    });
    const bytes = new Uint8Array([104, 105]);
    streams[0]!.listener({ data: bytes });
    expect(xt.made[0].written).toEqual([bytes]);
  });

  it('opens a terminal in the project without a session', async () => {
    const { h } = panel({ sessionId: null });
    await drawn();
    await h.flush();
    expect(sent('terminal.open')).toEqual([
      { project_id: `project-${project}`, cols: 80, rows: 24 },
    ]);
  });

  it('sends typed keys and new sizes to the terminal', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    xt.made[0].typed('ls\r');
    await h.flush();
    expect(sent('terminal.write')).toEqual([{ terminal_id: 'terminal-1', data: 'ls\r' }]);
    xt.made[0].cols = 120;
    xt.made[0].rows = 30;
    for (const callback of observed) callback();
    expect(sent('terminal.resize')).toEqual([{ terminal_id: 'terminal-1', cols: 120, rows: 30 }]);
  });

  it('shows the exit code with a reopen button that opens a new terminal', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    streams[0]!.listener({ exit: 3 });
    h.render();
    expect(text(h.value)).toContain('3');
    button(h.value, zh('sessions.terminal.reopen')).props.onClick();
    h.render();
    await drawn(2);
    await h.flush();
    expect(sent('terminal.open')).toHaveLength(2);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1', 'terminal-2']);
    expect(text(h.value)).not.toContain(zh('sessions.terminal.reopen'));
  });

  it('shows a lost connection with a reopen button that subscribes the kept terminal again', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    streams[0]!.listener({ closed: true });
    h.render();
    expect(text(find(h.value, (n) => n.props.className === 'ss-term-exit'))).toContain(
      zh('sessions.terminal.lost'),
    );
    button(h.value, zh('sessions.terminal.reopen')).props.onClick();
    h.render();
    await drawn(2);
    await h.flush();
    expect(sent('terminal.open')).toHaveLength(1);
    expect(sent('terminal.resize')).toEqual([{ terminal_id: 'terminal-1', cols: 80, rows: 24 }]);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1', 'terminal-1']);
    expect(text(h.value)).not.toContain(zh('sessions.terminal.lost'));
  });

  it('closes the terminal from its close button', async () => {
    const { h, onClose } = panel();
    await drawn();
    await h.flush();
    button(h.value, zh('sessions.terminal.close')).props.onClick();
    await h.flush();
    expect(sent('terminal.close')).toEqual([{ terminal_id: 'terminal-1' }]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('only ends the stream when it unmounts, and shows the same terminal when it mounts again', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    h.unmount();
    expect(streams[0]!.end).toHaveBeenCalledOnce();
    expect(xt.made[0].disposed).toBe(true);
    expect(sent('terminal.close')).toEqual([]);
    const again = mount(() =>
      TerminalPanel({ projectId: `project-${project}`, sessionId: 'session-a', onClose() {} }),
    );
    await drawn(2);
    await again.flush();
    expect(sent('terminal.open')).toHaveLength(1);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1', 'terminal-1']);
  });

  it('writes why the terminal could not open in the panel', async () => {
    bridge.command!.mockImplementation(async () => ({
      ok: false,
      error: { code: 'unsupported_capability', message: 'node-pty is not installed' },
    }));
    const { h } = panel();
    await drawn();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain(
      'node-pty is not installed',
    );
    expect(streams).toEqual([]);
  });

  it('offers to reopen a terminal that could not open', async () => {
    bridge.command!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'unsupported_capability', message: 'node-pty is not installed' },
    }));
    const { h } = panel();
    await drawn();
    await h.flush();
    button(h.value, zh('sessions.terminal.reopen')).props.onClick();
    h.render();
    await drawn(2);
    await h.flush();
    expect(sent('terminal.open')).toHaveLength(2);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1']);
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    expect(text(h.value)).not.toContain(zh('sessions.terminal.reopen'));
  });

  it('drops a refused open once the panel shows the terminal of another place', async () => {
    bridge.command!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'unsupported_capability', message: 'node-pty is not installed' },
    }));
    const projectId = `project-${++project}`;
    let sessionId: string | null = 'session-a';
    const h = mount(() => TerminalPanel({ projectId, sessionId, onClose() {} }));
    await drawn();
    await h.flush();
    expect(text(h.value)).toContain(zh('sessions.terminal.reopen'));
    sessionId = null;
    h.render();
    await drawn(2);
    await h.flush();
    expect(sent('terminal.open')).toEqual([
      { project_id: projectId, session_id: 'session-a', cols: 80, rows: 24 },
      { project_id: projectId, cols: 80, rows: 24 },
    ]);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1']);
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    expect(text(h.value)).not.toContain(zh('sessions.terminal.reopen'));
  });

  it("opens the terminal once the session's worktree is ready, without a click", async () => {
    let worktreeReady = false;
    const reply = bridge.command!.getMockImplementation() as (command: Command) => unknown;
    bridge.command!.mockImplementation(async (command: Command) =>
      command.type === 'terminal.open' && !worktreeReady
        ? { ok: false, error: { code: 'invalid_state', message: 'Worktree is not ready' } }
        : reply(command),
    );
    const projectId = `project-${++project}`;
    let ready = false;
    const h = mount(() =>
      TerminalPanel({ projectId, sessionId: 'session-a', ready, onClose() {} }),
    );
    await h.flush();
    worktreeReady = true;
    ready = true;
    h.render();
    await drawn();
    await h.flush();
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1']);
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('turns on xterm screen reader support', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    expect(xt.made[0].options.screenReaderMode).toBe(true);
  });

  it('draws in the code text size and refits when that size changes', async () => {
    setLook({ code_font: 15 });
    const { h } = panel();
    await drawn();
    await h.flush();
    expect(xt.made[0].options.fontSize).toBe(15);
    xt.made[0].cols = 100;
    setLook({ code_font: 18 });
    h.render();
    expect(xt.made).toHaveLength(1);
    expect(xt.made[0].options.fontSize).toBe(18);
    expect(sent('terminal.resize')).toEqual([{ terminal_id: 'terminal-1', cols: 100, rows: 24 }]);
  });

  // Holds back the replies to one command type until release is called.
  const holdBack = (type: string) => {
    const held: (() => void)[] = [];
    const reply = bridge.command!.getMockImplementation() as (command: Command) => unknown;
    bridge.command!.mockImplementation(
      (command: Command) =>
        new Promise((resolve) => {
          if (command.type === type) held.push(() => resolve(reply(command)));
          else resolve(reply(command));
        }),
    );
    return { release: () => held.splice(0).forEach((go) => go()) };
  };

  it('closes a terminal that finishes opening after its close button', async () => {
    const opening = holdBack('terminal.open');
    const { h, onClose } = panel();
    await drawn();
    await h.flush();
    button(h.value, zh('sessions.terminal.close')).props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    h.unmount();
    opening.release();
    await h.flush();
    expect(sent('terminal.close')).toEqual([{ terminal_id: 'terminal-1' }]);
    expect(streams).toEqual([]);
    const again = mount(() =>
      TerminalPanel({ projectId: `project-${project}`, sessionId: 'session-a', onClose() {} }),
    );
    await drawn(2);
    await again.flush();
    opening.release();
    await again.flush();
    expect(sent('terminal.open')).toHaveLength(2);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-2']);
  });

  it('shares an open that is still pending with a panel that mounts again', async () => {
    const opening = holdBack('terminal.open');
    const { h } = panel();
    await drawn();
    await h.flush();
    h.unmount();
    const again = mount(() =>
      TerminalPanel({ projectId: `project-${project}`, sessionId: 'session-a', onClose() {} }),
    );
    await drawn(2);
    await again.flush();
    opening.release();
    await again.flush();
    expect(sent('terminal.open')).toHaveLength(1);
    expect(sent('terminal.close')).toEqual([]);
    expect(streams.map((s) => s.terminal_id)).toEqual(['terminal-1']);
  });

  it('sends a size that changed while the terminal opened once it is open', async () => {
    const opening = holdBack('terminal.open');
    const { h } = panel();
    await drawn();
    await h.flush();
    xt.made[0].cols = 120;
    xt.made[0].rows = 30;
    for (const callback of observed) callback();
    opening.release();
    await h.flush();
    expect(sent('terminal.resize')).toEqual([{ terminal_id: 'terminal-1', cols: 120, rows: 30 }]);
  });

  it('sends typed input in order, one write after the other', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    const writing = holdBack('terminal.write');
    xt.made[0].typed('rm -i x');
    xt.made[0].typed('\r');
    await h.flush();
    expect(sent('terminal.write')).toEqual([{ terminal_id: 'terminal-1', data: 'rm -i x' }]);
    writing.release();
    await h.flush();
    expect(sent('terminal.write')).toEqual([
      { terminal_id: 'terminal-1', data: 'rm -i x' },
      { terminal_id: 'terminal-1', data: '\r' },
    ]);
  });

  it('splits a paste into writes of at most 64 KiB of UTF-8', async () => {
    const { h } = panel();
    await drawn();
    await h.flush();
    const paste = 'é'.repeat(40000) + '😀'.repeat(10000);
    xt.made[0].typed(paste);
    for (let i = 0; i < 4; i++) await h.flush();
    const writes = sent('terminal.write').map((input) => input.data as string);
    expect(writes.length).toBeGreaterThan(1);
    for (const data of writes)
      expect(new TextEncoder().encode(data).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(writes.join('')).toBe(paste);
  });

  it('counts as running for a second after output', async () => {
    vi.useFakeTimers();
    try {
      const onBusy = vi.fn();
      const { h } = panel({ onBusy });
      await drawn();
      await h.flush();
      streams[0]!.listener({ data: new Uint8Array([1]) });
      expect(onBusy).toHaveBeenLastCalledWith(true);
      vi.advanceTimersByTime(999);
      expect(onBusy).toHaveBeenLastCalledWith(true);
      vi.advanceTimersByTime(1);
      expect(onBusy).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const session = (id: string): Session => ({
  id,
  revision: 4,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
});

describe('terminal toggle', () => {
  const header = (terminal?: { open: boolean; busy: boolean; onToggle: () => void }) =>
    mount(() =>
      SessionHeader({
        session: session('session-a'),
        listed: listed('session-a'),
        title: 'title',
        panels: [],
        onPanel: vi.fn(),
        overview: false,
        ...(terminal ? { terminal } : {}),
      }),
    );

  it('switches the terminal on its own, with a dot while a command runs', () => {
    const onToggle = vi.fn();
    const shut = header({ open: false, busy: false, onToggle });
    const toggle = labelled(shut.value, zh('sessions.terminal.title'))!;
    expect(toggle.props['aria-pressed']).toBe(false);
    expect(nodes(toggle).some((n) => n.props.className === 'sh-pip')).toBe(false);
    toggle.props.onClick();
    expect(onToggle).toHaveBeenCalledOnce();
    const running = header({ open: true, busy: true, onToggle });
    const pressed = labelled(running.value, zh('sessions.terminal.running'))!;
    expect(pressed.props['aria-pressed']).toBe(true);
    expect(nodes(pressed).some((n) => n.props.className === 'sh-pip')).toBe(true);
  });

  const list = {
    data: [listed('session-a'), listed('baseline', { workspace_id: null })],
    loading: false,
    error: null,
    reload() {},
  };
  const needs = { items: [], loading: false, error: null, reload() {} };
  const screen = () => mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  const thread = (h: HookHost<any>) => named(h.value, 'Thread');
  const terminalPanel = (h: HookHost<any>) =>
    nodes(h.value).find((n) => typeof n.type === 'function' && n.type.name === 'TerminalPanel');

  it('shows the terminal under the conversation and panels at its stored height', () => {
    stored.set('pantheon.terminal-height', '300');
    const h = screen();
    expect(terminalPanel(h)).toBeUndefined();
    thread(h).props.terminal.onToggle();
    h.render();
    expect(thread(h).props.terminal.open).toBe(true);
    const shown = terminalPanel(h)!;
    expect(shown.props).toMatchObject({ projectId: 'project-a', sessionId: 'session-a' });
    expect(h.value.props.style['--ss-th']).toBe('300px');
    shown.props.onClose();
    h.render();
    expect(terminalPanel(h)).toBeUndefined();
  });

  it('starts a session without a worktree in the project', () => {
    mock.shell = { ...mock.shell, sessionId: 'baseline' };
    const h = screen();
    thread(h).props.terminal.onToggle();
    h.render();
    // The daemon opens the terminal of a session without a workspace in the project folder.
    expect(terminalPanel(h)!.props.sessionId).toBe('baseline');
  });

  const shownWith = (one: WorkbenchSession) => {
    mock.shell = { ...mock.shell, sessionId: one.id };
    const h = mount(() =>
      SessionsScreen({ projectId: 'project-a', needs, list: { ...list, data: [one] } }),
    );
    thread(h).props.terminal.onToggle();
    h.render();
    return terminalPanel(h)!.props;
  };

  it('starts the terminal of a session that has ended in the project', () => {
    for (const state of ['merged', 'discarded', 'failed'] as const)
      expect(shownWith(listed(`ended-${state}`, { state })).sessionId).toBeNull();
    expect(shownWith(listed('session-a')).sessionId).toBe('session-a');
  });

  it('holds the terminal of a session until its worktree is ready', () => {
    expect(shownWith(listed('session-a', { state: 'starting' })).ready).toBe(false);
    expect(shownWith(listed('session-a')).ready).toBe(true);
  });

  it('offers no terminal without the desktop bridge', () => {
    vi.stubGlobal('window', { ...window, pantheon: undefined });
    const h = screen();
    expect(thread(h).props.terminal).toBeUndefined();
    expect(terminalPanel(h)).toBeUndefined();
  });
});
