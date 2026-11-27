import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalIssues } from '@pantheon/protocol';
import { deferred, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  queries: [] as {
    method: string;
    kinds?: ReadonlySet<string>;
    valid?: (value: unknown) => boolean;
  }[],
  answers: {} as Record<string, { read: unknown; error: string | null }>,
  reload: () => {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', async (actual) => ({
  ...(await actual<object>()),
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: vi.fn(async () => ({ ok: true, value: {} })),
}));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (
    method: string,
    _projectId: string | null,
    valid: (value: unknown) => boolean,
    _extra: unknown,
    options?: { kinds?: ReadonlySet<string> },
  ) => {
    mock.queries.push({ method, kinds: options?.kinds, valid });
    const answer = mock.answers[method] ?? { read: null, error: null };
    return { ...answer, loading: false, unavailable: false, stale: false, reload: mock.reload };
  },
}));
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
import { Failure } from '@/components/PanelBoundary';
import { runCommand } from '@/data/commands';
import { useProjectSignals } from '@/data/signals';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { SignalsCard } from '@/screens/project/SignalsCard';
import { zh, zhf } from './i18n-setup.js';

type Issue = SignalIssues['issues'][number];

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MINUTE = 60_000;

const issueOf = (extra: Partial<Issue> = {}): Issue => ({
  id: 's1',
  revision: 1,
  project_id: 'alpha',
  source: 'gate_repeat',
  fingerprint: 'fp',
  title: 'test: Error: broken',
  state: 'open',
  count: 2,
  first_seen: NOW - 60 * MINUTE,
  last_seen: NOW - 5 * MINUTE,
  opened_at: NOW - 30 * MINUTE,
  samples: [{ at: NOW - 5 * MINUTE, text: 'Error: broken\n  at line 1' }],
  ...extra,
});

const answer = (issues: Issue[], error: string | null = null) => {
  mock.answers['project.signals'] = { read: { issues }, error };
};

const card = () => mount(() => SignalsCard({ projectId: 'alpha' }) as ReactElement | null);
const all = (tree: unknown) => nodes(tree as ReactElement);
const rows = (tree: unknown) => all(tree).filter((n) => n.type === 'li');
const button = (tree: unknown, name: string) =>
  all(tree).find((n) => n.type === 'button' && text(n) === name);
const resolveButton = (tree: unknown) => button(tree, zh('project.signals.resolve'));
const opener = (tree: unknown) => all(tree).find((n) => n.props['aria-expanded'] !== undefined)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.queries = [];
  mock.answers = {};
  mock.reload = () => {};
  vi.mocked(runCommand).mockClear();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('the signals read', () => {
  it('reads again after a signal changes state or a gate run may have counted into one', () => {
    mount(() => useProjectSignals('alpha'));
    expect(mock.queries.at(-1)?.method).toBe('project.signals');
    expect([...mock.queries.at(-1)!.kinds!].sort()).toEqual(
      [
        'signal.escalated',
        'signal.opened',
        'signal.resolved',
        'session.gate_checked',
        'session.merged',
        'session.merge_blocked',
        'workspace.removed',
      ].sort(),
    );
  });

  it('takes only a read with an issue list', () => {
    mount(() => useProjectSignals('alpha'));
    const valid = mock.queries.at(-1)!.valid!;
    expect(valid({ issues: [] })).toBe(true);
    expect(valid({ issues: null })).toBe(false);
    expect(valid(null)).toBe(false);
  });
});

