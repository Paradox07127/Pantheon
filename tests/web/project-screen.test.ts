import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { ChangeRow, ProjectSummary, WorkbenchSession } from '@pantheon/protocol';
import { SPAWNED_SESSION_LIMIT } from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  plan: { read: null, error: null, loading: false, unavailable: false, stale: false } as any,
  summaries: null as ProjectSummary[] | null,
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
vi.mock('@/data/project-resident', () => ({
  // Read, with no resident: the main agent is the one active last.
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
  useProjectsSummary: () => ({ data: mock.summaries, loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
import { runCommand } from '@/data/commands';
import { draftKey, useDrafts } from '@/data/drafts';
import { AgentList } from '@/screens/project/AgentList';
import { ConductorComposer } from '@/screens/project/ConductorComposer';
import { mainAgent, statusCounts } from '@/screens/project/project-model';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { StatusPanel } from '@/screens/project/StatusPanel';
import { ChangeLine, UnplannedList } from '@/screens/project/UnplannedList';
import { useShell } from '@/store';
import { zh, zhf } from './i18n-setup.js';

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-20T09:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-20T10:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

const onBoard = (id: string, state: Session['state'], revision = 3): Session =>
  ({
    id,
    revision,
    project_id: 'alpha',
    runtime: 'claude',
    state,
    turn_count: 1,
  }) as Session;

const summary: ProjectSummary = {
  project_id: 'alpha',
  name: 'Alpha',
  counts: { running: 2, waiting: 1, ready: 0, failed: 3 },
  merged_today: 0,
  needs_you: 2,
  last_activity_at: '2026-11-20T10:00:00.000Z',
  waiting: { by_decision: {}, longest_wait_ms: 18 * 60_000 },
};

const row = (id: string, title: string, extra: Partial<ChangeRow> = {}): ChangeRow => ({
  id,
  kind: 'session',
  title,
  runtime: 'claude',
  status: 'ready',
  gate: { state: 'passed' },
  changes: { files: 2, additions: 12, deletions: 12 },
  updated_at: '2026-11-20T10:00:00.000Z',
  ...extra,
});

const clipText = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'Clip')
    .map((n) => n.props.text as string);

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.plan = { read: null, error: null, loading: false, unavailable: false, stale: false };
  mock.summaries = [summary];
  useDrafts.setState({ drafts: {}, answers: {} });
  useShell.setState({ screen: 'project', sessionId: null });
  vi.mocked(runCommand).mockClear();
});
afterEach(() => unmountAll());

describe('the main agent', () => {
  it.each([
    [
      'takes the most recently active of several main agents',
      [
        listed('older', { conductor: true, last_activity_at: '2026-11-20T08:00:00.000Z' }),
        listed('newer', { conductor: true, last_activity_at: '2026-11-20T09:00:00.000Z' }),
        listed('worker', { last_activity_at: '2026-11-20T11:00:00.000Z' }),
      ],
      'newer',
    ],
    [
      'leaves out a closed main agent',
      [
        listed('ended', { conductor: true, state: 'done' }),
        listed('crashed', { conductor: true, state: 'failed' }),
        listed('open', { conductor: true, last_activity_at: '2026-11-19T10:00:00.000Z' }),
      ],
      'open',
    ],
    [
      'leaves out an archived main agent',
      [
        listed('archived', { conductor: true, archived_at: '2026-11-20T10:30:00.000Z' }),
        listed('kept', { conductor: true, last_activity_at: '2026-11-19T10:00:00.000Z' }),
      ],
      'kept',
    ],
    ['is none without a main agent', [listed('worker')], null],
    [
      'is none when every main agent is closed or archived',
      [
        listed('ended', { conductor: true, state: 'merged' }),
        listed('archived', { conductor: true, archived_at: '2026-11-20T10:30:00.000Z' }),
      ],
      null,
    ],
  ] as const)('%s', (_name, sessions, expected) => {
    expect(mainAgent(sessions as readonly WorkbenchSession[])?.id ?? null).toBe(expected);
  });
});

describe('the project screen', () => {
  const screen = (sessions: WorkbenchSession[]) =>
    mount(() => ProjectScreen({ projectId: 'alpha', sessions }) as ReactElement);
  const startButton = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'button' && text(n) === zh('project.empty.start'),
    );
  const has = (tree: unknown, component: unknown) =>
    nodes(tree as ReactElement).some((n) => n.type === component);

  it.each([
    ['offers to start a main agent and has no message box or agent list without one', [], true],
    [
      'has the message box and the agent list once there is a main agent',
      [listed('lead', { conductor: true })],
      false,
    ],
  ] as const)('%s', (_name, sessions, empty) => {
    const h = screen([listed('worker'), ...sessions]);
    expect(!!startButton(h.value)).toBe(empty);
    expect(text(h.value).includes(zh('project.empty.text'))).toBe(empty);
    expect(has(h.value, ConductorComposer)).toBe(!empty);
    expect(has(h.value, AgentList)).toBe(!empty);
    expect(has(h.value, UnplannedList)).toBe(true);
  });

  it('offers no main agent before the session list is read', () => {
    const h = mount(() => ProjectScreen({ projectId: 'alpha', sessions: null }) as ReactElement);
    expect(startButton(h.value)).toBeUndefined();
    expect(text(h.value).includes(zh('project.empty.text'))).toBe(false);
  });

  it('turns the main agent switch on in the new-session draft and opens the composer', () => {
    const h = screen([listed('worker')]);
    startButton(h.value)!.props.onClick();
    expect(useDrafts.getState().drafts[draftKey('alpha', null)]?.conductor).toBe(true);
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: '' });
  });
});

