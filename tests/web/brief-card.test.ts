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
import { Popover } from '../../apps/web/node_modules/@base-ui/react/popover/index.mjs';
import { BriefCard } from '@/screens/board/BriefCard';
import { ProjectNeeds } from '@/screens/board/NowPage';
import { TellLead } from '@/screens/board/TellLead';
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
/** The tree as drawn: a popover's portal only while its root is open. */
const drawn = (tree: unknown): any => {
  if (Array.isArray(tree)) return tree.map(drawn);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return tree;
  const node = tree as ReactElement<any>;
  const closed = node.type === Popover.Root && !node.props.open;
  const children = [node.props.children]
    .flat()
    .filter((child: any) => !(closed && child?.type === Popover.Portal))
    .map(drawn);
  return { ...node, props: { ...node.props, children } };
};
/** A cell of the card by its name, as a group or as the button that opens its list. */
const cell = (tree: unknown, label: string) =>
  find(drawn(tree), (n) => n.type !== Popover.Popup && n.props['aria-label'] === label);
const rootOf = (tree: unknown, label: string) =>
  find(
    tree as ReactElement,
    (n) =>
      n.type === Popover.Root &&
      nodes(n.props.children).some(
        (c) => c.type === Popover.Trigger && c.props['aria-label'] === label,
      ),
  );
