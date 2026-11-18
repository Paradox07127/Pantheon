import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AppSettings, BoardModel, ProjectBrief } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  openSession: vi.fn(),
  openProjectApproved: vi.fn(),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'brief-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    (selector: any) =>
      selector({ openSession: mock.openSession, openProjectApproved: mock.openProjectApproved }),
    { setState() {} },
  ),
}));
import { BriefCard } from '@/screens/board/BriefCard';
import { ProjectNeeds } from '@/screens/board/NowPage';
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

const serve = (brief: ProjectBrief, settings: Partial<AppSettings> = {}) => {
  query = vi.fn(async (method: string) => ({
    ok: true,
    value: method === 'app.settings' ? settings : brief,
  }));
  command = vi.fn(async () => ({ ok: true, value: { project_id: 'x', at: NOW } }));
  vi.stubGlobal('window', {
    pantheon: { query, command },
    addEventListener() {},
    removeEventListener() {},
  });
};

beforeEach(() => {
  mock.openSession.mockReset();
  mock.openProjectApproved.mockReset();
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
const needsList = (projectId: string) =>
  mount(() =>
    ProjectNeeds({ projectId, model, sessions, run: async () => null, onOpenSession() {} }),
  );
const group = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.props.role === 'group' && n.props['aria-label'] === label);
const links = (tree: unknown) => nodes(tree as ReactElement).filter((n) => n.type === 'a');
const sent = (type: string) =>
  command.mock.calls.map(([each]) => each).filter((each) => each.type === type);

describe('needs-you list under the card', () => {
  it('stays out until the brief read lands, so the card does not push it down', async () => {
    let land!: (answer: unknown) => void;
    serve(served);
    query.mockImplementation(() => new Promise((resolve) => (land = resolve)));
    const h = needsList('project-brief-g');
    await h.flush();
    expect(h.value).toBeNull();
    land({ ok: true, value: served });
    await h.flush();
    expect(h.value).not.toBeNull();
  });

  it('shows when the brief read fails', async () => {
    serve(served);
    query.mockImplementation(async () => ({
      ok: false,
      error: { code: 'daemon_unavailable', message: 'The daemon is not running' },
    }));
    const h = needsList('project-brief-h');
    await h.flush();
    expect(h.value).not.toBeNull();
  });

  it('marks its list while the task drawer is open, so the rows take the narrow columns', async () => {
    serve(served);
    const list = (drawer: boolean) =>
      mount(() =>
        ProjectNeeds({
          projectId: 'project-brief-i',
          model,
          sessions,
          run: async () => null,
          onOpenSession() {},
          drawer,
        }),
      );
    const open = list(true);
    await open.flush();
    expect((open.value as ReactElement<Record<string, unknown>>).props['data-drawer']).toBe('');
    const shut = list(false);
    await shut.flush();
    expect(
      (shut.value as ReactElement<Record<string, unknown>>).props['data-drawer'],
    ).toBeUndefined();
  });
});

describe('since you left card', () => {
  it('reads the brief of its project and is a group named for the time away', async () => {
    serve(served);
    const h = await card('project-brief-a');
    expect(query).toHaveBeenCalledWith('project.brief', { project_id: 'project-brief-a' });
    const root = group(h.value, zh('board.brief.label'));
    expect(text(root)).toContain(zh('board.brief.label'));
    expect(text(root)).toContain(zh('board.brief.read'));
  });

  it('heads the card with its title, the time the user left and Mark as read in one row', async () => {
    serve(served);
    const h = await card('project-brief-f');
    const root = group(h.value, zh('board.brief.label'));
    const header = find(root, (n) =>
      [n.props.children].flat().some((c: any) => c?.type === 'button'),
    );
    expect(
      [header.props.children]
        .flat()
        .filter(Boolean)
        .map((c: any) => (c.type === 'time' ? 'time' : text(c))),
    ).toEqual([zh('board.brief.label'), 'time', zh('board.brief.read')]);
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

  it('counts what was decided for the user and links each type to the approved list filtered by it', async () => {
    serve({
      since: LEFT,
      items: [
        {
          kind: 'decided',
          ref: { kind: 'decided', id: 'project-brief-j' },
          count: 6,
          types: { permission: 3, answer: 2, plan_change: 0 },
        },
      ],
    });
    const h = await card('project-brief-j');
    const cell = group(h.value, zhf('board.brief.decidedCount', { count: 6 }));
    expect(text(cell)).toContain(zh('board.brief.decided'));
    expect(text(cell)).toContain('6');
    const shown = links(cell);
    expect(shown.map(text)).toEqual([
      zhf('board.brief.decidedPermissions', { count: 3 }),
      zhf('board.brief.decidedAnswers', { count: 2 }),
    ]);
    shown.forEach((link) => link.props.onClick({ preventDefault() {} }));
    expect(mock.openProjectApproved.mock.calls).toEqual([
      ['project-brief-j', 'permission', LEFT],
      ['project-brief-j', 'answer', LEFT],
    ]);
  });

  it('has no decided cell without decisions', async () => {
    serve(served);
    const h = await card('project-brief-k');
    expect(text(h.value)).not.toContain(zh('board.brief.decided'));
  });

  it('marks the project read and hides', async () => {
    serve(served);
    const h = await card('project-brief-d');
    const read = find(h.value, (n) => n.type === 'button' && text(n) === zh('board.brief.read'));
    query.mockResolvedValue({ ok: true, value: { since: NOW, items: [] } });
    read.props.onClick();
    await h.flush();
    await h.flush();
    expect(sent('project.seen')).toEqual([
      expect.objectContaining({ input: { project_id: 'project-brief-d' } }),
    ]);
    expect(h.value).toBeNull();
  });

  it('renders nothing for an empty brief', async () => {
    serve({ since: LEFT, items: [] });
    const h = await card('project-brief-e');
    expect(query).toHaveBeenCalled();
    expect(h.value).toBeNull();
    expect(sent('project.brief.prose.write')).toEqual([]);
  });

  it('shows the paragraph under the cells with each cited item as its link', async () => {
    serve({
      ...served,
      prose: {
        sentences: [
          {
            text: 'Refund list filters merged, so Refund UI is complete.',
            refs: [
              { kind: 'merge', id: 'session-filters' },
              { kind: 'milestone', id: 'ms-refund-ui' },
            ],
          },
          {
            text: 'Reconciliation report failed its gate.',
            refs: [{ kind: 'event', id: 'event-recon-failed' }],
          },
          { text: 'The audit log waits on you.', refs: [{ kind: 'task', id: 'lead-1:audit' }] },
        ],
        at: NOW,
      },
    });
    const onOpenTask = vi.fn();
    const h = await card('project-brief-f', onOpenTask);
    const paragraph = find(h.value, (n) => n.type === 'p');
    expect(text(paragraph)).toBe(
      'Refund list filters merged, so Refund UI is complete. Reconciliation report failed its gate. The audit log waits on you.',
    );
    const cited = links(paragraph);
    expect(cited.map(text)).toEqual([
      'Refund list filters',
      'Reconciliation report',
      'The audit log waits on you.',
    ]);
    cited.forEach((link) => link.props.onClick({ preventDefault() {} }));
    expect(mock.openSession.mock.calls.map(([id]) => id)).toEqual([
      'session-filters',
      'session-recon',
    ]);
    expect(onOpenTask).toHaveBeenCalledWith('lead-1:audit');
    expect(text(h.value)).toContain(zh('board.brief.assistant'));
    expect(sent('project.brief.prose.write')).toEqual([]);
  });

  it('asks for the paragraph once for a brief without one', async () => {
    serve(served);
    const h = await card('project-brief-g');
    h.render();
    await h.flush();
    expect(sent('project.brief.prose.write')).toEqual([
      expect.objectContaining({ input: { project_id: 'project-brief-g' } }),
    ]);
  });

  it('does not ask for the paragraph with the setting off', async () => {
    serve(served, { brief_prose: false });
    const h = await card('project-brief-h');
    h.render();
    await h.flush();
    expect(sent('project.brief.prose.write')).toEqual([]);
  });
});
