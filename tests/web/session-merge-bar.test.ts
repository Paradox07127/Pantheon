import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ChangeStory, Review, ReviewFinding, Session } from '@pantheon/domain';
import type {
  SessionDiff,
  SessionGates,
  SessionGatesHistory,
  SessionPreflight,
  WorkbenchSession,
} from '@pantheon/protocol';
import type { FeedbackItem } from '@/data/feedback';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  preflight: null as SessionPreflight | null,
  preflightError: null as string | null,
  gates: null as SessionGates | null,
  history: null as SessionGatesHistory | null,
  feedback: {} as Record<string, FeedbackItem[]>,
  reloads: 0,
  stories: { read: [] as ChangeStory[] | null, error: null as string | null, reloads: 0 },
  toasts: [] as unknown[],
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => {
    mock.toasts.push(options);
    return 'toast';
  },
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'story' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: Object.assign((selector: any) => selector({ items: mock.feedback }), {
    getState: () => ({
      clear: (sessionId: string, ids: readonly string[]) => {
        mock.feedback[sessionId] = (mock.feedback[sessionId] ?? []).filter(
          (item) => !ids.includes(item.id),
        );
      },
    }),
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: null, error: null, reload: () => {} }),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => ({ data: mock.gates, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: [], error: null, reload: () => {} }),
  useSessionPreflight: () => ({
    data: mock.preflight,
    error: mock.preflightError,
    reload: () => void mock.reloads++,
  }),
  useSessionGatesHistory: () => ({ data: mock.history, error: null, reload: () => {} }),
}));
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => ({
    read: mock.stories.read,
    error: mock.stories.error,
    reload: () => void mock.stories.reloads++,
  }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({
    read: null,
    error: null,
    loading: false,
    unavailable: false,
    reload() {},
  }),
}));
import { t } from '@/i18n';
import { RunningFor } from '@/components/RunningFor';
import { runtimeName } from '@/components/RuntimeGlyph';
import { failureText } from '@/data/needs-you';
import { SessionInspector } from '@/screens/sessions/SessionsScreen';
import { ChecksTab, MergeBar, ReviewTab, StoryTab } from '@/screens/sessions/panel';
import { StoryView } from '@/screens/sessions/story/StoryView';

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'ready',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
};
const session: Session = {
  id: 'session-a',
  revision: 4,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
};
const preflight = (extra: Partial<SessionPreflight> = {}): SessionPreflight => ({
  target_branch: 'release',
  source_root: '/repo',
  commit_count: 3,
  files_changed: 5,
  worktree_clean: true,
  source_clean: true,
  conflicts: { state: 'none' },
  gate: { configured_total: 2, last: 'passed' },
  can_merge: true,
  ...extra,
});
const passed: SessionGates = {
  configured: true,
  running: false,
  last: {
    commit: 'abcdef1234567890',
    checked_at: 1,
    results: [
      { name: 'Lint', exit_code: 0, timed_out: false, output_tail: '' },
      { name: 'Unit tests', exit_code: 0, timed_out: false, output_tail: '' },
    ],
  },
};

const blocked = (key: string) => zh(`sessions.panel.blocked.${key}`);
const lastGate = (key: string) => zh(`sessions.panel.lastGate.${key}`);
const gatesRerun = zh('sessions.panel.mergeDialog.gatesRerun');
const checkStatus = (gate: string, passed: number, total: number) =>
  t(
    {
      id: 'sessions.panel.merge.checkStatus',
      defaultMessage: 'Check status {gate} {passed}/{total}',
    },
    { gate: zh(`sessions.panel.gate.${gate}`), passed, total },
  );
const mergeLabel = zh('sessions.panel.merge.merge');
const rerun = zh('sessions.mergeBar.rerun');

let commands: { type: string; input: unknown }[];
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let tabs: string[];

