import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
import { ProgressTable } from '@/screens/board/ProgressTable';
import { zh, zhf } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 10, 3, 12).getTime();

const row = (id: string, status: string, started_at: number, ended_at: number | null) => ({
  id,
  title: id,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at,
  ended_at,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('sorts by duration on the local clock when the board was read earlier', () => {
  const model = {
    since: NOW - 6 * 60 * MIN,
    now: NOW,
    counts: { median_ms: null },
    lanes: [],
    tasks: [
      row('running-task', 'running', NOW - 30 * MIN, null),
      row('finished-task', 'done', NOW - 100 * MIN, NOW - 55 * MIN),
    ],
  } as unknown as BoardModel;
  vi.setSystemTime(NOW + 20 * MIN);
  const host = new HookHost(() => ProgressTable({ model, onOpenTask() {} }));
  find(
    host.render(),
    (n) =>
      n.props['aria-label'] ===
      zhf('board.progress.sortBy', { column: zh('board.progress.columns.duration') }),
  ).props.onClick();
  const order = nodes(host.render())
    .filter((n) => n.props.className === 'bp-tr bp-trw')
    .map((n) => n.key);
  expect(order).toEqual(['finished-task', 'running-task']);
});

it('leaves Enter on a link inside a row to the link and opens the task from the row itself', () => {
  const model = {
    since: NOW - 6 * 60 * MIN,
    now: NOW,
    counts: { median_ms: null },
    lanes: [],
    tasks: [
      {
        ...row('linked-task', 'done', NOW - 100 * MIN, NOW - 55 * MIN),
        pr: { number: 12, url: 'https://github.com/acme/app/pull/12' },
      },
    ],
  } as unknown as BoardModel;
  vi.setSystemTime(NOW);
  const opened: string[] = [];
  const host = new HookHost(() => ProgressTable({ model, onOpenTask: (id) => opened.push(id) }));
  const tr = find(host.render(), (n) => n.props.className === 'bp-tr bp-trw');
  // Stands in for a DOM element whose nearest ancestor-or-self tag is `tag`.
  const element = (tag: string | null) => ({
    closest: (selector: string) => (tag && selector.split(/,\s*/).includes(tag) ? {} : null),
  });
  const press = (target: object) => {
    const event = { key: 'Enter', target, currentTarget: target, preventDefault: vi.fn() };
    tr.props.onKeyDown(event);
    return event.preventDefault;
  };
  expect(press(element('a'))).not.toHaveBeenCalled();
  expect(opened).toEqual([]);
  expect(press(element(null))).toHaveBeenCalled();
  expect(opened).toEqual(['linked-task']);
});
