import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { GithubItems, GithubPullDetail, WorkbenchSession } from '@pantheon/protocol';
import { Tabs } from '../../apps/web/node_modules/@base-ui/react/tabs';
import { deferred, find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any, github: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'pulls-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
  resolveTheme: () => 'light',
}));
// The panel's reads, each landed; the detail read by the pull request it asks for.
const reads = vi.hoisted(() => {
  const landed = <T>(data: T) => ({
    read: data,
    loading: false,
    stale: false,
    unavailable: false,
    error: null,
    reload() {},
  });
  return {
    landed,
    pulls: landed(null) as unknown,
    details: new Map<number, unknown>(),
    useGithubPulls: vi.fn((_projectId: string | null) => reads.pulls),
    useGithubPullDetail: vi.fn((_projectId: string | null, _number: number) => landed(null)),
    runCommand: vi.fn(),
    toast: vi.fn(),
  };
});
vi.mock('@/data/github-pulls', async (actual) => ({
  ...(await actual<object>()),
  useGithubPulls: reads.useGithubPulls,
  useGithubPullDetail: reads.useGithubPullDetail,
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useConnectionsStatus: () => ({ read: mock.github, checking: false, refresh() {} }),
}));
vi.mock('@/data/commands', () => ({ runCommand: reads.runCommand }));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: reads.toast,
}));
import { EmptyState } from '@/components/EmptyState';
import { ChangesScreen } from '@/screens/changes/ChangesScreen';
import { PullRequestDetail } from '@/screens/changes/PullRequestDetail';
import { PullRequestList } from '@/screens/changes/PullRequestList';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const pulls: GithubItems = {
  repo: 'acme/payments',
  items: [
    {
      number: 418,
      title: 'Refund list page',
      url: 'https://github.com/acme/payments/pull/418',
      state: 'open',
      updated_at: new Date(NOW - 4 * 60_000).toISOString(),
      checks: 'pending',
      checks_passed: 3,
      checks_total: 4,
      review_decision: 'review_required',
      head: 'pt/refund-list',
      session_id: 'refund-list',
    },
    {
      number: 409,
      title: 'Hotfix 1.8.2',
      url: 'https://github.com/acme/payments/pull/409',
      state: 'open',
      updated_at: new Date(NOW - 2 * 3_600_000).toISOString(),
      head: 'hotfix/1.8.2',
    },
  ],
};
const detail = (patch: Partial<GithubPullDetail> = {}): GithubPullDetail => ({
  number: 418,
  title: 'Refund list page',
  url: 'https://github.com/acme/payments/pull/418',
  state: 'open',
  review_decision: 'changes_requested',
  head: 'pt/refund-list',
  base: 'main',
  additions: 96,
  deletions: 8,
  session_id: 'refund-list',
  checks: [
    { name: 'build', state: 'passed', duration_ms: 72_000, url: null },
    { name: 'e2e', state: 'running', duration_ms: null, url: null },
    { name: 'unit-tests', state: 'failed', duration_ms: 160_000, url: 'https://ci/run/1' },
    { name: 'lint', state: 'skipped', duration_ms: 18_000, url: null },
  ],
  threads: [
    { path: 'src/old.ts', line: 2, author: 'lee', body: 'Rename this.', resolved: true },
    {
      path: 'src/signature.ts',
      line: 18,
      author: 'mei',
      body: 'Make the clock skew configurable.',
      resolved: false,
    },
    {
      path: 'fixtures/webhook.ts',
      line: 4,
      author: 'kai',
      body: 'Use a placeholder secret.',
      resolved: false,
    },
  ],
  ...patch,
});

const sessions = [
  { id: 'refund-list', title: 'Refund front-end list', state: 'idle', waiting: 0 },
] as unknown as WorkbenchSession[];

/** The board's record of the pull request's session, in the given state. */
const boardSession = (state: string) => ({
  id: 'refund-list',
  revision: 7,
  project_id: 'pulls',
  runtime: 'fixture',
  state,
  turn_count: 1,
});