beforeEach(() => {
  commands = [];
  tabs = [];
  mock.preflight = preflight();
  mock.preflightError = null;
  mock.gates = passed;
  mock.history = null;
  mock.feedback = {};
  mock.reloads = 0;
  mock.stories = { read: [], error: null, reloads: 0 };
  mock.toasts = [];
  mock.board = {
    board: {
      cursor: 1,
      sessions: [session],
      session_turns: [],
      projects: [],
      workspaces: [{ id: 'workspace-a', source: '/repo', path: '/work/worktrees/release-notes' }],
    },
    events: [],
    status: { state: 'live' },
    refresh() {},
  };
  const ok = async () => ({ ok: true, value: null });
  bridge = {
    command: vi.fn(async (command: any) => {
      commands.push(command);
      return { ok: true, value: {} };
    }),
    query: vi.fn(ok),
    revealPath: vi.fn(ok),
  };
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

let inspectorHost: HookHost<any>;
/** The merge bar of the inspector, rendered with the props the inspector gives it on each render. */
function bar(row: WorkbenchSession = listed, from: Session = session) {
  inspectorHost = mount(() =>
    SessionInspector({
      sessionId: 'session-a',
      listed: row,
      session: from,
      panels: ['changes'],
      onOpen: (tab) => tabs.push(tab),
      onClose() {},
      onView: () => {},
    }),
  );
  return mount(() => {
    const element = named(inspectorHost.value, 'MergeBar');
    return (element.type as (props: unknown) => ReactNode)(element.props);
  });
}
const merge = (h: HookHost<any>): ReactElement<any> =>
  find(h.value, (n) => n.type === 'button' && n.props.className === 'btn pri');
const described = (h: HookHost<any>, button: ReactElement<any>) =>
  text(find(h.value, (n) => n.props.id === button.props['aria-describedby']));
const dialog = (h: HookHost<any>) =>
  mount(() => {
    const element = named(h.value, 'MergeDialog');
    return (element.type as (props: unknown) => ReactNode)(element.props);
  });
/** Hands a fresh preflight read to the inspector and renders the bar and its dialog again. */
const reread = (next: SessionPreflight, h: HookHost<any>, d: HookHost<any>) => {
  mock.preflight = next;
  inspectorHost.render();
  h.render();
  d.render();
};
const confirmButton = (d: HookHost<any>): ReactElement<any> =>
  find(d.value, (n) => n.type === 'button' && text(n) === zh('sessions.panel.mergeDialog.merge'));
const opensSource = (h: HookHost<any>) =>
  nodes(h.value).find(
    (n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.panel.merge.openSource'),
  );
const gateButton = (h: HookHost<any>): ReactElement<any> =>
  find(
    h.value,
    (n) =>
      n.type === 'button' &&
      String(n.props['aria-label']).startsWith(
        zh('sessions.panel.merge.checkStatus').split('{')[0]!,
      ),
  );

describe('merge bar blocked', () => {
  it.each([
    [{ commit_count: 0, blocked_reason: 'no_changes' }, 'noChanges'],
    [{ worktree_clean: false, blocked_reason: 'uncommitted_changes' }, 'uncommitted'],
    [{ target_branch: null, blocked_reason: 'source_detached' }, 'sourceDetached'],
  ])('turns the merge button off with the reason: %#', (extra, reason) => {
    mock.preflight = preflight({ ...extra, can_merge: false });
    const h = bar();
    const button = merge(h);
    expect(button.props['aria-disabled']).toBe(true);
    expect(button.props.onClick).toBeUndefined();
    expect(described(h, button)).toBe(blocked(reason));
    expect(find(h.value, (n) => n.props.id === button.props['aria-describedby']).props.hidden).toBe(
      undefined,
    );
    expect(opensSource(h)).toBeUndefined();
  });

  it('turns the merge button off with a general reason when the preflight names none', () => {
    mock.preflight = preflight({ can_merge: false });
    const h = bar();
    const button = merge(h);
    expect(button.props['aria-disabled']).toBe(true);
    expect(button.props.onClick).toBeUndefined();
    expect(described(h, button)).toBe(blocked('notReady'));
  });

  it('names the reason beside the merge button of a detached source', () => {
    mock.preflight = preflight({
      target_branch: null,
      can_merge: false,
      blocked_reason: 'source_detached',
    });
    const h = bar();
    expect(text(merge(h))).toBe(mergeLabel);
    expect(described(h, merge(h))).toBe(blocked('sourceDetached'));
  });

  it('keeps the merge label of a source without a branch when the preflight names no reason', () => {
    mock.preflight = preflight({ target_branch: null });
    expect(text(merge(bar()))).toBe(mergeLabel);
  });

  it('turns the merge button off for a dirty source and offers to open it', async () => {
    mock.preflight = preflight({
      source_clean: false,
      conflicts: { state: 'none' },
      can_merge: false,
      blocked_reason: 'source_dirty',
    });
    const h = bar();
    const button = merge(h);
    expect(button.props['aria-disabled']).toBe(true);
    expect(described(h, button)).toBe(blocked('sourceDirty'));
    opensSource(h)!.props.onClick();
    await h.flush();
    expect(bridge.revealPath).toHaveBeenCalledWith('/repo');
  });
});

describe('merge bar gate', () => {
  it.each([
    ['none', 'none'],
    ['stale', 'stale'],
    ['failed', 'failed'],
  ] as const)('keeps merge on with a %s gate and says so in the dialog', async (last, said) => {
    mock.preflight = preflight({ gate: { configured_total: 2, last } });
    const h = bar();
    const button = merge(h);
    expect(button.props['aria-disabled']).toBeFalsy();
    expect(button.props.disabled).toBeFalsy();
    button.props.onClick();
    await h.flush();
    const d = dialog(h);
    reread(preflight({ gate: { configured_total: 2, last } }), h, d);
    const shown = text(d.value);
    expect(shown).toContain(lastGate(said));
    expect(shown).toContain(gatesRerun);
  });

  it('shows the passed gates of the configured total and opens the checks tab', () => {
    mock.gates = {
      ...passed,
      last: {
        ...passed.last!,
        results: [
          passed.last!.results[0]!,
          { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '' },
        ],
      },
    };
    mock.preflight = preflight({ gate: { configured_total: 3, last: 'failed' } });
    const checks = gateButton(bar());
    expect(text(checks)).toContain('1 通过，1 失败，1 跳过');
    checks.props.onClick();
    expect(tabs).toEqual(['checks']);
  });

  const ran = (...exits: number[]): SessionGates => ({
    ...passed,
    last: {
      ...passed.last!,
      results: exits.map((exit_code, i) => ({ ...passed.last!.results[i]!, exit_code })),
    },
  });
  it.each([
    [
      'counts every configured command as passed while the results of a current passed run are read',
      null,
      { configured_total: 2, last: 'passed' },
      ['passed', 2, 2],
      null,
    ],
    [
      'counts no results of another run while the preflight finds a passed run',
      ran(0, 1),
      { configured_total: 2, last: 'passed' },
      ['passed', 2, 2],
      null,
    ],
    [
      'counts no results of another run while the preflight finds a failed run',
      ran(0, 0),
      { configured_total: 2, last: 'failed' },
      ['failed', 0, 2],
      null,
    ],
    [
      'counts the configured commands before the first gate run',
      { configured: true, running: false, last: null },
      { configured_total: 1, last: 'none' },
      ['none', 0, 1],
      zh('sessions.panel.gate.none'),
    ],
    [
      'counts the last run over its own commands once the configuration changed',
      passed,
      { configured_total: 3, last: 'stale' },
      ['stale', 2, 2],
      '2 通过',
    ],
  ] as const)('%s', (_name, gates, gate, [state, passedCount, total], shows) => {
    mock.gates = gates as SessionGates | null;
    mock.preflight = preflight({ gate });
    const checks = gateButton(bar());
    expect(checks.props['aria-label']).toBe(checkStatus(state, passedCount, total));
    if (shows) expect(text(checks)).toContain(shows);
  });
});

describe('merge dialog', () => {
  it('reads the preflight again when the confirmation opens', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    expect(mock.reloads).toBe(1);
  });

  it('leaves out the gate rerun line when the project has no gate commands', async () => {
    mock.gates = { configured: false, running: false, last: null };
    mock.preflight = preflight({ gate: { configured_total: 0, last: 'none' } });
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    reread(preflight({ gate: { configured_total: 0, last: 'none' } }), h, d);
    const shown = text(d.value);
    expect(shown).toContain(lastGate('none'));
    expect(shown).not.toContain(gatesRerun);
  });

  it('names the target branch on the button', () => {
    expect(text(merge(bar()))).toBe(
      t(
        { id: 'sessions.panel.merge.mergeInto', defaultMessage: 'Merge into {target}…' },
        { target: 'release' },
      ),
    );
  });

  it('shows the route, counts and a passed gate', async () => {
    const h = bar();
    expect(named(h.value, 'MergeDialog').props.open).toBe(false);
    merge(h).props.onClick();
    await h.flush();
    expect(named(h.value, 'MergeDialog').props.open).toBe(true);
    const d = dialog(h);
    reread(preflight(), h, d);
    const shown = text(d.value);
    expect(shown).toContain('Release notes');
    expect(shown).not.toContain('release-notes');
    expect(shown).toContain('release');
    expect(shown).toContain('3');
    expect(shown).toContain('5');
    expect(shown).toContain(lastGate('passed'));
    expect(shown).toContain(gatesRerun);
  });

  it('sends the merge command once on confirm', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    expect(commands).toEqual([]);
    const d = dialog(h);
    reread(preflight(), h, d);
    confirmButton(d).props.onClick();
    await d.flush();
    await h.flush();
    expect(named(h.value, 'MergeDialog').props.open).toBe(false);
    expect(commands).toMatchObject([
      { type: 'session.merge', input: { session_id: 'session-a' }, expected_revision: 4 },
    ]);
  });

  it('stays open with merge off when the preflight read fails, and takes the next read', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    mock.preflight = null;
    inspectorHost.render();
    h.render();
    expect(named(h.value, 'MergeDialog').props.open).toBe(true);
    d.render();
    expect(confirmButton(d).props.disabled).toBe(true);
    expect(text(find(d.value, (n) => n.props.role === 'alert'))).toBe(
      zh('sessions.panel.mergeDialog.readFailed'),
    );
    reread(preflight(), h, d);
    expect(named(h.value, 'MergeDialog').props.open).toBe(true);
    expect(nodes(d.value).some((n) => n.props.role === 'alert')).toBe(false);
    expect(confirmButton(d).props.disabled).toBe(false);
  });

  it('says why the preflight read failed in the open confirmation', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    mock.preflight = null;
    mock.preflightError = 'The daemon did not answer';
    inspectorHost.render();
    h.render();
    d.render();
    expect(text(find(d.value, (n) => n.props.role === 'alert'))).toBe('The daemon did not answer');
  });

  it('shows the counts as loading until the preflight read on opening arrives', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    const list = () => find(d.value, (n) => n.type === 'dl');
    expect(list().props['aria-busy']).toBe(true);
    expect(text(list())).not.toContain(lastGate('passed'));
    reread(preflight({ commit_count: 7 }), h, d);
    expect(list().props['aria-busy']).toBeUndefined();
    expect(text(list())).toContain('7');
  });

  it('keeps merge off until the preflight read on opening arrives', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    expect(confirmButton(d).props.disabled).toBe(true);
    confirmButton(d).props.onClick();
    await d.flush();
    expect(commands).toEqual([]);
    reread(preflight(), h, d);
    expect(confirmButton(d).props.disabled).toBe(false);
  });

  it('turns merge off and asks to reopen once the preflight differs from the one confirmed', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    reread(preflight(), h, d);
    reread(preflight({ commit_count: 4 }), h, d);
    expect(confirmButton(d).props.disabled).toBe(true);
    expect(text(find(d.value, (n) => n.props.role === 'alert'))).toBe(
      zh('sessions.panel.mergeDialog.changed'),
    );
    expect(text(d.value)).toContain('3');
    confirmButton(d).props.onClick();
    await d.flush();
    expect(commands).toEqual([]);
  });

  it('turns merge off with the reason when the preflight read on opening blocks the merge', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    reread(
      preflight({ source_clean: false, can_merge: false, blocked_reason: 'source_dirty' }),
      h,
      d,
    );
    expect(confirmButton(d).props.disabled).toBe(true);
    expect(text(find(d.value, (n) => n.props.role === 'alert'))).toBe(blocked('sourceDirty'));
    confirmButton(d).props.onClick();
    await d.flush();
    expect(commands).toEqual([]);
  });

  it('keeps merge on when a later read finds the same conditions', async () => {
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    reread(preflight(), h, d);
    reread(preflight(), h, d);
    expect(confirmButton(d).props.disabled).toBe(false);
  });

  it('keeps the dialog open while the merge it sent is pending', async () => {
    bridge.command = vi.fn(() => new Promise(() => {}));
    const h = bar();
    merge(h).props.onClick();
    await h.flush();
    const d = dialog(h);
    reread(preflight(), h, d);
    confirmButton(d).props.onClick();
    await d.flush();
    expect(bridge.command).toHaveBeenCalledOnce();
    const cancel = find(d.value, (n) => text(n) === zh('sessions.panel.mergeDialog.cancel'));
    expect(cancel.props.disabled).toBe(true);
    (d.value as ReactElement<any>).props.onOpenChange(false);
    await h.flush();
    expect(named(h.value, 'MergeDialog').props.open).toBe(true);
  });

  it('turns the merge button off while the session merges', () => {
    const h = bar({ ...listed, state: 'merging' });
    const button = merge(h);
    expect(text(button)).toBe(zh('sessions.panel.merge.merging'));
    expect(button.props.disabled).toBe(true);
    expect(button.props.onClick).toBeUndefined();
  });
});

