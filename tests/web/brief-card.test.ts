import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel, ProjectBrief } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, openSession: vi.fn() }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'brief-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({ openSession: mock.openSession }), {
    setState() {},
  }),
}));
import { BriefCard } from '@/screens/board/BriefCard';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 17, 14);
const LEFT = NOW - 3 * 3_600_000;

type Task = BoardModel['tasks'][number];
const task = (id: string, title: string): Task =>
  ({
    id,
    title,
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'waiting',
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
  }) as Task;

const merge = (session_id: string, title: string): BoardModel['merges'][number] => ({
  session_id,
  title,
  merged_at: NOW - 3_600_000,
  from_sha: null,
  sha: 'merge-sha',
  additions: 0,
  deletions: 0,
  story_id: null,
});

const model = {
  since: NOW - 7 * 86_400_000,
  now: NOW,
  tasks: [task('lead-1:audit', 'Add refund audit log')],
  merges: [
    merge('session-filters', 'Refund list filters'),
    merge('session-copy', 'Refund UI copy'),
  ],
  milestones: [],
} as unknown as BoardModel;

const sessions = [
  { id: 'session-recon', title: 'Reconciliation report' },
  { id: 'lead-1', title: 'Refunds rollout lead' },
] as unknown as SnapshotSession[];

const waiting = {
  source: { table: 'board_plans', id: 'lead-1', revision: 4 },
  kind: 'board.plan.proposal',
  project_id: 'project-a',
  session_id: 'lead-1',
  task_id: 'lead-1:audit',
  status: 'pending',
  created_at: NOW - 3_600_000,
  reason: 'plan_proposal_awaiting_decision',
  decision: 'plan_change',
  blocks: 3,
  actions: [],
} as Extract<ProjectBrief['items'][number], { kind: 'decisions' }>['top'];

const served: ProjectBrief = {
  since: LEFT,
  items: [
    {
      kind: 'decisions',
      ref: { kind: 'task', id: 'lead-1:audit' },
      count: 7,
      new: 2,
      top: waiting,
    },
    {
      kind: 'milestone',
      ref: { kind: 'milestone', id: 'ms-refund-ui' },
      title: 'Refund UI',
      done: 3,
      total: 3,
    },
    { kind: 'merge', ref: { kind: 'merge', id: 'session-filters' }, at: NOW - 3_600_000 },
    { kind: 'merge', ref: { kind: 'merge', id: 'session-copy' }, at: NOW - 3_000_000 },
    {
      kind: 'failure',
      ref: { kind: 'event', id: 'event-recon-failed' },
      at: NOW - 2_000_000,
      reason: 'gate_failed',
    },
    {
      kind: 'assumption',
      ref: { kind: 'event', id: 'event-plan-v4' },
      at: NOW - 1_000_000,
      text: 'UTC is the day boundary',
    },
    { kind: 'proposal', ref: { kind: 'proposal', id: 'proposal-1' }, at: NOW - 500_000 },
  ],
};

let query: ReturnType<typeof vi.fn>;
let command: ReturnType<typeof vi.fn>;

const serve = (brief: ProjectBrief) => {
  query = vi.fn(async () => ({ ok: true, value: brief }));
  command = vi.fn(async () => ({ ok: true, value: { project_id: 'x', at: NOW } }));
  vi.stubGlobal('window', {
    pantheon: { query, command },
    addEventListener() {},
    removeEventListener() {},
  });
};

beforeEach(() => {
  mock.openSession.mockReset();
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [
      {
        event_id: 'event-recon-failed',
        aggregate_id: 'session-recon',
        kind: 'session.gate_checked',
      },
      { event_id: 'event-plan-v4', aggregate_id: 'lead-1', kind: 'board.plan_updated' },
    ],
    changed: 1,
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const card = async (projectId: string, onOpenTask = vi.fn()) => {
  const h = mount(() => BriefCard({ projectId, model, sessions, onOpenTask }));
  await h.flush();
  return h;
};
const group = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.props.role === 'group' && n.props['aria-label'] === label);
const links = (tree: unknown) => nodes(tree as ReactElement).filter((n) => n.type === 'a');

describe('since you left card', () => {
  it('reads the brief of its project and is a group named for the time away', async () => {
    serve(served);
    const h = await card('project-brief-a');
    expect(query).toHaveBeenCalledWith('project.brief', { project_id: 'project-brief-a' });
    const root = group(h.value, zh('board.brief.label'));
    expect(text(root)).toContain(zh('board.brief.label'));
    expect(text(root)).toContain(zh('board.brief.read'));
  });

  it('shows each count as the brief serves it', async () => {
    serve(served);
    const h = await card('project-brief-b');
    expect(text(group(h.value, zhf('board.brief.waitingCount', { count: 7 })))).toContain('7');
    expect(text(group(h.value, zhf('board.brief.milestonesCount', { count: 1 })))).toContain('1');
    expect(text(group(h.value, zhf('board.brief.mergedCount', { count: 2 })))).toContain('2');
    expect(text(group(h.value, zhf('board.brief.failedCount', { count: 1 })))).toContain('1');
    expect(text(group(h.value, zhf('board.brief.assumptionsCount', { count: 1 })))).toContain('1');
    expect(text(group(h.value, zhf('board.brief.proposalsCount', { count: 1 })))).toContain('1');
  });

  it('links each item to its task or session by title', async () => {
    serve(served);
    const onOpenTask = vi.fn();
    const h = await card('project-brief-c', onOpenTask);
    const shown = links(h.value);
    expect(shown.map(text)).toEqual([
      'Add refund audit log',
      'Refund list filters',
      'Refund UI copy',
      'Reconciliation report',
      'UTC is the day boundary',
    ]);
    const prevented = { preventDefault: vi.fn() };
    shown.forEach((link) => link.props.onClick(prevented));
    expect(onOpenTask).toHaveBeenCalledWith('lead-1:audit');
    expect(mock.openSession.mock.calls.map(([id]) => id)).toEqual([
      'session-filters',
      'session-copy',
      'session-recon',
      'lead-1',
    ]);
    expect(prevented.preventDefault).toHaveBeenCalledTimes(5);
    expect(text(h.value)).toContain('Refund UI');
  });

  it('marks the project read and hides', async () => {
    serve(served);
    const h = await card('project-brief-d');
    const read = find(h.value, (n) => n.type === 'button' && text(n) === zh('board.brief.read'));
    query.mockResolvedValue({ ok: true, value: { since: NOW, items: [] } });
    read.props.onClick();
    await h.flush();
    await h.flush();
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]![0]).toMatchObject({
      type: 'project.seen',
      input: { project_id: 'project-brief-d' },
    });
    expect(h.value).toBeNull();
  });

  it('renders nothing for an empty brief', async () => {
    serve({ since: LEFT, items: [] });
    const h = await card('project-brief-e');
    expect(query).toHaveBeenCalled();
    expect(h.value).toBeNull();
  });
});
