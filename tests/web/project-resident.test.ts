import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectResident, WorkbenchSession } from '@pantheon/protocol';
import { deferred, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  queries: [] as {
    method: string;
    kinds?: ReadonlySet<string>;
    valid?: (value: unknown) => boolean;
  }[],
  answers: {} as Record<string, { read: unknown; error: string | null }>,
  reload: () => {},
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
  runCommand: vi.fn(async () => ({ ok: true, value: {} })),
}));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (
    method: string,
    _projectId: string | null,
    valid: (value: unknown) => boolean,
    _extra: unknown,
    options?: { kinds?: ReadonlySet<string> },
  ) => {
    mock.queries.push({ method, kinds: options?.kinds, valid });
    const answer = mock.answers[method] ?? { read: null, error: null };
    return { ...answer, loading: false, unavailable: false, stale: false, reload: mock.reload };
  },
}));
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
import { Failure } from '@/components/PanelBoundary';
import { runCommand } from '@/data/commands';
import { useProjectResident } from '@/data/project-resident';
import { AgentList } from '@/screens/project/AgentList';
import { ConductorComposer } from '@/screens/project/ConductorComposer';
import { mainAgent } from '@/screens/project/project-model';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { ResidentCard } from '@/screens/project/ResidentCard';
import { StatusPanel } from '@/screens/project/StatusPanel';
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

const NOW = Date.parse('2026-11-20T12:00:00.000Z');

const residentOf = (extra: Partial<ProjectResident> = {}): ProjectResident => ({
  session_id: 'lead',
  since: NOW - 3 * 3_600_000,
  turns: { pantheon: 4, user: 9 },
  budget: { used_input_tokens: 12_000, input_tokens: 200_000 },
  wakes: [],
  ...extra,
});

const NONE: ProjectResident = {
  session_id: null,
  since: null,
  turns: { pantheon: 0, user: 0 },
  budget: null,
  wakes: [],
};

const lead = listed('lead', { conductor: true });

const card = (
  read: ProjectResident | null,
  state: { error?: string | null; reload?: () => void } = {},
) =>
  mount(
    () =>
      ResidentCard({
        projectId: 'alpha',
        main: lead,
        sessions: [lead],
        resident: {
          read,
          error: state.error ?? null,
          loading: false,
          reload: state.reload ?? (() => {}),
        },
      }) as ReactElement,
  );

const button = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).find((n) => n.type === 'button' && text(n) === name);

const wakeRows = (tree: unknown) =>
  nodes(tree as ReactElement).filter((n) => n.type === 'li' && n.props.className === 'pj-rw');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.queries = [];
  mock.answers = {};
  mock.reload = () => {};
  useShell.setState({ screen: 'project', sessionId: null });
  vi.mocked(runCommand).mockClear();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('the resident read', () => {
  it('reads again after the resident, wake and turn events', () => {
    mount(() => useProjectResident('alpha'));
    expect(mock.queries.at(-1)?.method).toBe('project.resident');
    expect([...mock.queries.at(-1)!.kinds!]).toEqual(
      expect.arrayContaining([
        'project.resident_set',
        'resident.woken',
        'resident.wake_skipped',
        'turn.running',
        'turn.completed',
        'turn.failed',
        'turn.cancelled',
        'workflow.policy_changed',
        'session.discarded',
        'session.deleted',
      ]),
    );
  });

  it('takes only a read whose turn counts are numbers', () => {
    mount(() => useProjectResident('alpha'));
    const valid = mock.queries.at(-1)!.valid!;
    expect(valid(residentOf())).toBe(true);
    expect(valid({ ...residentOf(), turns: null })).toBe(false);
    expect(valid({ ...residentOf(), turns: { pantheon: 1 } })).toBe(false);
  });
});

describe('making the main agent resident', () => {
  it('offers the main agent and sends its id', async () => {
    const h = card(NONE);
    expect(text(h.value)).toContain(zh('project.resident.none'));
    const set = button(h.value, zhf('project.resident.set', { title: 'title of lead' }))!;
    set.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.resident.set',
      { project_id: 'alpha', session_id: 'lead' },
      null,
    );
  });

  it('stops the resident with a null session', async () => {
    const h = card(residentOf());
    button(h.value, zh('project.resident.unset'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.resident.set',
      { project_id: 'alpha', session_id: null },
      null,
    );
  });

  it('disables the button while the command is out and shows its failure', async () => {
    const answer = deferred<any>();
    vi.mocked(runCommand).mockReturnValueOnce(answer.promise);
    const h = card(NONE);
    const name = zhf('project.resident.set', { title: 'title of lead' });
    button(h.value, name)!.props.onClick();
    h.render();
    expect(button(h.value, name)!.props.disabled).toBe(true);
    answer.resolve({ ok: false, error: { code: 'invalid_input', message: 'Session is closed' } });
    await h.flush();
    expect(button(h.value, name)!.props.disabled).toBe(false);
    const alert = nodes(h.value).find((n) => n.props.role === 'alert');
    expect(text(alert)).toContain('Session is closed');
  });

  it('opens the resident session from its title', () => {
    const h = card(residentOf());
    const who = nodes(h.value).find(
      (n) => n.type === 'button' && text(n).startsWith('title of lead'),
    )!;
    who.props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'lead' });
  });
});

