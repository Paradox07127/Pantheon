import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, find, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import type { NeedItem } from '../../apps/web/src/screens/board/frame-model.js';
import type { RunBoardCommand } from '../../apps/web/src/screens/board/panels-model.js';
import { zh } from './i18n-setup.js';

const keep = zh('board.needs.actions.keepTrial');
const revert = zh('board.needs.actions.revertTrial');

const NOW = Date.UTC(2026, 10, 14, 12);

const trial: NeedItem = {
  source: { table: 'workflow_definitions', id: 'wf-fast', revision: 4 },
  kind: 'workflow.definition.trial',
  project_id: 'project-a',
  status: 'waiting',
  created_at: NOW - 60 * 60_000,
  reason: 'workflow_definition_trial_completed',
  actions: [
    { command: 'workflow.definition.trial.decide', allowed: true, decision: 'keep' },
    { command: 'workflow.definition.trial.decide', allowed: true, decision: 'revert' },
  ],
};

function mount(item: NeedItem, run = vi.fn<RunBoardCommand>(async () => null)) {
  const h = new HookHost(() =>
    RequestCard({ item, size: 'full', who: 'Fast', now: NOW, run, onOpenSession: () => {} }),
  );
  h.render();
  return { h, run };
}
const labels = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));

describe('a finished workflow trial', () => {
  it('offers keeping or reverting the change and sends the decision', async () => {
    for (const [label, decision] of [
      [keep, 'keep'],
      [revert, 'revert'],
    ] as const) {
      const { h, run } = mount(trial);
      expect(labels(h.value)).toEqual([keep, revert]);
      find(h.value, (n) => n.type === 'button' && text(n) === label).props.onClick();
      await h.flush();
      expect(run).toHaveBeenCalledWith(
        'workflow.definition.trial.decide',
        { project_id: 'project-a', id: 'wf-fast', decision },
        null,
      );
      h.unmount();
    }
  });

  it('keeps both buttons off when the decision is not allowed', () => {
    const { h, run } = mount({
      ...trial,
      actions: trial.actions.map((a) => ({ ...a, allowed: false, disabled_reason: 'forbidden' })),
    });
    for (const label of [keep, revert]) {
      const el = find(h.value, (n) => n.type === 'button' && text(n) === label);
      expect(el.props['aria-disabled']).toBe(true);
      el.props.onClick();
    }
    expect(run).not.toHaveBeenCalled();
  });
});