beforeEach(() => {
  reads.pulls = reads.landed(pulls);
  reads.details.clear();
  reads.details.set(418, reads.landed(detail()));
  reads.useGithubPulls.mockClear();
  reads.useGithubPullDetail.mockReset();
  reads.useGithubPullDetail.mockImplementation(
    (_projectId, number) => (reads.details.get(number) ?? reads.landed(null)) as never,
  );
  reads.runCommand.mockReset();
  reads.toast.mockReset();
  mock.board = {
    board: {
      cursor: 1,
      projects: [],
      sessions: [boardSession('open')],
      workspaces: [],
      session_turns: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
  mock.github = { state: 'ready', github: { state: 'signed_in', installed: true } };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const list = () => mount(() => PullRequestList({ projectId: 'pulls', sessions }));
const listOf = (tree: unknown) =>
  nodes(tree as never).find(
    (n) => n.type === 'ul' && n.props['aria-label'] === zh('changes.pulls.list'),
  );
const rows = (tree: unknown) =>
  nodes(listOf(tree) as never).filter(
    (n) => n.type === 'button' && n.props['aria-pressed'] !== undefined,
  );
const shown = (tree: unknown) =>
  nodes(tree as never).find((n) => n.type === PullRequestDetail) as ReactElement<any> | undefined;
/** Opens the first pull request and renders the detail the panel shows, one level down. */
const openedDetail = () => {
  const host = list();
  rows(host.value)[0]!.props.onClick();
  host.render();
  return mount(() => PullRequestDetail(shown(host.value)!.props));
};
const handOff = (tree: unknown) =>
  nodes(tree as never).find(
    (n) =>
      n.type === 'button' &&
      text(n.props.children) ===
        zhf('changes.pulls.handOff', { session: 'Refund front-end list', count: 2 }),
  );

describe('pull requests in the changes screen', () => {
  it('shows a Pull requests tab after the filters, whose panel lists the pull requests', async () => {
    const host = mount(() => ChangesScreen({ projectId: 'pulls', sessions }));
    await host.flush();
    const tabs = nodes(host.value).filter((n) => n.type === Tabs.Tab);
    expect(tabs.at(-1)!.props.value).toBe('pulls');
    expect(text(tabs.at(-1)!)).toBe(zh('changes.pulls.tab'));
    expect(nodes(host.value).some((n) => n.type === PullRequestList)).toBe(false);
    find(host.value, (n) => n.type === Tabs.Root).props.onValueChange('pulls');
    host.render();
    expect(find(host.value, (n) => n.type === Tabs.Root).props.value).toBe('pulls');
    const panel = find(host.value, (n) => n.type === PullRequestList);
    expect(panel.props).toMatchObject({ projectId: 'pulls', sessions });
  });

  it('lists each open pull request with its number, title, check count and session, none opened', () => {
    const tree = list().value;
    const [first, second] = rows(tree);
    expect(first!.props['aria-pressed']).toBe(false);
    expect(second!.props['aria-pressed']).toBe(false);
    const line = text(first!.props.children);
    for (const part of ['#418', 'Refund list page', '3 / 4', 'Refund front-end list'])
      expect(line).toContain(part);
    expect(
      nodes(first!.props.children).some(
        (n) =>
          n.props.role === 'img' &&
          n.props['aria-label'] === zhf('changes.pulls.checksLabel', { total: 4, passed: 3 }),
      ),
    ).toBe(true);
    expect(text(second!.props.children)).toContain('#409');
    expect(nodes(second!.props.children).some((n) => n.props.role === 'img')).toBe(false);
    expect(shown(tree)).toBeUndefined();
  });

  it('opens the pressed pull request beside the list and closes it again', () => {
    const host = list();
    rows(host.value)[1]!.props.onClick();
    host.render();
    expect(rows(host.value).map((r) => r.props['aria-pressed'])).toEqual([false, true]);
    expect(shown(host.value)!.props.number).toBe(409);
    shown(host.value)!.props.onClose();
    host.render();
    expect(shown(host.value)).toBeUndefined();
    expect(rows(host.value).map((r) => r.props['aria-pressed'])).toEqual([false, false]);
  });

  it('names the opened pull request and its close button', () => {
    const tree = openedDetail().value;
    const aside = find(tree, (n) => n.type === 'aside');
    expect(aside.props['aria-label']).toBe(zhf('changes.pulls.detail', { number: 418 }));
    expect(
      nodes(tree).some(
        (n) => n.type === 'button' && n.props['aria-label'] === zh('changes.inspector.close'),
      ),
    ).toBe(true);
  });

  it('lists the failed checks first, each with its state named', () => {
    const tree = openedDetail().value;
    const checks = nodes(tree).filter(
      (n) =>
        n.type === 'li' &&
        nodes(n.props.children).some((c) => c.props.role === 'img' && c.props['data-state']),
    );
    expect(checks.map((c) => text(c.props.children))[0]).toContain('unit-tests');
    const states = checks.map(
      (c) => find(c.props.children, (n) => n.props.role === 'img').props['aria-label'],
    );
    expect(states).toEqual(
      ['failed', 'running', 'passed', 'skipped'].map((s) => zh(`changes.pulls.check.${s}`)),
    );
    expect(
      nodes(checks[0]!.props.children).some(
        (n) =>
          n.type === 'button' &&
          n.props['aria-label'] === zhf('changes.pulls.checkLogLabel', { name: 'unit-tests' }),
      ),
    ).toBe(true);
  });

  it('puts the unresolved review comments first and folds the resolved ones', () => {
    const tree = openedDetail().value;
    const cards = nodes(tree).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'ThreadCard',
    );
    expect(cards.map((c) => c.props.thread.author)).toEqual(['mei', 'kai', 'lee']);
    const folded = find(tree, (n) => n.type === 'details');
    expect(
      nodes(folded.props.children)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'ThreadCard')
        .map((c) => c.props.thread.author),
    ).toEqual(['lee']);
  });

  it('sends the unresolved comments to the open session of the pull request in one message', async () => {
    const sent = deferred<{ ok: true; value: unknown }>();
    reads.runCommand.mockReturnValue(sent.promise);
    const host = openedDetail();
    handOff(host.value)!.props.onClick();
    host.render();
    expect(handOff(host.value)!.props.disabled).toBe(true);
    expect(reads.runCommand).toHaveBeenCalledTimes(1);
    const [type, input, revision] = reads.runCommand.mock.calls[0]!;
    expect(type).toBe('session.send');
    expect(input.session_id).toBe('refund-list');
    expect(input.input).toContain('src/signature.ts:18');
    expect(input.input).toContain('fixtures/webhook.ts:4');
    expect(input.input).not.toContain('src/old.ts');
    expect(revision).toBe(7);
    sent.resolve({ ok: true, value: {} });
    await host.flush();
    expect(handOff(host.value)!.props.disabled).toBe(false);
    expect(reads.toast).toHaveBeenCalledWith({
      title: zhf('changes.pulls.handedOff', { count: 2, session: 'Refund front-end list' }),
    });
  });

  it('steers the comments into a session that is running', async () => {
    mock.board.board.sessions = [boardSession('running')];
    reads.runCommand.mockResolvedValue({ ok: true, value: {} });
    const host = openedDetail();
    handOff(host.value)!.props.onClick();
    await host.flush();
    expect(reads.runCommand.mock.calls[0]![0]).toBe('session.steer');
  });

  it('keeps the hand-off off while the session cannot take a message', async () => {
    mock.board.board.sessions = [boardSession('closed')];
    const host = openedDetail();
    expect(handOff(host.value)!.props['aria-disabled']).toBe(true);
    handOff(host.value)!.props.onClick();
    await host.flush();
    expect(reads.runCommand).not.toHaveBeenCalled();
  });

  it('opens the session of the pull request', () => {
    const tree = openedDetail().value;
    nodes(tree)
      .find((n) => n.type === 'button' && text(n.props.children).includes('Refund front-end list'))!
      .props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list');
  });

  it('offers no hand-off when the pull request has no session', () => {
    const { session_id: _, ...unowned } = detail();
    reads.details.set(418, reads.landed(unowned));
    const tree = openedDetail().value;
    expect(
      nodes(tree).some(
        (n) => n.type === 'button' && text(n.props.children).includes('Refund front-end list'),
      ),
    ).toBe(false);
    expect(handOff(tree)).toBeUndefined();
  });

  it('says only that the project has no GitHub repository when it has none', () => {
    reads.pulls = reads.landed<GithubItems>({ repo: null, items: [] });
    const tree = list().value;
    expect(find(tree, (n) => n.type === EmptyState).props.title).toBe(zh('changes.pulls.noRepo'));
    expect(listOf(tree)).toBeUndefined();
  });

  it('says only that GitHub is not connected when it is not', () => {
    mock.github = { state: 'ready', github: { state: 'signed_out', installed: true } };
    const tree = list().value;
    expect(find(tree, (n) => n.type === EmptyState).props.title).toBe(
      zh('changes.pulls.notConnected'),
    );
    expect(listOf(tree)).toBeUndefined();
  });
});
