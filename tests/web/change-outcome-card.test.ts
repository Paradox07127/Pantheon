import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, ChangeOutcome } from '@pantheon/protocol';
import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';
import { deferred, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const agents = vi.hoisted(() => ({ list: null as unknown }));
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: () => agents.list,
}));
import { ChangeOutcomeCard } from '@/components/ChangeOutcomeCard';
import { Skeleton } from '@/components/Skeleton';
import { agentName } from '@/data/agents';
import { useBoard } from '@/data/board';
import { forgetQuery } from '@/data/query-cache';
import { useCurrentProject } from '@/data/current-project';
import { listText } from '@/lib/list-text';
import { dayText } from '@/lib/time-text';
import { ROUTINE_TEMPLATE_NAMES } from '@/screens/sessions/AgentForm';
import { AgentProfilePanel } from '@/screens/sessions/AgentProfile';
import { WorkflowPage } from '@/screens/settings/WorkflowPage';
import { zh, zhf } from './i18n-setup.js';

const side = (
  tasks: number,
  first_pass: number,
  input_tokens: number | null,
  n: number,
  user_interventions: number,
) => ({ tasks, first_pass, cost_per_accepted_task: { input_tokens, n }, user_interventions });

const outcome = (over: Partial<ChangeOutcome> = {}): ChangeOutcome => ({
  event_id: 'ev-1',
  kind: 'policy_changed',
  at: Date.UTC(2026, 10, 12, 12),
  param: 'max_parallel',
  n: 12,
  tasks_required: 10,
  verdict: 'better',
  before: side(12, 7, 412_000, 9, 3),
  after: side(12, 10, 318_000, 11, 1),
  ...over,
});

const imgs = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.props.role === 'img')
    .map((n) => n.props['aria-label'] as string);
const rowNames = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.props.role === 'rowheader')
    .map(text);
const cells = (tree: ReactNode, name: string) => {
  const row = find(
    tree,
    (n) =>
      n.props.role === 'row' &&
      nodes(n.props.children).some((c) => c.props.role === 'rowheader' && text(c) === name),
  );
  return (row.props.children as ReactElement<any>[]).slice(2);
};
const card = (props: Parameters<typeof ChangeOutcomeCard>[0]) =>
  mount(() => ChangeOutcomeCard(props)).value as ReactNode;

