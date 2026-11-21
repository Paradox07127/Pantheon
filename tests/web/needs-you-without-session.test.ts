import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import type { NeedsYouItem } from '@/data/needs-you';
import { NeedsStrip } from '@/screens/board/BoardFrame';
import type { BoardNeed } from '@/screens/board/frame-model';
import { taskFocus } from '@/screens/board/task-focus';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const milestone: NeedsYouItem = {
  source: { table: 'milestones', id: 'milestone-1', revision: 3 },
  kind: 'milestone.ready_for_acceptance',
  project_id: 'project-a',
  session_id: 'lead',
  status: 'ready_for_acceptance',
  created_at: NOW - 60_000,
  reason: 'milestone_ready_for_acceptance',
  actions: [{ command: 'milestone.accept', allowed: true }],
};

const overBudget: NeedsYouItem = {
  source: { table: 'workflow_policies', id: 'project-a', revision: 1 },
  kind: 'project.over_budget',
  project_id: 'project-a',
  status: 'waiting',
  created_at: NOW - 30_000,
  reason: 'project_over_budget',
  actions: [{ command: 'workflow.policy.set', allowed: true }],
};

const cards = (html: string) => html.split('class="rq"').length - 1;

describe('needs-you items that are not about a session', () => {
  it('gives each its own card in the board strip, with no button that only opens a session', () => {
    const needs = [milestone, overBudget].map((item) => ({ ...item, unblocks: 0 })) as BoardNeed[];
    const html = renderToStaticMarkup(
      createElement(NeedsStrip, {
        model: { now: NOW, needs, tasks: [], milestones: [] } as unknown as BoardModel,
        sessions: [],
        run: async () => null,
        onOpenSession: () => {},
      }),
    );
    expect(cards(html)).toBe(2);
    expect(html).toContain(`>${zh('board.needs.actions.accept')}</button>`);
    expect(html).toContain(`>${zh('board.needs.actions.budget')}</button>`);
    expect(html).not.toContain(zh('board.needs.actions.open'));
  });

  it('does not focus a task the lead did itself because its milestone waits for acceptance', () => {
    const task = (id: string, status: string, sessionId: string) => ({
      id,
      title: id,
      status,
      blockers: [],
      segments: [{ session_id: sessionId }],
    });
    const model = {
      now: NOW,
      tasks: [task('lead:done', 'done', 'lead'), task('lead:next', 'ready', 'worker-2')],
      edges: [],
      needs: [{ ...milestone, unblocks: 0 }],
    } as unknown as BoardModel;
    expect(taskFocus(model)?.task.id).toBe('lead:next');
  });
});
