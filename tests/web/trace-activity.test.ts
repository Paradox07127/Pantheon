import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { ActivityList } from '@/screens/trace/ActivityList';
import type { TraceEvent } from '@/screens/trace/model';
import { find, mount, named, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 2, 8, 14, 20).getTime();
const at = (day: number, hour: number) => new Date(2026, 2, day, hour).getTime();

const event = (id: string, time: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id,
  at: time,
  sessionId: 'session-a',
  kind: 'session',
  what: 'opened',
  detail: null,
  ...extra,
});

afterEach(unmountAll);

function list(rows: TraceEvent[], onOpen = vi.fn()) {
  return mount(() =>
    ActivityList({
      rows,
      error: null,
      onRetry() {},
      titleOf: (id) => `title of ${id}`,
      now: NOW,
      onOpen,
    }),
  );
}

const sections = (h: HookHost<ReactElement>) =>
  nodes(h.value).filter((n) => n.props.className === 'trc-day');
const rowsOf = (section: ReactElement<any>) =>
  nodes(section).filter((n) => n.props.className === 'trc-ev');
const press = (h: HookHost<ReactElement>, node: ReactElement<any>) => {
  node.props.onClick();
  h.render();
};

describe('the activity list', () => {
  it('groups activity by day with today open and the earlier days folded', () => {
    const h = list([
      event('c', at(8, 9)),
      event('b', at(7, 20)),
      event('a', at(5, 10), { kind: 'merge', what: 'merged', detail: 'abcdef1' }),
    ]);
    expect(sections(h).map((s) => s.props['aria-label'])).toEqual([
      zh('lib.time.today'),
      zh('lib.time.yesterday'),
      '3月5日',
    ]);
    expect(sections(h).map((s) => rowsOf(s).length)).toEqual([1, 0, 0]);
    expect(text(find(sections(h)[1]!, (n) => n.props.className === 'trc-dn'))).toBe('1 条');

    press(
      h,
      find(sections(h)[1]!, (n) => n.props['aria-expanded'] === false),
    );
    expect(sections(h).map((s) => rowsOf(s).length)).toEqual([1, 1, 0]);
    press(
      h,
      find(sections(h)[0]!, (n) => n.props['aria-expanded'] === true),
    );
    expect(sections(h).map((s) => rowsOf(s).length)).toEqual([0, 1, 0]);
  });

  it('offers only the kinds the activity holds and leaves out a kind turned off', () => {
    const h = list([
      event('b', at(8, 10), { kind: 'approval', what: 'asked', detail: 'Bash', waitedMs: null }),
      event('a', at(8, 9), { kind: 'merge', what: 'merged', detail: 'abcdef1' }),
    ]);
    const kinds = () =>
      nodes(find(h.value, (n) => n.props.role === 'group').props.children).filter(
        (n) => n.type === 'button',
      );
    expect(kinds().map((n) => [text(n), n.props['aria-pressed']])).toEqual([
      [zh('trace.eventKind.approval'), true],
      [zh('trace.eventKind.merge'), true],
    ]);
    press(h, kinds()[0]!);
    expect(kinds()[0]!.props['aria-pressed']).toBe(false);
    expect(rowsOf(sections(h)[0]!).map((n) => text(n))).toEqual([
      '09:00title of session-a已合并 abcdef1',
    ]);
  });

  it('notes how long an approval waited, the lines a merge changed and a repeated gate run', () => {
    const h = list([
      event('d', NOW - 5 * MIN, {
        kind: 'approval',
        what: 'asked',
        detail: 'Bash',
        waitedMs: null,
      }),
      event('c', at(8, 12), {
        kind: 'approval',
        what: 'asked',
        detail: 'Edit',
        waitedMs: 18 * MIN,
      }),
      event('b', at(8, 11), {
        kind: 'merge',
        what: 'merged',
        detail: 'abcdef1',
        added: 9,
        removed: 0,
      }),
      event('a', at(8, 10), { kind: 'gate', what: 'gate_failed', detail: 'test', run: 3 }),
    ]);
    const notes = nodes(h.value)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'Note')
      .map((n) => text((n.type as (p: unknown) => ReactElement)(n.props)));
    expect(notes).toEqual(['等你 5 分钟', '等了 18 分钟', '+9 −0', '第 3 次']);
  });

  it('sets the command an approval asks to run and a merged commit apart, and counts checks passed and skipped', () => {
    const h = list([
      event('c', at(8, 12), { kind: 'merge', what: 'merged', detail: 'b124f99' }),
      event('b', at(8, 11), {
        kind: 'approval',
        what: 'asked',
        detail: 'Bash',
        input: 'pnpm db:migrate',
        waitedMs: 0,
      }),
      event('a', at(8, 10), {
        kind: 'gate',
        what: 'gate_passed',
        checks: { passed: 4, failed: 0, skipped: 1 },
      }),
    ]);
    const [merged, asked, gate] = rowsOf(sections(h)[0]!);
    expect(text(find(merged!, (n) => n.type === 'code'))).toBe('b124f99');
    expect(text(find(asked!, (n) => n.type === 'code'))).toBe('pnpm db:migrate');
    expect(text(find(asked!, (n) => n.props.className === 'trc-evw'))).toBe(
      '请求使用 Bash pnpm db:migrate',
    );
    expect(text(find(gate!, (n) => n.props.className === 'trc-evw'))).toBe('门禁 4 通过 1 跳过');
  });

  it('counts the checks a failed gate run did not pass', () => {
    const h = list([
      event('a', at(8, 10), {
        kind: 'gate',
        what: 'gate_failed',
        detail: 'unit',
        checks: { passed: 3, failed: 2, skipped: 1 },
      }),
    ]);
    const [gate] = rowsOf(sections(h)[0]!);
    expect(text(find(gate!, (n) => n.props.className === 'trc-evw'))).toBe(
      '门禁失败：unit 2 项不过',
    );
  });

  it('filters the rows by session and words', () => {
    const h = list([
      event('b', at(8, 11), { sessionId: 'refunds', kind: 'merge', what: 'merged', detail: 'abc' }),
      event('a', at(8, 10), { sessionId: 'exports' }),
    ]);
    const input = () => find(h.value, (n) => n.type === 'input');
    expect(input().props['aria-label']).toBe(zh('trace.activity.filter'));
    input().props.onChange({ target: { value: 'REFUNDS' } });
    h.render();
    expect(rowsOf(sections(h)[0]!).map((n) => text(n))).toEqual([
      '11:00title of refunds已合并 abc',
    ]);
    input().props.onChange({ target: { value: '会话开始' } });
    h.render();
    expect(rowsOf(sections(h)[0]!).map((n) => text(n))).toEqual(['10:00title of exports会话开始']);
    input().props.onChange({ target: { value: 'nothing like it' } });
    h.render();
    expect(named(h.value, 'Empty').props.text).toBe(zh('trace.activity.noMatch'));
  });

  it("opens a row's session", () => {
    const onOpen = vi.fn();
    const h = list([event('a', at(8, 9), { sessionId: 'session-b' })], onOpen);
    press(h, rowsOf(sections(h)[0]!)[0]!);
    expect(onOpen).toHaveBeenCalledWith('session-b');
  });

  it('shows an empty list as such', () => {
    expect(named(list([]).value, 'Empty').props.text).toBe(zh('trace.activity.empty'));
  });
});
