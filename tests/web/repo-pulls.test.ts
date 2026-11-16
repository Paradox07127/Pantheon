import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { GithubItems, GithubPullDetail } from '@pantheon/protocol';
import { deferred, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'pulls-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
// The tab's reads, each landed; the detail read by the pull request it asks for.
const reads = vi.hoisted(() => {
  const landed = <T>(data: T) => ({
    data,
    read: data,
    loading: false,
    refreshing: false,
    stale: false,
    unavailable: false,
    error: null,
    reload() {},
  });
  return {
    landed,
    pulls: landed(null) as unknown,
    details: new Map<number, unknown>(),
    sessions: landed([] as unknown[]),
    useGithubPullDetail: vi.fn((_projectId: string | null, _number: number) => landed(null)),
    runCommand: vi.fn(),
    toast: vi.fn(),
  };
});
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useGithubPulls: () => reads.pulls,
  useGithubPullDetail: reads.useGithubPullDetail,
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => reads.sessions,
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useConnectionsStatus: () => ({
    read: { state: 'ready', github: { state: 'signed_in', installed: true, signed_in: true } },
    checking: false,
    refresh() {},
  }),
}));
vi.mock('@/data/commands', () => ({ runCommand: reads.runCommand }));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: reads.toast,
}));
import { Empty } from '@/screens/board/Charts';
import { PullDetail } from '@/screens/repo/pulls/PullDetail';
import { PullRequestsTab } from '@/screens/repo/PullRequestsTab';
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

beforeEach(() => {
  reads.pulls = reads.landed(pulls);
  reads.details.clear();
  reads.details.set(418, reads.landed(detail()));
  reads.useGithubPullDetail.mockReset();
  reads.useGithubPullDetail.mockImplementation(
    (_projectId, number) => (reads.details.get(number) ?? reads.landed(null)) as never,
  );
  reads.sessions = reads.landed([
    { id: 'refund-list', title: 'Refund front-end list', state: 'idle', waiting: 0 },
  ]);
  reads.runCommand.mockReset();
  reads.toast.mockReset();
  mock.board = { board: { sessions: [{ id: 'refund-list', revision: 7 }] }, status: {} };
  mock.shell = { openSession: vi.fn() };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const tab = () => mount(() => PullRequestsTab({ projectId: 'pulls', onOpenSession() {} }));
const rows = (tree: unknown) =>
  nodes(tree as never).filter((n) => n.type === 'button' && n.props['aria-pressed'] !== undefined);
/** Renders the detail the tab shows, one level down. */
const shownDetail = (tree: unknown, onOpenSession = vi.fn()) => {
  const node = find(tree as never, (n) => n.type === PullDetail) as ReactElement<any>;
  return mount(() => PullDetail({ ...node.props, onOpenSession }));
};
const handOff = (tree: unknown) =>
  nodes(tree as never).find(
    (n) =>
      n.type === 'button' &&
      text(n.props.children) ===
        zhf('repo.pulls.handOff', { session: 'Refund front-end list', count: 2 }),
  );

describe('repository pull requests', () => {
  it('lists each open pull request with its number, title, check count and session, the first picked', () => {
    const tree = tab().value;
    const [first, second] = rows(tree);
    expect(first!.props['aria-pressed']).toBe(true);
    expect(second!.props['aria-pressed']).toBe(false);
    const line = text(first!.props.children);
    for (const part of ['#418', 'Refund list page', '3 / 4', 'Refund front-end list'])
      expect(line).toContain(part);
    expect(
      nodes(first!.props.children).some(
        (n) =>
          n.props.role === 'img' &&
          n.props['aria-label'] === zhf('repo.pulls.checksLabel', { total: 4, passed: 3 }),
      ),
    ).toBe(true);
    expect(text(second!.props.children)).toContain('#409');
    expect(nodes(second!.props.children).some((n) => n.props.role === 'img')).toBe(false);
    expect(find(tree, (n) => n.type === PullDetail).props.number).toBe(418);
  });

  it('shows the picked pull request once a row is pressed', () => {
    const host = tab();
    rows(host.value)[1]!.props.onClick();
    host.render();
    expect(rows(host.value)[1]!.props['aria-pressed']).toBe(true);
    expect(find(host.value, (n) => n.type === PullDetail).props.number).toBe(409);
  });

  it('lists the failed checks first, each with its state named', () => {
    const tree = shownDetail(tab().value).value;
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
      ['failed', 'running', 'passed', 'skipped'].map((s) => zh(`repo.pulls.check.${s}`)),
    );
    expect(
      nodes(checks[0]!.props.children).some(
        (n) =>
          n.type === 'button' &&
          n.props['aria-label'] === zhf('repo.pulls.checkLogLabel', { name: 'unit-tests' }),
      ),
    ).toBe(true);
  });

  it('puts the unresolved review comments first and folds the resolved ones', () => {
    const tree = shownDetail(tab().value).value;
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

  it('sends the unresolved comments to the pull request session in one message', async () => {
    const sent = deferred<{ ok: true; value: unknown }>();
    reads.runCommand.mockReturnValue(sent.promise);
    const host = shownDetail(tab().value);
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
      title: zhf('repo.pulls.handedOff', { count: 2, session: 'Refund front-end list' }),
    });
  });

  it('offers no hand-off when the pull request has no session', () => {
    const { session_id: _, ...unowned } = detail();
    reads.details.set(418, reads.landed(unowned));
    const tree = shownDetail(tab().value).value;
    expect(
      nodes(tree).some(
        (n) => n.type === 'button' && text(n.props.children).includes('Refund front-end list'),
      ),
    ).toBe(false);
    expect(handOff(tree)).toBeUndefined();
  });

  it('says only that the project has no GitHub repository when it has none', () => {
    reads.pulls = reads.landed<GithubItems>({ repo: null, items: [] });
    const tree = tab().value;
    expect(find(tree, (n) => n.type === Empty).props.text).toBe(zh('repo.pulls.noRepo'));
    expect(rows(tree)).toEqual([]);
    expect(nodes(tree).some((n) => n.type === PullDetail)).toBe(false);
  });
});
