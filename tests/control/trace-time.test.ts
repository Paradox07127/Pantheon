import { expect, it } from 'vitest';
import type { TraceSpan } from '@pantheon/domain';
import { allocationOf } from '../../packages/control/dist/trace-time.js';

const span = (
  id: string,
  kind: TraceSpan['kind'],
  start: number | null,
  end: number | null,
  fields: Partial<TraceSpan> = {},
): TraceSpan => ({
  id,
  kind,
  start,
  end,
  parent: kind === 'turn' ? null : 'turn',
  turn: 'turn',
  name: id,
  timing: 'native',
  status: 'ok',
  ...fields,
});
const lane = (key: string, turns: TraceSpan[], spans: TraceSpan[]) => ({
  lane: { key, runtime: 'claude' },
  turns,
  spans,
});
const amounts = (rows: { kind: string; ms: number }[]) =>
  Object.fromEntries(rows.map(({ kind, ms }) => [kind, ms]));

it('uses the request union, separates overlapping categories and counts nested work only once', () => {
  const first = lane(
    'first',
    [span('turn', 'turn', 0, 100)],
    [
      span('outer', 'tool', 10, 60),
      span('command', 'tool', 20, 55, { parent: 'outer' }),
      span('model', 'llm', 45, 80),
      span('no-boundary', 'tool', null, 90, { duration_ms: 12 }),
      span('mixed-boundary', 'tool', 85, 93, { native_interval: false }),
      span('compact-boundary', 'compact', 94, 94),
    ],
  );
  const second = lane('second', [span('turn', 'turn', 30, 70)], [span('command', 'tool', 30, 70)]);
  const result = allocationOf([first, second], [], 5, 95, 'included', false);
  expect(result).toMatchObject({
    wall_ms: 90,
    work_ms: 137,
    turns: 2,
    operations: 7,
    untimed_operations: 2,
    unplaced_operations: 1,
  });
  expect(amounts(result.wall)).toEqual({ tool: 35, parallel: 25, llm: 10, unknown: 20 });
  expect(amounts(result.work)).toEqual({ tool: 102, llm: 35 });
  expect(result.wall.find((row) => row.kind === 'parallel')?.concurrent).toEqual([
    { kinds: ['llm', 'tool'], ms: 25 },
  ]);
});

it('attributes nested Claude subagent spans to their root turn and excludes gaps between turns', () => {
  const result = allocationOf(
    [
      lane(
        'first',
        [span('turn', 'turn', 0, 50), span('next', 'turn', 80, 100, { turn: 'next' })],
        [
          span('agent', 'subagent', 10, 40),
          span('nested-turn', 'turn', 15, 37, { turn: 'nested-turn', parent: 'agent' }),
          span('child', 'tool', 15, 35, { turn: 'nested-turn', parent: 'nested-turn' }),
        ],
      ),
    ],
    [],
    0,
    100,
    'included',
    false,
  );
  expect(result.wall_ms).toBe(70);
  expect(result.work_ms).toBe(30);
  expect(amounts(result.wall)).toEqual({ unknown: 40, subagent: 10, tool: 20 });
  expect(result.work.find((row) => row.kind === 'tool')?.evidence[0]?.turn_id).toBe('turn');
});
