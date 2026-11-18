import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { t as message } from '@/i18n';
import { HookHost, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
const viewport = vi.hoisted(() => ({ zoom: 1 }));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, viewport.zoom] }),
}));
import { DOMAIN_LABEL } from '@/data/workflow-policy';
import { TaskCard } from '@/screens/board/FlowNode';
import { COMPACT_ZOOM, MIN_USER_ZOOM } from '@/screens/board/flow-layout';
import type { NodeActionContext } from '@/screens/board/NodeActions';
import type { NeedItem } from '@/screens/board/frame-model';
import { TASK_STATE_TONE } from '@/screens/board/status';
import { useShell } from '@/store';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 13, 12);
const say = (id: string, values: Record<string, string | number>) =>
  message({ id, defaultMessage: '' }, values);
const action = (key: string) => zh(`board.node.action.${key}`);
const OPEN = action('open');

const task = (patch: Partial<Task> = {}): Task => ({
  id: 'lead:refund',
  owner_session_id: 'lead',
  title: 'refund key',
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'running',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...patch,
});

const activity = (patch: Partial<NonNullable<Task['activity']>>): Task['activity'] => ({
  phase: 'thinking',
  since: NOW - 60_000,
  health: 'fresh',
  attempt: 1,
  ...patch,
});

const claim = { session_id: 'worker', runtime: 'claude', model: null };
const approving = task({
  state: 'waiting_approval',
  claim,
  activity: activity({
    phase: 'waiting_approval',
    waiting: {
      kind: 'approval',
      summary: 'pnpm db:migrate --env staging',
      approval_id: 'ap1',
      since: NOW,
    },
  }),
});
const permission: NeedItem = {
  source: { table: 'approvals', id: 'ap1', revision: 4 },
  kind: 'permission',
  project_id: 'p',
  session_id: 'worker',
  status: 'pending',
  created_at: NOW,
  reason: 'permission_requested',
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: {
    action: 'Bash',
    input_hash: 'h',
    input_summary: 'pnpm db:migrate --env staging',
    project_rule_supported: false,
  },
} as unknown as NeedItem;

// Dialog triggers and hover tips stay unexpanded: they render through Base UI.
const KEEP = new Set(['Tip', 'TellLead', 'MergeButton']);
const expand = (tree: ReactNode): ReactNode => {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return tree;
  const el = tree as ReactElement<any>;
  if (typeof el.type === 'function' && !KEEP.has(el.type.name))
    return expand((el.type as (p: unknown) => ReactNode)(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } } as ReactElement;
};

const hosts: HookHost<ReactNode>[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  viewport.zoom = 1;
});

const run = vi.fn(async () => null as string | null);
const context = (needs: NeedItem[] = []): NodeActionContext => ({
  tell: { sessions: [], run },
  needs,
});

function render(
  t: Task,
  opts: {
    selected?: boolean;
    actions?: NodeActionContext;
    line?: string;
    tall?: number;
    drafted?: { acceptance?: number; upstream?: true };
  },
) {
  const h = new HookHost(() =>
    expand(
      TaskCard({
        data: {
          task: t,
          selected: opts.selected ?? false,
          now: NOW,
          critical: false,
          ready: false,
          line: opts.line ?? null,
          tall: opts.tall,
          ...(opts.actions && { actions: opts.actions }),
          ...(opts.drafted && { drafted: opts.drafted }),
        },
      } as unknown as Parameters<typeof TaskCard>[0]),
    ),
  );
  hosts.push(h);
  return h;
}
const tree = (t: Task, opts: Parameters<typeof render>[1] = {}) => render(t, opts).render();
const byClass = (root: ReactNode, name: string) =>
  nodes(root).find((n) =>
    String(n.props.className ?? '')
      .split(' ')
      .includes(name),
  );
const buttons = (root: ReactNode) =>
  nodes(byClass(root, 'bd-nact')).filter(
    (n) => n.type === 'button' || (typeof n.type === 'function' && n.type.name !== 'Tip'),
  );
