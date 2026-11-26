import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type {
  ChangeRow,
  PlanItemView,
  ProjectPlanView,
  WorkbenchSession,
} from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  plan: { read: null, error: null, loading: false, unavailable: false, stale: false } as any,
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
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ ...mock.plan, reload() {} }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
import { runCommand } from '@/data/commands';
import { ChangeDetails } from '@/screens/changes/ChangesScreen';
import { AgentList } from '@/screens/project/AgentList';
import { ItemInspector } from '@/screens/project/ItemInspector';
import { PlanList, PlanRow } from '@/screens/project/PlanList';
import {
  acceptAction,
  dependencyLabel,
  upstreamOf,
  type ShownPlanItem,
} from '@/screens/project/project-model';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { useShell } from '@/store';
import { zh, zhf } from './i18n-setup.js';

type Plan = NonNullable<ProjectPlanView['plan']>;

const change = (sessionId: string, extra: Partial<ChangeRow> = {}): ChangeRow => ({
  id: `session:${sessionId}`,
  kind: 'session',
  title: `change of ${sessionId}`,
  runtime: 'codex',
  branch: `pt/${sessionId}`,
  status: 'failed',
  gate: { state: 'failed', failed: ['Unit tests'] },
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
    ...(extra.change ? { session_id: extra.change.id.replace('session:', '') } : {}),
    ...extra,
  }) as ShownPlanItem;

const plan = (items: PlanItemView[]): Plan => ({
  session_id: 'lead',
  conductor_open: true,
  revision: 4,
  updated_at: '2026-11-26T09:00:00.000Z',
  milestones: [],
  items,
});

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession =>
  ({
    id,
    title: `title of ${id}`,
    runtime: 'codex',
    state: 'idle',
    last_activity_at: '2026-11-26T09:00:00.000Z',
    ...extra,
  }) as WorkbenchSession;

const onBoard = (id: string, extra: Partial<Session> = {}): Session =>
  ({ id, revision: 3, project_id: 'alpha', runtime: 'codex', state: 'open', ...extra }) as Session;

const sections = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => n.type === 'section')
    .map((n) => n.props['aria-label'] as string);
const button = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).find(
    (n) => n.type === 'button' && (text(n) === name || n.props['aria-label'] === name),
  );

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.plan = { read: null, error: null, loading: false, unavailable: false, stale: false };
  useShell.setState({ screen: 'project', sessionId: null });
  vi.mocked(runCommand).mockClear();
});
afterEach(() => unmountAll());

const inspector = (
  shown: ShownPlanItem,
  others: PlanItemView[] = [],
  sessions: WorkbenchSession[] = [],
) =>
  mount(
    () =>
      ItemInspector({
        item: shown,
        plan: plan([shown, ...others]),
        projectId: 'alpha',
        sessions,
        onClose() {},
      }) as ReactElement,
  );