describe('the message box to the main agent', () => {
  const box = (main: WorkbenchSession) => mount(() => ConductorComposer({ main }) as ReactElement);
  const textarea = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'textarea' && n.props['aria-label'] === zh('project.composer.message'),
    )!;
  const send = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'button' && n.props['aria-label'] === zh('project.composer.send'),
    )!;

  it.each([
    ['sends to an idle main agent', 'idle', 'open', 'session.send'],
    ['steers a running main agent', 'running', 'running', 'session.steer'],
  ] as const)('%s', async (_name, listedState, boardState, command) => {
    mock.board.board.sessions = [onBoard('lead', boardState, 9)];
    const h = box(listed('lead', { conductor: true, state: listedState }));
    expect(textarea(h.value).props.placeholder).toBe(
      zhf('project.composer.placeholder', { title: 'title of lead' }),
    );
    const message = 'Split the parser first.\nThen the printer.';
    textarea(h.value).props.onChange({ target: { value: message } });
    h.render();
    send(h.value).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(command, { session_id: 'lead', input: message }, 9);
    expect(textarea(h.value).props.value).toBe('');
  });

  it('keeps the message and shows the error when the daemon refuses it', async () => {
    mock.board.board.sessions = [onBoard('lead', 'open')];
    vi.mocked(runCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'resource_busy', message: 'The session is busy' },
    } as never);
    const h = box(listed('lead', { conductor: true }));
    textarea(h.value).props.onChange({ target: { value: 'Land the parser' } });
    h.render();
    send(h.value).props.onClick();
    await h.flush();
    expect(textarea(h.value).props.value).toBe('Land the parser');
    const alert = nodes(h.value).find((n) => n.props.role === 'alert');
    expect(text(alert)).toContain('The session is busy');
  });
});

