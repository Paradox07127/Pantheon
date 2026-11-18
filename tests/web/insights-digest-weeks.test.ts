import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  reads: [] as { method: string; params: Record<string, string> }[],
  model: null as unknown,
  read: {
    error: null as string | null,
    stale: false,
    readAt: null as number | null,
  } as { error: string | null; stale: boolean; readAt: number | null; refreshing?: boolean },
  reload() {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = () => ({ events: [], resync: 0, status: { state: 'live' }, board: null });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSession() {}, openTaskSession() {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (
    method: string,
    key: string | null,
    params: (key: string) => Record<string, string>,
  ) => {
    if (key) mock.reads.push({ method, params: params(key) });
    const data = method === 'board.view' && key ? mock.model : null;
    const { error, stale, readAt, refreshing } = mock.read;
    return {
      data,
      loading: data === null && !error,
      refreshing,
      error,
      stale,
      readAt,
      reload: mock.reload,
    };
  },
}));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useImprovementSignals: () => ({
    read: [],
    loading: false,
    error: null,
    stale: false,
    reload() {},
  }),
}));
import { ReadStatus } from '@/components/ReadStatus';
import { Failure, RANGES } from '@/screens/board/BoardScreen';
import { CollabTab } from '@/screens/insights/CollabTab';
import { DigestPanel } from '@/screens/insights/DigestPanel';
import { InsightsScreen, InsightsView } from '@/screens/insights/InsightsScreen';

const dg = (key: string) => zh(`insights.digest.${key}`);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 15));
  mock.reads = [];
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const boardReads = () => mock.reads.filter((r) => r.method === 'board.view').map((r) => r.params);

const MODEL = {
  since: new Date(2026, 10, 5).getTime(),
  now: new Date(2026, 10, 11, 15).getTime(),
  headline: null,
  counts: { running: 0, waiting: 0, ready: 0, failed: 0, merged: 0, median_ms: null },
  lanes: [],
  tasks: [],
  edges: [],
  milestones: [],
  burnup: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  usage: [],
  models: [],
  merges: [],
  findings: [],
  risks: [],
} as unknown as BoardModel;

describe('engineering board range', () => {
  it('offers today, 7 days, 30 days and all, and reads the board of the picked one', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    expect(RANGES.map((r) => [r.days, r.label])).toEqual([
      [1, zh('board.ranges.today')],
      [7, '7 天'],
      [30, '30 天'],
      ['all', zh('board.ranges.all')],
    ]);
    const h = mount(() => InsightsScreen({ projectId: 'range-project', onOpenSession() {} }));
    expect(boardReads().at(-1)).toEqual({ project_id: 'range-project', days: '7' });
    h.value.props.onDays('all');
    h.render();
    expect(boardReads().at(-1)).toEqual({ project_id: 'range-project', days: 'all' });
    h.value.props.onDays(30);
    h.render();
    expect(boardReads().at(-1)).toEqual({ project_id: 'range-project', days: '30' });
  });
});

