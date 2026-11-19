import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardHistory, BoardModel, PendingReplan } from '@pantheon/protocol';
import { find, HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  opened: [] as string[],
  picked: [] as string[][],
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'rp-id' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => {
  const shell = {
    openSession: (id: string) => mock.opened.push(id),
    openProjectApproved() {},
  };
  return {
    useShell: Object.assign((selector: any) => selector(shell), {
      getState: () => shell,
      setState() {},
    }),
  };
});
vi.mock('@/data/board-page', async (actual) => ({
  ...(await actual<object>()),
  pickBoardPage: (projectId: string, page: string) => mock.picked.push(['page', projectId, page]),
  pickTaskView: (projectId: string, view: string) => mock.picked.push(['view', projectId, view]),
  pickTaskScope: (projectId: string, scope: string) =>
    mock.picked.push(['scope', projectId, scope]),
}));
import { BriefCard } from '@/screens/board/BriefCard';
import { HistoryView } from '@/screens/board/HistoryView';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
import type { BoardMilestone, SnapshotMilestone } from '@/screens/board/panels-model';
import { dayText, durationText } from '@/lib/time-text';
import { listText } from '@/lib/list-text';

const DAY = 86_400_000;
const START = new Date(2026, 9, 1).getTime();
const NOW = START + 48 * DAY;

type Decision = BoardHistory['decisions'][number];

const trigger = (
  text: string,
  over: Partial<NonNullable<Decision['replan']>['triggers'][number]> = {},
) => ({
  event_id: `event-${text}`,
  milestone_id: 'ms-v2',
  type: 'handbacks' as const,
  value: 2,
  task_id: 'lead-1:reconcile-report',
  task_title: 'Reconciliation report',
  text,
  ...over,
});

const replan = (
  at: number,
  texts: string[],
  changes: Partial<Pick<NonNullable<Decision['replan']>, 'added' | 'removed' | 'changed'>> = {},
): Decision => ({
  at,
  lane_id: null,
  kind: 'replan',
  title: 'Refunds v2 rollout',
  lead_session_id: 'lead-1',
  replan: {
    triggers: texts.map((each) => trigger(each)),
    added: [],
    removed: [],
    changed: [],
    ...changes,
  },
});

const waiting: PendingReplan = {
  event_id: 'event-budget',
  milestone_id: 'ms-v2',
  at: NOW - 6 * 60_000,
  type: 'budget_ratio',
  value: 0.82,
  task_id: 'lead-1:idempotency',
  task_title: 'Refund idempotency',
};

const history = (over: Partial<BoardHistory> = {}): BoardHistory => ({
  started_at: START,
  truncated: false,
  tasks: [],
  days: [],
  decisions: [],
  milestones: [{ id: 'ms-v2', title: 'Refunds v2 rollout', state: 'active', reached_at: null }],
  idle: [],
  ...over,
});

const MILESTONES = [{ id: 'ms-v2', owner_session_id: 'lead-1' }];

beforeEach(() => {
  mock.opened.length = 0;
  mock.picked.length = 0;
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

/** Reads answered by method. */
const serve = (values: Record<string, unknown>) => {
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({ ok: true, value: values[method] ?? null })),
      command: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
};

const timeline = (h: BoardHistory) => {
  const host = new HookHost(
    () =>
      HistoryView({
        history: h,
        lanes: [],
        now: NOW,
        milestones: MILESTONES,
        onOpenSession: (id) => mock.opened.push(id),
        onOpenTask: () => {},
      }),
    (tree) => {
      find(tree, (n) => n.props.className === 'bd-hs-plot').props.ref.current ??= {
        clientWidth: 1200,
        querySelectorAll: () => [],
      };
    },
  );
  host.render();
  return host;
};

const byLabel = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.props['aria-label'] === label);
const hasLabel = (tree: unknown, label: string) =>
  nodes(tree as ReactElement).some((n) => n.props['aria-label'] === label);
/** The re-plan rows of the list: their disclosures, newest first. */
const rows = (tree: unknown) =>
  nodes(byLabel(tree, zh('board.history.replans'))).filter(
    (n) => n.props.open !== undefined && n.props.onOpenChange,
  );
const replanned = (text: string) => zhf('board.history.replan.title', { text });