describe('merge bar readiness', () => {
  const head = 'fedcba9876543210';
  /** The merge bar alone, given the worktree's current commit. */
  const alone = (extra: Record<string, unknown> = {}) =>
    mount(() =>
      MergeBar({
        sessionId: 'session-a',
        revision: 4,
        live: true,
        merging: false,
        preflight: mock.preflight,
        onPreflight: () => void mock.reloads++,
        gates: mock.gates,
        branch: 'main',
        source: 'Release notes',
        onChecks() {},
        listed,
        head: passed.last!.commit,
        ...extra,
      }),
    );
  const button = (h: HookHost<any>, said: string): ReactElement<any> =>
    find(h.value, (n) => n.type === 'button' && text(n) === said);

  it('turns merge off beside the reason when the gates ran on an earlier commit, and reruns them', async () => {
    mock.preflight = preflight({ gate: { configured_total: 2, last: 'stale' } });
    const h = alone({ head });
    const off = merge(h);
    expect(off.props['aria-disabled']).toBe(true);
    expect(off.props.onClick).toBeUndefined();
    expect(described(h, off)).toBe(zh('sessions.mergeBar.earlierCommit'));
    expect(text(h.value)).toContain('abcdef1');
    expect(nodes(h.value).some((n) => n.type === 'span' && n.props.hidden)).toBe(false);
    button(h, rerun).props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      { type: 'session.gates.run', input: { session_id: 'session-a' }, expected_revision: 4 },
    ]);
    expect(mock.reloads).toBe(1);
  });

  it('keeps the gate rerun off until the gates are read again', async () => {
    mock.preflight = preflight({ gate: { configured_total: 2, last: 'stale' } });
    const h = alone({ head });
    button(h, rerun).props.onClick();
    await h.flush();
    expect(button(h, rerun).props.disabled).toBe(true);
    mock.gates = { ...passed };
    h.render();
    expect(button(h, rerun).props.disabled).toBe(false);
  });

  it('counts the commands an out-of-date run never reached as skipped', () => {
    mock.gates = {
      ...passed,
      last: {
        ...passed.last!,
        results: [
          passed.last!.results[0]!,
          { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '' },
        ],
      },
    };
    mock.preflight = preflight({ gate: { configured_total: 3, last: 'stale' } });
    const gate = gateButton(
      alone({
        listed: {
          ...listed,
          gate: {
            state: 'stale',
            passed: 1,
            failed: 1,
            running: 0,
            not_run: 1,
            finished_at: new Date(passed.last!.checked_at).toISOString(),
          },
        },
      }),
    );
    expect(gate.props['aria-label']).toBe(checkStatus('stale', 1, 3));
    expect(text(gate)).toContain('1 通过，1 失败，1 跳过');
  });

  it('keeps merge on and names the commit when the gates ran on the current one', () => {
    const h = alone();
    expect(merge(h).props['aria-disabled']).toBeFalsy();
    expect(text(h.value)).toContain(zh('sessions.mergeBar.currentCommit'));
    expect(text(h.value)).toContain('abcdef1');
    expect(text(h.value)).not.toContain(rerun);
  });

  it('keeps merge on when only the gate commands changed since the run', () => {
    mock.preflight = preflight({ gate: { configured_total: 3, last: 'stale' } });
    expect(merge(alone()).props['aria-disabled']).toBeFalsy();
  });

  it('writes the preflight reason as text beside the merge button', () => {
    mock.preflight = preflight({ commit_count: 0, can_merge: false, blocked_reason: 'no_changes' });
    const h = alone();
    const reason = find(h.value, (n) => n.props.id === merge(h).props['aria-describedby']);
    expect(reason.props.hidden).toBeFalsy();
    expect(text(reason)).toBe(blocked('noChanges'));
    expect(nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'Tip')).toBe(
      false,
    );
  });

  it('counts the skipped gate commands apart from the passed ones', () => {
    mock.gates = {
      ...passed,
      last: {
        ...passed.last!,
        results: [
          passed.last!.results[0]!,
          { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '' },
        ],
      },
    };
    mock.preflight = preflight({ gate: { configured_total: 3, last: 'failed' } });
    expect(text(gateButton(alone()))).toContain('1 通过，1 失败，1 跳过');
    mock.gates = passed;
    mock.preflight = preflight();
    expect(text(gateButton(alone()))).toContain('2 通过');
  });

  it('counts a command skipped after failing apart in a run that passed, not as passed', () => {
    mock.gates = {
      ...passed,
      last: {
        ...passed.last!,
        results: [
          passed.last!.results[0]!,
          {
            name: 'Audit',
            exit_code: 1,
            timed_out: false,
            output_tail: '',
            state: 'skipped',
            reason: 'timeout',
          },
        ],
      },
    };
    const gate = gateButton(alone());
    expect(gate.props['aria-label']).toBe(checkStatus('passed', 1, 2));
    expect(text(gate)).toContain('1 通过，1 跳过');
  });

  it('counts the passed, running and skipped commands while the gates run', () => {
    mock.gates = { ...passed, running: true };
    mock.preflight = preflight({ gate: { configured_total: 4, last: 'stale' } });
    const gate = gateButton(
      alone({
        listed: {
          ...listed,
          gate: { state: 'running', passed: 1, failed: 0, skipped: 1, running: 2 },
        },
      }),
    );
    expect(text(gate)).toContain('1 通过，2 在跑，1 跳过');
    expect(
      nodes(find(gate, (n) => n.props.className === 'ss-pseg').props.children)
        .filter((n) => n.type === 'i')
        .map((n) => [n.props['data-tone'], n.props.style.flexGrow]),
    ).toEqual([
      ['ok', 1],
      ['run', 2],
      ['idle', 1],
    ]);
  });

  it('shows how far the branch is ahead of and behind its target', () => {
    const h = alone({ listed: { ...listed, ahead: 3, behind: 0 } });
    expect(text(h.value)).toContain('相对 release 领先 3，落后 0');
  });

  it('says the merge meets no conflicts, lists the conflicting files on demand, and leaves an unknown state out', async () => {
    expect(text(find(alone().value, (n) => n.props.className === 'ss-mb-cf'))).toBe('冲突无');
    mock.preflight = preflight({ conflicts: { state: 'conflicts', files: ['a.ts', 'b/c.ts'] } });
    const h = alone();
    const row = () =>
      find(h.value, (n) => n.type === 'button' && n.props.className === 'ss-gate ss-mb-cf');
    expect(text(row())).toBe('冲突2 个文件');
    expect(row().props['aria-expanded']).toBe(false);
    expect(() => find(h.value, (n) => n.props.className === 'ss-mb-cfl')).toThrow();
    row().props.onClick();
    await h.flush();
    expect(row().props['aria-expanded']).toBe(true);
    const files = find(h.value, (n) => n.props.className === 'ss-mb-cfl');
    expect(
      nodes(files)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual(['a.ts', 'b/c.ts']);
    mock.preflight = preflight({ conflicts: { state: 'unknown' } });
    expect(text(alone().value)).not.toContain(zh('sessions.mergeBar.conflicts'));
  });

  it('counts the open diff comments after the conflicts and leaves the cell out without any', () => {
    mock.preflight = preflight({ open_comments: 2 });
    const cells = nodes(alone().value).filter((n) => n.props.className === 'ss-mb-cf');
    expect(cells.map((n) => text(n))).toEqual(['冲突无', '评论2 条未处理']);
    mock.preflight = preflight();
    expect(text(alone().value)).not.toContain('未处理');
  });

  it.each([
    { name: 'ends a session', from: session, extra: {}, says: 'consequence' },
    {
      name: 'keeps a lead that lands its direct task',
      from: { ...session, direct_task: { id: 'task-a', generation: 1 } },
      extra: {},
      says: 'directConsequence',
    },
    {
      name: 'says nothing without commits to merge',
      from: session,
      extra: { commit_count: 0, can_merge: false, blocked_reason: 'no_changes' },
      says: null,
    },
  ])('says what merging does: $name', ({ from, extra, says }) => {
    mock.preflight = preflight(extra);
    const said = text(bar(listed, from).value);
    for (const id of ['consequence', 'directConsequence'])
      expect(said.includes(zh(`sessions.mergeBar.${id}`))).toBe(id === says);
  });

  it('sends the attached items for the agent to fix and takes them off', async () => {
    mock.feedback = {
      'session-a': [{ id: 'comment-a', kind: 'comment', label: 'a.ts:3', text: 'Rename this' }],
    };
    const h = alone({ feedback: mock.feedback['session-a'] });
    button(h, '让 agent 修 1 项').props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.send',
        input: { session_id: 'session-a', input: 'Rename this' },
        expected_revision: 4,
      },
    ]);
    expect(mock.feedback['session-a']).toEqual([]);
  });

  it('steers the items into the running turn while the agent waits on the user', async () => {
    mock.board.board.sessions = [{ ...session, state: 'running' }];
    const items: FeedbackItem[] = [
      { id: 'comment-a', kind: 'comment', label: 'a.ts:3', text: 'Rename this' },
    ];
    const h = alone({ listed: { ...listed, state: 'waiting', waiting: 1 }, feedback: items });
    button(h, '让 agent 修 1 项').props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      { type: 'session.steer', input: { session_id: 'session-a', input: 'Rename this' } },
    ]);
  });

  it('marks the sent diff comments and says when one could not be marked', async () => {
    const refused = { code: 'revision_conflict', message: 'The comment changed' };
    bridge.command!.mockImplementation(async (command: any) => {
      commands.push(command);
      return command.type === 'session.comment.resolve'
        ? { ok: false, error: refused }
        : { ok: true, value: {} };
    });
    const items: FeedbackItem[] = [
      {
        id: 'comment-a',
        kind: 'comment',
        label: 'a.ts:3',
        text: 'Rename this',
        comment: { id: 'stored-a', revision: 2 },
      },
    ];
    const h = alone({ feedback: items });
    button(h, '让 agent 修 1 项').props.onClick();
    await h.flush();
    await h.flush();
    expect(commands).toMatchObject([
      { type: 'session.send' },
      {
        type: 'session.comment.resolve',
        input: { comment_id: 'stored-a', state: 'sent' },
        expected_revision: 2,
      },
    ]);
    expect(mock.toasts).toEqual([{ title: failureText(refused), kind: 'failure' }]);
  });

  it('opens the discard confirmation from the merge bar', async () => {
    const h = alone();
    expect(named(h.value, 'DiscardDialog').props.open).toBe(false);
    button(h, zh('sessions.mergeBar.discard')).props.onClick();
    await h.flush();
    expect(named(h.value, 'DiscardDialog').props).toMatchObject({
      open: true,
      sessionId: 'session-a',
      title: 'Release notes',
    });
  });
});

