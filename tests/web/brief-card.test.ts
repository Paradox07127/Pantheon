import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AppSettings, BoardModel, DecisionForUser, ProjectBrief } from '@pantheon/protocol';
import { find, HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
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
import { ProjectNeeds } from '@/screens/board/OverviewPage';
import { RungLabel } from '@/screens/board/TaskRecovery';
import { TellLead } from '@/screens/board/TellLead';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { reasonText } from '@/data/needs-you';
import { listText } from '@/lib/list-text';
import { dayText } from '@/lib/time-text';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 17, 14);
const LEFT = NOW - 3 * 3_600_000;

type Task = BoardModel['tasks'][number];
const task = (id: string, title: string, extra: Partial<Task> = {}): Task =>
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
    ...extra,
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

const RUNG = {
  rung: 'retry',
  by: 'pantheon',
  reason: 'gate_failed',
  used: 2,
  limit: 3,
  since: NOW - 300_000,
  switches: [],
} as const;

const model = {
  since: NOW - 7 * 86_400_000,
  now: NOW,
  tasks: [
    task('lead-1:audit', 'Add refund audit log', {
      gate_steps: [
        { name: 'lint', state: 'passed' },
        { name: 'test:web', state: 'failed' },
      ],
      rung: { ...RUNG, switches: [] },
    }),
  ],
  merges: [
    merge('session-filters', 'Refund list filters'),
    merge('session-copy', 'Refund UI copy'),
  ],
  milestones: [],
} as unknown as BoardModel;

const sessions = [
  { id: 'session-recon', title: 'Reconciliation report' },
  { id: 'lead-1', title: 'Refunds rollout lead', state: 'open' },
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
    {
      kind: 'failure',
      ref: { kind: 'task', id: 'lead-1:audit' },
      at: NOW - 400_000,
      reason: 'gate_failed',
    },
    { kind: 'proposal', ref: { kind: 'proposal', id: 'proposal-1' }, at: NOW - 500_000 },
  ],
};

let query: ReturnType<typeof vi.fn>;
let command: ReturnType<typeof vi.fn>;

