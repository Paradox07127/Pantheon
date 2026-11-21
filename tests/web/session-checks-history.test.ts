import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionGateRun, SessionGates, SessionGatesHistory } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
const shell = vi.hoisted(() => ({ sessionRun: null as string | null }));
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSession() {}, sessionRun: shell.sessionRun }),
}));
import { GateTracker } from '@/screens/sessions/GateTracker';
import { GateResults } from '@/screens/sessions/GateResults';
import { ChecksTab } from '@/screens/sessions/panel';

const NOW = Date.UTC(2026, 10, 3, 12);
afterEach(() => {
  unmountAll();
  shell.sessionRun = null;
});

const read = <T>(data: T) => ({ data, error: null, reload: () => {} });
const result = (name: string, patch: Partial<SessionGateRun['results'][number]>) => ({
  name,
  command: ['pnpm', name],
  ...patch,
});
const run = (id: string, minutesAgo: number, results: SessionGateRun['results']) => ({
  run_id: id,
  commit: `${id}0123456789abcdef`,
  started_at: new Date(NOW - minutesAgo * 60_000 - 10_000).toISOString(),
  finished_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  results,
});

const newest = run('c3', 1, [
  result('lint', { exit_code: 0, duration_ms: 1000 }),
  result('test', { exit_code: 1, duration_ms: 3000 }),
]);
const middle = run('b2', 20, [
  result('lint', { exit_code: 0, duration_ms: 500 }),
  result('test', { exit_code: 1, duration_ms: 4000 }),
  result('build', { skipped: true }),
]);
const oldest = run('a1', 60, [
  result('lint', { exit_code: 0, duration_ms: 2000 }),
  result('test', { exit_code: 0, duration_ms: 1000 }),
  result('build', { exit_code: 0, duration_ms: 3000 }),
]);

const gates: SessionGates = {
  configured: true,
  running: false,
  last: {
    commit: newest.commit,
    checked_at: Date.parse(newest.finished_at),
    results: [
      { name: 'lint', exit_code: 0, timed_out: false, output_tail: '' },
      { name: 'test', exit_code: 1, timed_out: false, output_tail: '1 failed' },
    ],
  },
};

function checks(
  runs: SessionGatesHistory['runs'],
  latest: SessionGates = gates,
  history: Parameters<typeof ChecksTab>[0]['history'] = read({ runs }),
) {
  return mount(() =>
    ChecksTab({
      gates: read(latest),
      history,
      readOnly: false,
      merging: false,
      busy: false,
      attached: new Set<string>(),
      onAttach: () => {},
      onRun: () => {},
      onSettings: () => {},
    }),
  );
}
const chart = (tab: HookHost<any>) =>
  mount(() => GateTracker(named(tab.value, 'GateTracker').props));
const cells = (tree: unknown) =>
  nodes(tree as never).filter(
    (n) => n.type === 'button' && String(n.props.className).startsWith('ql-tc'),
  );
/** The cells of the first row, one per run, oldest first. */
const columns = (tree: unknown) => cells(tree).slice(0, 3);
const current = (tab: HookHost<any>) =>
  columns(chart(tab).value).map((g) => g.props['aria-current']);
const attach = (tree: unknown) =>
  nodes(tree as never).filter((n) => String(n.props['aria-label']).startsWith('附加'));
const list = (tab: HookHost<any>) =>
  find(tab.value, (n) => n.type === 'ul' && n.props.className === 'ss-checks');
/** The gate results of the newest run, listed when no older run is picked. */
const latest = (tab: HookHost<any>) => named(tab.value, 'GateResults').props;