describe('checks tab history', () => {
  it('hands the session gate history it reads to the checks tab', () => {
    mock.history = { runs: [] };
    const inspector = mount(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed,
        session,
        panels: ['checks'],
        onOpen() {},
        onClose() {},
        onView: () => {},
      }),
    );
    expect(named(inspector.value, 'ChecksTab').props.history.data).toBe(mock.history);
  });
});

describe('checks tab rerun of the failed commands', () => {
  const failing: SessionGates = {
    ...passed,
    last: {
      ...passed.last!,
      results: [
        passed.last!.results[0]!,
        { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '' },
      ],
    },
  };
  const tab = (gates: SessionGates, reload = () => {}) =>
    mount(() =>
      ChecksTab({
        sessionId: 'session-a',
        revision: 4,
        gates: { data: gates, error: null, reload },
        readOnly: false,
        merging: false,
        busy: false,
        attached: new Set<string>(),
        onAttach() {},
        onRun() {},
        onSettings() {},
      }),
    );
  const onlyFailed = (h: HookHost<any>) =>
    nodes(h.value).find(
      (n) => n.type === 'button' && text(n) === zh('sessions.panel.checks.rerunFailed'),
    );

  it('offers no rerun of the failed commands when the only one not passed was skipped', () => {
    const skipped: SessionGates = {
      ...passed,
      last: {
        ...passed.last!,
        results: [
          passed.last!.results[0]!,
          {
            name: 'Audit',
            exit_code: 1,
            timed_out: false,
            output_tail: '',
            state: 'skipped',
            reason: 'timeout',
          },
        ],
      },
    };
    expect(onlyFailed(tab(skipped))).toBeUndefined();
  });

  it('reruns only the failed commands, offered only after a failure', async () => {
    expect(onlyFailed(tab(passed))).toBeUndefined();
    const reload = vi.fn();
    const h = tab(failing, reload);
    onlyFailed(h)!.props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.gates.run',
        input: { session_id: 'session-a', only_failed: true },
        expected_revision: 4,
      },
    ]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps the rerun of the failed commands off until the gates are read again', async () => {
    let gates = failing;
    const h = mount(() =>
      ChecksTab({
        sessionId: 'session-a',
        revision: 4,
        gates: { data: gates, error: null, reload() {} },
        readOnly: false,
        merging: false,
        busy: false,
        attached: new Set<string>(),
        onAttach() {},
        onRun() {},
        onSettings() {},
      }),
    );
    onlyFailed(h)!.props.onClick();
    await h.flush();
    expect(onlyFailed(h)!.props.disabled).toBe(true);
    gates = { ...failing };
    h.render();
    expect(onlyFailed(h)!.props.disabled).toBe(false);
  });

  it('says why a rerun of the failed commands was refused', async () => {
    bridge.command!.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'gate_retry_unavailable',
        message: 'Retrying failed gates requires the same HEAD and a clean worktree',
      },
    });
    const h = tab(failing);
    onlyFailed(h)!.props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain(
      zh('data.reason.gateRetryUnavailable'),
    );
  });
});