describe('change outcome block', () => {
  it('names the block, gives the count, the date and the verdict, then each measure before and after', () => {
    const tree = card({ outcome: outcome(), wide: true, label: 'Did it help? Concurrency limit' });
    const root = tree as ReactElement<any>;
    expect(root.type).toBe('section');
    expect(root.props['aria-label']).toBe('Did it help? Concurrency limit');
    expect(text(tree)).toContain(zh('components.changeOutcome.title'));
    expect(text(tree)).toContain(zhf('components.changeOutcome.count', { count: 12 }));
    expect(text(tree)).toContain(
      zhf('components.changeOutcome.since', {
        date: dayText(outcome().at, Date.now()),
      }),
    );
    expect(text(tree)).toContain(zh('components.changeOutcome.better'));
    const table = find(tree, (n) => n.props.role === 'table');
    expect(table.props['aria-label']).toBe(zh('components.changeOutcome.table'));
    expect(
      nodes(table)
        .filter((n) => n.props.role === 'columnheader')
        .map(text),
    ).toEqual([zh('components.changeOutcome.before'), zh('components.changeOutcome.after')]);
    expect(rowNames(table)).toEqual(
      ['tasks', 'firstPass', 'tokens', 'stopped'].map((id) => zh(`components.changeOutcome.${id}`)),
    );
    const pair = (row: string, before: string, after: string) =>
      zhf('components.changeOutcome.pair', { row: zh(row), before, after });
    expect(imgs(table)).toEqual([
      pair('components.changeOutcome.firstPass', '7 / 12', '10 / 12'),
      pair('components.changeOutcome.tokens', '412k', '318k'),
      pair('components.changeOutcome.stopped', '3 / 12', '1 / 12'),
    ]);
    const tokens = cells(table, zh('components.changeOutcome.tokens'));
    expect(tokens.map(text)).toEqual(['412k', '318k']);
    expect(tokens.map((n) => n.props.title)).toEqual([
      zhf('components.changeOutcome.accepted', { count: 9 }),
      zhf('components.changeOutcome.accepted', { count: 11 }),
    ]);
    expect(nodes(tree).filter((n) => n.type === 'button')).toEqual([]);
  });

  it.each([
    ['better', 'components.changeOutcome.better'],
    ['worse', 'components.changeOutcome.worse'],
    ['not_enough_evidence', 'components.changeOutcome.notEnough'],
  ] as const)('words the %s verdict in its chip', (verdict, id) => {
    const chip = find(
      card({ outcome: outcome({ verdict }) }),
      (n) => n.props['data-v'] === verdict,
    );
    expect(text(chip)).toBe(zh(id));
  });

  it('shows the tasks still needed as a meter while there are fewer than required', () => {
    const tree = card({
      outcome: outcome({ n: 3, verdict: 'not_enough_evidence' }),
      title: 'Bug hunt turned on',
    });
    expect((tree as ReactElement<any>).props.role).toBe('group');
    expect((tree as ReactElement<any>).props['aria-label']).toBe('Bug hunt turned on');
    expect(imgs(tree)[0]).toBe(zhf('components.changeOutcome.needed', { count: 3, required: 10 }));
    expect(text(tree)).toContain(
      zhf('components.changeOutcome.countOf', { count: 3, required: 10 }),
    );
    expect(rowNames(tree)).toContain(zh('components.changeOutcome.tokensShort'));
  });

  it('draws no bars for windows without tasks and names the missing token cost', () => {
    const empty = side(0, 0, null, 0, 0);
    const tree = card({ outcome: outcome({ n: 0, before: empty, after: empty }) });
    expect(imgs(tree)).toEqual([
      zhf('components.changeOutcome.needed', { count: 0, required: 10 }),
      zh('components.changeOutcome.noAccepted'),
      zh('components.changeOutcome.noAccepted'),
    ]);
    expect(cells(tree, zh('components.changeOutcome.firstPass')).map(text)).toEqual(['0', '0']);
  });

  it('leaves out the token bars when one side accepted no task', () => {
    const tree = card({
      outcome: outcome({ before: side(10, 0, null, 0, 6), after: side(10, 6, 377_000, 6, 2) }),
    });
    const tokens = cells(tree, zh('components.changeOutcome.tokensShort'));
    expect(tokens[0]!.props['aria-label']).toBe(zh('components.changeOutcome.noAccepted'));
    expect(text(tokens[1])).toBe('377k');
    expect(imgs(tree).some((name) => name.startsWith(zh('components.changeOutcome.tokens')))).toBe(
      false,
    );
  });

  it('keeps its rows with skeletons for the numbers while the read is out', () => {
    const tree = card({ outcome: null });
    expect((tree as ReactElement<any>).props['aria-busy']).toBe(true);
    expect(rowNames(tree)).toHaveLength(4);
    expect(nodes(tree).filter((n) => n.type === Skeleton).length).toBeGreaterThan(8);
    expect(imgs(tree)).toEqual([]);
  });

  it('shows a failed read in its place with a retry', () => {
    const retry = vi.fn();
    const tree = card({ outcome: null, error: 'the daemon did not answer', onRetry: retry });
    const alert = find(tree, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(
      zhf('components.changeOutcome.failed', { reason: 'the daemon did not answer' }),
    );
    find(tree, (n) => n.type === 'button' && text(n) === zh('components.retry')).props.onClick();
    expect(retry).toHaveBeenCalled();
    expect(nodes(tree).some((n) => n.props.role === 'table')).toBe(false);
  });
});

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const bridge = {
  answers: {} as Record<string, BridgeResult<unknown>>,
  queries: [] as { method: string; params: Record<string, string> }[],
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    return (
      bridge.answers[method] ?? { ok: false, error: { code: 'unknown_route', message: method } }
    );
  },
  async command(): Promise<BridgeResult<unknown>> {
    return { ok: true, value: {} };
  },
};
const answer = (value: unknown): BridgeResult<unknown> => ({ ok: true, value });
const reads = () => bridge.queries.filter((q) => q.method === 'change.outcomes');
const policy = {
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  improvement_mode: 'confirm',
  plan_changes: 'auto',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: [],
};
let stored: Map<string, string>;

beforeEach(() => {
  for (const id of ['alpha', 'beta']) forgetQuery('change.outcomes', id);
  stored = new Map();
  bridge.answers = {
    'workflow.policy': answer(policy),
    'improvement.list': answer([]),
    'change.outcomes': answer([]),
  };
  bridge.queries = [];
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    events: [],
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null, events: [] } as never);
  useCurrentProject.setState({ projectId: null });
});