describe('re-plans on the whole history', () => {
  it('draws a re-plan as a button on the plot that opens its row in the list', () => {
    const at = START + 40 * DAY;
    const h = timeline(
      history({ decisions: [replan(at, ['task reconcile-report was handed back 2 times'])] }),
    );
    const name = zhf('board.history.decisionList', {
      date: dayText(at, NOW, { time: true }),
      items: replanned('task reconcile-report was handed back 2 times'),
    });
    const mark = byLabel(h.value, name);
    expect(mark.props.role).toBe('button');
    expect(mark.props['aria-expanded']).toBe(false);
    expect(rows(h.value)[0]!.props.id).toBe(mark.props['aria-controls']);
    expect(rows(h.value)[0]!.props.open).toBe(false);
    mark.props.onClick();
    h.render();
    expect(byLabel(h.value, name).props['aria-expanded']).toBe(true);
    expect(rows(h.value)[0]!.props.open).toBe(true);
  });

  it('lists the re-plans newest first under a heading with their count, with what each changed', () => {
    const h = timeline(
      history({
        decisions: [
          replan(START + 10 * DAY, ['task refund-endpoint stalled'], {
            changed: ['Refund endpoint'],
          }),
          { at: START + 11 * DAY, lane_id: null, kind: 'plan', title: 'Ship refunds' },
          replan(
            START + 40 * DAY,
            [
              'task reconcile-report was handed back 2 times',
              'task reconcile-report spent 104% of its budget',
            ],
            {
              added: ['Sum in cents', 'CSV export'],
              removed: ['Nightly mail'],
              changed: ['Diff report'],
            },
          ),
        ],
      }),
    );
    const list = byLabel(h.value, zh('board.history.replans'));
    expect(text(find(list, (n) => n.type === 'h2'))).toBe(`${zh('board.history.replans')}2`);
    const [newest, oldest] = rows(h.value);
    expect(text(newest)).toContain(replanned('task reconcile-report was handed back 2 times'));
    expect(text(newest)).toContain(zhf('board.history.replan.more', { count: 1 }));
    expect(text(newest)).toContain(
      listText(
        zhf('board.replan.added', { count: 2 }),
        zhf('board.replan.removed', { count: 1 }),
        zhf('board.replan.changed', { count: 1 }),
      ),
    );
    expect(text(oldest)).toContain(replanned('task refund-endpoint stalled'));
    expect(text(oldest)).toContain(zhf('board.replan.changed', { count: 1 }));
    expect(text(oldest)).not.toContain(zhf('board.replan.added', { count: 0 }));
    expect(text(oldest)).not.toContain(zhf('board.history.replan.more', { count: 0 }));

    const changes = byLabel(newest, zh('board.history.replan.changes'));
    expect(
      nodes(changes)
        .filter((n) => n.type === 'li')
        .map((li) => [li.props['data-k'], text(li)]),
    ).toEqual([
      ['added', `${zh('board.history.replan.added')}Sum in cents`],
      ['added', `${zh('board.history.replan.added')}CSV export`],
      ['removed', `${zh('board.history.replan.removed')}Nightly mail`],
      ['changed', `${zh('board.history.replan.changed')}Diff report`],
    ]);
    const met = byLabel(newest, zh('board.history.replan.conditions'));
    expect(
      nodes(met)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual([
      'task reconcile-report was handed back 2 timesRefunds v2 rollout',
      'task reconcile-report spent 104% of its budgetRefunds v2 rollout',
    ]);
    expect(hasLabel(oldest, zh('board.history.replan.conditions'))).toBe(false);
  });

  it('says no task changed when a re-plan changed none, and opens the lead from the row', () => {
    const h = timeline(history({ decisions: [replan(START + 5 * DAY, ['task a stalled'])] }));
    const [row] = rows(h.value);
    expect(text(row)).toContain(zh('board.history.replan.none'));
    expect(hasLabel(row, zh('board.history.replan.changes'))).toBe(false);
    find(
      row!,
      (n) => n.type === 'button' && text(n) === zh('board.replan.openLead'),
    ).props.onClick();
    expect(mock.opened).toEqual(['lead-1']);
  });

  it('shows a condition that waits for the lead above the re-plans, on the plot and in the legend', () => {
    const h = timeline(
      history({
        decisions: [replan(START + 5 * DAY, ['task a stalled'])],
        pending_replans: [waiting],
      }),
    );
    const list = byLabel(h.value, zh('board.history.replans'));
    // The innermost element with both the waiting glyph and a button.
    const row = nodes(list)
      .filter(
        (n) =>
          hasLabel(n, zh('board.history.replan.waiting')) &&
          nodes(n).some((each) => each.type === 'button'),
      )
      .at(-1)!;
    const fired = zhf('board.replan.fired.budget', { task: 'Refund idempotency', percent: '82%' });
    expect(text(row)).toContain(zhf('board.history.replan.met', { text: fired }));
    expect(text(row)).toContain('Refunds v2 rollout');
    expect(text(row)).toContain(zh('board.replan.unanswered'));
    expect(text(row)).toContain(durationText(6 * 60_000));
    find(
      row,
      (n) => n.type === 'button' && text(n) === zh('board.replan.openLead'),
    ).props.onClick();
    expect(mock.opened).toEqual(['lead-1']);
    expect(
      byLabel(
        h.value,
        zhf('board.history.decisionList', {
          date: dayText(waiting.at, NOW, { time: true }),
          items: zhf('board.history.replan.met', { text: fired }),
        }),
      ).props.role,
    ).toBe('img');
    const legend = byLabel(h.value, zh('board.history.legend'));
    expect(
      nodes(legend)
        .filter((n) => n.type === 'li')
        .map(text)
        .slice(-2),
    ).toEqual([zh('board.history.legend.replanned'), zh('board.history.legend.replanMet')]);
  });

  it('draws no list and no legend entries without re-plans', () => {
    const h = timeline(history({ decisions: [{ at: START + DAY, lane_id: null, kind: 'plan' }] }));
    expect(hasLabel(h.value, zh('board.history.replans'))).toBe(false);
    const legend = text(byLabel(h.value, zh('board.history.legend')));
    expect(legend).not.toContain(zh('board.history.legend.replanned'));
    expect(legend).not.toContain(zh('board.history.legend.replanMet'));
  });

  it('shows the first 8 re-plans with a switch to show all', () => {
    const h = timeline(
      history({
        decisions: Array.from({ length: 10 }, (_, i) =>
          replan(START + (i + 1) * DAY, [`task ${i} stalled`]),
        ),
      }),
    );
    expect(rows(h.value)).toHaveLength(8);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zhf('board.rows.all', { count: 10 }),
    ).props.onClick();
    h.render();
    expect(rows(h.value)).toHaveLength(10);
  });
});