const labels = (root: ReactNode) =>
  buttons(root).map((n) =>
    n.type === 'button' ? text(n) : (n.props.text ?? (n.type as { name: string }).name),
  );

describe('flow node draft tags', () => {
  const tags = (root: ReactNode) =>
    nodes(root)
      .filter((n) => n.props.className === 'bd-ntag')
      .map(text);

  it('tags a node whose drafted acceptance count or upstream tasks changed', () => {
    expect(tags(tree(task(), { drafted: { acceptance: 1, upstream: true } }))).toEqual([
      say('board.plan.flow.draftAcceptance', { delta: '+1' }),
      zh('board.plan.flow.draftUpstream'),
    ]);
    expect(tags(tree(task(), { drafted: { acceptance: -2 } }))).toEqual([
      say('board.plan.flow.draftAcceptance', { delta: '−2' }),
    ]);
  });

  it('tags no node the draft leaves alone', () => {
    expect(tags(tree(task()))).toEqual([]);
  });
});

describe('flow node title row', () => {
  it('draws the context ring in the title row, not among the amounts', () => {
    const shown = tree(task({ context: { used_tokens: 46_000, window_tokens: 100_000 } }));
    expect(byClass(byClass(shown, 'bd-nh'), 'bd-nctx')).toBeDefined();
    expect(byClass(byClass(shown, 'bd-nq'), 'bd-nctx')).toBeUndefined();
  });
});

const iconNames = (root: ReactNode) =>
  nodes(root).map((n) => (n.type as { displayName?: string }).displayName);

describe('flow node task type', () => {
  it('marks each task type with its icon and name', () => {
    for (const [type, icon, label] of [
      ['feature', 'Zap', zh('board.task.type.feature')],
      ['fix', 'Bug', zh('board.task.type.fix')],
      ['research', 'Search', zh('board.task.type.research')],
      ['infra', 'Settings2', zh('board.task.type.infra')],
      ['docs', 'File', zh('board.task.type.docs')],
    ] as const) {
      const mark = byClass(byClass(tree(task({ task_type: type })), 'bd-nh'), 'bd-nkind')!;
      expect(mark.props).toMatchObject({ role: 'img', 'aria-label': label });
      expect(iconNames(mark)).toContain(icon);
    }
  });

  it('falls back to the domain icon without a task type, and to none without either', () => {
    const planned: Task['planned'] = { kind: { domain: 'review', tier: 't1' } };
    const mark = byClass(tree(task({ planned })), 'bd-nkind')!;
    expect(mark.props['aria-label']).toBe(DOMAIN_LABEL.review);
    expect(iconNames(mark)).toContain('Eye');
    expect(byClass(tree(task()), 'bd-nkind')).toBeUndefined();
  });
});

describe('flow node evidence', () => {
  const marks = (root: ReactNode) =>
    nodes(root)
      .filter((n) => n.props.role === 'img' && String(n.props['aria-label']).startsWith('证据'))
      .map((n) => [n.props['aria-label'], text(n)]);
  const merged = { state: 'merged' as const, status: 'done' as const };

  it.each([
    ['report', undefined, 'report'],
    ['gate', undefined, 'gate'],
    ['reviewed', 'other_vendor', 'reviewed.otherVendor'],
    ['reviewed', 'other_runtime', 'reviewed.otherRuntime'],
  ] as const)('marks a merged task backed by %s %s', (level, reviewer, key) => {
    const shown = tree(
      task({ ...merged, evidence_level: level, ...(reviewer && { evidence_reviewer: reviewer }) }),
    );
    expect(marks(shown)).toEqual([
      [zh(`board.evidence.${key}.label`), zh(`board.evidence.${key}`)],
    ]);
  });

  it('marks no task without a level', () => {
    expect(marks(tree(task(merged)))).toEqual([]);
    expect(marks(tree(task()))).toEqual([]);
  });
});

