import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Review } from '@pantheon/domain';
import type { SessionGateRun, SessionGates, WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSession() {}, sessionRun: null }),
}));
import { GateResults } from '@/screens/sessions/GateResults';
import { ChecksTab } from '@/screens/sessions/panel';

afterEach(() => {
  unmountAll();
});

const read = <T>(data: T) => ({ data, error: null, reload: () => {} });
const last: NonNullable<SessionGates['last']> = {
  commit: 'c30123456789abcdef',
  checked_at: Date.UTC(2026, 10, 3, 12),
  results: [
    { name: 'lint', exit_code: 0, timed_out: false, output_tail: '' },
    { name: 'unit', exit_code: 0, timed_out: false, output_tail: '' },
    { name: 'e2e', exit_code: 1, timed_out: false, output_tail: '' },
    { name: 'types', exit_code: 0, timed_out: false, output_tail: '' },
  ],
};
const review = (state: Review['state']): Review => ({
  id: 'review-1',
  revision: 1,
  project_id: 'project-1',
  session_id: 'session-1',
  round: 1,
  runtimes: ['codex'],
  state,
  findings: [],
  session_ids: [],
});

function checks(patch: {
  running?: boolean;
  last?: SessionGates['last'];
  commands?: string[];
  runs?: SessionGateRun[];
  gate?: WorkbenchSession['gate'];
  reviews?: Review[] | null;
  onReview?: () => void;
}) {
  return mount(() =>
    ChecksTab({
      gates: read<SessionGates>({
        configured: true,
        running: !!patch.running,
        last: patch.last === undefined ? last : patch.last,
        ...(patch.commands ? { commands: patch.commands } : {}),
      }),
      history: patch.runs && read({ runs: patch.runs }),
      readOnly: false,
      merging: false,
      busy: false,
      attached: new Set<string>(),
      onAttach: () => {},
      onRun: () => {},
      onSettings: () => {},
      gate: patch.gate,
      reviews: patch.reviews,
      onReview: patch.onReview,
    }),
  );
}
const bar = (tab: HookHost<any>) =>
  find(tab.value, (n) => n.type === 'span' && n.props.className === 'ss-pseg');
const segments = (tab: HookHost<any>) =>
  nodes(bar(tab).props.children)
    .filter((n) => n.type === 'i')
    .map((n) => [n.props['data-tone'], n.props.style?.flexGrow]);
/** The labels of the result groups the panel lists, or null without a result list. */
const groups = (tab: HookHost<any>) => {
  const listed = nodes(tab.value).find(
    (n) => typeof n.type === 'function' && n.type.name === 'GateResults',
  );
  if (!listed) return null;
  const list = mount(() => (listed.type as (props: unknown) => any)(listed.props)).value;
  return nodes(list)
    .filter((n) => n.type === 'section')
    .map((g) => g.props['aria-label']);
};
const reviewRow = (tab: HookHost<any>) =>
  nodes(tab.value).find(
    (n) => n.type === 'button' && text(n).includes(zh('sessions.panel.checks.externalReview')),
  );