describe('choosing a plan item', () => {
  const lead = listed('lead', { conductor: true });
  const items = [
    item('worked', { stage: 'checks', status: 'failed', change: change('worker') }),
    item('queued'),
  ];

  /** The screen with its plan list, the list's rows and the inspector drawn in the same host. */
  const at = { projectId: 'alpha' };
  const screen = () =>
    mount(() => {
      const tree = ProjectScreen({ projectId: at.projectId, sessions: [lead] }) as ReactElement;
      const list = nodes(tree).find((n) => n.type === PlanList);
      const rows = nodes(list && PlanList(list.props))
        .filter((n) => n.type === PlanRow)
        .map((n) => PlanRow(n.props) as ReactElement<any>);
      const shown = nodes(tree).find((n) => n.type === ItemInspector);
      return { tree, rows, inspector: shown && (ItemInspector(shown.props) as ReactElement<any>) };
    });

  it('opens the details of the row it selects, an item without a session too, in place of the agents, and closes them', () => {
    mock.plan.read = { plan: plan(items), unplanned: [] };
    const h = screen();
    expect(h.value.inspector).toBeUndefined();
    expect(nodes(h.value.tree).some((n) => n.type === AgentList)).toBe(true);
    const title = nodes(h.value.rows[1]).find((n) => n.type === 'button')!;
    expect(text(title)).toBe('Title of queued');
    title.props.onClick();
    h.render();
    expect(h.value.inspector!.type).toBe('aside');
    expect(h.value.inspector!.props['aria-label']).toBe(
      zhf('project.inspector.label', { title: 'Title of queued' }),
    );
    expect(h.value.rows.map((row) => row.props['aria-current'])).toEqual([undefined, 'true']);
    expect(nodes(h.value.tree).some((n) => n.type === AgentList)).toBe(false);
    expect(useShell.getState()).toMatchObject({ screen: 'project', sessionId: null });

    h.value.rows[0]!.props.onClick();
    h.render();
    expect(h.value.inspector!.props['aria-label']).toBe(
      zhf('project.inspector.label', { title: 'Title of worked' }),
    );
    expect(useShell.getState()).toMatchObject({ screen: 'project', sessionId: null });

    button(h.value.inspector, zh('project.inspector.close'))!.props.onClick();
    h.render();
    expect(h.value.inspector).toBeUndefined();
    expect(h.value.rows.map((row) => row.props['aria-current'])).toEqual([undefined, undefined]);
    expect(nodes(h.value.tree).some((n) => n.type === AgentList)).toBe(true);
  });

  it('keeps a selection to the project it was made in', () => {
    mock.plan.read = { plan: plan(items), unplanned: [] };
    at.projectId = 'alpha';
    const h = screen();
    nodes(h.value.rows[1])
      .find((n) => n.type === 'button')!
      .props.onClick();
    h.render();
    expect(h.value.inspector).toBeDefined();
    // Another project whose plan has an item of the same id.
    at.projectId = 'beta';
    h.render();
    expect(h.value.inspector).toBeUndefined();
    at.projectId = 'alpha';
  });

  it.each([
    ['removed from the plan', [items[0]!]],
    ['dropped', [items[0]!, item('queued', { stage: 'dropped', dropped: true })]],
  ] as const)('closes the details once the chosen item is %s', (_name, after) => {
    mock.plan.read = { plan: plan(items), unplanned: [] };
    const h = screen();
    h.value.rows[1]!.props.onClick();
    h.render();
    expect(h.value.inspector).toBeDefined();
    mock.plan.read = { plan: plan([...after]), unplanned: [] };
    h.render();
    expect(h.value.inspector).toBeUndefined();
    mock.plan.read = { plan: plan(items), unplanned: [] };
    h.render();
    expect(h.value.inspector).toBeUndefined();
  });
});

