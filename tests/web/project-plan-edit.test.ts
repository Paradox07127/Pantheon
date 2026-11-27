import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { PlanItemView, ProjectPlanView, WorkbenchSession } from '@pantheon/protocol';
import { deferred, find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  listeners: new Set<(state: any) => void>(),
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
    subscribe: (listener: (state: any) => void) => {
      mock.listeners.add(listener);
      return () => mock.listeners.delete(listener);
    },
  }),
}));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ ...mock.plan, reload() {} }),
}));
vi.mock('@/data/project-resident', () => ({
  useProjectResident: () => ({
    read: {
      session_id: null,
      since: null,
      turns: { pantheon: 0, user: 0 },
      budget: null,
      wakes: [],
    },
    error: null,
    loading: false,
    reload() {},
  }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
import { runCommand } from '@/data/commands';
import { EMPTY_DRAFT, planContent, watchPlanTurns } from '@/screens/project/plan-edit';
import { PlanEditor, setPlanDraft } from '@/screens/project/PlanEditor';
import { PlanList, PlanRow } from '@/screens/project/PlanList';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { useShell } from '@/store';
import { zh, zhf } from './i18n-setup.js';

type Plan = NonNullable<ProjectPlanView['plan']>;

const item = (id: string, title: string, extra: Partial<PlanItemView> = {}): PlanItemView => ({
  id,
  title,
  milestone: 'm-1',
  stage: 'plan',
  status: 'not_started',
  gate_runs: [],
  ...extra,
});

const plan = (extra: Partial<Plan> = {}): Plan => ({
  session_id: 'lead',
  conductor_open: true,
  revision: 4,
  updated_at: '2026-11-26T09:00:00.000Z',
  milestones: [{ id: 'm-1', title: 'Beta' }],
  items: [
    item('plan-1', 'API'),
    item('plan-2', 'Docs'),
    item('plan-3', 'Fix login'),
    item('plan-5', 'Old idea', { stage: 'dropped', dropped: true }),
    item('plan-7', 'Ship', { accepted: { at: '2026-11-25T09:00:00.000Z' } }),
  ],
  ...extra,
});

const lead: WorkbenchSession = {
  id: 'lead',
  created_at: '2026-11-20T09:00:00.000Z',
  title: 'Lead',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-lead',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-20T10:00:00.000Z',
  changes: null,
  merge: null,
  conductor: true,
};

const onBoard = (state: Session['state'], turn_count: number): Session =>
  ({
    id: 'lead',
    revision: 9,
    project_id: 'alpha',
    runtime: 'claude',
    state,
    turn_count,
  }) as Session;

/** Puts the main agent on the board as the daemon's next update. */
const setSession = (session: Session) => {
  mock.board = { ...mock.board, board: { ...mock.board.board, sessions: [session] } };
  mock.listeners.forEach((listener) => listener(mock.board));
};

/** The plan once the main agent wrote the rename sent to it. */
const written = () =>
  plan({
    revision: 5,
    items: plan().items.map((i) =>
      i.id === 'plan-3' ? { ...i, title: 'Fix login and logout' } : i,
    ),
  });

let shown: Plan;
const listProps = (extra: Partial<Parameters<typeof PlanList>[0]> = {}) => ({
  plan: shown,
  sessions: [lead],
  selected: null,
  onSelect() {},
  projectId: 'alpha',
  main: lead,
  ...extra,
});

/** The plan list as drawn; in edit it is the editor's own tree. */
const list = (extra: Partial<Parameters<typeof PlanList>[0]> = {}) =>
  mount(() => {
    const tree = PlanList(listProps(extra)) as ReactElement<any> | null;
    return tree?.type === PlanEditor ? (PlanEditor(tree.props) as ReactElement) : tree;
  });

const buttonNamed = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).find(
    (n) => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === name,
  );
const inputs = (tree: unknown) => nodes(tree as ReactElement).filter((n) => n.type === 'input');
const titleInput = (tree: unknown, title: string) =>
  inputs(tree).find((n) => n.props['aria-label'] === zhf('project.plan.edit.itemTitle', { title }));
const rowOf = (tree: unknown, title: string) =>
  nodes(tree as ReactElement)
    .filter((n) => n.type === 'li')
    .find((li) => nodes(li).includes(titleInput(tree, title)!))!;
const editedMarks = (tree: unknown) =>
  nodes(tree as ReactElement).filter(
    (n) => n.props.role === 'img' && n.props['aria-label'] === zh('project.plan.edit.edited'),
  );
const sendButton = (tree: unknown) => buttonNamed(tree, zh('project.plan.edit.send'))!;
const sentLines = () => {
  const input = vi.mocked(runCommand).mock.calls.at(-1)![1].input as string;
  const [head, ...lines] = input.split('\n');
  expect(head).toContain('write_plan');
  return lines;
};
const send = async () => {
  const h = list();
  sendButton(h.value).props.onClick();
  await h.flush();
  return h;
};
/** The ids of the read-only rows marked pending. */
const pendingRows = () =>
  nodes(list().value)
    .filter((n) => n.type === PlanRow)
    .filter((n) => n.props.pending)
    .map((n) => n.props.item.id)
    .sort();
const pendingMarks = (tree: unknown) =>
  nodes(tree as ReactElement).filter(
    (n) => n.props.role === 'img' && n.props['aria-label'] === zh('project.plan.pending'),
  );

beforeEach(() => {
  shown = plan();
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [onBoard('open', 1)], workspaces: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  useShell.setState({ screen: 'project', planDrafts: {}, planPending: {}, planErrors: {} });
  vi.mocked(runCommand).mockClear();
  watchPlanTurns();
});
afterEach(() => {
  unmountAll();
  mock.listeners.clear();
});

const startEdit = () => buttonNamed(list().value, zh('project.plan.edit'))!.props.onClick();

describe('the edit button of the plan list', () => {
  it.each([
    ['is offered in the list with an open main agent', {}, true],
    ['is not offered in the flow', { view: 'flow' as const }, false],
    ['is not offered without a main agent', { main: null }, false],
    ['is not offered once the main agent closed', { plan: plan({ conductor_open: false }) }, false],
  ])('%s', (_name, extra, offered) => {
    const h = list(extra);
    expect(!!buttonNamed(h.value, zh('project.plan.edit'))).toBe(offered);
    expect(inputs(h.value)).toEqual([]);
  });

  it('gets the project and its main agent from the project screen', () => {
    mock.plan = { ...mock.plan, read: { plan: shown, unplanned: [] } };
    const h = mount(() => ProjectScreen({ projectId: 'alpha', sessions: [lead] }) as ReactElement);
    const props = find(h.value, (n) => n.type === PlanList).props;
    expect(props.projectId).toBe('alpha');
    expect(props.main.id).toBe('lead');
  });
});

describe('editing the plan', () => {
  it.each([
    [
      'a new title',
      (tree: unknown) =>
        titleInput(tree, 'Fix login')!.props.onChange({
          target: { value: 'Fix login and logout' },
        }),
      ['rename plan-3 "Fix login" -> "Fix login and logout"'],
      'Fix login',
      ['plan-3'],
    ],
    [
      'a dropped item',
      (tree: unknown) =>
        buttonNamed(rowOf(tree, 'API'), zh('project.plan.edit.drop'))!.props.onClick(),
      ['drop plan-1 "API"'],
      'API',
      ['plan-1'],
    ],
    [
      'an item restored',
      (tree: unknown) =>
        buttonNamed(rowOf(tree, 'Old idea'), zh('project.plan.edit.restore'))!.props.onClick(),
      ['restore plan-5 "Old idea"'],
      'Old idea',
      ['plan-5'],
    ],
    [
      'an item moved up',
      (tree: unknown) =>
        buttonNamed(rowOf(tree, 'Docs'), zh('project.plan.edit.up'))!.props.onClick(),
      [
        'order milestone m-1 "Beta": plan-2 "Docs", plan-1 "API", plan-3 "Fix login", plan-5 "Old idea", plan-7 "Ship"',
      ],
      'Docs',
      ['plan-1', 'plan-2'],
    ],
    [
      'an item moved down',
      (tree: unknown) =>
        buttonNamed(rowOf(tree, 'API'), zh('project.plan.edit.down'))!.props.onClick(),
      [
        'order milestone m-1 "Beta": plan-2 "Docs", plan-1 "API", plan-3 "Fix login", plan-5 "Old idea", plan-7 "Ship"',
      ],
      'API',
      ['plan-1', 'plan-2'],
    ],
    [
      'a milestone turned round',
      () =>
        setPlanDraft('alpha', {
          ...EMPTY_DRAFT,
          order: { 'm-1': ['plan-3', 'plan-5', 'plan-7', 'plan-1', 'plan-2'] },
        }),
      [
        'order milestone m-1 "Beta": plan-3 "Fix login", plan-5 "Old idea", plan-7 "Ship", plan-1 "API", plan-2 "Docs"',
      ],
      'API',
      ['plan-1', 'plan-2', 'plan-3', 'plan-5', 'plan-7'],
    ],
  ])(
    'sends %s as its line and marks its row',
    async (_name, edit, lines, title, pending: string[]) => {
      startEdit();
      edit(list().value);
      const h = list();
      expect(editedMarks(rowOf(h.value, title))).toHaveLength(1);
      await send();
      expect(sentLines()).toEqual(lines);
      expect(pendingRows()).toEqual(pending);
    },
  );

  it('orders the items outside every milestone on their own line', async () => {
    shown = plan({
      items: [
        item('plan-1', 'API', { milestone: undefined }),
        item('plan-2', 'Docs', { milestone: undefined }),
      ],
    });
    startEdit();
    buttonNamed(rowOf(list().value, 'Docs'), zh('project.plan.edit.up'))!.props.onClick();
    await send();
    expect(sentLines()).toEqual(['order outside every milestone: plan-2 "Docs", plan-1 "API"']);
  });

  it('sends a new item at the end of its milestone after the last item', async () => {
    startEdit();
    buttonNamed(list().value, zhf('project.plan.edit.addTo', { group: 'Beta' }))!.props.onClick();
    const added = inputs(list().value).find(
      (n) => n.props['aria-label'] === zhf('project.plan.edit.newTitle', { group: 'Beta' }),
    )!;
    added.props.onChange({ target: { value: 'Write release notes' } });
    expect(editedMarks(list().value)).toHaveLength(1);
    await send();
    expect(sentLines()).toEqual([
      'add "Write release notes" to milestone m-1 "Beta", after plan-7 "Ship"',
    ]);
    const beta = () =>
      find(list().value, (n) => n.props.role === 'group' && n.props['aria-label'] === 'Beta');
    const row = nodes(beta())
      .filter((n) => n.type === 'li')
      .find((li) => text(li).includes('Write release notes'));
    expect(row).toBeDefined();
    expect(pendingMarks(row)).toHaveLength(1);
    expect(nodes(row).filter((n) => n.type === 'button')).toEqual([]);
    shown = written();
    expect(text(beta())).not.toContain('Write release notes');
  });

  it('offers no drop for an item the user accepted, and a restore once it is dropped', () => {
    shown = plan({
      items: [
        ...plan().items,
        item('plan-8', 'Kept', {
          stage: 'dropped',
          dropped: true,
          accepted: { at: '2026-11-25T09:00:00.000Z' },
        }),
      ],
    });
    startEdit();
    const h = list();
    expect(buttonNamed(rowOf(h.value, 'Ship'), zh('project.plan.edit.drop'))).toBeUndefined();
    expect(buttonNamed(rowOf(h.value, 'Docs'), zh('project.plan.edit.drop'))).toBeDefined();
    expect(buttonNamed(rowOf(h.value, 'Kept'), zh('project.plan.edit.restore'))).toBeDefined();
  });

  it('takes back the restore of an item the user accepted and the plan dropped', () => {
    shown = plan({
      items: [
        item('plan-8', 'Kept', {
          stage: 'dropped',
          dropped: true,
          accepted: { at: '2026-11-25T09:00:00.000Z' },
        }),
      ],
    });
    startEdit();
    buttonNamed(rowOf(list().value, 'Kept'), zh('project.plan.edit.restore'))!.props.onClick();
    const undo = buttonNamed(rowOf(list().value, 'Kept'), zh('project.plan.edit.drop'));
    expect(undo).toBeDefined();
    undo!.props.onClick();
    const h = list();
    expect(buttonNamed(rowOf(h.value, 'Kept'), zh('project.plan.edit.restore'))).toBeDefined();
    expect(editedMarks(rowOf(h.value, 'Kept'))).toEqual([]);
  });

  it('keeps an item the user accepted after the draft dropped it', () => {
    startEdit();
    buttonNamed(rowOf(list().value, 'API'), zh('project.plan.edit.drop'))!.props.onClick();
    shown = plan({
      items: plan().items.map((i) =>
        i.id === 'plan-1' ? { ...i, accepted: { at: '2026-11-26T10:00:00.000Z' } } : i,
      ),
    });
    const h = list();
    expect(editedMarks(rowOf(h.value, 'API'))).toEqual([]);
    expect(buttonNamed(rowOf(h.value, 'API'), zh('project.plan.edit.restore'))).toBeUndefined();
    expect(sendButton(h.value).props.disabled).toBe(true);
  });

  it.each([
    ['as it is', () => plan()],
    [
      'with spaces around a title',
      () => plan({ items: [item('plan-1', ' API '), item('plan-2', 'Docs')] }),
    ],
  ])('cannot send without an edit to the plan %s', (_name, make) => {
    shown = make();
    startEdit();
    expect(editedMarks(list().value)).toEqual([]);
    expect(sendButton(list().value).props.disabled).toBe(true);
  });

  it.each([
    ['a plan without milestones', () => plan({ milestones: [], items: [] }), EMPTY_DRAFT],
    [
      'a draft that added an item there',
      () => plan(),
      { ...EMPTY_DRAFT, added: { '': [{ key: 'loose', title: '' }] } },
    ],
  ])(
    'offers the items outside every milestone for %s and sends what it adds',
    async (_name, make, draft) => {
      shown = make();
      setPlanDraft('alpha', draft);
      const other = zh('project.plan.other');
      const add = buttonNamed(list().value, zhf('project.plan.edit.addTo', { group: other }));
      expect(add).toBeDefined();
      add!.props.onClick();
      inputs(list().value)
        .find((n) => n.props['aria-label'] === zhf('project.plan.edit.newTitle', { group: other }))!
        .props.onChange({ target: { value: 'Loose end' } });
      await send();
      expect(sentLines()).toEqual(['add "Loose end" outside every milestone']);
    },
  );

  it('edits an item and a milestone whose ids are names on every object', async () => {
    shown = plan({
      milestones: [{ id: 'toString', title: 'Beta' }],
      items: [
        item('constructor', 'API', { milestone: 'toString' }),
        item('valueOf', 'Docs', { milestone: 'toString' }),
      ],
    });
    startEdit();
    titleInput(list().value, 'API')!.props.onChange({ target: { value: 'API v2' } });
    buttonNamed(rowOf(list().value, 'Docs'), zh('project.plan.edit.up'))!.props.onClick();
    await send();
    expect(sentLines()).toEqual([
      'rename constructor "API" -> "API v2"',
      'order milestone toString "Beta": valueOf "Docs", constructor "API"',
    ]);
  });

  it('takes titles of at most 120 characters, as write_plan does', () => {
    startEdit();
    buttonNamed(list().value, zhf('project.plan.edit.addTo', { group: 'Beta' }))!.props.onClick();
    const lengths = inputs(list().value).map((n) => n.props.maxLength);
    expect(lengths).toHaveLength(6);
    expect(lengths.every((n) => n === 120)).toBe(true);
  });

  // write_plan takes at most 40 items, dropped ones among them.
  const items = (count: number) =>
    Array.from({ length: count }, (_, k) =>
      item(`plan-${k}`, `Item ${k}`, k === 0 ? { stage: 'dropped', dropped: true } : {}),
    );
  /** New items sent to the main agent in the turn it is about to run, not yet written. */
  const sentAdds = (titles: string[], to = 'lead') =>
    useShell.setState({
      planPending: {
        alpha: {
          content: planContent(shown),
          sessionId: to,
          turn: 2,
          items: [],
          added: titles.map((title) => ({ group: 'm-1', title })),
        },
      },
    });

  it.each([
    [38, 0, 'lead', false],
    [39, 0, 'lead', true],
    [37, 1, 'lead', false],
    [38, 1, 'lead', true],
    [38, 1, 'earlier-lead', true],
  ])(
    'with %i items, %i sent to %s and one added, adding another is off: %s',
    (count, sent, to, off) => {
      shown = plan({ items: items(count) });
      if (to !== 'lead')
        mock.board = {
          ...mock.board,
          board: {
            ...mock.board.board,
            sessions: [onBoard('open', 1), { ...onBoard('running', 2), id: to }],
          },
        };
      sentAdds(
        Array.from({ length: sent }, (_, k) => `Sent ${k}`),
        to,
      );
      startEdit();
      const add = () =>
        buttonNamed(list().value, zhf('project.plan.edit.addTo', { group: 'Beta' }))!;
      add().props.onClick();
      expect(!!add().props.disabled).toBe(off);
    },
  );

  it('does not send new items past the limit and says why', async () => {
    shown = plan({ items: items(39) });
    sentAdds(['Sent']);
    setPlanDraft('alpha', {
      ...EMPTY_DRAFT,
      added: { 'm-1': [{ key: 'new', title: 'One more' }] },
    });
    await send();
    expect(runCommand).not.toHaveBeenCalled();
    expect(text(nodes(list().value).find((n) => n.props.role === 'alert'))).toBe(
      zhf('project.plan.edit.full', { max: 40 }),
    );
  });
});

describe('sending the edits', () => {
  const renameAndDrop = () => {
    startEdit();
    const h = list();
    titleInput(h.value, 'Fix login')!.props.onChange({ target: { value: 'Fix login and logout' } });
    buttonNamed(rowOf(list().value, 'API'), zh('project.plan.edit.drop'))!.props.onClick();
  };

  it.each([
    ['sends to an idle main agent', 'open', 'session.send'],
    ['steers a running main agent', 'running', 'session.steer'],
  ] as const)('%s', async (_name, state, command) => {
    setSession(onBoard(state, 1));
    renameAndDrop();
    await send();
    expect(runCommand).toHaveBeenCalledWith(
      command,
      { session_id: 'lead', input: expect.any(String) },
      9,
    );
    expect(sentLines()).toEqual([
      'drop plan-1 "API"',
      'rename plan-3 "Fix login" -> "Fix login and logout"',
    ]);
    expect(inputs(list().value)).toEqual([]);
  });

  const refused = { ok: false, error: { code: 'resource_busy', message: 'The session is busy' } };
  const alerts = (tree: unknown) =>
    nodes(tree as ReactElement).filter((n) => n.props.role === 'alert');

  it.each([
    ['at once', () => {}],
    ['once the list is left and drawn again', () => unmountAll()],
  ])('keeps the draft and shows the error when the daemon refuses it, %s', async (_name, then) => {
    vi.mocked(runCommand).mockResolvedValueOnce(refused as never);
    renameAndDrop();
    await send();
    then();
    expect(text(alerts(list().value)[0])).toContain('The session is busy');
    expect(titleInput(list().value, 'Fix login')!.props.value).toBe('Fix login and logout');
    expect(titleInput(list().value, 'Fix login')!.props.readOnly).toBe(false);
  });

  it('clears the error on another send and on discarding', async () => {
    vi.mocked(runCommand).mockResolvedValueOnce(refused as never);
    renameAndDrop();
    await send();
    const reply = deferred<typeof refused>();
    vi.mocked(runCommand).mockReturnValueOnce(reply.promise as never);
    const h = list();
    sendButton(h.value).props.onClick();
    expect(alerts(list().value)).toEqual([]);
    reply.resolve(refused);
    await h.flush();
    expect(alerts(list().value)).toHaveLength(1);
    buttonNamed(list().value, zh('project.plan.edit.discard'))!.props.onClick();
    startEdit();
    expect(alerts(list().value)).toEqual([]);
  });

  it('keeps the draft read-only while the send is on its way, also once the list is drawn again', async () => {
    const reply = deferred<{ ok: true; value: null }>();
    vi.mocked(runCommand).mockReturnValueOnce(reply.promise as never);
    renameAndDrop();
    sendButton(list().value).props.onClick();
    unmountAll();
    const h = list();
    expect(titleInput(h.value, 'Fix login')!.props.readOnly).toBe(true);
    expect(sendButton(h.value).props.disabled).toBe(true);
    expect(buttonNamed(rowOf(h.value, 'Docs'), zh('project.plan.edit.drop'))!.props.disabled).toBe(
      true,
    );
    sendButton(h.value).props.onClick();
    reply.resolve({ ok: true, value: null });
    await h.flush();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(useShell.getState().planDrafts.alpha).toBeUndefined();
    expect(inputs(list().value)).toEqual([]);
  });

  it('keeps a draft started while the send was on its way', async () => {
    const reply = deferred<{ ok: true; value: null }>();
    vi.mocked(runCommand).mockReturnValueOnce(reply.promise as never);
    renameAndDrop();
    const h = list();
    sendButton(h.value).props.onClick();
    const next = { ...EMPTY_DRAFT, titles: { 'plan-2': 'Docs and examples' } };
    setPlanDraft('alpha', next);
    reply.resolve({ ok: true, value: null });
    await h.flush();
    expect(useShell.getState().planDrafts.alpha).toBe(next);
  });

  it('keeps the draft when the list is left and drawn again, and discarding clears it', () => {
    renameAndDrop();
    unmountAll();
    const h = list();
    expect(titleInput(h.value, 'Fix login')!.props.value).toBe('Fix login and logout');
    buttonNamed(h.value, zh('project.plan.edit.discard'))!.props.onClick();
    expect(inputs(list().value)).toEqual([]);
    startEdit();
    expect(titleInput(list().value, 'Fix login')!.props.value).toBe('Fix login');
  });
});

describe('edits sent and not yet written', () => {
  const rename = () => {
    startEdit();
    titleInput(list().value, 'Fix login')!.props.onChange({
      target: { value: 'Fix login and logout' },
    });
  };
  const drop = () => {
    startEdit();
    buttonNamed(rowOf(list().value, 'API'), zh('project.plan.edit.drop'))!.props.onClick();
  };
  const sendTwo = async () => {
    rename();
    buttonNamed(rowOf(list().value, 'API'), zh('project.plan.edit.drop'))!.props.onClick();
    await send();
  };

  it('marks the items the edits name as pending', async () => {
    await sendTwo();
    expect(pendingRows()).toEqual(['plan-1', 'plan-3']);
    const row = nodes(list().value).find(
      (n) => n.type === PlanRow && n.props.item.id === 'plan-3',
    )!;
    const marks = nodes(PlanRow(row.props) as ReactElement).filter(
      (n) => n.props.role === 'img' && n.props['aria-label'] === zh('project.plan.pending'),
    );
    expect(marks).toHaveLength(1);
  });

  it.each([
    ['drops the mark once the main agent wrote the plan', written, []],
    [
      'keeps the mark when the user accepted an item meanwhile',
      () =>
        plan({
          revision: 5,
          updated_at: '2026-11-26T10:00:00.000Z',
          items: plan().items.map((i) =>
            i.id === 'plan-2' ? { ...i, accepted: { at: '2026-11-26T10:00:00.000Z' } } : i,
          ),
        }),
      ['plan-1', 'plan-3'],
    ],
  ])('%s', async (_name, next, marked) => {
    await sendTwo();
    shown = next();
    expect(pendingRows()).toEqual(marked);
  });

  it.each([
    ['', {}],
    [
      ' with nothing to handle while its session waits on the user',
      {
        status: 'needs_you',
        change: {
          id: 'session:asking',
          kind: 'session',
          title: 'change of asking',
          runtime: 'codex',
          status: 'needs_you',
          gate: { state: 'none' },
          updated_at: '2026-11-26T09:00:00.000Z',
        },
      },
    ],
  ] as const)('marks a restored item pending and does not open it%s', async (_name, extra) => {
    shown = plan({
      items: plan().items.map((i) =>
        i.id === 'plan-5' ? ({ ...i, ...extra } as PlanItemView) : i,
      ),
    });
    startEdit();
    buttonNamed(rowOf(list().value, 'Old idea'), zh('project.plan.edit.restore'))!.props.onClick();
    await send();
    const row = nodes(list().value).find(
      (n) => n.type === PlanRow && n.props.item.id === 'plan-5',
    )!;
    expect(row.props.pending).toBe(true);
    expect(row.props.reason).toBeNull();
    const drawn = PlanRow(row.props) as ReactElement<any>;
    expect(nodes(drawn).filter((n) => n.type === 'button')).toEqual([]);
    expect(drawn.props.onClick).toBeUndefined();
  });

  // The board as the daemon writes it: an accepted send or steer adds one turn and runs.
  it.each([
    [
      'sent to an idle main agent',
      onBoard('open', 1),
      [
        [onBoard('open', 1), true],
        [onBoard('running', 2), true],
        [onBoard('open', 2), false],
        [onBoard('running', 3), false],
      ],
    ],
    [
      'steered into a running turn',
      onBoard('running', 1),
      [
        [onBoard('running', 1), true],
        [onBoard('running', 2), true],
        [onBoard('running', 3), true],
        [onBoard('open', 3), false],
        [onBoard('running', 4), false],
      ],
    ],
    [
      'whose turn ended while the list was not drawn',
      onBoard('open', 1),
      [
        [onBoard('running', 2), null],
        [onBoard('open', 2), null],
        [onBoard('running', 3), false],
      ],
    ],
  ] as const)(
    'keeps the mark of edits %s until that turn ended',
    async (_name, at, boards: readonly (readonly [Session, boolean | null])[]) => {
      setSession(at);
      await sendTwo();
      unmountAll();
      // null: the list is not drawn while the board shows that.
      for (const [session, marked] of boards) {
        setSession(session);
        if (marked !== null) expect(pendingRows()).toEqual(marked ? ['plan-1', 'plan-3'] : []);
        unmountAll();
      }
    },
  );

  it.each([
    ['adds to the marks of a send not yet written', () => {}, ['plan-1', 'plan-3']],
    ['replaces the marks once the plan was written', () => (shown = written()), ['plan-1']],
    [
      'replaces the marks of a turn that ended before another one started',
      () => {
        setSession(onBoard('open', 2));
        pendingRows();
        setSession(onBoard('running', 3));
      },
      ['plan-1'],
    ],
  ])('a second send %s', async (_name, between, marked) => {
    rename();
    await send();
    setSession(onBoard('running', 2));
    between();
    drop();
    await send();
    const turn = mock.board.board.sessions[0].turn_count + 1;
    expect(pendingRows()).toEqual(marked);
    setSession(onBoard('running', turn));
    expect(pendingRows()).toEqual(marked);
    setSession(onBoard('open', turn));
    expect(pendingRows()).toEqual([]);
  });
});
