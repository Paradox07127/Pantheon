import { describe, expect, it } from 'vitest';
import type { BoardModel } from '../../packages/protocol/src/index.js';
import {
  LANE_GAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  flowLayout,
} from '../../apps/web/src/screens/board/flow-layout.js';

type Task = BoardModel['tasks'][number];

const task = (id: string, lane_id: string | null): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id,
  milestone_id: null,
  status: 'todo',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
});

const board = (tasks: Task[], edges: BoardModel['edges'] = []): BoardModel =>
  ({
    lanes: [
      { id: 'api', title: 'API' },
      { id: 'ui', title: 'UI' },
    ],
    tasks,
    edges,
  }) as BoardModel;

// Three tasks with no edges share the first column and stack in rows.
const stacked = board([task('tall', 'api'), task('short', 'api'), task('mid', 'api')]);
const heights = new Map([
  ['tall', 200],
  ['short', 90],
  ['mid', 150],
]);

describe('board flow layout with measured card heights', () => {
  it('stacks cards of different heights in one lane without overlapping', () => {
    const layout = flowLayout(stacked, 1200, 'lane', heights);
    const nodes = layout.nodes;
    expect(nodes).toHaveLength(3);
    for (const a of nodes)
      for (const b of nodes) {
        if (a === b) continue;
        const apart =
          a.x + NODE_WIDTH <= b.x ||
          b.x + NODE_WIDTH <= a.x ||
          a.y + heights.get(a.id)! <= b.y ||
          b.y + heights.get(b.id)! <= a.y;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
    const band = layout.lanes[0]!;
    for (const n of nodes) {
      expect(n.y).toBeGreaterThanOrEqual(band.y);
      expect(n.y + heights.get(n.id)!).toBeLessThanOrEqual(band.y + band.height);
    }
  });

  it('sizes a one-row lane to its tallest card and starts the next lane after it', () => {
    const model = board(
      [task('a', 'api'), task('b', 'api'), task('c', 'ui')],
      [{ from: 'a', to: 'b', state: 'pending' }],
    );
    const layout = flowLayout(
      model,
      1200,
      'lane',
      new Map([
        ['a', 100],
        ['b', 180],
        ['c', 120],
      ]),
    );
    const [api, ui] = layout.lanes;
    expect(api!.height).toBe(180 + 2 * 16);
    expect(ui!.height).toBe(120 + 2 * 16);
    expect(ui!.y).toBe(api!.y + api!.height + LANE_GAP);
    expect(layout.height).toBe(ui!.y + ui!.height);
  });

  it('takes the default card height for a card not measured yet', () => {
    const layout = flowLayout(stacked, 1200, 'lane', new Map([['tall', 200]]));
    expect(layout.lanes[0]!.height).toBe(200 + 2 * NODE_HEIGHT + 2 * 16 + 2 * 16);
  });
});
