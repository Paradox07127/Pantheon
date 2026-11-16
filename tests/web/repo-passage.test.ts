import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type {
  GithubItems,
  RepoTimeline,
  SessionDiff,
  SessionGatesHistory,
  WorkbenchSession,
} from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  sessions: [] as unknown[],
  diff: null as unknown,
  timeline: null as unknown,
  pulls: null as unknown,
  history: null as unknown,
  stories: [] as unknown[],
  storyDiff: null as unknown,
  comments: [] as unknown[],
  statuses: [] as { runtime: string; enabled: boolean; installed: boolean; auth: object }[],
  unavailable: {} as Record<string, string>,
  run: null as unknown as (...args: unknown[]) => Promise<unknown>,
  open: null as unknown as (...args: unknown[]) => void,
}));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
const landed = vi.hoisted(() => (data: unknown) => ({
  data,
  read: data,
  loading: false,
  refreshing: false,
  stale: false,
  error: null,
  reload() {},
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'passage-id' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoTimeline: () => landed(mock.timeline),
  useGithubPulls: () => landed(mock.pulls),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => landed(mock.sessions),
  useSessionDiff: (sessionId: string | null) => landed(sessionId === null ? null : mock.diff),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => landed(null),
  useSessionGatesHistory: () => landed(mock.history),
  useSessionReviews: () => landed([]),
  useSessionPreflight: () => landed(null),
}));
vi.mock('@/data/session-comments', async (actual) => ({
  ...(await actual<object>()),
  useSessionComments: () => landed(mock.comments),
}));
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => landed(mock.stories),
  useChangeStoryDiff: () => landed(mock.storyDiff),
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({
    read: { state: 'ready', statuses: mock.statuses },
    runtimes: mock.statuses.map((s) => s.runtime),
    unavailable: mock.unavailable,
    disconnected: [],
    refresh() {},
    reload: async () => {},
  }),
}));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: (...args: unknown[]) => mock.run(...args),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => landed(null),
}));
vi.mock('@/screens/repo/route', async (actual) => ({
  ...(await actual<object>()),
  openRepoView: (...args: unknown[]) => mock.open(...args),
}));
import { runtimeName } from '@/components/RuntimeGlyph';
import { SessionPassage } from '@/screens/repo/passage/SessionPassage';

const SESSION = 'session-list';
const START = Date.now() - 60 * 60_000;

const LISTED: WorkbenchSession = {
  id: SESSION,
  created_at: new Date(START).toISOString(),
  title: 'Refund list',
  runtime: 'claude',
  branch: 'pt/refund-list',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-list',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: new Date(START).toISOString(),
  changes: null,
  merge: null,
};

const DIFF: SessionDiff = {
  session_id: SESSION,
  base_sha: 'base',
  head_sha: 'a41c9e2000000000',
  files: [{ path: 'web/refunds/filters.ts', additions: 14, deletions: 18, untracked: false }],
  patch: null,
  truncated: false,
};

const TIMELINE: RepoTimeline = {
  from: START,
  to: Date.now(),
  bin_ms: 3_600_000,
  lanes: [
    {
      key: SESSION,
      label: 'pt/refund-list',
      kind: 'branch',
      spans: [],
      points: [{ sha: 'a41c9e2000000000', at: START + 30 * 60_000, kind: 'commit' }],
      gates: [{ at: START + 31 * 60_000, session_id: SESSION, passed: true }],
      turns: [{ at: START + 60_000, session_id: SESSION, turn_id: 'turn-1' }],
    },
  ],
  releases: [],
  totals: { commits: 1, merges: 0, gate_runs: 1, gate_first_pass: 1 },
  overview: [],
  extent: null,
};

const HISTORY: SessionGatesHistory = {
  runs: [
    {
      run_id: 'run-2',
      commit: 'a41c9e2000000000',
      started_at: new Date(START + 31 * 60_000).toISOString(),
      finished_at: new Date(START + 32 * 60_000).toISOString(),
      results: [
        { name: 'typecheck', command: ['tsc'], state: 'passed', exit_code: 0 },
        { name: 'format', command: ['prettier'], state: 'skipped', skipped: true, exit_code: 1 },
      ],
    },
    {
      run_id: 'run-1',
      commit: '7d02b51000000000',
      started_at: new Date(START + 20 * 60_000).toISOString(),
      finished_at: new Date(START + 21 * 60_000).toISOString(),
      results: [{ name: 'typecheck', command: ['tsc'], state: 'failed', exit_code: 2 }],
    },
  ],
};

const installed = (runtime: string) => ({
  runtime,
  enabled: true,
  installed: true,
  auth: { state: 'logged_in' },
});

