import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, HookHost, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import { runShortcut } from '@/lib/shortcuts';
import { SessionHeader } from '@/screens/sessions/SessionsScreen';
import { tokenText } from '@/lib/number-text';
import type { Panel } from '@/screens/sessions/inspector-model';
import { zh, zhf } from './i18n-setup.js';

type Listener = (e: KeyboardEvent) => void;

let commands: { type: string; input: unknown }[];
let listeners: Listener[];
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let clipboard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  commands = [];
  listeners = [];
  mock.board = {
    board: {
      sessions: [],
      session_turns: [],
      projects: [],
      workspaces: [{ id: 'workspace-a', path: '/work/a' }],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  const ok = async () => ({ ok: true, value: null });
  bridge = {
    command: vi.fn(async (command: any) => {
      commands.push(command);
      return { ok: true, value: {} };
    }),
    query: vi.fn(ok),
    openInEditor: vi.fn(ok),
    openInTerminal: vi.fn(ok),
    revealPath: vi.fn(ok),
  };
  clipboard = vi.fn(async () => {});
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: clipboard } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const listed = (
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state,
  waiting: state === 'waiting' ? 1 : 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const session = (extra: Partial<Session> = {}): Session => ({
  id: 'session-a',
  revision: 4,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
  ...extra,
});

function header(
  props: {
    session?: Session;
    listed?: WorkbenchSession;
    panels?: readonly Panel[];
    onPanel?: (tab: Panel) => void;
  } = {},
) {
  return mount(() =>
    SessionHeader({
      session: props.session ?? session(),
      listed: props.listed ?? listed('idle'),
      title: 'Release notes',
      panels: props.panels ?? ['changes'],
      onPanel: props.onPanel ?? (() => {}),
      overview: true,
    }),
  );
}

const button = (h: HookHost<any>, label: string) =>
  nodes(h.value).find((n) => n.type === 'button' && text(n).trim() === label);
/** Renders a part of the header, such as one of its menus, with the props the header gave it. */
const part = (h: HookHost<any>, name: string) => {
  const element = named(h.value, name);
  return mount(() => (element.type as (props: unknown) => ReactNode)(element.props));
};
/** A menu item: a component element with an onClick whose text is the label. */
const item = (h: HookHost<any>, label: string): ReactElement<any> =>
  find(
    h.value,
    (n) => typeof n.type !== 'string' && typeof n.props.onClick === 'function' && text(n) === label,
  );

describe('thread header state', () => {
  it('shows the previous failure beside an idle state while leaving the conversation open', () => {
    const h = header({
      listed: listed('idle', {
        last_turn: { id: 'turn-a', state: 'failed', error: 'Test failed' },
      }),
    });
    const result = part(h, 'LastTurn');
    expect(named(result.value, 'LastTurnMark').props.session.last_turn.state).toBe('failed');
    expect(named(result.value, 'Tip').props.content).toBe('Test failed');
    expect(button(h, '停止')).toBeUndefined();
  });

  it.each([
    [listed('running'), '运行中'],
    [listed('waiting', { waiting_kind: 'question' }), '待回答'],
    [listed('failed'), '失败'],
  ])('draws the state of the session as a glyph without its name: %#', (row, name) => {
    const h = header({ listed: row });
    const icon = find(
      h.value,
      (n) => typeof n.type === 'function' && n.type.name === 'SessionStateIcon',
    );
    expect(icon.props).toMatchObject({ session: row, place: 'header' });
    expect(text(h.value)).not.toContain(name);
  });

  it("counts the running session's time at the right of the bar", () => {
    const created_at = new Date(Date.now() - 5_000).toISOString();
    const h = header({ listed: listed('running', { created_at }) });
    expect(text(part(h, 'RunClock').value)).toBe(zhf('data.elapsed.seconds', { seconds: 5 }));
  });

  it('leaves stopping the turn to the composer and ⌘., also while it runs', () => {
    const h = header({ session: session({ state: 'running' }), listed: listed('running') });
    expect(button(h, '停止')).toBeUndefined();
    expect(button(h, '停止中')).toBeUndefined();
  });
});

describe('thread header live data', () => {
  const span = (extra: Record<string, unknown>) => ({
    parent: null,
    name: 'step',
    start: 1,
    end: 2,
    status: 'ok',
    timing: 'native',
    ...extra,
  });
  const traced = (spans: unknown[]) =>
    bridge.query!.mockImplementation(async (method: string) =>
      method === 'session.trace'
        ? { ok: true, value: { lane: { key: 'session-a' }, spans } }
        : { ok: true, value: null },
    );

  it('sums the tokens of every turn in the trace', async () => {
    traced([
      span({ id: 'turn-a', turn: 'turn-a', kind: 'turn', tokens: { input: 1000, output: 500 } }),
      span({ id: 'turn-b', turn: 'turn-b', kind: 'turn', status: 'running', end: null }),
      span({ id: 'llm-1', turn: 'turn-b', kind: 'llm', tokens: { input: 3000, output: 1500 } }),
      span({ id: 'llm-2', turn: 'turn-b', kind: 'llm', tokens: { input: 2000, output: 600 } }),
    ]);
    const tokens = part(header(), 'LiveTokens');
    await tokens.flush();
    expect(bridge.query).toHaveBeenCalledWith('session.trace', {
      project_id: 'project-a',
      lane_key: 'session-a',
    });
    expect(text(tokens.value)).toContain(`${tokenText(8600)} tokens`);
    expect(named(tokens.value, 'Tip').props.content).toBe('输入 6,000，输出 2,600');
    // Focusable, so the keyboard can open the tip too.
    expect(named(tokens.value, 'Tip').props.children.props.tabIndex).toBe(0);
  });

  it('shows no tokens while the trace has none', async () => {
    traced([]);
    const tokens = part(header(), 'LiveTokens');
    await tokens.flush();
    expect(tokens.value).toBeNull();
  });

  it('shows the git changes of the session', () => {
    const h = header({
      listed: listed('idle', { changes: { files: 2, additions: 12, deletions: 0 } }),
    });
    expect(text(h.value)).toContain('+12');
    expect(text(h.value)).toContain('−0');
    expect(named(h.value, 'DiffCounts').props).toEqual({ additions: 12, deletions: 0 });
    const changes = find(h.value, (n) => n.props?.className === 'sh-diff');
    expect(changes.props.tabIndex).toBe(0);
    expect(text(header({ listed: listed('idle', { changes: null }) }).value)).not.toContain('+');
  });
});

describe('thread header checks', () => {
  const checks = (gate: WorkbenchSession['gate']) =>
    find(
      header({ listed: listed('ready', { gate }) }).value,
      (n) => n.props.className === 'sh-gate',
    );

  it.each([
    ['stale', zh('sessions.screen.gateStale')],
    ['cancelled', zh('sessions.screen.gateCancelled')],
    ['cancelling', zh('sessions.screen.gateCancelling')],
  ] as const)('names a %s run beside its counts', (state, name) => {
    const gate = checks({ state, passed: 3, failed: 0, running: 0 });
    expect(gate.props['aria-label']).toContain(name);
    expect(gate.props['aria-label']).toContain('检查通过 3 / 3');
    expect(named(gate, 'GateMark').props.gate.state).toBe(state);
  });

  it('gives a passed run only its counts', () => {
    const gate = checks({ state: 'passed', passed: 3, failed: 0, running: 0 });
    expect(gate.props['aria-label']).toBe('检查通过 3 / 3');
    expect(nodes(gate).some((n) => (n.type as any)?.name === 'GateMark')).toBe(false);
  });
});

describe('thread header layout', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../apps/web/src/screens/sessions/header.css', import.meta.url)),
    'utf8',
  );
  const rule = (selector: string) =>
    new RegExp(`(^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2] ?? '';

  it('lets the branch and device chips shrink and cut their names', () => {
    for (const chip of ['.sh-chip', '.sh-dev']) {
      expect(rule(chip)).toMatch(/flex: 0 1 auto;/);
      expect(rule(chip)).toMatch(/min-width: 0;/);
    }
    const h = header({
      listed: listed('idle', { device_id: 'build-box', branch: 'feature/long-name' }),
    });
    for (const name of ['build-box', 'feature/long-name']) {
      const cut = find(h.value, (n) => n.props.className === 'sh-cut' && text(n) === name);
      expect(cut).toBeTruthy();
    }
  });
});

describe('thread header open items', () => {
  const OPEN = [
    zh('sessions.rowMenu.editor'),
    zh('sessions.rowMenu.terminal'),
    zh('sessions.rowMenu.finder'),
    zh('sessions.model.menu.copyWorktreePath'),
  ];
  const opens = (h: HookHost<any>) => part(h, 'MoreMenu');

  it('opens the worktree of an ended merged session', async () => {
    const h = opens(header({ listed: listed('merged') }));
    for (const label of OPEN) expect(item(h, label).props.disabled).toBe(false);
    for (const label of OPEN) item(h, label).props.onClick();
    await h.flush();
    expect(bridge.openInEditor).toHaveBeenCalledWith('workspace-a');
    expect(bridge.openInTerminal).toHaveBeenCalledWith('workspace-a');
    expect(bridge.revealPath).toHaveBeenCalledWith('/work/a');
    expect(clipboard).toHaveBeenCalledWith('/work/a');
  });

  it('turns every open item off once the worktree is discarded', () => {
    const h = opens(header({ listed: listed('discarded') }));
    for (const label of OPEN) expect(item(h, label).props.disabled).toBe(true);
  });
});

describe('thread header title and more menu', () => {
  it('shows a baseline title as text and turns its rename off', () => {
    const h = header({
      session: session({ workspace_id: undefined, baseline: { baseline_id: 'baseline-a' } }),
      listed: listed('done', { workspace_id: null }),
    });
    expect(
      nodes(h.value).some(
        (n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.screen.editTitle'),
      ),
    ).toBe(false);
    expect(nodes(h.value).some((n) => n.type === 'h1' && text(n) === 'Release notes')).toBe(true);
    const more = part(h, 'MoreMenu');
    expect(item(more, zh('sessions.model.menu.rename')).props.disabled).toBe(true);
    expect(
      nodes(more.value).some(
        (n) =>
          typeof n.type === 'function' && n.type.name === 'Tip' && /摸底/.test(n.props.content),
      ),
    ).toBe(true);
  });

  it('renames a worktree session from its title and from the more menu', async () => {
    const h = header();
    expect(
      nodes(h.value).some(
        (n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.screen.editTitle'),
      ),
    ).toBe(true);
    const title = find(h.value, (n) => n.type === 'h1');
    expect(nodes(title).some((n) => n.type === 'button' && text(n) === 'Release notes')).toBe(true);
    const more = part(h, 'MoreMenu');
    expect(item(more, zh('sessions.model.menu.rename')).props.disabled).toBe(false);
    item(more, zh('sessions.model.menu.rename')).props.onClick();
    await more.flush();
    await h.flush();
    expect(
      nodes(h.value).some(
        (n) => n.type === 'input' && n.props['aria-label'] === zh('sessions.screen.sessionTitle'),
      ),
    ).toBe(true);
  });

  const baseline = (extra: Partial<Session> = {}) =>
    header({
      session: session({
        state: 'closed',
        workspace_id: undefined,
        baseline: { baseline_id: 'baseline-a' },
        ...extra,
      }),
      listed: listed('done', { workspace_id: null }),
    });
  const offers = (h: HookHost<any>, label: string) =>
    nodes(part(h, 'MoreMenu').value).some(
      (n) =>
        typeof n.type !== 'string' && typeof n.props.onClick === 'function' && text(n) === label,
    );

  it('moves the discard of an ended baseline into the more menu', () => {
    const h = baseline();
    expect(offers(h, zh('sessions.model.menu.discard'))).toBe(true);
    expect(button(h, zh('sessions.parts.discard'))).toBeUndefined();
  });

  it.each([
    { state: 'running' },
    { state: 'reconciling' },
    { stop_pending: true },
    { process_identity: { pid: 123 } },
  ] as Partial<Session>[])(
    'leaves baseline discard out while termination is unconfirmed: %j',
    (active) => {
      expect(offers(baseline(active), zh('sessions.model.menu.discard'))).toBe(false);
    },
  );

  it('offers the discard of a live worktree session in the more menu and confirms it', async () => {
    const h = header({ listed: listed('ready') });
    expect(button(h, zh('sessions.parts.discard'))).toBeUndefined();
    const more = part(h, 'MoreMenu');
    item(more, zh('sessions.model.menu.discard')).props.onClick();
    await more.flush();
    await h.flush();
    const dialog = named(h.value, 'DiscardDialog');
    expect(dialog.props.open).toBe(true);
    expect(dialog.props.description).toBeUndefined();
    const confirm = mount(() => (dialog.type as (props: unknown) => ReactNode)(dialog.props));
    find(
      confirm.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.parts.discard'),
    ).props.onClick();
    await confirm.flush();
    expect(commands).toMatchObject([
      { type: 'session.discard', input: { session_id: 'session-a' } },
    ]);
  });

  it.each(['merged', 'discarded'] as const)('offers no discard of a %s session', (state) => {
    expect(offers(header({ listed: listed(state) }), zh('sessions.model.menu.discard'))).toBe(
      false,
    );
  });

  it('keeps the row menu items in the more menu', () => {
    const more = part(header({ listed: listed('merged') }), 'MoreMenu');
    for (const label of [
      zh('sessions.model.menu.pin'),
      zh('sessions.model.menu.archive'),
      zh('sessions.model.menu.delete'),
    ])
      expect(item(more, label)).toBeTruthy();
  });
});

describe('thread header panel toggles', () => {
  const toggle = (h: HookHost<any>, label: string) =>
    nodes(h.value).find((n) => n.type === 'button' && n.props['aria-label'] === label)!;

  it('closes the open panel from its pressed toggle, with no details button', () => {
    const onPanel = vi.fn();
    const open = header({ panels: ['changes'], onPanel });
    expect(button(open, zh('sessions.screen.details'))).toBeUndefined();
    expect(toggle(open, zh('sessions.screen.tabChanges')).props['aria-pressed']).toBe(true);
    toggle(open, zh('sessions.screen.tabChanges')).props.onClick();
    expect(onPanel).toHaveBeenCalledExactlyOnceWith('changes');
    expect(
      toggle(header({ panels: [], onPanel }), zh('sessions.screen.tabChanges')).props[
        'aria-pressed'
      ],
    ).toBe(false);
  });

  const tipOf = (h: HookHost<any>, label: string) =>
    find(
      h.value,
      (n) =>
        typeof n.type === 'function' &&
        n.type.name === 'Tip' &&
        n.props.children.props['aria-label'] === label,
    ).props.content;

  it('draws every panel toggle for a session without a worktree and turns off what it lacks', () => {
    bridge.browserOpen = vi.fn();
    const onPanel = vi.fn();
    const h = header({ listed: listed('done', { workspace_id: null }), panels: [], onPanel });
    const toolbar = find(h.value, (n) => n.props.role === 'toolbar');
    expect(
      nodes(toolbar)
        .filter((n) => n.type === 'button')
        .map((n) => n.props['aria-label']),
    ).toEqual([
      zh('sessions.screen.tabChanges'),
      zh('sessions.screen.tabChecks'),
      zh('sessions.panel.dock.plan'),
      zh('sessions.panel.dock.browser'),
      zh('sessions.panel.dock.trace'),
      zh('sessions.panel.dock.monitor'),
    ]);
    for (const [label, reason] of [
      [zh('sessions.screen.tabChanges'), zh('sessions.header.readOnly')],
      [zh('sessions.screen.tabChecks'), zh('sessions.header.ungated')],
    ]) {
      expect(toggle(h, label!).props['aria-disabled']).toBe('true');
      expect(tipOf(h, label!)).toBe(reason);
      toggle(h, label!).props.onClick?.();
    }
    expect(onPanel).not.toHaveBeenCalled();
    for (const label of ['plan', 'browser', 'trace', 'monitor'].map((p) =>
      zh(`sessions.panel.dock.${p}`),
    ))
      expect(toggle(h, label).props['aria-disabled']).toBeUndefined();
    toggle(h, zh('sessions.panel.dock.plan')).props.onClick();
    expect(onPanel).toHaveBeenCalledExactlyOnceWith('plan');
  });

  it("shows the branch of the project's first folder for a session without a worktree", async () => {
    bridge.query!.mockImplementation(async (method: string) =>
      method === 'project.facts.read'
        ? {
            ok: true,
            value: {
              workstreams: [],
              facts: {
                folders: [
                  { root: '/src/a', branch: 'main' },
                  { root: '/src/b', branch: 'other' },
                ],
              },
            },
          }
        : { ok: true, value: null },
    );
    const h = header({ listed: listed('done', { workspace_id: null }) });
    await h.flush();
    const shown = nodes(h.value)
      .filter((n) => n.type === 'span')
      .map(text);
    expect(shown).toContain('main');
    expect(shown).not.toContain('other');
  });

  it('toggles the first panel with ⌥⌘B, which the desktop menu sends as its details item', () => {
    const onPanel = vi.fn();
    header({ onPanel });
    const e = {
      key: '∫',
      code: 'KeyB',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    for (const listener of [...listeners]) listener(e);
    expect(onPanel).not.toHaveBeenCalled();
    runShortcut('details');
    expect(onPanel).toHaveBeenCalledExactlyOnceWith('changes');
  });
});