const finding = (extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'finding-a',
  review_id: 'review-a',
  runtime: 'codex',
  round: 1,
  location: 'src/gone.ts:9',
  quote: 'return answer;',
  evidence: 'the line was removed',
  impact: 'Returns the wrong answer',
  status: 'open',
  blocking: false,
  ...extra,
});
const review = (extra: Partial<Review> = {}): Review => ({
  id: 'review-a',
  revision: 3,
  project_id: 'project-a',
  session_id: 'session-a',
  round: 1,
  runtimes: ['codex'],
  state: 'completed',
  findings: [finding()],
  session_ids: [],
  ...extra,
});

describe('review tab', () => {
  const reviews = { data: null as Review[] | null, error: null, reload: vi.fn() };
  const tab = () =>
    mount(() =>
      ReviewTab({
        sessionId: 'session-a',
        runtime: 'claude',
        reviews,
        files: [],
        readOnly: false,
        attached: new Set(),
        onAttach() {},
      }),
    );
  const requestButton = (h: HookHost<any>): ReactElement<any> =>
    find(h.value, (n) => n.type === 'button' && text(n).startsWith('请 '));
  beforeEach(() => {
    reviews.data = [];
    reviews.reload = vi.fn();
  });

  it('keeps the request off until the reviews are read', () => {
    reviews.data = null;
    expect(requestButton(tab()).props.disabled).toBe(true);
  });

  it('keeps the request off until the read reviews hold the accepted one', async () => {
    bridge.command!.mockImplementation(async (command: any) => {
      commands.push(command);
      return { ok: true, value: { review_id: 'review-new' } };
    });
    const h = tab();
    requestButton(h).props.onClick();
    await h.flush();
    expect(reviews.reload).toHaveBeenCalled();
    expect(requestButton(h).props.disabled).toBe(true);
    reviews.data = [review({ id: 'review-new', findings: [] })];
    h.render();
    expect(requestButton(h).props.disabled).toBe(false);
    expect(commands.filter((c) => c.type === 'review.request')).toHaveLength(1);
  });

  it('says the newest review failed and keeps the request on to retry it', () => {
    reviews.data = [
      review({ id: 'review-old', round: 1 }),
      review({ id: 'review-b', round: 2, state: 'failed', findings: [] }),
    ];
    const h = tab();
    expect(named(h.value, 'ReviewCoverage').props.review).toMatchObject({
      id: 'review-b',
      state: 'failed',
    });
    expect(requestButton(h).props.disabled).toBe(false);
    reviews.data = [review({ id: 'review-b', round: 2, findings: [] })];
    h.render();
    expect(named(h.value, 'ReviewCoverage').props.review.state).toBe('completed');
  });

  it('adopts or dismisses a finding that has no place in the diff', async () => {
    reviews.data = [review()];
    const h = tab();
    const finding = (outcome: 'adopt' | 'dismiss', label: string) =>
      find(
        h.value,
        (n) =>
          n.props['aria-label'] ===
          t(
            { id: `sessions.panel.review.${outcome}Label`, defaultMessage: `${label}: {impact}` },
            { impact: 'Returns the wrong answer' },
          ),
      );
    finding('adopt', 'Adopt').props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      {
        type: 'review.finding.resolve',
        input: { review_id: 'review-a', finding_id: 'finding-a', outcome: 'adopted' },
        expected_revision: 3,
      },
    ]);
    expect(reviews.reload).toHaveBeenCalled();
    reviews.data = [review({ revision: 4 })];
    h.render();
    finding('dismiss', 'Dismiss').props.onClick();
    await h.flush();
    expect(commands[1]).toMatchObject({ input: { outcome: 'dismissed' }, expected_revision: 4 });
  });

  it('keeps the other findings off until the reviews read holds the one resolved', async () => {
    const other = finding({ id: 'finding-b', impact: 'Leaks a handle' });
    reviews.data = [review({ findings: [finding(), other] })];
    const h = tab();
    const control = (outcome: 'adopt' | 'dismiss', label: string, impact: string) =>
      find(
        h.value,
        (n) =>
          n.props['aria-label'] ===
          t(
            { id: `sessions.panel.review.${outcome}Label`, defaultMessage: `${label}: {impact}` },
            { impact },
          ),
      );
    control('adopt', 'Adopt', 'Returns the wrong answer').props.onClick();
    await h.flush();
    expect(control('dismiss', 'Dismiss', 'Leaks a handle').props.disabled).toBe(true);
    reviews.data = [review({ revision: 4, findings: [finding(), other] })];
    h.render();
    expect(control('dismiss', 'Dismiss', 'Leaks a handle').props.disabled).toBe(false);
  });
});