describe('weekly digest weeks', () => {
  const bar = { nodeType: 1 } as unknown as HTMLElement;
  let projectId = 'digest-project';
  let section: 'digest' | 'quality' = 'digest';
  const view = () =>
    mount(() =>
      InsightsView({
        model: MODEL,
        loading: false,
        error: null,
        onRetry() {},
        days: 30,
        onDays() {},
        section,
        onSection() {},
        projectId,
        onOpenSession() {},
        onOpenStory() {},
      }),
    );
  // Draws the digest the board shows and returns its top bar buttons.
  const digest = (tree: unknown) => {
    const node: any = named(tree as never, 'WeeklyDigest');
    const panel: any = find(
      mount(() => node.type(node.props)).value,
      (n) => n.type === DigestPanel,
    );
    const section = panel.type({ ...panel.props, bar });
    const portal = [section.props.children].flat().find((c: any) => c?.containerInfo === bar);
    return { week: node.props.week as number, buttons: [portal.children.props.children].flat() };
  };
  const button = (buttons: any[], label: string) =>
    buttons.find((b) => b?.props['aria-label'] === label);

  beforeEach(() => {
    mock.model = MODEL;
    mock.read = { error: null, stale: false, readAt: null };
    projectId = 'digest-project';
    section = 'digest';
  });

  it('reads the 7 days through today, whatever the range, and a week earlier after the previous week button', () => {
    const h = view();
    const first = digest(h.value);
    expect(boardReads().at(-1)).toEqual({ project_id: 'digest-project', days: '7' });
    expect(button(first.buttons, dg('nextWeek')).props.disabled).toBe(true);
    button(first.buttons, dg('previousWeek')).props.onClick();
    h.render();
    const back = digest(h.value);
    expect(back.week).toBe(1);
    expect(boardReads().at(-1)).toEqual({
      project_id: 'digest-project',
      days: '7',
      until: '2026-11-04',
    });
    button(back.buttons, dg('previousWeek')).props.onClick();
    h.render();
    digest(h.value);
    expect(boardReads().at(-1)!.until).toBe('2026-10-28');
  });

  it('keeps the week shown until the read of the picked week lands', () => {
    const h = view();
    const shown = mount(() => {
      const node: any = named(h.value as never, 'WeeklyDigest');
      return node.type(node.props);
    });
    const panel = (): any => find(shown.value, (n) => n.type === DigestPanel);
    const controls = () => {
      const section = panel().type({ ...panel().props, bar });
      const portal = [section.props.children].flat().find((c: any) => c?.containerInfo === bar);
      return [portal.children.props.children].flat();
    };
    button(controls(), dg('previousWeek')).props.onClick();
    mock.model = null;
    h.render();
    shown.render();
    expect(panel().props).toMatchObject({ model: MODEL, week: 0 });
    const earlier = { ...MODEL, since: new Date(2026, 9, 29).getTime() };
    mock.model = earlier;
    shown.render();
    expect(panel().props).toMatchObject({ model: earlier, week: 1 });
  });

  it('never asks for a week after this one while an earlier week still shows', () => {
    mock.model = { ...MODEL, since: new Date(2026, 9, 22).getTime() };
    const h = view();
    const shown = digest(h.value);
    expect(shown.week).toBe(0);
    button(shown.buttons, dg('nextWeek')).props.onClick();
    h.render();
    expect(digest(h.value).week).toBe(0);
    expect(boardReads().at(-1)).toEqual({ project_id: 'digest-project', days: '7' });
  });

  it("shows the digest read's failure with its own retry when no week has landed", () => {
    mock.model = null;
    mock.read = { error: 'daemon gone', stale: false, readAt: null };
    const node: any = named(view().value as never, 'WeeklyDigest');
    const failure = find(mount(() => node.type(node.props)).value, (n) => n.type === Failure);
    expect(failure.props).toMatchObject({ error: 'daemon gone', onRetry: mock.reload });
  });

  it('keeps the week buttons beside the failure of the week read', () => {
    mock.model = null;
    mock.read = { error: 'daemon gone', stale: false, readAt: null };
    const weeks: number[] = [];
    const node: any = named(view().value as never, 'WeeklyDigest');
    const tree = mount(() =>
      node.type({ ...node.props, bar, week: 2, onWeek: (w: number) => weeks.push(w) }),
    ).value;
    expect(find(tree, (n) => n.type === Failure).props.error).toBe('daemon gone');
    const portal: any = [tree.props.children].flat().find((c: any) => c?.containerInfo === bar);
    const controls = [portal.children.props.children].flat();
    expect(text(controls.find((c: any) => c?.type === 'span'))).toBe('10月22日 – 28日');
    button(controls, dg('previousWeek')).props.onClick();
    button(controls, dg('nextWeek')).props.onClick();
    expect(weeks).toEqual([3, 1]);
  });

  it("says when the digest shown is a retained read the last refresh failed, with the digest's own reload", () => {
    mock.read = { error: 'daemon gone', stale: true, readAt: 5 };
    const node: any = named(view().value as never, 'WeeklyDigest');
    const status = find(mount(() => node.type(node.props)).value, (n) => n.type === ReadStatus);
    expect(status.props).toMatchObject({
      label: dg('label'),
      stale: true,
      error: 'daemon gone',
      readAt: 5,
      reload: mock.reload,
    });
  });

  it('draws no status bar over a digest shown from the cache until its read runs long', async () => {
    mock.read = { error: null, stale: true, readAt: 5, refreshing: true };
    const node: any = named(view().value as never, 'WeeklyDigest');
    const shown = mount(() => node.type(node.props));
    const status = () => nodes(shown.value).filter((n) => n.type === ReadStatus);
    expect(status()).toHaveLength(0);
    vi.advanceTimersByTime(300);
    await shown.flush();
    expect(status()).toHaveLength(1);
  });

  it('leaves the range switch off the digest tab', () => {
    const range = (tree: unknown) =>
      find(tree as never, (n) => n.props['aria-label'] === zh('board.headline.range'));
    expect(() => range(view().value)).toThrow('Expected element missing');
    section = 'quality';
    expect(range(view().value)).toBeDefined();
  });

  it('keeps the week across tabs and starts again from this week in another project', () => {
    const h = view();
    button(digest(h.value).buttons, dg('previousWeek')).props.onClick();
    h.render();
    section = 'quality';
    h.render();
    section = 'digest';
    h.render();
    expect(digest(h.value).week).toBe(1);
    projectId = 'other-project';
    h.render();
    expect(digest(h.value).week).toBe(0);
    expect(find(h.value, (n) => n.props.projectId === 'other-project')).toBeDefined();
  });
});

describe('collaboration on a retained board', () => {
  it('offers no session action while the board shown is stale', () => {
    const h = mount(() =>
      InsightsView({
        model: MODEL,
        loading: false,
        error: 'daemon gone',
        stale: true,
        onRetry() {},
        days: 7,
        onDays() {},
        section: 'collab',
        onSection() {},
        projectId: 'collab-project',
        onOpenSession() {},
        onOpenStory() {},
      }),
    );
    expect(find(h.value, (n) => n.type === CollabTab).props.readOnly).toBe(true);
  });
});