describe('the main agent with a resident', () => {
  const older = listed('older', { conductor: true, last_activity_at: '2026-11-20T08:00:00.000Z' });
  const newer = listed('newer', { conductor: true, last_activity_at: '2026-11-20T09:00:00.000Z' });
  const mainOf = (tree: unknown, component: unknown) =>
    nodes(tree as ReactElement).find((n) => n.type === component)?.props.main?.id ?? null;
  const screen = (sessions: WorkbenchSession[]) =>
    mount(() => ProjectScreen({ projectId: 'alpha', sessions }) as ReactElement);

  it('is the resident even when another main agent was active since', () => {
    mock.answers['project.resident'] = { read: residentOf({ session_id: 'older' }), error: null };
    const h = screen([older, newer]);
    expect(mainOf(h.value, StatusPanel)).toBe('older');
    expect(mainOf(h.value, AgentList)).toBe('older');
    expect(mainOf(h.value, ConductorComposer)).toBe('older');
    expect(mainOf(h.value, ResidentCard)).toBe('older');
  });

  it('falls back to the one active last once the resident closed', () => {
    mock.answers['project.resident'] = { read: residentOf({ session_id: 'older' }), error: null };
    const h = screen([{ ...older, state: 'done' }, newer]);
    expect(mainOf(h.value, StatusPanel)).toBe('newer');
    expect(mainOf(h.value, AgentList)).toBe('newer');
    expect(mainAgent([older, newer], 'older')?.id).toBe('older');
    expect(mainAgent([older, newer], null)?.id).toBe('newer');
  });

  it('stays the resident once archived while it is still open', () => {
    const archived = { ...older, archived_at: '2026-11-20T10:00:00.000Z' };
    expect(mainAgent([archived, newer], 'older')?.id).toBe('older');
    expect(mainAgent([archived, newer], null)?.id).toBe('newer');
  });

  it('opens no composer and no empty state before the resident is known', () => {
    mock.answers['project.resident'] = { read: null, error: null };
    const h = screen([older, newer]);
    expect(mainOf(h.value, ConductorComposer)).toBeNull();
    expect(text(h.value as ReactElement)).not.toContain(zh('project.empty.text'));
  });
});

describe('the resident card', () => {
  it('shows the two turn counts and the budget in use', () => {
    const shown = text(card(residentOf()).value);
    expect(shown).toContain(`${zh('project.resident.pantheonTurns')}4`);
    expect(shown).toContain(`${zh('project.resident.userTurns')}9`);
    expect(shown).toContain(
      `${zh('project.resident.budget')}${zhf('project.resident.budgetUse', { used: '12k', limit: '200k' })}`,
    );
  });

  it('says a used-up budget stops the wakes', () => {
    const read = residentOf({
      budget: { used_input_tokens: 210_000, input_tokens: 200_000, reached_at: NOW - 60_000 },
    });
    const shown = text(card(read).value);
    expect(shown).toContain(zh('project.resident.budgetReached'));
    expect(shown).not.toContain('210k');
  });

  it('writes each kind of wake and each reason a wake was skipped', () => {
    const read = residentOf({
      wakes: [
        {
          at: NOW - 5 * 60_000,
          kind: 'woken',
          cause: 'c1',
          turn_id: 't1',
          preview: 'Review finished',
        },
        { at: NOW - 2 * 3_600_000, kind: 'skipped', cause: 'c2', reason: 'budget' },
        { at: NOW - 3 * 3_600_000, kind: 'skipped', cause: 'c3', reason: 'not_accepting' },
      ],
    });
    expect(wakeRows(card(read).value).map((row) => text(row))).toEqual([
      `${zhf('data.age.minutes', { count: 5 })}${zh('project.resident.woken')}Review finished`,
      `${zhf('data.age.hours', { count: 2 })}${zh('project.resident.skippedBudget')}`,
      `${zhf('data.age.hours', { count: 3 })}${zh('project.resident.skippedNotAccepting')}`,
    ]);
  });

  it('shows the latest five wakes and all of them once expanded', () => {
    const wakes = Array.from({ length: 8 }, (_, i) => ({
      at: NOW - (i + 1) * 60_000,
      kind: 'woken' as const,
      cause: `c${i}`,
      turn_id: `t${i}`,
    }));
    const h = card(residentOf({ wakes }));
    expect(wakeRows(h.value)).toHaveLength(5);
    button(h.value, zh('project.resident.more'))!.props.onClick();
    h.render();
    expect(wakeRows(h.value)).toHaveLength(8);
  });

  it('says when the resident was never woken and offers no more button', () => {
    const h = card(residentOf());
    expect(text(h.value)).toContain(zh('project.resident.noWakes'));
    expect(button(h.value, zh('project.resident.more'))).toBeUndefined();
  });

  it.each([
    ['with no earlier read', null],
    ['beside the earlier read', residentOf()],
  ])('shows a failed read with a retry %s', (_name, read) => {
    const reload = vi.fn();
    const h = card(read, { error: 'daemon gone', reload });
    const failure = nodes(h.value).find((n) => n.type === Failure)!;
    expect(failure.props.error).toBe('daemon gone');
    failure.props.onRetry();
    expect(reload).toHaveBeenCalled();
    expect(text(h.value).includes(zh('project.resident.userTurns'))).toBe(read !== null);
  });
});