describe('flow node amounts', () => {
  it('counts the subagents beside the diff, and draws nothing for none', () => {
    const agents = byClass(byClass(tree(task({ subagents: 2 })), 'bd-nq'), 'bd-nagents')!;
    expect(agents.props).toMatchObject({
      role: 'img',
      'aria-label': say('board.plan.flow.subagents', { count: 2 }),
    });
    expect(text(agents)).toBe('2');
    expect(iconNames(agents)).toContain('Bot');
    expect(byClass(tree(task({ subagents: 0 })), 'bd-nagents')).toBeUndefined();
    expect(byClass(tree(task()), 'bd-nagents')).toBeUndefined();
  });
});

describe('flow node external review', () => {
  it('counts the open findings by severity in two parts once the round has them', () => {
    const review = { rounds: 2, verdict: 'failed' as const };
    const counted = byClass(
      tree(task({ external_review: { ...review, findings: { blocking: 1, other: 3 } } })),
      'bd-nrv',
    )!;
    const parts = nodes(counted).filter(
      (n) => n.type === 'span' && typeof n.props.children === 'string',
    );
    expect(parts.map(text)).toEqual([
      say('board.plan.flow.review.blocking', { count: 1 }),
      say('board.plan.flow.review.other', { count: 3 }),
    ]);
    expect(text(byClass(tree(task({ external_review: review })), 'bd-nrv'))).toBe(
      say('board.plan.flow.review.rounds', { rounds: 2 }),
    );
  });

  it('times a finished round, counts a running one up to now, and times none without a start', () => {
    const time = (review: NonNullable<Task['external_review']>) =>
      byClass(byClass(tree(task({ external_review: review })), 'bd-nrv'), 'bd-ntm');
    const finished = time({
      rounds: 1,
      verdict: 'passed',
      started_at: NOW - 60 * 60_000,
      ended_at: NOW - 10 * 60_000,
      findings: { blocking: 0, other: 0 },
    });
    expect(text(finished)).toBe('50 分钟');
    // A second round started after the first ended keeps the first's end time.
    const running = time({
      rounds: 2,
      verdict: 'pending',
      started_at: NOW - 20 * 60_000,
      ended_at: NOW - 30 * 60_000,
    });
    expect(text(running)).toBe('已过 20 分钟');
    expect(time({ rounds: 1, verdict: 'pending' })).toBeUndefined();
  });
});

describe('flow node size by zoom', () => {
  it('draws the standard node from 60%, a capsule down to 15% and a dot below', () => {
    expect(MIN_USER_ZOOM).toBeLessThan(0.15);
    viewport.zoom = COMPACT_ZOOM;
    expect(byClass(tree(task()), 'bd-nd')).toBeDefined();
    viewport.zoom = 0.3;
    const pill = tree(task({ state: 'todo' }));
    expect(byClass(pill, 'bd-nd')).toBeUndefined();
    expect(byClass(pill, 'bd-npill')!.props['data-look']).toBe('queue');
    expect(text(byClass(pill, 'bd-npill'))).toBe('refund key');
    viewport.zoom = 0.1;
    const dot = tree(task({ state: 'merged' }));
    expect(byClass(dot, 'bd-npill')).toBeUndefined();
    expect(byClass(dot, 'bd-ndot')!.props['data-look']).toBe('done');
  });

  it('colours a node by the same table as its state icon, gating and blocked included', () => {
    viewport.zoom = 0.1;
    for (const state of ['gating', 'blocked', 'awaiting_acceptance', 'waiting_upstream'] as const) {
      const colours = Object.values(byClass(tree(task({ state })), 'bd-ndot')!.props.style ?? {});
      expect(colours).toEqual([`var(${TASK_STATE_TONE[state]})`]);
    }
    viewport.zoom = 1;
    const card = byClass(tree(task({ state: 'blocked' })), 'bd-nd')!;
    expect(Object.values(card.props.style ?? {})).toEqual([`var(${TASK_STATE_TONE.blocked})`]);
  });

  it('keeps the height of its card when zoomed out, so the measured layout stays', () => {
    viewport.zoom = 0.3;
    expect(byClass(tree(task(), { tall: 132 }), 'bd-nmini')!.props.style.height).toBe(132);
  });
});

