import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BridgeResult, LearnedItem } from '@pantheon/protocol';
import {
  HookHost,
  find,
  named,
  nodes,
  text,
  unmountAll,
  mount as mountHost,
} from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'learned-id' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { useShell } from '@/store';
import { LearnedDetail } from '@/screens/memory/LearnedDetail';
import { LearnedList } from '@/screens/memory/LearnedList';
import { LearnedPage } from '@/screens/memory/LearnedPage';
import { zh, zhf } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const learned = (over: Partial<LearnedItem> & { id: string }): LearnedItem => ({
  kind: 'experience',
  grade: 'trial',
  status: 'candidate',
  group: 'needs_you',
  diff: { from: '', to: `Rule ${over.id}.` },
  evidence: [],
  actions: [],
  at: Date.now() - 60_000,
  ...over,
});

const items: LearnedItem[] = [
  learned({
    id: 'imp-c',
    actions: [
      { command: 'improvement.decide', decision: 'confirm' },
      { command: 'improvement.decide', decision: 'reject' },
    ],
    evidence: [
      { kind: 'retrospective', id: 'r1', title: 'Refund retries' },
      { kind: 'session', id: 's1' },
      { kind: 'gate_run', id: 'g1' },
    ],
  }),
  learned({
    id: 'imp-t',
    kind: 'policy_change',
    title: 'max_parallel',
    status: 'trial',
    group: 'on_trial',
    diff: { from: '3', to: '4' },
    n: 3,
    tasks_required: 5,
    actions: [
      { command: 'improvement.decide', decision: 'revert' },
      { command: 'improvement.decide', decision: 'pin' },
    ],
  }),
  learned({
    id: 'prop-1',
    kind: 'agent_change',
    title: 'reviewer',
    grade: 'confirm',
    status: 'pending',
    diff: { from: 'Review diffs.', to: 'Review diffs.\nAsk for missing tests.' },
    evidence: [{ kind: 'session', id: 's2' }],
    actions: [
      { command: 'agent.proposal.resolve', decision: 'create' },
      { command: 'agent.proposal.resolve', decision: 'decline' },
    ],
  }),
  learned({
    id: 'wf-1',
    kind: 'workflow_definition',
    status: 'trial',
    diff: { from: '{\n  "steps": 3\n}', to: '{\n  "steps": 4\n}' },
    n: 5,
    actions: [
      { command: 'workflow.definition.trial.decide', decision: 'keep' },
      { command: 'workflow.definition.trial.decide', decision: 'revert' },
    ],
  }),
  learned({
    id: 'mem-1',
    kind: 'memory_note',
    grade: 'auto',
    status: 'active',
    group: 'in_force',
    title: 'Webhook tests',
    diff: { from: '', to: 'Webhook signature tests need TZ=UTC.' },
    actions: [{ command: 'memory.archive' }],
  }),
  learned({
    id: 'imp-x',
    status: 'reverted',
    group: 'reverted',
    verdict: 'worse',
    n: 4,
  }),
];

const bridge = {
  items,
  reads: 0,
  queries: [] as { method: string; params: Record<string, string> }[],
  commands: [] as Command[],
  answer: null as BridgeResult<unknown> | null,
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    if (method === 'learned.list') {
      bridge.reads++;
      return { ok: true, value: bridge.items };
    }
    if (method === 'memory.item') return { ok: true, value: { id: params.memory_id, revision: 4 } };
    if (method === 'board.view') return { ok: true, value: { since: 0, now: 1, tasks: [] } };
    if (method === 'improvement.sessions' || method === 'session.list')
      return { ok: true, value: [] };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.answer ?? { ok: true, value: {} };
  },
};

const tree = (h: HookHost<any>) => h.value as ReactNode;
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);
const listboxes = (t: ReactNode) => nodes(t).filter((n) => n.props.role === 'listbox');
const rows = (t: ReactNode) => nodes(t).filter((n) => n.props.role === 'option');
const item = (id: string) => items.find((i) => i.id === id)!;

async function mountPage(onOpenRetros = () => {}) {
  const h = mountHost(() => LearnedPage({ projectId: 'pay', onOpenRetros }));
  await h.flush();
  return h;
}
async function mountDetail(id: string, onOpenRetro = () => {}) {
  const h = mountHost(() =>
    LearnedDetail({ projectId: 'pay', item: item(id), onClose: () => {}, onOpenRetro }),
  );
  await h.flush();
  return h;
}
const mountList = () => mountHost(() => LearnedList({ items, selected: null, onSelect: vi.fn() }));