const NOW_CARD = Date.UTC(2026, 10, 18, 10, 42);
const milestone = (over: Partial<BoardMilestone> = {}): BoardMilestone => ({
  id: 'ms-v2',
  title: 'Refunds v2 rollout',
  session_ids: [],
  merged: 0,
  status: 'active',
  criteria: [],
  owner_session_id: 'lead-1',
  tasks: { done: 7, total: 12 },
  assumptions: [{ id: 'staging-v1', text: 'Staging keeps the v1 refund table', affects: [] }],
  ...over,
});
const stored = (replan_if?: SnapshotMilestone['replan_if']) =>
  ({
    id: 'ms-v2',
    revision: 2,
    project_id: 'project-replan',
    title: 'Refunds v2 rollout',
    required_sessions: [],
    criteria: [],
    created_at: NOW_CARD,
    updated_by: 'lead-1',
    owner_session_id: 'lead-1',
    key: 'v2',
    ...(replan_if && { replan_if }),
  }) as unknown as SnapshotMilestone;
const CONDITIONS: SnapshotMilestone['replan_if'] = [
  { type: 'handbacks', count: 2 },
  { type: 'budget_ratio', at: 0.8 },
  { type: 'stall' },
  { type: 'assumption_false', assumption_id: 'staging-v1' },
];

const milestoneCard = async (projectId: string, row: SnapshotMilestone) => {
  const ms = milestone();
  const card = mount(() =>
    MilestoneCard({
      model: { now: NOW_CARD, tasks: [], merges: [], milestones: [ms] } as unknown as BoardModel,
      milestone: ms,
      actions: { projectId, milestones: [row], sessions: [], run: async () => null },
      onOpenTask: () => {},
    }),
  );
  // The conditions read the history on their own, so they are drawn with their own hooks.
  const conditions = nodes(card.value).find(
    (n) => typeof n.type === 'function' && n.type.name === 'ReplanConditions',
  );
  if (!conditions) return card;
  const h = mount(() => (conditions.type as (props: unknown) => ReactElement)(conditions.props));
  await h.flush();
  return h;
};