describe('the signals card', () => {
  it('lists escalated, then open, then resolved, each newest first', () => {
    answer([
      issueOf({ id: 'r-old', title: 'resolved old', state: 'resolved', last_seen: NOW - 50 }),
      issueOf({ id: 'o-old', title: 'open old', state: 'open', last_seen: NOW - 40 }),
      issueOf({ id: 'e', title: 'escalated', state: 'escalated', last_seen: NOW - 100 }),
      issueOf({ id: 'r-new', title: 'resolved new', state: 'resolved', last_seen: NOW - 1 }),
      issueOf({ id: 'o-new', title: 'open new', state: 'open', last_seen: NOW - 2 }),
    ]);
    expect(rows(card().value).map((row) => row.props['aria-label'])).toEqual([
      'escalated',
      'open new',
      'open old',
      'resolved new',
      'resolved old',
    ]);
  });

  it('shows at most five resolved issues, the newest, and every unresolved one', () => {
    answer([
      ...Array.from({ length: 7 }, (_, i) =>
        issueOf({ id: `r${i}`, title: `resolved ${i}`, state: 'resolved', last_seen: NOW - i }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        issueOf({ id: `o${i}`, title: `open ${i}`, last_seen: NOW - 100 - i }),
      ),
    ]);
    const shown = rows(card().value).map((row) => row.props['aria-label']);
    expect(shown.filter((name) => name.startsWith('open'))).toHaveLength(6);
    expect(shown.filter((name) => name.startsWith('resolved'))).toEqual([
      'resolved 0',
      'resolved 1',
      'resolved 2',
      'resolved 3',
      'resolved 4',
    ]);
  });

  it.each([
    ['an empty list', { read: { issues: [] }, error: null }],
    ['no read yet', { read: null, error: null }],
  ])('is absent with %s', (_name, read) => {
    mock.answers['project.signals'] = read;
    expect(card().value).toBeNull();
  });

  it('writes each state and source, the count and the last time seen', () => {
    answer([
      issueOf({ id: 'a', state: 'escalated', source: 'gate_repeat', count: 4 }),
      issueOf({ id: 'b', state: 'open', source: 'gate_flaky', count: 1 }),
      issueOf({ id: 'c', state: 'resolved', source: 'gate_repeat', count: 7 }),
    ]);
    const shown = rows(card().value).map((row) => text(row));
    const age = zhf('data.age.minutes', { count: 5 });
    expect(shown[0]).toContain(zh('project.signals.escalated'));
    expect(shown[0]).toContain(zh('project.signals.gateRepeat'));
    expect(shown[0]).toContain(zhf('project.signals.count', { count: 4 }));
    expect(shown[1]).toContain(zh('project.signals.open'));
    expect(shown[1]).toContain(zh('project.signals.gateFlaky'));
    expect(shown[1]).toContain(zhf('project.signals.count', { count: 1 }));
    expect(shown[2]).toContain(zh('project.signals.resolved'));
    expect(shown[2]).toContain(zhf('project.signals.count', { count: 7 }));
    for (const row of shown) {
      expect(row).toContain('test: Error: broken');
      expect(row).toContain(age);
    }
    expect(zh('project.signals.gateRepeat')).toBe('反复失败');
    expect(zh('project.signals.gateFlaky')).toBe('时过时挂');
    expect(zh('project.signals.open')).toBe('开启');
    expect(zh('project.signals.escalated')).toBe('升级');
    expect(zh('project.signals.resolved')).toBe('已解决');
  });

  it('opens a row on its latest sample, line breaks kept', () => {
    answer([
      issueOf({
        samples: [
          { at: NOW - MINUTE, text: 'newest\nsecond line' },
          { at: NOW - 2 * MINUTE, text: 'older' },
        ],
      }),
    ]);
    const h = card();
    const sample = () => all(h.value).find((n) => n.type === 'pre');
    expect(opener(h.value).props['aria-expanded']).toBe(false);
    expect(sample()).toBeUndefined();
    opener(h.value).props.onClick();
    h.render();
    expect(opener(h.value).props['aria-expanded']).toBe(true);
    expect(text(sample())).toBe('newest\nsecond line');
    opener(h.value).props.onClick();
    h.render();
    expect(sample()).toBeUndefined();
  });

  it('marks an issue resolved through project.signal.resolve and reads again', async () => {
    const reload = vi.fn();
    mock.reload = reload;
    answer([issueOf()]);
    const h = card();
    resolveButton(h.value)!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.signal.resolve',
      { project_id: 'alpha', issue_id: 's1' },
      null,
    );
    expect(reload).toHaveBeenCalled();
  });

  it('disables marking while it is out and shows a failure in the row', async () => {
    const out = deferred<any>();
    vi.mocked(runCommand).mockReturnValueOnce(out.promise);
    answer([issueOf({ id: 'a', title: 'first' }), issueOf({ id: 'b', title: 'second' })]);
    const h = card();
    resolveButton(rows(h.value)[0])!.props.onClick();
    h.render();
    for (const row of rows(h.value)) expect(resolveButton(row)!.props.disabled).toBe(true);
    out.resolve({ ok: false, error: { code: 'not_found', message: 'Signal issue not found' } });
    await h.flush();
    expect(resolveButton(rows(h.value)[0])!.props.disabled).toBe(false);
    const alert = (row: unknown) => all(row).find((n) => n.props.role === 'alert');
    expect(text(alert(rows(h.value)[0]))).toContain('Signal issue not found');
    expect(alert(rows(h.value)[1])).toBeUndefined();
  });

  it('offers no marking on a resolved row', () => {
    answer([issueOf({ state: 'resolved', resolved_at: NOW })]);
    expect(rows(card().value)).toHaveLength(1);
    expect(resolveButton(card().value)).toBeUndefined();
  });

  it.each([
    ['with no earlier read', false],
    ['beside the earlier read', true],
  ])('shows a failed read with a retry %s', (_name, earlier) => {
    const reload = vi.fn();
    mock.reload = reload;
    mock.answers['project.signals'] = {
      read: earlier ? { issues: [issueOf()] } : null,
      error: 'daemon gone',
    };
    const h = card();
    const failure = all(h.value).find((n) => n.type === Failure)!;
    expect(failure.props.error).toBe('daemon gone');
    failure.props.onRetry();
    expect(reload).toHaveBeenCalled();
    expect(rows(h.value)).toHaveLength(earlier ? 1 : 0);
  });
});

describe('the signals card on the project page', () => {
  it('shows on the project page with its own key for the project', () => {
    const tree = all(
      mount(() => ProjectScreen({ projectId: 'alpha', sessions: [] }) as ReactElement).value,
    );
    const shown = tree.find((n) => n.type === SignalsCard);
    expect(shown?.props.projectId).toBe('alpha');
    expect(shown?.key).toContain('alpha');
  });
});