beforeEach(() => {
  bridge.items = items;
  bridge.reads = 0;
  bridge.queries = [];
  bridge.commands = [];
  bridge.answer = null;
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [] },
    events: [],
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null, events: [] } as never);
});

describe('learned inbox', () => {
  it('reads the learned changes of the project and opens on the first that needs you', async () => {
    const h = await mountPage();
    expect(bridge.queries.filter((q) => q.method === 'learned.list')).toEqual([
      { method: 'learned.list', params: { project_id: 'pay' } },
    ]);
    const list = named(tree(h), 'LearnedList');
    expect(list.props.items.map((i: LearnedItem) => i.id)).toEqual(items.map((i) => i.id));
    expect(list.props.selected).toBe('imp-c');
    expect(named(tree(h), 'LearnedDetail').props.item.id).toBe('imp-c');
  });

  it('reads them again after a learned change event of the project, not after others', async () => {
    const h = await mountPage();
    const push = async (kind: string, project_id: string, sequence: number) => {
      useBoard.setState(
        (s) =>
          ({
            events: [...s.events, { kind, project_id, sequence }],
          }) as never,
      );
      h.render();
      await h.flush();
    };
    const reads = bridge.reads;
    await push('turn.completed', 'pay', 10);
    await push('improvement.status_changed', 'other', 11);
    expect(bridge.reads).toBe(reads);
    await push('improvement.status_changed', 'pay', 12);
    expect(bridge.reads).toBe(reads + 1);
    await push('memory.archived', 'pay', 13);
    expect(bridge.reads).toBe(reads + 2);
  });

  it('groups the changes into needs you, on trial and in force, the reverted folded', () => {
    const h = mountList();
    expect(listboxes(tree(h)).map((n) => n.props['aria-label'])).toEqual([
      zh('memory.learned.group.candidate'),
      zh('memory.learned.group.trial'),
      zh('memory.learned.group.active'),
    ]);
    expect(listboxes(tree(h)).map((n) => rows(n).map((r) => r.key))).toEqual([
      ['imp-c', 'prop-1', 'wf-1'],
      ['imp-t'],
      ['mem-1'],
    ]);
    const fold = find(tree(h), (n) => 'aria-expanded' in n.props);
    expect(fold.props['aria-expanded']).toBe(false);
    expect(text(fold.props.children)).toBe(`${zh('memory.learned.group.closed')}1`);
    fold.props.onClick();
    h.render();
    expect(rows(listboxes(tree(h))[3]).map((r) => r.key)).toEqual(['imp-x']);
  });

  it('names each row by its title, kind and group', () => {
    const names = Object.fromEntries(
      rows(tree(mountList())).map((r) => [r.key, r.props['aria-label']]),
    );
    expect(names['imp-t']).toBe(
      zhf('memory.learned.row', {
        title: '并发上限从 3 改成 4',
        kind: zh('memory.learned.kind.policyChange'),
        group: zh('memory.learned.group.trial'),
      }),
    );
    expect(names['mem-1']).toBe(
      zhf('memory.learned.row', {
        title: 'Webhook signature tests need TZ=UTC.',
        kind: zh('memory.learned.kind.memoryNote'),
        group: zh('memory.learned.group.active'),
      }),
    );
    expect(names['wf-1']).toContain('{"steps":4}');
  });

  it('says a trial without a verdict has not enough evidence yet, with its tasks so far', async () => {
    const trial = rows(tree(mountList())).find((r) => r.key === 'imp-t')!;
    expect(text(trial.props.children)).toContain(
      `${zh('memory.learned.verdict.notEnoughEvidence')}3 / 5 个任务`,
    );
    const h = await mountDetail('imp-t');
    const result = find(
      tree(h),
      (n) => n.props['aria-label'] === zh('memory.learnedDetail.trialResult'),
    );
    expect(result.props.role).toBe('group');
    expect(text(result)).toBe(
      `${zh('memory.learnedDetail.trial')}${zh('memory.learned.verdict.notEnoughEvidence')}${zh('memory.learnedDetail.trialTasks')}3 / 5 个任务`,
    );
    const ended = rows(tree(mountList())).find((r) => r.key === 'wf-1')!;
    expect(text(ended.props.children)).not.toContain(
      zh('memory.learned.verdict.notEnoughEvidence'),
    );
  });

  it('draws the change as lines removed and added', async () => {
    const h = await mountDetail('prop-1');
    const diff = find(tree(h), (n) => n.type === 'ul');
    expect(diff.props['aria-label']).toBe(
      zhf('memory.learnedDetail.change', { removed: 0, added: 1 }),
    );
    expect(
      nodes(diff.props.children)
        .filter((n) => n.type === 'li')
        .map((li) => [li.props['data-kind'], text(li)]),
    ).toEqual([
      [undefined, 'Review diffs.'],
      ['add', '+Ask for missing tests.'],
    ]);
    const wf = await mountDetail('wf-1');
    const lines = nodes(find(tree(wf), (n) => n.type === 'ul').props.children).filter(
      (n) => n.type === 'li',
    );
    expect(lines.map((li) => text(li))).toEqual(['{', '−  "steps": 3', '+  "steps": 4', '}']);
  });

  it.each([
    [
      'imp-c',
      zh('memory.learnedDetail.confirm'),
      'improvement.decide',
      { project_id: 'pay', improvement_id: 'imp-c', decision: 'confirm' },
      null,
    ],
    [
      'imp-t',
      zh('memory.learnedDetail.revert'),
      'improvement.decide',
      { project_id: 'pay', improvement_id: 'imp-t', decision: 'revert' },
      null,
    ],
    [
      'prop-1',
      zh('memory.learnedDetail.apply'),
      'agent.proposal.resolve',
      { proposal_id: 'prop-1', decision: 'create' },
      null,
    ],
    [
      'wf-1',
      zh('memory.learnedDetail.keep'),
      'workflow.definition.trial.decide',
      { project_id: 'pay', id: 'wf-1', decision: 'keep' },
      null,
    ],
    ['mem-1', zh('memory.learnedDetail.archive'), 'memory.archive', { memory_id: 'mem-1' }, 4],
  ])('sends %s its action %s', async (id, label, type, input, revision) => {
    const h = await mountDetail(id);
    button(tree(h), label).props.onClick();
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({ type, input, expected_revision: revision }),
    ]);
  });

  it('draws one button per action, the first primary, and none for an item without actions', async () => {
    const labels = async (id: string) =>
      nodes(tree(await mountDetail(id)))
        .filter((n) => n.type === 'button' && n.props.className?.startsWith('btn'))
        .map((n) => [text(n.props.children), n.props.className]);
    expect(await labels('imp-t')).toEqual([
      [zh('memory.learnedDetail.revert'), 'btn pri'],
      [zh('memory.learnedDetail.pin'), 'btn'],
    ]);
    expect(await labels('prop-1')).toEqual([
      [zh('memory.learnedDetail.apply'), 'btn pri'],
      [zh('memory.learnedDetail.decline'), 'btn'],
    ]);
    expect(await labels('imp-x')).toEqual([]);
  });

  it('says above the buttons what failed, and keeps them', async () => {
    bridge.answer = { ok: false, error: { code: 'daemon_down', message: 'no answer' } };
    const h = await mountDetail('imp-t');
    button(tree(h), zh('memory.learnedDetail.revert')).props.onClick();
    await h.flush();
    const alert = find(tree(h), (n) => n.props.role === 'alert');
    expect(text(alert)).toMatch(/^没能撤回：.*no answer/);
    expect(button(tree(h), zh('memory.learnedDetail.revert')).props['aria-busy']).toBeUndefined();
  });

  it('opens the retrospectives and sessions the change rests on', async () => {
    const onOpenRetro = vi.fn();
    const openSession = vi.fn();
    const before = useShell.getState().openSession;
    useShell.setState({ openSession });
    try {
      const h = await mountDetail('imp-c', onOpenRetro);
      const evidence = nodes(tree(h)).filter((n) => n.props.className === 'mld-ev');
      expect(evidence.map((n) => [n.type, n.props['aria-label'], text(n.props.children)])).toEqual([
        [
          'button',
          zhf('memory.learnedDetail.openRetro', { id: 'r1' }),
          `${zh('memory.learnedDetail.evidence.retrospective')}Refund retries`,
        ],
        [
          'button',
          zhf('memory.learnedDetail.openSession', { id: 's1' }),
          `${zh('memory.learnedDetail.evidence.session')}s1`,
        ],
        ['div', undefined, `${zh('memory.learnedDetail.evidence.gateRun')}g1`],
      ]);
      evidence[0]!.props.onClick();
      evidence[1]!.props.onClick();
      expect(onOpenRetro).toHaveBeenCalledWith('r1');
      expect(openSession).toHaveBeenCalledWith('s1');
    } finally {
      useShell.setState({ openSession: before });
    }
  });
});