const param = (id: string) => zh(`data.workflowPolicy.param.${id}`);
const outcomeLabel = (id: string) => zhf('settings.workflow.outcome', { param: param(id) });
const blocks = (tree: ReactNode) => nodes(tree).filter((n) => n.type === ChangeOutcomeCard);
/** The block drawn right after the parameter's row, in the same rows group. */
const under = (tree: ReactNode, id: string) => {
  const row = find(tree, (n) => n.props.role === 'group' && n.props['aria-label'] === param(id));
  const pair = find(tree, (n) => Array.isArray(n.props.children) && n.props.children.includes(row));
  return (pair.props.children as ReactElement<any>[])[1];
};
async function page(props: Parameters<typeof WorkflowPage>[0] = { project: project as never }) {
  const h = mount(() => WorkflowPage(props));
  await h.flush();
  return h;
}

describe('workflow settings', () => {
  it('puts the newest outcome of each changed setting under its row, and none under the others', async () => {
    bridge.answers['change.outcomes'] = answer([
      outcome({ event_id: 'ev-3', param: 'max_parallel', at: 3 }),
      outcome({ event_id: 'ev-2', param: 'acceptance_wake', at: 2 }),
      outcome({ event_id: 'ev-1', param: 'max_parallel', at: 1 }),
      outcome({ event_id: 'ev-0', kind: 'agent_created', param: undefined, agent_id: 'a' }),
    ]);
    const h = await page();
    expect(reads()[0]!.params).toEqual({ project_id: 'alpha' });
    expect(
      blocks(h.value).map((b) => [b.props.label, b.props.outcome.event_id, b.props.wide]),
    ).toEqual([
      [outcomeLabel('maxParallel'), 'ev-3', true],
      [outcomeLabel('acceptanceWake'), 'ev-2', true],
    ]);
    expect(under(h.value, 'maxParallel')!.props.outcome.event_id).toBe('ev-3');
    expect(under(h.value, 'acceptanceWake')!.props.outcome.event_id).toBe('ev-2');
    expect(under(h.value, 'maxParallelLimit')).toBeFalsy();
  });

  it('shows a failed read once, under the first row, with its retry', async () => {
    bridge.answers['change.outcomes'] = {
      ok: false,
      error: { code: 'internal', message: 'the daemon did not answer' },
    };
    const h = await page();
    const failed = blocks(h.value);
    expect(failed).toHaveLength(1);
    expect(under(h.value, 'maxParallel')).toBe(failed[0]);
    expect(failed[0]!.props.error).toContain('the daemon did not answer');
    const before = reads().length;
    bridge.answers['change.outcomes'] = answer([]);
    failed[0]!.props.onRetry();
    await h.flush();
    expect(reads().length).toBe(before + 1);
    expect(blocks(h.value)).toEqual([]);
  });

  it('draws nothing when the daemon has no change.outcomes', async () => {
    delete bridge.answers['change.outcomes'];
    const h = await page();
    expect(blocks(h.value)).toEqual([]);
  });

  it('reads the current project on the page every project follows, and nothing without one', async () => {
    useBoard.setState({
      board: { cursor: 1, projects: [project, { ...project, id: 'beta' }], sessions: [] },
    } as never);
    await page({ project: null });
    expect(reads()).toEqual([]);
    useCurrentProject.setState({ projectId: 'beta' });
    await page({ project: null });
    expect(reads().map((q) => q.params.project_id)).toEqual(['beta']);
  });

  it('reads again after a change or a task of the project, not after other events', async () => {
    const h = await page();
    const push = async (kind: string, project_id: string, sequence: number) => {
      useBoard.setState(
        (s) => ({ events: [...s.events, { kind, project_id, sequence }] }) as never,
      );
      h.render();
      await h.flush();
    };
    const first = reads().length;
    await push('turn.completed', 'alpha', 10);
    await push('retrospective.recorded', 'beta', 11);
    expect(reads().length).toBe(first);
    await push('retrospective.recorded', 'alpha', 12);
    expect(reads().length).toBe(first + 1);
    await push('workflow.policy_changed', 'alpha', 13);
    expect(reads().length).toBe(first + 2);
    await push('agent_profile.updated', 'alpha', 14);
    expect(reads().length).toBe(first + 3);
  });
});