describe('the item inspector', () => {
  it('opens the session the item describes and has no such button without one', () => {
    const h = inspector(
      item('self', { stage: 'write', session_ids: ['worker', 'lead'], session_id: 'lead' }),
    );
    button(h.value, zh('project.inspector.openSession'))!.props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'lead' });
    expect(
      button(inspector(item('queued')).value, zh('project.inspector.openSession')),
    ).toBeUndefined();
  });

  it('shows the runtime, the branch, the diff size and the evidence in one line', () => {
    const h = inspector(
      item('worked', {
        stage: 'checks',
        status: 'failed',
        change: change('worker'),
        diff: { files: 2, additions: 38, deletions: 6 },
        evidence: { level: 'report' },
      }),
    );
    const shown = text(h.value);
    expect(shown).toContain('pt/worker');
    expect(shown).toContain('+38 −6');
    const drawn = (name: string) =>
      nodes(h.value).filter((n) => typeof n.type === 'function' && n.type.name === name);
    expect(drawn('RowMark').map((n) => n.props.row.runtime)).toEqual(['codex']);
    expect(drawn('EvidenceMark').map((n) => n.props.evidence)).toEqual([{ level: 'report' }]);
  });

  it('names the runtime of an item that has a session and no change row', () => {
    const h = inspector(
      item('lead', { session_id: 'lead' }),
      [],
      [listed('lead', { runtime: 'claude' })],
    );
    const marks = nodes(h.value)
      .filter((n) => n.props.role === 'img')
      .map((n) => n.props['aria-label'] as string);
    expect(marks).toContain('Claude');
  });

  it.each([
    [
      'a failure the main agent knows of, stuck as well',
      {
        failure: {
          reason: 'webhook.rejects_stale failed twice',
          at: '2026-11-26T08:56:00.000Z',
          handled_by: 'main_agent',
        },
        stuck_since: '2026-11-26T08:00:00.000Z',
      },
      ['webhook.rejects_stale failed twice', '主 agent 已知道', '卡住'],
    ],
    [
      'a failure left to you',
      { failure: { reason: 'Lint failed', at: '2026-11-26T08:56:00.000Z', handled_by: 'you' } },
      ['Lint failed', '等你处理'],
    ],
  ] as const)('shows the reason of %s', (_name, extra, words) => {
    const h = inspector(item('x', { stage: 'checks', status: 'failed', ...extra }));
    const failure = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.failure'),
    )!;
    for (const word of words) expect(text(failure)).toContain(word);
  });

  it.each([
    ['no failure', {}, 'project.inspector.failure', false],
    [
      'a failure',
      { failure: { reason: 'Lint failed', at: '2026-11-26T08:56:00.000Z', handled_by: 'you' } },
      'project.inspector.failure',
      true,
    ],
    ['no acceptance', {}, 'project.inspector.acceptance', false],
    ['an empty acceptance', { acceptance: [] }, 'project.inspector.acceptance', false],
    [
      'an acceptance',
      { acceptance: ['Stale timestamps get a 400', 'The public API stays'] },
      'project.inspector.acceptance',
      true,
    ],
    ['no dependency', {}, 'project.inspector.deps', false],
    ['a dependency', { depends_on: ['upstream'] }, 'project.inspector.deps', true],
  ] as const)('with %s has the section %s: %s', (_name, extra, id, present) => {
    const h = inspector(item('x', extra as Partial<PlanItemView>), [item('upstream')]);
    expect(sections(h.value).includes(zh(id))).toBe(present);
  });

  it('lists each acceptance line as text only, without a count or marks', () => {
    const h = inspector(
      item('x', { acceptance: ['Stale timestamps get a 400', 'The public API stays'] }),
    );
    const section = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.acceptance'),
    )!;
    expect(
      nodes(section)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual(['Stale timestamps get a 400', 'The public API stays']);
    expect(text(section)).not.toContain('/');
    expect(nodes(section).some((n) => n.props.role === 'img')).toBe(false);
  });

  it.each([
    ['with', true],
    ['without', false],
  ] as const)('draws the change details %s a change row', (_name, has) => {
    const row = change('worker');
    const sessions = [listed('worker')];
    const h = inspector(item('x', has ? { change: row } : {}), [], sessions);
    const details = nodes(h.value).filter((n) => n.type === ChangeDetails);
    expect(details.map((n) => [n.key, n.props.row, n.props.sessions])).toEqual(
      has ? [[row.id, row, sessions]] : [],
    );
  });

  it.each([
    ['reported', {}, '1.2M tokens'],
    ['unreported', { tokens_unreported: true }, null],
  ] as const)('shows the context and the %s use of its session', (_name, usage, tokens) => {
    mock.board.board.sessions = [
      onBoard('worker', {
        turn_count: 14,
        usage: { input_tokens: 1_000_000, output_tokens: 200_000, ...usage } as Session['usage'],
      }),
    ];
    const h = inspector(
      item('x', { change: change('worker') }),
      [],
      [listed('worker', { context: { used_tokens: 48, window_tokens: 100 } })],
    );
    const section = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.usage'),
    )!;
    expect(text(section)).toContain('48%');
    if (tokens) expect(text(section)).toContain(tokens);
    else expect(text(section)).not.toContain('tokens');
    expect(text(section)).toContain('14 回合');
    expect(
      nodes(section).some((n) => typeof n.type === 'function' && n.type.name === 'ContextRing'),
    ).toBe(true);
  });

  it('shows the turns and no token count of a session that has not reported its use', () => {
    mock.board.board.sessions = [onBoard('worker', { turn_count: 3 })];
    const h = inspector(item('x', { change: change('worker') }), [], [listed('worker')]);
    const section = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.usage'),
    )!;
    expect(text(section)).toContain('3 回合');
    expect(text(section)).not.toContain('tokens');
  });

  it('draws no context share for a window of unknown size', () => {
    const h = inspector(
      item('x', { change: change('worker') }),
      [],
      [listed('worker', { context: { used_tokens: 0, window_tokens: 0 } })],
    );
    const section = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.usage'),
    );
    expect(text(section ?? h.value)).not.toContain('NaN');
  });

  it('shows no token or turn count for a session the board has not read yet', () => {
    mock.board.board.sessions = [];
    const h = inspector(
      item('x', { change: change('worker') }),
      [],
      [listed('worker', { context: { used_tokens: 48, window_tokens: 100 } })],
    );
    const section = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('project.inspector.usage'),
    )!;
    expect(text(section)).toContain('48%');
    expect(text(section)).not.toMatch(/tokens|回合/);
  });

  it('has no use section without a listed session', () => {
    expect(sections(inspector(item('x')).value)).not.toContain(zh('project.inspector.usage'));
    expect(sections(inspector(item('x', { change: change('gone') })).value)).not.toContain(
      zh('project.inspector.usage'),
    );
  });
});