/** Opens the cell's popover as a press on its button does, and returns the popup as drawn. */
const openCell = (h: { value: unknown; render(): unknown }, label: string) => {
  rootOf(h.value, label).props.onOpenChange(true);
  h.render();
  return find(drawn(h.value), (n) => n.type === Popover.Popup && n.props['aria-label'] === label);
};
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
    expect(text(cell(h.value, zhf('board.brief.waitingCount', { count: 7 })))).toContain('7');
    expect(text(cell(h.value, zhf('board.brief.milestonesCount', { count: 1 })))).toContain('1');
    expect(text(cell(h.value, zhf('board.brief.mergedCount', { count: 2 })))).toContain('2');
    expect(text(cell(h.value, zhf('board.brief.failedCount', { count: 2 })))).toContain('2');
    expect(text(cell(h.value, zhf('board.brief.assumptionsCount', { count: 1 })))).toContain('1');
    expect(text(cell(h.value, zhf('board.brief.proposalsCount', { count: 1 })))).toContain('1');
  });

  it('draws only the titles and counts until a cell is opened', async () => {
    serve(served);
    const h = await card('project-brief-c');
    const shown = drawn(h.value);
    expect(links(shown)).toEqual([]);
    for (const item of [
      'Add refund audit log',
      'Refund list filters',
      'Refund UI copy',
      'Reconciliation report',
      'UTC is the day boundary',
      'Refund UI',
    ])
      expect(text(shown)).not.toContain(item);
  });

  it('keeps the waiting cell a count with no button, since the list under the card has its items', async () => {
    serve(served);
    const h = await card('project-brief-c');
    const waitingCell = cell(h.value, zhf('board.brief.waitingCount', { count: 7 }));
    expect(waitingCell.props.role).toBe('group');
    expect(text(waitingCell)).toBe(`${zh('board.brief.waiting')}7`);
    expect(
      nodes(h.value).some(
        (n) =>
          n.type === Popover.Trigger &&
          n.props['aria-label'] === zhf('board.brief.waitingCount', { count: 7 }),
      ),
    ).toBe(false);
  });

  it.each([
    {
      cellName: 'merged',
      label: () => zhf('board.brief.mergedCount', { count: 2 }),
      titles: ['Refund list filters', 'Refund UI copy'],
      sessions: ['session-filters', 'session-copy'],
      tasks: [],
    },
    {
      cellName: 'failed',
      label: () => zhf('board.brief.failedCount', { count: 2 }),
      titles: ['Reconciliation report', 'Add refund audit log'],
      sessions: ['session-recon'],
      tasks: ['lead-1:audit'],
    },
    {
      cellName: 'assumptions',
      label: () => zhf('board.brief.assumptionsCount', { count: 1 }),
      titles: ['UTC is the day boundary'],
      sessions: ['lead-1'],
      tasks: [],
    },
  ])(
    'opens the $cellName cell to its items, each linking to its task or session',
    async ({ label, titles, sessions: opened, tasks }) => {
      serve(served);
      const onOpenTask = vi.fn();
      const h = await card('project-brief-c', onOpenTask);
      const button = cell(h.value, label());
      expect(button.type).toBe(Popover.Trigger);
      expect(button.props['aria-haspopup']).toBe('dialog');
      expect(button.props['aria-expanded']).toBe(false);
      const popup = openCell(h, label());
      expect(cell(h.value, label()).props['aria-expanded']).toBe(true);
      const shown = links(popup);
      expect(shown.map(text)).toEqual(titles);
      const prevented = { preventDefault: vi.fn() };
      shown.forEach((link) => link.props.onClick(prevented));
      expect(prevented.preventDefault).toHaveBeenCalledTimes(titles.length);
      expect(mock.openSession.mock.calls.map(([id]) => id)).toEqual(opened);
      expect(onOpenTask.mock.calls.map(([id]) => id)).toEqual(tasks);
      h.render();
      expect(rootOf(h.value, label()).props.open).toBe(false);
    },
  );

  it('lists the milestones that moved by title, without their score', async () => {
    serve(served);
    const h = await card('project-brief-c');
    const popup = openCell(h, zhf('board.brief.milestonesCount', { count: 1 }));
    expect(text(popup)).toBe('Refund UI');
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
    const label = zhf('board.brief.decidedCount', { count: 6 });
    expect(text(cell(h.value, label))).toContain(zh('board.brief.decided'));
    expect(text(cell(h.value, label))).toContain('6');
    const shown = links(openCell(h, label));
    expect(shown.map(text)).toEqual([
      zhf('board.brief.decidedPermissions', { count: 3 }),
      zhf('board.brief.decidedAnswers', { count: 2 }),
      zhf('board.brief.decidedOther', { count: 1 }),
    ]);
    shown.forEach((link) => link.props.onClick({ preventDefault() {} }));
    expect(mock.openProjectApproved.mock.calls).toEqual([
      ['project-brief-j', 'permission', LEFT],
      ['project-brief-j', 'answer', LEFT],
      ['project-brief-j', undefined, LEFT],
    ]);
  });

  it('has no other row when the types add up to the count', async () => {
    serve({
      since: LEFT,
      items: [
        {
          kind: 'decided',
          ref: { kind: 'decided', id: 'project-brief-j' },
          count: 5,
          types: { permission: 3, answer: 2, plan_change: 0 },
        },
      ],
    });
    const h = await card('project-brief-j');
    expect(links(openCell(h, zhf('board.brief.decidedCount', { count: 5 }))).map(text)).toEqual([
      zhf('board.brief.decidedPermissions', { count: 3 }),
      zhf('board.brief.decidedAnswers', { count: 2 }),
    ]);
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
  const accepted = (verified: boolean): DecisionForUser => ({
    kind: 'power_used',
    at: NOW - 120_000,
    power: 'accept_milestone',
    subject: 'ms-refund-ui',
    session_id: 'lead-1',
    reason: WHY,
    ...(verified ? {} : { verification: { id: 'verification-1', state: 'failed' as const } }),
  });
  const withMilestone = {
    ...model,
    milestones: [{ id: 'ms-refund-ui', title: 'Refund UI' }],
  } as unknown as BoardModel;

  it('lists a milestone the lead accepted without a passed verification under the counts, with its reason, state and Tell lead', async () => {
    serve(decidedBrief, {}, [accepted(false)]);
    const h = await card('project-brief-l', vi.fn(), withMilestone);
    expect(query).toHaveBeenCalledWith('project.decisions', {
      project_id: 'project-brief-l',
      since: String(LEFT + 1),
    });
    const label = zhf('board.brief.decidedCount', { count: 4 });
    expect(text(cell(h.value, label))).toContain('4');
    const popup = openCell(h, label);
    expect(links(popup).map(text)).toEqual([
      zhf('board.brief.decidedPermissions', { count: 2 }),
      zhf('board.brief.decidedOther', { count: 2 }),
    ]);
    const entry = find(
      popup,
      (n) =>
        n.props.role === 'group' &&
        n.props['aria-label'] ===
          zhf('board.brief.leadAccepted', { lead: 'Refunds rollout lead', milestone: 'Refund UI' }),
    );
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

  it('keeps the decided popover to its counts when the lead accepted only verified milestones', async () => {
    serve(decidedBrief, {}, [accepted(true)]);
    const h = await card('project-brief-l', vi.fn(), withMilestone);
    const popup = openCell(h, zhf('board.brief.decidedCount', { count: 4 }));
    expect(text(popup)).toBe(
      zhf('board.brief.decidedPermissions', { count: 2 }) +
        zhf('board.brief.decidedOther', { count: 2 }),
    );
    expect(nodes(popup).some((n) => n.type === TellLead)).toBe(false);
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