const BUG_HUNT = ROUTINE_TEMPLATES.find((each) => each.id === 'bug-hunt')!.prompt;
const triage = {
  id: 'agent-triage',
  revision: 7,
  project_id: 'alpha',
  template: 'triage',
  name: 'Triage',
  role: 'Bugs',
  role_prompt: 'Built-in role of triage',
  routines: [
    { id: 'r-hunt', prompt: BUG_HUNT, every_ms: 86_400_000, enabled: true },
    {
      id: 'r-own',
      prompt: 'Sweep the flaky tests\nthen report',
      every_ms: 3_600_000,
      enabled: true,
    },
  ],
  effective_tools: [],
  effective_listens: [],
  created_by: { kind: 'user' },
  created_at: 1,
};

/** The profile's "Did it help?" part, rendered on its own after its read. */
async function profileOutcomes() {
  agents.list = [triage];
  const panel = mount(() =>
    AgentProfilePanel({ projectId: 'alpha', agentId: 'agent-triage', onClose: () => {} }),
  );
  const part = named(panel.value, 'AgentOutcomes');
  const h = mount(() => (part.type as (props: unknown) => ReactNode)(part.props));
  await h.flush();
  return h;
}

describe('agent profile', () => {
  it('adds the part after This week', () => {
    agents.list = [triage];
    const tree = mount(() =>
      AgentProfilePanel({ projectId: 'alpha', agentId: 'agent-triage', onClose: () => {} }),
    ).value;
    const parts = nodes(tree)
      .filter((n) => typeof n.type === 'function')
      .map((n) => (n.type as { name: string }).name);
    expect(parts.indexOf('AgentOutcomes')).toBe(parts.indexOf('WeekLedger') + 1);
  });

  it("shows this agent's creation and routine outcomes, newest first, titled by what changed", async () => {
    bridge.answers['change.outcomes'] = answer([
      outcome({
        event_id: 'ev-4',
        kind: 'routine_enabled',
        param: undefined,
        agent_id: 'agent-triage',
        routine_ids: ['r-hunt', 'r-own'],
        at: 4,
      }),
      outcome({ event_id: 'ev-3', param: 'max_parallel', at: 3 }),
      outcome({ event_id: 'ev-2', kind: 'agent_created', param: undefined, agent_id: 'other' }),
      outcome({
        event_id: 'ev-1',
        kind: 'agent_created',
        param: undefined,
        agent_id: 'agent-triage',
      }),
    ]);
    const h = await profileOutcomes();
    const caption = find(h.value, (n) => n.type === 'span' && n.props.className === 'cap');
    expect(text(caption)).toBe(zh('components.changeOutcome.title'));
    expect(
      blocks(h.value).map((b) => [b.props.outcome.event_id, b.props.title, b.props.wide]),
    ).toEqual([
      [
        'ev-4',
        zhf('sessions.agents.outcomes.turnedOn', {
          routines: listText(ROUTINE_TEMPLATE_NAMES['bug-hunt']!(), 'Sweep the flaky tests'),
        }),
        undefined,
      ],
      [
        'ev-1',
        zhf('sessions.agents.outcomes.created', { name: agentName(triage as never) }),
        undefined,
      ],
    ]);
  });

  it('draws nothing once read without an outcome of this agent', async () => {
    bridge.answers['change.outcomes'] = answer([
      outcome({ event_id: 'ev-2', kind: 'agent_created', param: undefined, agent_id: 'other' }),
    ]);
    expect((await profileOutcomes()).value).toBeNull();
  });

  it('keeps a loading block while the read is out and shows a failed read with a retry', async () => {
    const out = deferred<BridgeResult<unknown>>();
    const query = bridge.query;
    bridge.query = (method, params) =>
      method === 'change.outcomes' ? out.promise : query(method, params);
    try {
      const h = await profileOutcomes();
      expect(blocks(h.value).map((b) => [b.props.outcome, b.props.error])).toEqual([
        [null, undefined],
      ]);
      out.resolve({ ok: false, error: { code: 'internal', message: 'the daemon did not answer' } });
      await h.flush();
      const failed = blocks(h.value);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.props.error).toContain('the daemon did not answer');
      expect(typeof failed[0]!.props.onRetry).toBe('function');
    } finally {
      bridge.query = query;
    }
  });
});
