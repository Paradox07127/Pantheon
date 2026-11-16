import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { TraceTimeAllocation, TraceTimeEvidence } from '@pantheon/domain';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'time-id' }),
);
import { TraceTimeChart } from '@/screens/trace/TraceTimeChart';
import { mount, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const label = (key: string) => zh(`trace.timeChart.${key}`);

const MIN = 60_000;
const call: TraceTimeEvidence = {
  lane_key: 'lane-a',
  turn_id: 'turn-1',
  id: 'call-1',
  operation: 'shell',
  at: Date.UTC(2026, 10, 13, 10, 30),
  source: 'native',
};
const allocation = (extra: Partial<TraceTimeAllocation> = {}): TraceTimeAllocation => ({
  from: 0,
  to: 0,
  wall_ms: 91 * MIN,
  wall: [
    { kind: 'llm', ms: 38 * MIN, evidence: [] },
    { kind: 'tool', ms: 21 * MIN, evidence: [call] },
    { kind: 'approval', ms: 14 * MIN, evidence: [] },
    { kind: 'subagent', ms: 9 * MIN, evidence: [] },
    { kind: 'queue', ms: 5 * MIN, evidence: [] },
    { kind: 'parallel', ms: 2 * MIN, evidence: [], concurrent: [] },
    { kind: 'compact', ms: 1 * MIN, evidence: [] },
    { kind: 'unknown', ms: 1 * MIN, evidence: [] },
  ],
  work_ms: 120 * MIN,
  work: [{ kind: 'tool', ms: 120 * MIN, evidence: [call] }],
  turns: 38,
  operations: 412,
  untimed_operations: 37,
  unplaced_operations: 3,
  gate_ms: 8 * MIN + 12_000,
  gates: 6,
  live: true,
  partial: true,
  native: 'unavailable',
  ...extra,
});

function chart(data: TraceTimeAllocation, onEvidence?: (item: TraceTimeEvidence) => void) {
  return mount(() =>
    TraceTimeChart({
      query: { data, loading: false, error: null, reload() {} },
      titleOf: () => 'Refund idempotency',
      onEvidence,
    }),
  );
}
const cls = (tree: ReactNode, name: string) =>
  nodes(tree).filter((n) =>
    String(n.props.className ?? '')
      .split(' ')
      .includes(name),
  );
const one = (tree: ReactNode, name: string) => {
  const found = cls(tree, name);
  expect(found, name).toHaveLength(1);
  return found[0]!;
};
const cells = (row: ReactElement<any>) =>
  (row.props.children as ReactNode[]).flat().filter(Boolean) as ReactElement<any>[];

describe('time breakdown chart', () => {
  it('heads the panel with its title, the measure switch and the turn count', () => {
    const tree = chart(allocation()).value;
    const section = tree as ReactElement<any>;
    expect(String(section.props.className).split(' ')).toContain('panel');
    const head = one(tree, 'trc-time-head');
    expect(text(head)).toContain(label('title'));
    expect(text(head)).toContain(label('wall'));
    expect(text(head)).toContain(label('work'));
    expect(text(one(tree, 'trc-time-turns'))).toBe('38 个回合');
  });

  it('stands the measure switch, disabled, while the breakdown is read', () => {
    const measure = (tree: ReactNode) =>
      nodes(tree).filter((n) => n.props['aria-label'] === zh('trace.time.mode'));
    const reading = mount(() =>
      TraceTimeChart({
        query: { data: null, loading: true, error: null, reload() {} },
        titleOf: () => '',
      }),
    ).value as ReactElement<any>;
    expect(reading.props['aria-busy']).toBe(true);
    expect(measure(reading).map((n) => n.props.disabled)).toEqual([true]);
    const read = chart(allocation()).value as ReactElement<any>;
    expect(read.props['aria-busy']).toBeUndefined();
    expect(measure(read).map((n) => n.props.disabled)).toEqual([false]);
  });

  it('draws six groups in the bar with the total written beside it', () => {
    const tree = chart(allocation()).value;
    const bar = one(tree, 'trc-time-bar');
    const parts = (bar.props.children as ReactElement<any>[]).map((part) => [
      part.props['data-group'],
      part.props.style['--n'] / MIN,
    ]);
    expect(parts).toEqual([
      ['model', 38],
      ['tool', 21],
      ['approval', 14],
      ['subagent', 9],
      ['queue', 5],
      ['other', 4],
    ]);
    expect(bar.props.role).toBe('img');
    expect(bar.props['aria-label']).toBe(
      '墙钟 1 时 31 分：模型 38 分，工具 21 分，等你批准 14 分，子 agent 9 分，排队 5 分，其他 4 分',
    );
    expect(text(one(tree, 'trc-time-total'))).toBe('1 时 31 分');
  });

  it('lists the groups in two columns with minutes and whole percentages', () => {
    const tree = chart(allocation()).value;
    const rows = cls(one(tree, 'trc-time-keys'), 'trc-time-key').map((row) =>
      cells(row)
        .slice(1)
        .map((cell) => text(cell)),
    );
    expect(rows).toEqual([
      [label('model'), '38 分', '42%'],
      [label('approval'), '14 分', '15%'],
      [label('tool'), '21 分', '23%'],
      [label('subagent'), '9 分', '10%'],
      [label('queue'), '5 分', '5%'],
      [label('other'), '4 分', '4%'],
    ]);
  });

  it('opens other into parallel, compaction, delivery and unknown', () => {
    const host = chart(allocation());
    const other = () =>
      cls(host.value, 'trc-time-key').find((row) => text(row).startsWith(label('other')))!;
    expect(other().type).toBe('button');
    expect(other().props['aria-expanded']).toBe(false);
    expect(other().props['aria-label']).toBe('其他 4 分：并行，压缩，未知');
    expect(cls(host.value, 'trc-time-sub')).toHaveLength(0);
    other().props.onClick();
    host.render();
    expect(other().props['aria-expanded']).toBe(true);
    expect(
      cls(host.value, 'trc-time-sub').map((row) =>
        cells(row)
          .slice(1)
          .map((cell) => text(cell)),
      ),
    ).toEqual([
      [label('parallel'), '2 分', '2%'],
      [label('compact'), '1 分', '1%'],
      [label('unknown'), '1 分', '1%'],
    ]);
  });

  it('notes the gates, the untimed calls and the unplaced calls beside the chart', () => {
    const tree = chart(allocation()).value;
    const notes = one(tree, 'trc-time-notes');
    expect(text(notes)).toContain(label('gates'));
    expect(text(notes)).toContain('8 分 12 秒');
    expect(text(notes)).toContain('6 次，不算进左边的条');
    expect(text(notes)).toContain('412 个调用里 37 个没有计时');
    expect(text(notes)).toContain('3 个调用放不进墙钟');
    const none = chart(
      allocation({ gates: 0, gate_ms: 0, untimed_operations: 0, unplaced_operations: 0 }),
    ).value;
    expect(cls(none, 'trc-time-notes')).toHaveLength(0);
  });

  it('leaves evidence and coverage notes out without a jump handler', () => {
    const tree = chart(allocation()).value;
    const keys = cls(tree, 'trc-time-key').filter((row) => !text(row).startsWith(label('other')));
    expect(keys.map((row) => row.type)).toEqual(['div', 'div', 'div', 'div', 'div']);
    expect(cls(tree, 'trc-time-evidence')).toHaveLength(0);
    expect(cls(tree, 'trc-time-foot')).toHaveLength(0);
  });

  it('keeps the evidence of each kind for the session analysis', () => {
    const open = vi.fn();
    const host = chart(allocation(), open);
    const tool = () =>
      cls(host.value, 'trc-time-key').find((row) => text(row).startsWith(label('tool')))!;
    expect(tool().type).toBe('button');
    tool().props.onClick();
    host.render();
    expect(tool().props['aria-expanded']).toBe(true);
    const evidence = one(host.value, 'trc-time-evidence');
    expect(text(evidence)).toContain('shell, Refund idempotency');
    evidence.props.onClick();
    expect(open).toHaveBeenCalledWith(call);
    expect(text(one(host.value, 'trc-time-foot'))).toContain(zh('trace.time.live'));
  });
});