describe('checks tab without gate commands', () => {
  it('still shows the external review row', () => {
    const h = mount(() =>
      ChecksTab({
        sessionId: 'session-a',
        revision: 4,
        gates: {
          data: { configured: false, running: false, last: null },
          error: null,
          reload() {},
        },
        readOnly: false,
        merging: false,
        busy: false,
        attached: new Set<string>(),
        onAttach() {},
        onRun() {},
        onSettings() {},
        reviews: [review()],
      }),
    );
    const shown = text(h.value);
    expect(shown).toContain(zh('sessions.panel.checks.noGates'));
    expect(shown).toContain(zh('sessions.panel.checks.externalReview'));
  });
});

describe('story view', () => {
  const story: ChangeStory = {
    id: 'story-a',
    revision: 1,
    project_id: 'project-a',
    workbench_session_id: 'session-a',
    source: '/repo',
    from_sha: '0123456789abcdef',
    to_sha: 'fedcba9876543210',
    state: 'ready',
    created_at: 1,
    result: {
      overall: { before: [], after: [] },
      cards: [
        {
          title: 'Fix the answer',
          kind: 'fix',
          surface: 'api',
          acceptance: [],
          before: 'wrong answer',
          after: 'right answer',
          how: [],
          hunks: ['H1'],
          tests: [],
          out_of_scope: false,
          evidence: [],
          shared_with: [],
        },
      ],
      noise: [],
      uninterpreted: ['H2'],
      hunk_total: 2,
      unmatched_acceptance: [0],
    },
  };
  const view = (findings: readonly ReviewFinding[] = []) =>
    mount(() =>
      StoryView({
        point: {
          kind: 'landed',
          workspace_id: 'workspace-a',
          task_goal: 'Release notes',
          source: '/repo',
          branch: null,
          from_sha: story.from_sha,
          to_sha: story.to_sha,
          at: 1,
        },
        story,
        result: story.result!,
        diff: null,
        findings,
      }),
    );

  it('leaves out the acceptance count while the acceptance list is unknown', () => {
    expect(text(view().value)).not.toContain('验收');
  });

  it('turns the hunk rows off while the diff is unavailable', () => {
    const group = find(
      view().value,
      (n) =>
        typeof n.type === 'function' && n.props.label === zh('sessions.panel.story.uninterpreted'),
    );
    const g = mount(() => (group.type as (props: unknown) => ReactNode)(group.props));
    find(g.value, (n) => n.props.className === 'gs-gh').props.onClick();
    g.render();
    const row = named(g.value, 'HunkRow');
    const button = find(
      (row.type as (props: unknown) => ReactNode)(row.props),
      (n) => n.type === 'button',
    );
    expect(button.props['aria-disabled']).toBe(true);
    expect(button.props.onClick).toBeUndefined();
  });

  it('keeps the open findings in view while the diff is unavailable', () => {
    const shown = nodes(view([finding()]).value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Finding',
    );
    expect(shown.map((n) => n.props.finding.id)).toEqual(['finding-a']);
  });
});

