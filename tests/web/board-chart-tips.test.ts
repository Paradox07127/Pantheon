import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
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