describe('flow node reason layer', () => {
  const said = (t: Task) => text(byClass(tree(t, { selected: true }), 'bd-nwhy'));
  it('says a task awaits approval without the command, which the needs-you strip shows', () => {
    const shown = tree(approving, { line: 'Awaiting approval pnpm db:migrate --env staging' });
    expect(text(shown)).not.toContain('pnpm');
    expect(text(shown)).toContain(zh('board.task.phase.waitingApproval'));
  });

  it('shows the question a task waits to have answered', () => {
    const asking = task({
      activity: activity({
        phase: 'waiting_input',
        waiting: { kind: 'input', summary: 'One endpoint or two?', approval_id: 'q', since: NOW },
      }),
    });
    expect(text(byClass(tree(asking), 'bd-nwhy'))).toBe('One endpoint or two?');
  });

  it('says how often a failed task was retried, only once it is selected', () => {
    const failed = task({ state: 'failed', activity: activity({ phase: 'idle', attempt: 3 }) });
    expect(byClass(tree(failed), 'bd-nwhy')).toBeUndefined();
    expect(said(failed)).toBe(say('board.node.reason.retried', { count: 2 }));
    const first = task({ state: 'failed', activity: activity({ phase: 'idle', attempt: 1 }) });
    expect(byClass(tree(first, { selected: true }), 'bd-nwhy')).toBeUndefined();
  });

  it('says a retried task failed at the same place again when the backend found so', () => {
    const failed = (repeated_failure?: boolean) =>
      task({
        state: 'failed',
        activity: activity({ phase: 'idle', attempt: 3, repeated_failure }),
      });
    expect(said(failed(true))).toBe(say('board.node.reason.retriedSamePlace', { count: 2 }));
    expect(said(failed(false))).toBe(say('board.node.reason.retried', { count: 2 }));
  });

  it('says no session works on a blocked task', () => {
    const blocked = task({ state: 'blocked' });
    expect(said(blocked)).toBe(zh('board.node.reason.unattended'));
    const working = task({ state: 'blocked', turn_running: true });
    expect(byClass(tree(working, { selected: true }), 'bd-nwhy')).toBeUndefined();
  });

  it('names what completed a merged task', () => {
    const merged = task({ state: 'merged', done_by: 'merged', checks: 'pass' });
    expect(byClass(tree(merged), 'bd-nwhy')).toBeUndefined();
    expect(said(merged)).toBe(zh('board.node.reason.mergedChecked'));
    const accepted = task({ state: 'merged', done_by: 'accepted' });
    expect(said(accepted)).toBe(zh('board.node.reason.accepted'));
  });
});