describe('story tab', () => {
  let shown: { row: WorkbenchSession; diff: SessionDiff | null };
  const diff = (head_sha: string): SessionDiff => ({
    session_id: 'session-a',
    base_sha: '0123456789abcdef',
    head_sha,
    files: [],
    patch: null,
    truncated: false,
  });
  const tab = () =>
    mount(() =>
      StoryTab({
        sessionId: 'session-a',
        projectId: 'project-a',
        listed: shown.row,
        diff: shown.diff,
        findings: [],
      }),
    );
  const generate = (h: HookHost<any>): ReactElement<any> =>
    find(h.value, (n) => n.type === 'button' && text(n) === zh('sessions.panel.story.generate'));
  beforeEach(() => {
    shown = { row: listed, diff: null };
  });

  it('offers generation again once the head moved past a refusal', async () => {
    bridge.command!.mockImplementation(async () => ({
      ok: false,
      error: { code: 'invalid_state', message: 'no commits' },
    }));
    const h = tab();
    generate(h).props.onClick();
    await h.flush();
    expect(generate(h).props['aria-disabled']).toBe(true);
    shown.diff = diff('fedcba9876543210');
    h.render();
    expect(generate(h).props['aria-disabled']).toBeUndefined();
    expect(generate(h).props.onClick).toBeTypeOf('function');
  });

  it('turns generation off for a discarded session', () => {
    shown.row = { ...listed, state: 'discarded' };
    const h = tab();
    expect(generate(h).props['aria-disabled']).toBe(true);
    expect(generate(h).props.onClick).toBeUndefined();
    expect(named(h.value, 'Tip').props.content).toBe(zh('sessions.model.worktree.removed'));
  });

  it('offers a retry when a refresh fails over an earlier read', () => {
    mock.stories.read = [
      {
        id: 'story-a',
        revision: 1,
        project_id: 'project-a',
        workbench_session_id: 'session-a',
        source: '/repo',
        from_sha: '0123456789abcdef',
        to_sha: 'fedcba9876543210',
        state: 'running',
        created_at: 1,
      },
    ];
    mock.stories.error = 'daemon unreachable';
    const h = tab();
    expect(find(h.value, (n) => n.type === RunningFor).props).toEqual({
      label: zh('components.running.writing'),
      since: 1,
    });
    const failed = named(h.value, 'ReadFailed');
    expect(failed.props.read.error).toBe('daemon unreachable');
    failed.props.read.reload();
    expect(mock.stories.reloads).toBe(1);
  });

  it('says which runtime interpreted the shown story and how long ago', () => {
    mock.stories.read = [
      {
        id: 'story-a',
        revision: 1,
        project_id: 'project-a',
        workbench_session_id: 'session-a',
        source: '/repo',
        from_sha: '0123456789abcdef',
        to_sha: 'fedcba9876543210',
        state: 'ready',
        runtime: 'codex',
        created_at: Date.now() - 3 * 60_000,
        result: {
          overall: { before: [], after: [] },
          cards: [],
          noise: [],
          uninterpreted: [],
          hunk_total: 0,
          unmatched_acceptance: [],
        },
      } as unknown as ChangeStory,
    ];
    shown.diff = diff('fedcba9876543210');
    const h = tab();
    expect(text(h.value)).toContain(
      zhf('repo.changes.storyBy', { runtime: runtimeName('codex'), unit: 'minute', count: 3 }),
    );
  });
});