const serve = (
  brief: ProjectBrief,
  settings: Partial<AppSettings> = {},
  decided: DecisionForUser[] = [],
) => {
  query = vi.fn(async (method: string) => ({
    ok: true,
    value:
      method === 'app.settings'
        ? settings
        : method === 'project.decisions'
          ? { items: decided }
          : brief,
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

const card = async (projectId: string, onOpenTask = vi.fn(), shown = model) => {
  const h = mount(() =>
    BriefCard({ projectId, model: shown, sessions, onOpenTask, run: async () => null }),
  );
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
/** A lane of the time track by its name and the counts its label writes out. */
const laneLabel = (lane: string, count: number, ...parts: string[]) =>
  zhf('board.brief.laneLabel', { lane, count, parts: listText(...parts) });
/** The points of a lane, as the buttons it draws and the proposals it reads first. */
const points = (lane: ReactElement<any>) => nodes(lane.props.children).filter((n) => n !== lane);
const pointLabel = (at: number, type: string, title: string) =>
  zhf('board.brief.point', { time: dayText(at, NOW, { time: true }), type, title });

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

  it('heads the card with its title, how long the user was away and Mark as read in one row', async () => {
    serve(served);
    const h = await card('project-brief-f');
    const root = group(h.value, zh('board.brief.label'));
    const header = find(root, (n) =>
      [n.props.children].flat().some((c: any) => c?.type === 'button'),
    );
    const parts = [header.props.children].flat().filter(Boolean);
    expect(parts.map((c: any) => (c.type === 'time' ? 'time' : text(c)))).toEqual([
      zh('board.brief.label'),
      'time',
      zh('board.brief.read'),
    ]);
    expect(text(parts[1])).toBe(zhf('board.brief.away', { duration: '3 小时' }));
  });

  it('draws the delivered lane with a point per merge and failure, each named by its time, kind and title', async () => {
    serve(served);
    const onOpenTask = vi.fn();
    const h = await card('project-brief-b', onOpenTask);
    const lane = group(
      h.value,
      laneLabel(
        zh('board.brief.lane.delivered'),
        4,
        zhf('board.brief.mergedCount', { count: 2 }),
        zhf('board.brief.failedCount', { count: 2 }),
      ),
    );
    const shown = points(lane).filter((n) => n.type === 'button');
    expect(shown.map((n) => n.props['aria-label'])).toEqual([
      pointLabel(NOW - 3_600_000, zh('board.brief.merged'), 'Refund list filters'),
      pointLabel(NOW - 3_000_000, zh('board.brief.merged'), 'Refund UI copy'),
      pointLabel(NOW - 2_000_000, reasonText('gate_failed'), 'Reconciliation report'),
      pointLabel(NOW - 400_000, reasonText('gate_failed'), 'Add refund audit log'),
    ]);
    // Placed by time on the track from leaving to now.
    expect(shown[0]!.props.style.left).toBe(`${(2 / 3) * 100}%`);
    shown.forEach((point) => point.props.onClick());
    expect(mock.openSession.mock.calls.map(([id]) => id)).toEqual([
      'session-filters',
      'session-copy',
      'session-recon',
    ]);
    expect(onOpenTask.mock.calls.map(([id]) => id)).toEqual(['lead-1:audit']);
  });

  it('draws the plan lane with the new assumptions and the agent proposals', async () => {
    serve(served);
    const h = await card('project-brief-c');
    const lane = group(
      h.value,
      laneLabel(
        zh('board.brief.lane.plan'),
        2,
        zhf('board.brief.assumptionsCount', { count: 1 }),
        zhf('board.brief.proposalsCount', { count: 1 }),
      ),
    );
    const [assumption, proposal] = points(lane).filter(
      (n) =>
        n.type === 'button' || (typeof n.type === 'function' && n.type.name === 'ProposalPoint'),
    );
    expect(assumption!.props['aria-label']).toBe(
      pointLabel(NOW - 1_000_000, zh('board.brief.type.assumption'), 'UTC is the day boundary'),
    );
    assumption!.props.onClick();
    expect(mock.openSession).toHaveBeenCalledWith('lead-1');
    expect(proposal!.props.point).toMatchObject({ key: 'proposal-1', at: NOW - 500_000 });
  });

  it('draws the decided lane with a point per decision, which opens the approved list on its type', async () => {
    const decided: DecisionForUser[] = [
      {
        kind: 'prompt_approved',
        at: NOW - 7_000_000,
        approval_id: 'approval-1',
        session_id: 'session-recon',
        decided_by: 'session:lead-1',
        tool: 'Bash',
        input_summary: 'pnpm test',
      },
      {
        kind: 'question_answered',
        at: NOW - 6_000_000,
        lead_session_id: 'lead-1',
        question_id: 'question-1',
        question: 'Which day boundary?',
        answer: 'UTC',
        citations: [],
      },
    ];
    serve(
      {
        since: LEFT,
        items: [
          {
            kind: 'decided',
            ref: { kind: 'decided', id: 'project-brief-j' },
            count: 2,
            types: { permission: 1, answer: 1, plan_change: 0 },
          },
        ],
      },
      {},
      decided,
    );
    const h = await card('project-brief-j');
    const lane = group(
      h.value,
      laneLabel(
        zh('board.brief.decided'),
        2,
        zhf('board.brief.decidedPermissions', { count: 1 }),
        zhf('board.brief.decidedAnswers', { count: 1 }),
      ),
    );
    const shown = points(lane).filter((n) => n.type === 'button');
    expect(shown.map((n) => n.props['aria-label'])).toEqual([
      pointLabel(NOW - 7_000_000, zh('board.brief.type.permission'), 'pnpm test'),
      pointLabel(NOW - 6_000_000, zh('board.brief.type.answer'), 'Which day boundary?'),
    ]);
    shown.forEach((point) => point.props.onClick());
    expect(mock.openProjectApproved.mock.calls).toEqual([
      ['project-brief-j', 'permission', LEFT],
      ['project-brief-j', 'answer', LEFT],
    ]);
    // The lanes without events are drawn empty.
    expect(
      group(h.value, zhf('board.brief.laneEmpty', { lane: zh('board.brief.lane.delivered') })),
    ).toBeTruthy();
  });

  it('keeps a milestone that moved, which has no time, as a line under the track, with the decisions waiting', async () => {
    serve(served);
    const h = await card('project-brief-c');
    const lines = find(
      h.value,
      (n) => n.props.className === 'bf-brief-rows' && text(n).includes('Refund UI'),
    );
    expect(text(lines)).toBe(`${zhf('board.brief.waitingCount', { count: 7 })}Refund UI`);
  });

  it('lists each failure still waiting with its failed gate step and who acts next', async () => {
    serve(served);
    const onOpenTask = vi.fn();
    const h = await card('project-brief-c', onOpenTask);
    const failed = nodes(h.value).filter((n) => n.props.className === 'bf-brief-fail');
    expect(failed.map((n) => text(n))).toEqual([
      'Reconciliation report',
      'Add refund audit logtest:web',
    ]);
    expect(find(failed[1], (n) => n.type === RungLabel).props.rung).toMatchObject({ used: 2 });
    failed.forEach((n) => n.props.onClick({ preventDefault() {} }));
    expect(mock.openSession).toHaveBeenCalledWith('session-recon');
    expect(onOpenTask).toHaveBeenCalledWith('lead-1:audit');
  });

  const decidedBrief: ProjectBrief = {
    since: LEFT,
    items: [
      {
        kind: 'decided',
        ref: { kind: 'decided', id: 'project-brief-l' },
        count: 4,
        types: { permission: 2, answer: 0, plan_change: 0 },
      },
    ],
  };
  const WHY = 'The failing test pins a display format the criteria do not ask for.';
  const accepted = (
    verified: boolean,
    state: 'failed' | 'running' | 'pending' = 'failed',
  ): DecisionForUser => ({
    kind: 'power_used',
    at: NOW - 120_000,
    power: 'accept_milestone',
    subject: 'ms-refund-ui',
    session_id: 'lead-1',
    reason: WHY,
    ...(verified ? {} : { verification: { id: 'verification-1', state } }),
  });
  const withMilestone = {
    ...model,
    milestones: [{ id: 'ms-refund-ui', title: 'Refund UI' }],
  } as unknown as BoardModel;
  const acceptedEntry = (tree: unknown) =>
    find(
      tree as ReactElement,
      (n) =>
        n.props.role === 'group' &&
        n.props['aria-label'] ===
          zhf('board.brief.leadAccepted', { lead: 'Refunds rollout lead', milestone: 'Refund UI' }),
    );

  it('lists a milestone the lead accepted without a passed verification under the track, with its reason, state and Tell lead', async () => {
    serve(decidedBrief, {}, [accepted(false)]);
    const h = await card('project-brief-l', vi.fn(), withMilestone);
    expect(query).toHaveBeenCalledWith('project.decisions', {
      project_id: 'project-brief-l',
      since: String(LEFT + 1),
    });
    const entry = acceptedEntry(h.value);
    expect(text(entry)).toContain(WHY);
    expect(text(entry)).toContain(zh('board.verify.badge.failed'));
    const tell = find(entry, (n) => n.type === TellLead);
    const drawnTell = new HookHost(() => TellLead(tell.props)).render();
    expect(find(drawnTell, (b) => b.type === 'button').props['aria-label']).toBe(
      zhf('board.lead.tell.buttonLabel', {
        action: zh('board.verify.card.tellLead'),
        label: 'Refund UI',
      }),
    );
    expect(tell.props.lead).toBe(sessions[1]);
    expect(tell.props.draft).toContain('Refund UI');
  });

  it.each(['running', 'pending'] as const)(
    'shows a verification still %s at the acceptance without a time, as the decision has none',
    async (state) => {
      serve(decidedBrief, {}, [accepted(false, state)]);
      const h = await card('project-brief-l', vi.fn(), withMilestone);
      expect(
        nodes(acceptedEntry(h.value)).some(
          (n) => typeof n.type === 'string' && text(n) === zh('board.verify.badge.runningNoTime'),
        ),
      ).toBe(true);
    },
  );

  it('lists no accepted milestone when the lead accepted only verified ones', async () => {
    serve(decidedBrief, {}, [accepted(true)]);
    const h = await card('project-brief-l', vi.fn(), withMilestone);
    expect(nodes(h.value).some((n) => n.type === TellLead)).toBe(false);
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

  it('shows the paragraph over the track with each cited item as its link, and when it was written', async () => {
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
        at: NOW - 60_000,
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
    expect(text(h.value)).toContain(
      zhf('board.brief.writtenAt', { time: dayText(NOW - 60_000, NOW, { time: true }) }),
    );
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