describe('the dependency graph', () => {
  const landed = item('signature', {
    title: 'Fix webhook signature',
    stage: 'landed',
    status: 'merged',
  });
  const open = item('schema', { title: 'Design the schema', stage: 'write', status: 'running' });
  const me = item('stale', { depends_on: ['signature', 'schema', 'unknown'] });

  it('takes the upstream items the plan knows, each with whether it landed', () => {
    expect(upstreamOf(me, [landed, open, me])).toEqual([
      { id: 'signature', title: 'Fix webhook signature', landed: true },
      { id: 'schema', title: 'Design the schema', landed: false },
    ]);
  });

  it('names each upstream item and whether it landed, then this item', () => {
    const name = '依赖：Fix webhook signature 已落地，Design the schema 没落地，之后是这一项';
    expect(dependencyLabel(upstreamOf(me, [landed, open, me]))).toBe(name);
    const h = inspector(me, [landed, open]);
    const graph = nodes(h.value).filter(
      (n) => n.props.role === 'img' && n.props['aria-label'] === name,
    );
    expect(graph).toHaveLength(1);
  });
});

describe('accepting an item', () => {
  it.each([
    ['offers to accept an item not accepted', item('x'), true, '接受', null],
    [
      'offers to take back an accepted item',
      item('x', { accepted: { at: '2026-11-26T09:00:00.000Z' } }),
      false,
      '取消接受',
      null,
    ],
    [
      'keeps the accept off while a failure stands',
      item('x', { failure: { reason: 'Lint failed', at: 't', handled_by: 'you' } }),
      true,
      '接受',
      '失败没解决，还不能接受',
    ],
  ] as const)('%s', (_name, shown, accepted, label, blocked) => {
    expect(acceptAction(shown)).toEqual({ accepted, label, blocked });
  });

  it.each([
    ['accepts an item not accepted', item('x'), true, '接受'],
    [
      'takes back an accepted item',
      item('x', { accepted: { at: '2026-11-26T09:00:00.000Z' } }),
      false,
      '取消接受',
    ],
  ] as const)('%s at the plan revision', async (_name, shown, accepted, label) => {
    const h = inspector(shown);
    const accept = button(h.value, label)!;
    expect(accept.props['aria-disabled']).toBeUndefined();
    accept.props.onClick();
    h.render();
    expect(button(h.value, label)!.props['aria-busy']).toBe(true);
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.plan.accept',
      { project_id: 'alpha', item_id: 'x', accepted },
      4,
    );
    expect(button(h.value, label)!.props['aria-busy']).toBeUndefined();
  });

  it('keeps the accept off while a failure stands and sends nothing', async () => {
    const h = inspector(
      item('x', { failure: { reason: 'Lint failed', at: 't', handled_by: 'you' } }),
    );
    const accept = button(h.value, '接受')!;
    expect(accept.props['aria-disabled']).toBe(true);
    const tip = nodes(h.value).find((n) => typeof n.type === 'function' && n.type.name === 'Tip')!;
    expect(tip.props.content).toBe('失败没解决，还不能接受');
    accept.props.onClick();
    await h.flush();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('shows the error when the daemon refuses it', async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan changed' },
    } as never);
    const h = inspector(item('x'));
    button(h.value, '接受')!.props.onClick();
    await h.flush();
    const alert = nodes(h.value).find((n) => n.props.role === 'alert');
    expect(text(alert)).toContain('The plan changed');
  });
});