describe('the agent list', () => {
  const lead = listed('lead', {
    conductor: true,
    recap: { headline: 'Waiting for the schema', happened: '', at: 1 },
    context: { used_tokens: 41, window_tokens: 100 },
  });
  const sessions = [
    lead,
    listed('schema', {
      spawned_by: { session_id: 'lead' },
      state: 'running',
      last_turn: { id: 't1', state: 'running' },
    }),
    listed('migration', {
      spawned_by: { session_id: 'lead' },
      state: 'waiting',
      waiting: 1,
      last_turn: { id: 't2', state: 'completed' },
    }),
    listed('mine'),
    listed('elsewhere', { spawned_by: { session_id: 'other-lead' } }),
  ];
  const rows = (tree: unknown) => nodes(tree as ReactElement).filter((n) => n.type === 'button');

  it('lists the main agent first, then the sessions it spawned, and no other session', () => {
    const h = mount(() => AgentList({ main: lead, sessions }) as ReactElement);
    expect(rows(h.value).map((b) => clipText(b)[0])).toEqual([
      'title of lead',
      'title of schema',
      'title of migration',
    ]);
    expect(clipText(rows(h.value)[0])).toContain('Waiting for the schema');
    rows(h.value)[1]!.props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'schema' });
  });

  it('says under a spawned session why its last turn failed instead of its headline', () => {
    const recap = { headline: 'Schema drafted', happened: '', at: 1 };
    const subtitles = (last_turn: WorkbenchSession['last_turn']) => {
      const spawned = listed('schema', { spawned_by: { session_id: 'lead' }, recap, last_turn });
      const h = mount(() => AgentList({ main: lead, sessions: [lead, spawned] }) as ReactElement);
      return clipText(rows(h.value)[1]);
    };
    expect(
      subtitles({ id: 't3', state: 'failed', error: 'Build failed', told_main_agent: true }),
    ).toEqual([
      'title of schema',
      zhf('components.sessionState.lastTurnFailedBecause', {
        reason: 'Build failed',
        handler: zh('project.plan.mainAgentKnows'),
      }),
    ]);
    expect(subtitles({ id: 't3', state: 'completed' })).toEqual([
      'title of schema',
      'Schema drafted',
    ]);
  });

  // The waiting session holds a running turn its last send does not show, as a steer would.
  it('counts the spawned sessions taking a turn against the limit in its title', () => {
    const h = mount(() => AgentList({ main: lead, sessions }) as ReactElement);
    const slots = nodes(h.value).find(
      (n) =>
        n.props['aria-label'] ===
        zhf('project.agents.slotsLabel', { running: 2, limit: SPAWNED_SESSION_LIMIT }),
    );
    expect(text(slots)).toBe(
      zhf('project.agents.slots', { running: 2, limit: SPAWNED_SESSION_LIMIT }),
    );
  });
});

describe('the status head', () => {
  it('takes its counts from the project summary, zeros included, waiting as its needs-you items', () => {
    expect(statusCounts(summary)).toEqual([
      { key: 'running', label: zh('project.status.running'), count: 2 },
      {
        key: 'waiting',
        label: zh('project.status.waiting'),
        count: 2,
        longest: 18 * 60_000,
      },
      { key: 'ready', label: zh('project.status.ready'), count: 0 },
      { key: 'failed', label: zh('project.status.failed'), count: 3 },
      { key: 'today', label: zh('project.status.landedToday'), count: 0 },
    ]);
  });

  it.each([
    [
      'shows the latest landing by its short sha and title',
      {
        sha: 'a41c9e2f00d1c0ffee',
        title: 'Constant-time compare helper',
        at: '2026-11-20T10:00:00.000Z',
      },
    ],
    ['leaves the latest landing out when nothing landed', undefined],
  ] as const)('%s', (_name, latest) => {
    const h = mount(
      () => StatusPanel({ summary, main: null, latest: latest && { ...latest } }) as ReactElement,
    );
    const shown = text(h.value);
    expect(shown.includes(zh('project.status.latestLanding'))).toBe(!!latest);
    if (latest) {
      expect(shown).toContain('a41c9e2');
      expect(shown).not.toContain(latest.sha);
      expect(clipText(h.value)).toContain(latest.title);
    }
  });
});

describe('the unplanned list', () => {
  const rows = [
    row('session:bump', 'Bump vitest to 3.2'),
    row('landing:hotfix', 'Hotfix without a session', { kind: 'branch', runtime: undefined }),
  ];

  it('has one row per unplanned change and opens the session of a row', () => {
    const h = mount(() => UnplannedList({ rows }) as ReactElement);
    expect(text(h.value)).toContain(zh('project.unplanned.title'));
    const lines = nodes(h.value)
      .filter((n) => n.type === ChangeLine)
      .map((n) => ChangeLine(n.props));
    expect(lines.map((line) => clipText(line)[0])).toEqual([
      'Bump vitest to 3.2',
      'Hotfix without a session',
    ]);
    const open = nodes(lines[0]).find((n) => n.type === 'button')!;
    open.props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'bump' });
    expect(nodes(lines[1]).some((n) => n.type === 'button')).toBe(false);
  });
});