describe('re-plan conditions on the milestone line', () => {
  it('offers no button for a milestone without conditions', async () => {
    serve({});
    const h = await milestoneCard('project-replan-a', stored());
    expect(
      nodes(h.value).some((n) =>
        String(n.props['aria-label'] ?? '').includes(
          zhf('board.plan.milestone.replanPopup', { title: 'Refunds v2 rollout' }),
        ),
      ),
    ).toBe(false);
  });

  it('counts the conditions and lists them in declared order in a popover', async () => {
    serve({ 'board.history': history() });
    const h = await milestoneCard('project-replan-b', stored(CONDITIONS));
    const button = byLabel(
      h.value,
      zhf('board.plan.milestone.replanCount', { count: 4, title: 'Refunds v2 rollout' }),
    );
    expect(text(button)).toBe('4');
    const popup = byLabel(
      h.value,
      zhf('board.plan.milestone.replanPopup', { title: 'Refunds v2 rollout' }),
    );
    expect(text(popup)).toContain(zh('board.plan.milestone.replanTitle'));
    expect(
      nodes(popup)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual([
      zhf('board.replan.if.handbacks', { count: 2 }),
      zhf('board.replan.if.budget', { percent: '80%' }),
      zh('board.replan.if.stall'),
      `${zh('board.replan.if.assumption')}Staging keeps the v1 refund table`,
    ]);
  });

  it('turns the button into the met chip with the wait while a condition waits for the lead', async () => {
    serve({
      'board.history': history({ pending_replans: [{ ...waiting, at: NOW_CARD - 6 * 60_000 }] }),
    });
    vi.useFakeTimers({ now: NOW_CARD, toFake: ['Date'] });
    try {
      const h = await milestoneCard('project-replan-c', stored(CONDITIONS));
      const wait = durationText(6 * 60_000);
      const button = byLabel(
        h.value,
        zhf('board.plan.milestone.replanMetLabel', { wait, count: 4, title: 'Refunds v2 rollout' }),
      );
      expect(text(button)).toBe(`${zh('board.plan.milestone.replanMet')}${wait}`);
      const popup = byLabel(
        h.value,
        zhf('board.plan.milestone.replanPopup', { title: 'Refunds v2 rollout' }),
      );
      const met = nodes(popup)
        .filter((n) => n.type === 'li')
        .find((li) => hasLabel(li, zh('board.plan.milestone.replanWaiting')))!;
      expect(text(met)).toContain(zhf('board.replan.if.budget', { percent: '80%' }));
      expect(text(met)).toContain(
        zhf('board.replan.fired.budget', { task: 'Refund idempotency', percent: '82%' }),
      );
      expect(text(met)).toContain(zh('board.replan.unanswered'));
      find(
        met,
        (n) => n.type === 'button' && text(n) === zh('board.replan.openLead'),
      ).props.onClick();
      expect(mock.opened).toEqual(['lead-1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('re-plans since you left', () => {
  const LEFT = NOW_CARD - 3 * 3_600_000;
  const model = {
    since: NOW_CARD - 7 * DAY,
    now: NOW_CARD,
    tasks: [],
    merges: [],
    milestones: [],
  } as unknown as BoardModel;

  it('lists the re-plans after leaving and the waiting conditions, and opens a re-plan on the timeline', async () => {
    const after = replan(NOW_CARD - 3_600_000, ['task reconcile-report was handed back 2 times'], {
      added: ['CSV export'],
    });
    const h0 = history({
      decisions: [replan(LEFT - 3_600_000, ['task old stalled']), after],
      pending_replans: [{ ...waiting, at: NOW_CARD - 6 * 60_000 }],
    });
    serve({
      'project.brief': { since: LEFT, items: [] },
      'app.settings': { brief_prose: false },
      'board.history': h0,
    });
    const h = mount(() =>
      BriefCard({ projectId: 'project-replan-d', model, sessions: [], onOpenTask: () => {} }),
    );
    await h.flush();
    const card = h.value!;
    expect(text(card)).not.toContain('task old stalled');
    const row = find(
      card,
      (n) =>
        n.type === 'button' && text(n).includes('task reconcile-report was handed back 2 times'),
    );
    expect(text(row)).toContain(zh('board.brief.type.replan'));
    expect(text(row)).toContain(zhf('board.replan.added', { count: 1 }));
    expect(text(card)).toContain(zh('board.brief.type.replanMet'));
    expect(text(card)).toContain(
      zhf('board.replan.fired.budget', { task: 'Refund idempotency', percent: '82%' }),
    );
    row.props.onClick();
    expect(mock.picked).toEqual(
      expect.arrayContaining([
        ['page', 'project-replan-d', 'tasks'],
        ['view', 'project-replan-d', 'timeline'],
        ['scope', 'project-replan-d', 'all'],
      ]),
    );
    const t = timeline(h0);
    expect(rows(t.value).map((n) => n.props.open)).toEqual([true, false]);
  });
});
