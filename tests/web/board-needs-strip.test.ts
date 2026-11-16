import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { NeedsStrip } from '@/screens/board/BoardFrame';
import type { BoardNeed } from '@/screens/board/frame-model';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const blocked: BoardNeed = {
  source: { table: 'sessions', id: 'worker-1', revision: 7 },
  kind: 'session.merge_blocked',
  project_id: 'project-a',
  status: 'open',
  created_at: NOW - 60_000,
  reason: 'merge_blocked',
  actions: [{ command: 'session.merge', allowed: true }],
  unblocks: 0,
};

const worker = {
  id: 'worker-1',
  revision: 7,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
  title: 'Serve exports',
  merge: { state: 'blocked', reason: 'out_of_scope', conflicts: ['README.md'] },
} as SnapshotSession;

describe('needs-you strip', () => {
  it('offers to merge a merge blocked out of scope anyway, not to retry it', () => {
    const html = renderToStaticMarkup(
      createElement(NeedsStrip, {
        model: { now: NOW, needs: [blocked] } as unknown as BoardModel,
        sessions: [worker],
        run: async () => null,
        onOpenSession: () => {},
      }),
    );
    expect(html).toContain(
      `aria-label="${zh('board.needs.actions.mergeOutOfScope')} Serve exports"`,
    );
    expect(html).not.toContain(zh('board.needs.actions.merge'));
  });
});