describe('session gate history', () => {
  it('fills a timed-out step like a failed one, as the session checks list draws it', () => {
    const timedOut = run('d4', 1, [
      result('lint', { exit_code: 1, duration_ms: 1000 }),
      result('test', { exit_code: null, timed_out: true, duration_ms: 3000 }),
    ]);
    const tests = cells(chart(checks([timedOut, middle])).value).filter((c) =>
      c.props['aria-label'].startsWith('test'),
    );
    const late = tests.filter((c) =>
      c.props['aria-label'].includes(zh('board.gateStates.timedOut')),
    );
    expect(late).toHaveLength(1);
    expect(tests.map((c) => c.props.className)).toEqual([
      late[0]!.props.className,
      late[0]!.props.className,
    ]);
  });

  it('draws a row per command with a cell per run, filled by its result', () => {
    const tree = chart(checks([newest, middle, oldest])).value;
    expect(
      cells(tree).map((c) => [c.props['aria-label'].split('，')[0], c.props.className]),
    ).toEqual([
      ['lint', 'ql-tc ql-tc-ok'],
      ['lint', 'ql-tc ql-tc-ok'],
      ['lint', 'ql-tc ql-tc-ok'],
      ['test', 'ql-tc ql-tc-ok'],
      ['test', 'ql-tc ql-tc-bad'],
      ['test', 'ql-tc ql-tc-bad'],
      ['build', 'ql-tc ql-tc-ok'],
      ['build', 'ql-tc ql-tc-none'],
      ['build', 'ql-tc ql-tc-none'],
    ]);
    const rates = find(tree, (n) => n.props.className === 'ql-gtp');
    expect(nodes(rates.props.children).map((n) => text(n))).toEqual(['100%', '33%', '100%']);
  });

  it('names the commit, time and result of a cell, and leaves a skipped command empty', () => {
    const tree = chart(checks([newest, middle, oldest])).value;
    expect(cells(tree)[4]!.props['aria-label']).toMatch(/^test，b201234，.+，退出码 1$/);
    expect(cells(tree)[7]!.props['aria-label']).toMatch(/，跳过$/);
    expect(cells(tree)[8]!.props['aria-label']).toMatch(/，未跑$/);
  });

  it('shows an older run read-only when its group is clicked', () => {
    const tab = checks([newest, middle, oldest]);
    expect(latest(tab)).toMatchObject({ last: gates.last, run: newest });
    expect(columns(chart(tab).value)[2]!.props['aria-current']).toBe(true);
    columns(chart(tab).value)[1]!.props.onClick();
    tab.render();
    const rows = list(tab);
    expect(text(rows)).toContain('b201234');
    expect(text(rows)).not.toContain('c301234');
    expect(
      nodes(rows)
        .filter((n) => n.props.role === 'img')
        .map((n) => n.props['aria-label']),
    ).toEqual([
      zh('board.gateStates.passed'),
      zh('board.gateStates.failed'),
      zh('board.gateStates.skipped'),
    ]);
    expect(attach(rows)).toEqual([]);
    expect(text(tab.value)).not.toContain(zh('sessions.panel.checks.rerun'));
    expect(current(tab)).toEqual([undefined, true, undefined]);
  });

  it('returns to the newest run on Escape or a click on the newest group', () => {
    const tab = checks([newest, middle, oldest]);
    columns(chart(tab).value)[0]!.props.onClick();
    tab.render();
    expect(text(list(tab))).toContain('a101234');
    const keys = find(tab.value, (n) => typeof n.props.onKeyDown === 'function');
    keys.props.onKeyDown({ key: 'Escape', stopPropagation: () => {} });
    tab.render();
    expect(latest(tab).run).toBe(newest);
    expect(text(tab.value)).toContain(zh('sessions.panel.checks.rerun'));
    columns(chart(tab).value)[1]!.props.onClick();
    tab.render();
    columns(chart(tab).value)[2]!.props.onClick();
    tab.render();
    expect(latest(tab).run).toBe(newest);
  });

  it('offers a retry when the history read fails', () => {
    const reload = vi.fn();
    const tab = checks([], gates, { data: null, error: 'daemon unreachable', reload });
    const failed = named(tab.value, 'ReadFailed');
    expect(failed.props.read.error).toBe('daemon unreachable');
    failed.props.read.reload();
    expect(reload).toHaveBeenCalledOnce();
    expect(latest(tab).last).toBe(gates.last);
  });

  it('draws no chart for a single run', () => {
    const tab = checks([newest]);
    expect(() => named(tab.value, 'GateTracker')).toThrow();
    expect(latest(tab)).toMatchObject({ last: gates.last, run: newest });
  });

  it('opens on the run the session was opened for', () => {
    shell.sessionRun = middle.run_id;
    const tab = checks([newest, middle, oldest]);
    expect(text(list(tab))).toContain('b201234');
    expect(attach(list(tab))).toEqual([]);
    expect(current(tab)).toEqual([undefined, true, undefined]);
  });

  it('marks the run whose results are listed when the history already holds a newer one', () => {
    const behind: SessionGates = {
      ...gates,
      last: { ...gates.last!, commit: middle.commit, checked_at: Date.parse(middle.finished_at) },
    };
    const tab = checks([newest, middle, oldest], behind);
    expect(latest(tab)).toMatchObject({ last: behind.last, run: middle });
    expect(current(tab)).toEqual([undefined, true, undefined]);
    columns(chart(tab).value)[2]!.props.onClick();
    tab.render();
    expect(text(list(tab))).toContain('c301234');
    expect(attach(list(tab))).toEqual([]);
  });

  it('expands only the clicked one of two commands that share a name', () => {
    const twice: SessionGates = {
      ...gates,
      last: {
        ...gates.last!,
        results: [
          { name: 'test', exit_code: 1, timed_out: false, output_tail: 'unit failed' },
          { name: 'test', exit_code: 1, timed_out: false, output_tail: 'e2e failed' },
        ],
      },
    };
    const props = latest(checks([], twice));
    const results = mount(() => GateResults(props));
    const rows = nodes(results.value).filter((n) => n.type === 'li');
    expect(new Set(rows.map((n) => n.key)).size).toBe(2);
    const toggles = nodes(results.value).filter((n) => n.props['aria-expanded'] !== undefined);
    toggles[1]!.props.onClick();
    results.render();
    const logs = nodes(results.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Log',
    );
    const shown = logs.flatMap((log) =>
      nodes(mount(() => (log.type as (p: unknown) => unknown)(log.props)).value as never).filter(
        (n) => n.type === 'pre',
      ),
    );
    expect(shown.map((n) => text(n))).toEqual(['e2e failed']);
  });
});