beforeEach(() => {
  mock.board = {
    board: {
      cursor: 1,
      projects: [],
      sessions: [{ id: SESSION, project_id: 'payments', revision: 1 }],
      session_turns: [{ id: 'turn-1', session_id: SESSION, input: 'Build the list' }],
      workspaces: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
  mock.sessions = [LISTED];
  mock.diff = DIFF;
  mock.timeline = TIMELINE;
  mock.pulls = { repo: 'acme/payments', items: [] } satisfies GithubItems;
  mock.history = HISTORY;
  mock.stories = [];
  mock.storyDiff = null;
  mock.comments = [];
  mock.statuses = [installed('claude'), installed('codex')];
  mock.unavailable = {};
  mock.run = vi.fn(async () => ({ ok: true, value: { review_id: 'review-1' } }));
  mock.open = vi.fn();
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const passage = () =>
  mount(() =>
    SessionPassage({ projectId: 'payments', sessionId: SESSION, onOpenSession: () => {} }),
  ).value;
/** The section headed by the heading with this text. */
const section = (tree: unknown, heading: string) =>
  find(
    tree as never,
    (n) =>
      n.type === 'section' &&
      nodes(n.props.children).some((h) => h.type === 'h3' && text(h.props.children) === heading),
  );
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const expand = (node: ReactElement<any>) =>
  mount(() => (node.type as (props: object) => any)(node.props));

describe('session branch passage', () => {
  it('draws the turn, commit, gate, review and pull request lanes, and says no pull request is open', () => {
    const lanes = section(passage(), zh('repo.passage.passage'));
    const images = nodes(lanes).filter((n) => n.props.role === 'img');
    expect(images).toHaveLength(5);
    const shown = text(lanes);
    for (const id of [
      'repo.passage.lane.turns',
      'repo.passage.lane.commits',
      'repo.passage.lane.gates',
      'repo.passage.lane.reviews',
      'repo.passage.lane.pull',
    ])
      expect(shown).toContain(zh(id));
    const pull = labelled(lanes, zh('repo.passage.lane.noPull'));
    expect(pull.props.role).toBe('img');
    expect(text(pull)).toBe(zh('repo.passage.lane.noPull'));
  });

  it('reads the session’s turns, commits and gates from the lane it was folded into', () => {
    const other = 'session-other';
    mock.timeline = {
      ...TIMELINE,
      lanes: [
        {
          key: 'main',
          label: 'main',
          kind: 'main',
          spans: [],
          points: [
            {
              sha: 'a41c9e2000000000',
              at: START + 30 * 60_000,
              kind: 'commit',
              session_id: SESSION,
            },
          ],
          gates: [],
          turns: [],
        },
        {
          key: 'other',
          label: 'other',
          kind: 'other',
          merged_lanes: 2,
          spans: [],
          points: [
            {
              sha: 'a41c9e2000000000',
              at: START + 30 * 60_000,
              kind: 'commit',
              session_id: SESSION,
            },
            { sha: 'f00d5e1000000000', at: START + 40 * 60_000, kind: 'commit', session_id: other },
          ],
          gates: [
            { at: START + 31 * 60_000, session_id: SESSION, passed: false },
            { at: START + 41 * 60_000, session_id: other, passed: true },
          ],
          turns: [
            { at: START + 60_000, session_id: SESSION, turn_id: 'turn-1' },
            { at: START + 2 * 60_000, session_id: other, turn_id: 'turn-other' },
          ],
        },
      ],
    } satisfies RepoTimeline;
    const lanes = section(passage(), zh('repo.passage.passage'));
    const labels = nodes(lanes)
      .filter((n) => n.props.role === 'img')
      .map((n) => n.props['aria-label']);
    expect(labels.slice(0, 3)).toEqual([
      zhf('repo.passage.lane.turnsLabel', { count: 1 }),
      zhf('repo.passage.lane.commitsLabel', { count: 1 }),
      zhf('repo.passage.lane.gatesLabel', { count: 1, failed: 1 }),
    ]);
  });

  it('counts and draws a binned commit lane by its bins', () => {
    mock.timeline = {
      ...TIMELINE,
      lanes: [
        {
          key: SESSION,
          label: 'pt/refund-list',
          kind: 'branch',
          spans: [],
          gates: [],
          turns: [],
          bins: [
            { start: START, commits: 150, merges: 0 },
            { start: START + 20 * 60_000, commits: 0, merges: 0 },
            { start: START + 40 * 60_000, commits: 90, merges: 2 },
          ],
        },
      ],
      bin_ms: 20 * 60_000,
    } satisfies RepoTimeline;
    const lanes = section(passage(), zh('repo.passage.passage'));
    const commits = labelled(lanes, zhf('repo.passage.lane.commitsLabel', { count: 240 }));
    expect(commits.props.role).toBe('img');
    expect(nodes(commits.props.children)).toHaveLength(2);
  });

  it('marks a skipped gate step apart from a passed one and from one the run never reached', () => {
    const gates = section(passage(), zh('repo.passage.gates'));
    const table = labelled(gates, zh('repo.passage.gatesTable'));
    expect(table.type).toBe('table');
    const headers = nodes(table)
      .filter((n) => n.type === 'th' && n.props.scope === 'col')
      .map((n) => text(n.props.children));
    expect(headers).toEqual([zh('repo.passage.commit'), 'typecheck', 'format']);
    const cells = nodes(table)
      .filter((n) => n.type === 'td')
      .map((n) => nodes(n).find((c) => c.props.role === 'img')?.props['aria-label'] ?? text(n));
    expect(cells).toEqual([
      zh('repo.passage.step.passed'),
      zh('repo.passage.step.skipped'),
      zh('repo.passage.step.failed'),
      zh('repo.passage.step.notRun'),
    ]);
  });

  it('names a step recorded only as skipped “skipped”, not “not run”', () => {
    mock.history = {
      runs: [
        {
          ...HISTORY.runs[1]!,
          results: [
            { name: 'typecheck', command: ['tsc'], skipped: true },
            { name: 'format', command: ['prettier'], state: 'passed', exit_code: 0 },
          ],
        },
      ],
    };
    const table = labelled(
      section(passage(), zh('repo.passage.gates')),
      zh('repo.passage.gatesTable'),
    );
    const skipped = nodes(table)
      .filter((n) => n.type === 'td')
      .map((n) => nodes(n).find((c) => c.props.role === 'img')?.props['aria-label'] ?? text(n));
    expect(skipped).toEqual([zh('repo.passage.step.skipped'), zh('repo.passage.step.passed')]);
  });

  it('opens a changed file’s history from its name in the file table', () => {
    const files = section(passage(), zh('repo.passage.files'));
    const table = labelled(files, zh('repo.passage.filesTable'));
    find(
      table,
      (n) => n.type === 'button' && text(n.props.children) === 'web/refunds/filters.ts',
    ).props.onClick();
    expect(mock.open).toHaveBeenCalledWith('payments', {
      kind: 'file',
      path: 'web/refunds/filters.ts',
    });
  });

  it('picks the other runtime for the cross review and asks it to review', async () => {
    const review = expand(
      find(passage(), (n) => typeof n.type === 'function' && n.type.name === 'CrossReview'),
    );
    const toggles = () =>
      nodes(labelled(review.value, zh('repo.passage.reviewers'))).filter(
        (n) => n.type === 'button',
      );
    expect(toggles().map((b) => [text(b.props.children), b.props['aria-pressed']])).toEqual([
      [runtimeName('claude'), false],
      [runtimeName('codex'), true],
    ]);
    const start = () =>
      find(
        review.value,
        (n) => n.type === 'button' && text(n.props.children) === zh('repo.passage.requestReview'),
      );
    expect(start().props.disabled).toBe(false);
    await start().props.onClick();
    expect(mock.run).toHaveBeenCalledWith(
      'review.request',
      { session_id: SESSION, runtimes: ['codex'] },
      null,
    );
  });

  it('offers only the runtimes installed on this machine for the cross review', () => {
    mock.statuses = [
      installed('claude'),
      installed('codex'),
      { ...installed('opencode'), installed: false },
    ];
    mock.unavailable = { opencode: 'Not installed' };
    const review = expand(
      find(passage(), (n) => typeof n.type === 'function' && n.type.name === 'CrossReview'),
    );
    const toggles = nodes(labelled(review.value, zh('repo.passage.reviewers')))
      .filter((n) => n.type === 'button')
      .map((b) => text(b.props.children));
    expect(toggles).toEqual([runtimeName('claude'), runtimeName('codex')]);
  });

  it('turns the review request off once no runtime is picked', () => {
    const review = expand(
      find(passage(), (n) => typeof n.type === 'function' && n.type.name === 'CrossReview'),
    );
    const codex = find(
      labelled(review.value, zh('repo.passage.reviewers')),
      (n) => n.type === 'button' && n.props['aria-pressed'] === true,
    );
    codex.props.onClick();
    review.render();
    const start = find(
      review.value,
      (n) => n.type === 'button' && text(n.props.children) === zh('repo.passage.requestReview'),
    );
    expect(start.props.disabled).toBe(true);
  });
});
