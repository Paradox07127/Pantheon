import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChangeRow,
  PlanItemView,
  ProjectPlanView,
  WorkbenchSession,
} from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/session-thread', () => ({
  useSessionThread: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
import { EvidenceMark } from '@/screens/project/EvidenceMark';
import { ItemInspector } from '@/screens/project/ItemInspector';
import { MilestoneHead, PlanList, PlanRow, ReasonLine } from '@/screens/project/PlanList';
import {
  milestoneCount,
  planGroups,
  planGlyph,
  planReason,
  planStage,
  type ShownPlanItem,
} from '@/screens/project/project-model';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

type Plan = NonNullable<ProjectPlanView['plan']>;

const change = (
  sessionId: string,
  status: ChangeRow['status'],
  extra: Partial<ChangeRow> = {},
): ChangeRow => ({
  id: `session:${sessionId}`,
  kind: 'session',
  title: `change of ${sessionId}`,
  runtime: 'codex',
  status,
  gate: { state: 'none' },
  updated_at: '2026-11-26T09:00:00.000Z',
  ...extra,
});

const item = (id: string, extra: Partial<PlanItemView> = {}): ShownPlanItem =>
  ({
    id,
    title: `Title of ${id}`,
    stage: 'plan',
    status: 'not_started',
    gate_runs: [],
    // The view names the session of its change row.
    ...(extra.change ? { session_id: extra.change.id.replace('session:', '') } : {}),
    ...extra,
  }) as ShownPlanItem;

const plan = (items: PlanItemView[], extra: Partial<Plan> = {}): Plan => ({
  session_id: 'lead',
  conductor_open: true,
  revision: 4,
  updated_at: '2026-11-26T09:00:00.000Z',
  milestones: [
    { id: 'signatures', title: 'Signature checks' },
    { id: 'audit', title: 'Audit log' },
    { id: 'unused', title: 'Nothing left in it' },
  ],
  items,
  ...extra,
});

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession =>
  ({ id, title: `session ${id}`, state: 'waiting', ...extra }) as WorkbenchSession;

const call = (node: ReactElement<any>) =>
  (node.type as (props: unknown) => ReactElement)(node.props);
const rendered = (tree: unknown, component: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => n.type === component)
    .map(call);
const imgLabels = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => n.props.role === 'img' && typeof n.type === 'string')
    .map((n) => n.props['aria-label'] as string);

beforeEach(() => useShell.setState({ screen: 'project', sessionId: null }));
afterEach(() => unmountAll());

describe('plan groups', () => {
  const items = [
    item('loose-first'),
    item('audit-schema', { milestone: 'audit', stage: 'write', status: 'running' }),
    item('compare-helper', { milestone: 'signatures', stage: 'landed', status: 'merged' }),
    item('stale-timestamps', { milestone: 'signatures', stage: 'checks', status: 'failed' }),
    item('given-up', { milestone: 'signatures', stage: 'dropped', dropped: true }),
    item('only-dropped', { milestone: 'unused', stage: 'dropped', dropped: true }),
    item('loose-second'),
  ];

  it('groups by milestone in the plan order, the items outside milestones last, without dropped items or empty groups', () => {
    expect(planGroups(plan(items)).map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ['Signature checks', ['compare-helper', 'stale-timestamps']],
      ['Audit log', ['audit-schema']],
      ['其他', ['loose-first', 'loose-second']],
    ]);
  });

  it('counts the landed and all shown items of a milestone and names each non-zero state in its bar', () => {
    const signatures = planGroups(plan(items))[0]!;
    expect(milestoneCount(signatures.items)).toMatchObject({
      landed: 1,
      total: 2,
      label: '2 项：1 已落地，1 失败',
    });
    const drawn = MilestoneHead({ group: signatures });
    expect(text(drawn)).toContain('1 / 2');
    expect(imgLabels(drawn)).toEqual(['2 项：1 已落地，1 失败']);
    expect(
      milestoneCount([
        item('a', { stage: 'write', status: 'running' }),
        item('b', { stage: 'review', status: 'running' }),
        item('c'),
      ]).label,
    ).toBe('3 项：2 进行中，1 未开始');
  });
});

