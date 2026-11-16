import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
import { ProgressTable } from '@/screens/board/ProgressTable';
import { MergeTrack } from '@/screens/board/QualityCharts';

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 3, 12).getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // A shown tooltip listens for Escape.
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const focusAt = { currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20 }) } };

const segment = (id: string, started_at: number) => ({
  id,
  session_id: id,
  title: id,
  runtime: 'claude',
  model: 'opus',
  status: 'running',
  started_at,
  ended_at: null,
  tokens: 0,
});

const tableModel = (segments: ReturnType<typeof segment>[]) =>
  ({
    since: NOW - 6 * HOUR,
    now: NOW,
    counts: { median_ms: null },
    lanes: [],
    tasks: [
      {
        id: 'parallel-task',
        title: 'parallel task',
        goal: '',
        scope: [],
        lane_id: null,
        milestone_id: null,
        status: 'running',
        blockers: [],
        segments,
        additions: null,
        deletions: null,
        checks: 'none',
        started_at: NOW - 5 * HOUR,
        ended_at: null,
      },
    ],
  }) as unknown as BoardModel;

describe('progress table timeline', () => {
  it('describes a focused segment by the tooltip it opens', () => {
    const model = tableModel([segment('seg-a', NOW - 2 * HOUR), segment('seg-b', NOW - HOUR)]);
    const table = mount(() => ProgressTable({ model, onOpenTask() {} }));
    const segs = () => nodes(table.value).filter((n) => n.props.role === 'img');
    expect(segs().map((s) => s.props['aria-describedby'])).toEqual([undefined, undefined]);
    segs()[1]!.props.onFocus(focusAt);
    table.render();
    const id = named(table.value, 'FloatTip').props.id;
    expect(id).toBeTruthy();
    expect(segs().map((s) => s.props['aria-describedby'])).toEqual([undefined, id]);
  });

  it('draws any number of parallel segments on at most three tracks', () => {
    const model = tableModel(
      Array.from({ length: 6 }, (_, i) => segment(`seg-${i}`, NOW - (5 - i * 0.5) * HOUR)),
    );
    const table = mount(() => ProgressTable({ model, onOpenTask() {} }));
    const bars = nodes(table.value).filter((n) => String(n.props.className).startsWith('bp-gb'));
    expect(bars).toHaveLength(6);
    expect(new Set(bars.map((b) => b.props.style.top)).size).toBe(3);
  });
});

describe('merge track tips', () => {
  const merge = (session_id: string, title: string): BoardModel['merges'][number] => ({
    session_id,
    title,
    merged_at: NOW - HOUR,
    from_sha: null,
    sha: `${session_id}abcdef0123456789`,
    additions: 4,
    deletions: 1,
    story_id: null,
  });

  it('opens the tooltip of a merge mark on keyboard focus and describes the mark by it', () => {
    const track = mount(() =>
      MergeTrack({
        merges: [merge('kept-session', 'kept session')],
        since: NOW - 2 * HOUR,
        now: NOW,
        onOpenSession() {},
      }),
    );
    const mark = () =>
      find(track.value, (n) => n.type === 'button' && /^kept session /.test(n.props['aria-label']));
    mark().props.onFocus(focusAt);
    track.render();
    const tip = named(track.value, 'FloatTip');
    expect(tip.props.content.rows[0].value).toBe('kept session');
    expect(mark().props['aria-describedby']).toBe(tip.props.id);
    mark().props.onBlur();
    track.render();
    expect(() => named(track.value, 'FloatTip')).toThrow();
    expect(mark().props['aria-describedby']).toBeUndefined();
  });
});