describe('flow node actions', () => {
  it('leaves allowing and denying an approval to the needs-you strip, and opens its session', () => {
    run.mockClear();
    const openSession = vi.fn();
    useShell.setState({ openSession });
    const shown = tree(approving, { actions: context([permission]) });
    expect(labels(shown)).toEqual([OPEN]);
    buttons(shown)[0]!.props.onClick();
    expect(openSession).toHaveBeenCalledWith('worker', undefined);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps button presses and keys from selecting the node', () => {
    const row = byClass(tree(approving, { actions: context([permission]) }), 'bd-nact')!;
    const stop = vi.fn();
    row.props.onClick({ stopPropagation: stop });
    row.props.onKeyDown({ stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(String(row.props.className)).toContain('nodrag');
  });

  it('offers only opening the session while the approval is not on the board yet', () => {
    expect(labels(tree(approving, { actions: context() }))).toEqual([OPEN]);
  });

  it('draws no actions on a read-only chart or on a task that is not shown expanded', () => {
    expect(byClass(tree(approving), 'bd-nact')).toBeUndefined();
    const failed = task({ state: 'failed', claim });
    expect(byClass(tree(failed, { actions: context() }), 'bd-nact')).toBeUndefined();
  });

  it('opens the failure of a failed task and asks its lead to dispatch it again', () => {
    const openSession = vi.fn();
    useShell.setState({ openSession });
    const failed = task({ state: 'failed', claim, checks: 'fail' });
    const shown = tree(failed, { selected: true, actions: context() });
    expect(labels(shown)).toEqual([action('failure'), action('redispatch')]);
    buttons(shown)[0]!.props.onClick();
    expect(openSession).toHaveBeenCalledWith('worker', 'checks');
    const alone = task({ state: 'failed', owner_session_id: undefined, claim });
    expect(labels(tree(alone, { selected: true, actions: context() }))).toEqual([
      action('failure'),
    ]);
  });

  it('opens the session of a blocked task and asks its lead', () => {
    const blocked = task({ state: 'blocked', claim });
    expect(labels(tree(blocked, { selected: true, actions: context() }))).toEqual([
      action('session'),
      action('ask'),
    ]);
  });

  it('reviews and merges a session ready to merge', () => {
    const ready = task({ id: 'worker', owner_session_id: undefined, status: 'ready', claim });
    expect(labels(tree(ready, { selected: true, actions: context() }))).toEqual([
      action('review'),
      'MergeButton',
    ]);
  });

  const asking = (options?: string[]) =>
    task({
      claim,
      activity: activity({
        phase: 'waiting_input',
        waiting: {
          kind: 'input',
          summary: 'One endpoint or two?',
          approval_id: 'q1',
          since: NOW,
          ...(options && { options }),
        },
      }),
    });
  const question: NeedItem = {
    ...permission,
    source: { table: 'approvals', id: 'q1', revision: 7 },
    binding: { ...permission.binding!, action: 'AskUserQuestion', input_summary: 'q' },
    questions: [
      {
        question: 'One endpoint or two?',
        header: '',
        multiSelect: false,
        options: [
          { label: 'Two endpoints', description: '' },
          { label: 'One endpoint', description: '' },
        ],
      },
    ],
  } as NeedItem;

  const relayed = {
    source: { table: 'board_plans', id: 'lead', revision: 3 },
    kind: 'lead.question',
    project_id: 'p',
    session_id: 'lead',
    request_id: 'question-1',
    status: 'pending',
    created_at: NOW,
    reason: 'lead_question',
    decision: 'question',
    blocks: 0,
    actions: [{ command: 'lead.question.answer', allowed: true }],
    question: {
      id: 'question-1',
      at: NOW,
      question: 'One endpoint or two?',
      options: ['Two endpoints', 'One endpoint'],
      recommended: '',
      assumption: '',
      blocks: [],
      source: { session_id: 'worker', approval_id: 'q1' },
      questions: question.questions,
    },
  } as NeedItem;

  it.each([
    ['its own request', question, 'q1', false],
    ['the lead question relaying it', relayed, 'lead:question-1', false],
    ['its own request, in the needs-you strip on the board', question, 'q1', true],
    ['the lead question, in the needs-you strip on the board', relayed, 'lead:question-1', true],
  ])(
    'opens the question card of %s instead of answering the request from the node',
    (_, need, key, onBoard) => {
      run.mockClear();
      const opened = vi.spyOn(useShell.getState(), 'openProjectNeed').mockImplementation(() => {});
      const asked = vi.fn();
      const shown = tree(asking(['Two endpoints', 'One endpoint']), {
        actions: { ...context([need]), ...(onBoard && { onAskNeed: asked }) },
      });
      expect(labels(shown)).toEqual([action('answer'), OPEN]);
      buttons(shown)[0]!.props.onClick();
      expect([asked.mock.calls, opened.mock.calls]).toEqual(
        onBoard ? [[[key]], []] : [[], [['p', key]]],
      );
      expect(run).not.toHaveBeenCalled();
      opened.mockRestore();
    },
  );

  it('only opens the session of a question the board has no item for', () => {
    expect(labels(tree(asking(), { actions: context([]) }))).toEqual([OPEN]);
  });
});