describe('the reason under a plan item', () => {
  const upstream = item('upstream', { title: 'Migrate the secrets table', stage: 'write' });
  const schema = item('schema', { title: 'Design the schema', stage: 'review' });
  const landed = item('landed', { title: 'Already in', stage: 'landed', status: 'merged' });
  const all = [upstream, schema, landed];
  const sessions = [
    listed('asking', {
      recap: { headline: 'Migrating', happened: '', needs_you: 'Run the staging migration', at: 1 },
    }),
    listed('silent'),
  ];

  it.each([
    [
      'a failure the main agent knows of',
      item('x', {
        failure: {
          reason: 'webhook.rejects_stale failed twice',
          at: 't',
          handled_by: 'main_agent',
        },
      }),
      {
        kind: 'failure',
        text: 'webhook.rejects_stale failed twice',
        handledBy: 'main_agent',
      },
    ],
    [
      'a failure left to you, stuck as well',
      item('x', {
        failure: { reason: 'Lint failed', at: 't', handled_by: 'you' },
        stuck_since: '2026-11-26T08:00:00.000Z',
      }),
      {
        kind: 'failure',
        text: 'Lint failed',
        handledBy: 'you',
        stuckSince: '2026-11-26T08:00:00.000Z',
      },
    ],
    [
      'only stuck',
      item('x', { stuck_since: '2026-11-26T08:00:00.000Z', stage: 'write', status: 'running' }),
      { kind: 'stuck', stuckSince: '2026-11-26T08:00:00.000Z' },
    ],
    [
      'waiting on you with what the session asks',
      item('x', { stage: 'write', status: 'needs_you', change: change('asking', 'needs_you') }),
      { kind: 'needs_you', text: 'Run the staging migration', sessionId: 'asking' },
    ],
    [
      'waiting on you without a recap',
      item('x', { stage: 'write', status: 'needs_you', change: change('silent', 'needs_you') }),
      { kind: 'needs_you', text: '等你处理', sessionId: 'silent' },
    ],
    [
      'not started behind one item',
      item('x', { depends_on: ['upstream', 'landed'] }),
      { kind: 'waiting', text: '等 Migrate the secrets table 落地' },
    ],
    [
      'not started behind two items',
      item('x', { depends_on: ['upstream', 'schema'] }),
      { kind: 'waiting', text: '等 Migrate the secrets table、Design the schema 落地' },
    ],
  ] as const)('%s', (_name, shown, expected) => {
    expect(planReason(shown, all, sessions)).toEqual(expected);
  });

  it.each([
    ['an item not started whose dependencies all landed', item('x', { depends_on: ['landed'] })],
    [
      'a landed item whose session asks for later work',
      item('x', { stage: 'landed', status: 'merged', change: change('asking', 'needs_you') }),
    ],
  ] as const)('has no reason for %s', (_name, shown) => {
    expect(planReason(shown, all, sessions)).toBeNull();
  });

  it('shows the chips of a failure and how long it has been stuck', () => {
    const line = ReasonLine({
      reason: {
        kind: 'failure',
        text: 'Lint failed',
        handledBy: 'main_agent',
        stuckSince: '2026-11-26T08:29:00.000Z',
      },
      now: Date.parse('2026-11-26T09:00:00.000Z'),
    });
    expect(text(line)).toContain('Lint failed');
    expect(text(line)).toContain('主 agent 已知道');
    expect(text(line)).toContain('卡住 31 分钟');
  });
});

describe('the stage cells', () => {
  it.each([
    ['plan', 'not_started', '阶段：未开始', '未开始', 0],
    ['write', 'running', '阶段：写', '写', 2],
    ['write', 'not_started', '阶段：写', '写', 2],
    ['checks', 'failed', '阶段：检查', '检查', 3],
    ['review', 'running', '阶段：审查', '审查', 4],
    ['merge', 'ready', '阶段：合并', '合并', 5],
    ['landed', 'merged', '阶段：已落地', '已落地', 5],
    ['abandoned', 'abandoned', '阶段：已放弃', '已放弃', 0],
  ] as const)('%s, %s reads %s (%s) with %s cells lit', (stage, status, label, name, lit) => {
    const shown = planStage(item('x', { stage, status }));
    expect(shown.label).toBe(label);
    expect(shown.name).toBe(name);
    expect(shown.cells).toHaveLength(5);
    expect(shown.cells.filter((c) => c !== 'empty')).toHaveLength(lit);
    if (stage === 'landed') expect(shown.cells.every((c) => c === 'done')).toBe(true);
  });
});