describe('the checks panel rows', () => {
  it.each([
    [
      'splits the bar into passed, failed and running while the gates run',
      { running: true, gate: { state: 'running', passed: 2, failed: 1, running: 1 } },
      {
        segments: [
          ['ok', 2],
          ['bad', 1],
          ['run', 1],
        ],
        label: '2 通过，1 失败，1 在跑',
        total: '2 通过，1 在跑，0 跳过',
      },
    ],
    [
      'counts the passed, running and skipped commands the session reports while the gates run',
      { running: true, gate: { state: 'running', passed: 2, failed: 0, skipped: 2, running: 1 } },
      {
        segments: [
          ['ok', 2],
          ['idle', 2],
          ['run', 1],
        ],
        total: '2 通过，1 在跑，2 跳过',
      },
    ],
    [
      'counts a command skipped after failing apart from the passed and failed ones',
      {
        last: {
          ...last,
          results: [
            last.results[0]!,
            {
              name: 'audit',
              exit_code: 1,
              timed_out: false,
              output_tail: '',
              state: 'skipped' as const,
              reason: 'timeout' as const,
            },
          ],
        },
      },
      {
        segments: [
          ['ok', 1],
          ['idle', 1],
        ],
        label: '1 通过，0 失败，0 在跑，1 跳过',
        total: '1 / 2 通过',
      },
    ],
    [
      'counts the commands a failed run never reached as a part of their own in the total',
      {
        last: { ...last, results: [last.results[2]!] },
        runs: [
          {
            run_id: 'run-1',
            commit: last.commit,
            started_at: new Date(last.checked_at - 1000).toISOString(),
            finished_at: new Date(last.checked_at).toISOString(),
            results: [
              { name: 'e2e', command: ['e2e'], exit_code: 1 },
              ...['build', 'typecheck', 'format', 'design'].map((name) => ({
                name,
                command: [name],
                skipped: true,
              })),
            ],
          },
        ],
      },
      {
        segments: [
          ['bad', 1],
          ['none', 4],
        ],
        label: '0 通过，1 失败，0 在跑，4 没跑',
        total: '0 / 5 通过',
      },
    ],
    [
      'counts the commands a failed run never reached from the session before its history is read',
      {
        last: { ...last, results: [last.results[2]!] },
        gate: {
          state: 'failed',
          passed: 0,
          failed: 1,
          running: 0,
          not_run: 4,
          finished_at: new Date(last.checked_at).toISOString(),
        },
      },
      {
        segments: [
          ['bad', 1],
          ['none', 4],
        ],
        label: '0 通过，1 失败，0 在跑，4 没跑',
        total: '0 / 5 通过',
      },
    ],
    [
      'lists no command as not run while the first run goes',
      {
        last: null,
        commands: ['build', 'test'],
        running: true,
        gate: { state: 'running', passed: 1, failed: 0, running: 1 },
      },
      {
        segments: [
          ['ok', 1],
          ['run', 1],
        ],
        total: '1 通过，1 在跑，0 跳过',
        groups: [],
      },
    ],
    [
      'names the three counts of a finished run',
      {},
      {
        segments: [
          ['ok', 3],
          ['bad', 1],
        ],
        label: '3 通过，1 失败，0 在跑',
      },
    ],
  ] as const)('%s', (_name, patch, expected) => {
    const tab = checks(patch as Parameters<typeof checks>[0]);
    const total = nodes(tab.value).find((n) => n.props.className === 'ss-ptn');
    expect({
      segments: segments(tab),
      label: bar(tab).props['aria-label'],
      total: total && text(total),
      groups: groups(tab),
    }).toMatchObject(expected);
  });

  it('counts a step’s tests, failures first and the skipped apart, and leaves a step without counts as it was', () => {
    const counted = {
      ...last,
      results: last.results.map((r) =>
        r.name === 'unit'
          ? { ...r, tests: { passed: 38, failed: 0, skipped: 0 } }
          : r.name === 'e2e'
            ? { ...r, tests: { passed: 5, failed: 2, skipped: 3 } }
            : r,
      ),
    };
    const tree = mount(() => GateResults({ last: counted, running: false, readOnly: false })).value;
    const counts = (name: string) => {
      const row = find(
        tree,
        (n) =>
          n.type === 'button' &&
          n.props.className === 'gres-row' &&
          nodes(n.props.children).some((c) => c.props.title === name),
      );
      const cell = nodes(row).find((n) => n.props.className === 'gres-tc');
      return cell ? nodes(cell.props.children).map((n) => text(n)) : null;
    };
    expect(counts('unit')).toEqual(['38 通过']);
    expect(counts('e2e')).toEqual(['2 失败', '5 通过', '3 跳过']);
    expect(counts('lint')).toBeNull();
  });

  it('adds the external review after the steps, which opens the changes panel', () => {
    const onReview = vi.fn();
    const tab = checks({ reviews: [review('running')], onReview });
    const row = reviewRow(tab)!;
    expect(text(row)).toContain('Codex');
    expect(find(row, (n) => n.props.role === 'img').props['aria-label']).toBe(
      zh('sessions.panel.review.reviewing'),
    );
    row.props.onClick();
    expect(onReview).toHaveBeenCalledOnce();
    expect(segments(tab)).toEqual([
      ['ok', 3],
      ['bad', 1],
    ]);
    expect(nodes(tab.value).indexOf(row)).toBeGreaterThan(
      nodes(tab.value).indexOf(named(tab.value, 'GateResults')),
    );
  });

  it('lists the configured commands as not run before any run and offers to run them', () => {
    const tab = checks({ last: null, commands: ['build', 'test'] });
    const listed = named(tab.value, 'GateResults');
    const list = mount(() => (listed.type as (props: unknown) => any)(listed.props)).value;
    const groups = nodes(list).filter((n) => n.type === 'section');
    expect(groups.map((g) => g.props['aria-label'])).toEqual([
      zh('sessions.gateResults.group.notRun'),
    ]);
    expect(
      nodes(groups[0])
        .filter((n) => n.props.role === 'img')
        .map((n) => n.props['aria-label']),
    ).toEqual([zh('sessions.gateResults.group.notRun'), zh('sessions.gateResults.group.notRun')]);
    expect(text(groups[0])).toContain('build');
    expect(text(groups[0])).toContain('test');
    const buttons = (tree: unknown) =>
      nodes(tree as never)
        .filter((n) => n.type === 'button')
        .map((n) => text(n));
    expect(buttons(tab.value)).toContain(zh('sessions.panel.checks.run'));
    expect(buttons(tab.value)).not.toContain(zh('sessions.panel.checks.rerun'));
    expect(buttons(checks({}).value)).toContain(zh('sessions.panel.checks.rerun'));
  });

  it('draws no review row without a review', () => {
    expect(reviewRow(checks({ reviews: [] }))).toBeUndefined();
    expect(reviewRow(checks({}))).toBeUndefined();
  });
});