describe('the state glyph', () => {
  it.each([
    [
      'a running session without a change row',
      item('x', { stage: 'write', status: 'running' }),
      'running',
    ],
    ['an item not started', item('x'), 'idle'],
    [
      'a landed item whose change is ready again',
      item('x', { stage: 'landed', status: 'merged', change: change('worker', 'ready') }),
      'merged',
    ],
    ['an abandoned item', item('x', { stage: 'abandoned', status: 'abandoned' }), 'discarded'],
  ] as const)('marks %s with its glyph', (_name, shown, glyph) => {
    expect(planGlyph(shown)).toBe(glyph);
  });
});

describe('the evidence mark', () => {
  it.each([
    [{ level: 'report' }, '只是自报'],
    [{ level: 'gate' }, '门禁通过'],
    [{ level: 'reviewed', reviewer: 'other_vendor' }, '另一家审过'],
    [{ level: 'reviewed', reviewer: 'other_runtime' }, '同家另一运行时审过'],
    [{ level: 'reviewed' }, '审过'],
    [{ level: 'accepted' }, '你已接受'],
  ] as const)('%o reads %s', (evidence, words) => {
    const mark = EvidenceMark({ evidence });
    expect(mark.props.role).toBe('img');
    expect(mark.props['aria-label']).toBe(`证据：${words}`);
    expect(text(mark)).toBe(words);
  });

  it('is a dash without evidence', () => {
    expect(text(EvidenceMark({ evidence: undefined }))).toBe('—');
  });
});

describe('the plan list', () => {
  const onSelect = vi.fn();
  beforeEach(() => onSelect.mockClear());
  const list = (shown: Plan | null, sessions: WorkbenchSession[] = []) =>
    mount(() => PlanList({ plan: shown, sessions, selected: null, onSelect }) as ReactElement);

  it('draws nothing without a plan', () => {
    expect(list(null).value).toBeNull();
  });

  it.each([
    ['says the main agent closed once it has', false, true],
    ['says nothing of the main agent while it is open', true, false],
  ] as const)('%s', (_name, open, says) => {
    const h = list(plan([item('x')], { conductor_open: open }));
    expect(text(h.value).includes('主 agent 已关闭')).toBe(says);
  });

  it('selects the item of a row from its title or the row, a row without a session too', () => {
    const h = list(
      plan([
        item('running', { stage: 'write', status: 'running', change: change('worker', 'running') }),
        item('queued'),
      ]),
    );
    const rows = rendered(h.value, PlanRow);
    const buttons = rows.map((row) => nodes(row).filter((n) => n.type === 'button'));
    expect(buttons.map((found) => text(found[0]))).toEqual(['Title of running', 'Title of queued']);
    buttons[0]![0]!.props.onClick();
    expect(onSelect).toHaveBeenLastCalledWith('running');
    (rows[1] as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(onSelect).toHaveBeenLastCalledWith('queued');
    expect(useShell.getState()).toMatchObject({ screen: 'project', sessionId: null });
  });

  it('opens from the details the session the row describes, not the first the item names, while it has no change row', () => {
    const self = item('self', {
      stage: 'write',
      session_ids: ['worker', 'lead'],
      session_id: 'lead',
    });
    const h = mount(
      () =>
        ItemInspector({
          item: self,
          plan: plan([self]),
          projectId: 'alpha',
          sessions: [],
          onClose() {},
        }) as ReactElement,
    );
    const button = nodes(h.value).find(
      (n) => n.type === 'button' && text(n) === zh('project.inspector.openSession'),
    )!;
    button.props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'lead' });
  });

  it('opens the waiting session from the handle button of its reason', () => {
    const h = list(
      plan([
        item('asking', {
          stage: 'write',
          status: 'needs_you',
          change: change('asking', 'needs_you'),
        }),
      ]),
      [listed('asking')],
    );
    const reason = rendered(rendered(h.value, PlanRow)[0], ReasonLine)[0];
    const handle = nodes(reason).find((n) => n.type === 'button' && text(n) === '去处理')!;
    const stopPropagation = vi.fn();
    handle.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'asking' });
  });

  it('names the gate runs and the stage of a row', () => {
    const h = list(
      plan([
        item('checked', {
          stage: 'checks',
          status: 'failed',
          change: change('checked', 'failed'),
          gate_runs: ['failed', 'passed'],
          diff: { files: 2, additions: 38, deletions: 6 },
        }),
      ]),
    );
    const row = rendered(h.value, PlanRow)[0];
    expect(imgLabels(row)).toEqual(expect.arrayContaining(['阶段：检查', '门禁 2 次，失败，通过']));
  });
});
