import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, deferred, find, nodes, text } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import { toastManager } from '../../apps/web/src/components/Toast.js';
import { useMemoryView } from '../../apps/web/src/data/memory-view.js';
import { useShell } from '../../apps/web/src/store.js';
import { useSettingsView } from '../../apps/web/src/screens/settings/view.js';
import { needWho, type NeedItem } from '../../apps/web/src/screens/board/frame-model.js';
import type {
  RunBoardCommand,
  SnapshotSession,
} from '../../apps/web/src/screens/board/panels-model.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const escalated: NeedItem = {
  source: { table: 'approvals', id: 'approval-1', revision: 4 },
  kind: 'permission',
  project_id: 'project-a',
  session_id: 'worker-1',
  status: 'pending',
  created_at: NOW - 30 * 60_000,
  reason: 'permission_requested',
  decision: 'permission',
  blocks: 0,
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: { action: 'Bash', input_summary: 'pnpm test' },
  waited_ms: 25 * 60_000,
  escalated: true,
};

const waiting: NeedItem = {
  source: { table: 'sessions', id: 'worker-1', revision: 7 },
  kind: 'session.failed',
  project_id: 'project-a',
  status: 'idle',
  created_at: NOW - 60_000,
  reason: 'usage_limit_waiting',
  decision: 'other',
  blocks: 0,
  actions: [],
  resets_at: NOW + 2 * 60 * 60_000,
};

const gate: NeedItem = {
  source: { table: 'sessions', id: 'worker-1', revision: 7 },
  kind: 'session.gate_failed',
  project_id: 'project-a',
  status: 'open',
  created_at: NOW - 60_000,
  reason: 'gate_failed',
  decision: 'other',
  blocks: 0,
  actions: [],
  failure_class: 'environment',
};

const stalled: NeedItem = {
  source: { table: 'sessions', id: 'worker-1', revision: 7 },
  kind: 'session.failed',
  project_id: 'project-a',
  status: 'running',
  created_at: NOW - 20 * 60_000,
  reason: 'task_turn_stalled',
  decision: 'other',
  blocks: 0,
  actions: [{ command: 'session.interrupt', allowed: true }],
};

const proposed: NeedItem = {
  source: { table: 'board_plans', id: 'lead-1', revision: 3 },
  kind: 'board.plan.proposal',
  project_id: 'project-a',
  session_id: 'lead-1',
  request_id: 'proposal-1',
  status: 'pending',
  created_at: NOW - 60_000,
  reason: 'plan_proposal_awaiting_decision',
  decision: 'plan_change',
  blocks: 0,
  actions: [{ command: 'board.plan.proposal.resolve', allowed: true }],
};

const worker = {
  id: 'worker-1',
  revision: 7,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'running',
  turn_count: 2,
  title: 'Serve exports',
  task: { lead_session_id: 'lead-1', id: 'exports' },
} as unknown as SnapshotSession;

const overBudget: NeedItem = {
  source: { table: 'workflow_policies', id: 'project-a', revision: 4 },
  kind: 'project.over_budget',
  project_id: 'project-a',
  status: 'over_budget',
  created_at: NOW - 60_000,
  reason: 'project_over_budget',
  decision: 'budget',
  blocks: 0,
  actions: [{ command: 'workflow.policy.set', allowed: true }],
  project_budget: { used_input_tokens: 150, input_tokens: 100 },
};

const planNotes: NeedItem = {
  source: { table: 'memory_records', id: 'note-2', revision: 1 },
  kind: 'memory.decision_budget',
  project_id: 'project-a',
  status: 'over_budget',
  created_at: NOW - 60_000,
  reason: 'plan_decisions_over_budget',
  decision: 'budget',
  blocks: 0,
  actions: [],
  memory_notes: { count: 2, memory_ids: ['note-1', 'note-2'] },
};

type Props = Parameters<typeof RequestCard>[0];

function mount(props: Partial<Props> & Pick<Props, 'item'>, run = vi.fn<RunBoardCommand>()) {
  const h = new HookHost(() =>
    RequestCard({
      size: 'full',
      who: 'Serve exports',
      now: NOW,
      run,
      onOpenSession: () => {},
      ...props,
    } as Props),
  );
  h.render();
  return { h, run };
}

const button = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);
const labels = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));

afterEach(() => vi.restoreAllMocks());

describe('request card details', () => {
  it('shows how long an escalated request has waited and marks it escalated', () => {
    for (const size of ['full', 'compact'] as const) {
      const { h } = mount({ item: escalated, size });
      expect(text(h.value)).toContain('已等 25 分');
      expect(
        find(h.value, (n) => text(n) === zh('components.requestCard.escalated')).props.className,
      ).toBe('tr-st wait');
    }
  });

  it('shows when a usage limit resets as local time', () => {
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(waiting.resets_at);
    const { h } = mount({ item: waiting });
    expect(text(h.value)).toContain(`${time} 恢复`);
  });

  it('names a known gate failure class and shows an unknown one as it is', () => {
    expect(text(mount({ item: gate }).h.value)).toContain(zh('data.failureClass.environment'));
    const unknown = { ...gate, failure_class: 'quota' } as unknown as NeedItem;
    expect(text(mount({ item: unknown }).h.value)).toContain('quota');
  });

  it('shows none of the four facts on an item without them', () => {
    const { h } = mount({ item: { ...escalated, waited_ms: undefined, escalated: undefined } });
    expect(text(h.value)).not.toContain('已等');
    expect(text(h.value)).not.toContain(zh('components.requestCard.escalated'));
  });

  it('interrupts a stalled or looping task through its lead and holds the button until the answer', async () => {
    for (const reason of ['task_turn_stalled', 'task_turn_looping'] as const) {
      const answer = deferred<string | null>();
      const { h, run } = mount(
        { item: { ...stalled, reason }, session: worker },
        vi.fn<RunBoardCommand>(() => answer.promise),
      );
      button(h.value, zh('components.requestCard.interrupt')).props.onClick();
      h.render();
      expect(run).toHaveBeenCalledWith(
        'task.interrupt',
        { project_id: 'project-a', lead_session_id: 'lead-1', task_id: 'exports' },
        null,
      );
      expect(button(h.value, zh('components.requestCard.interrupt')).props['aria-disabled']).toBe(
        true,
      );
      button(h.value, zh('components.requestCard.interrupt')).props.onClick();
      expect(run).toHaveBeenCalledTimes(1);
      answer.resolve(null);
      await h.flush();
      expect(
        button(h.value, zh('components.requestCard.interrupt')).props['aria-disabled'],
      ).toBeUndefined();
    }
  });

  it('reports a failed interrupt in a toast', async () => {
    const add = vi.spyOn(toastManager, 'add');
    const { h } = mount(
      { item: stalled, session: worker },
      vi.fn<RunBoardCommand>(async () => 'The task has no running turn'),
    );
    button(h.value, zh('components.requestCard.interrupt')).props.onClick();
    await h.flush();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The task has no running turn' }),
    );
    expect(text(h.value)).not.toContain('The task has no running turn');
  });

  it('marks a lead plan proposal with the plan edit icon and decides it in place with Accept and Reject', async () => {
    const leadSession = { ...worker, id: 'lead-1', title: 'Refunds lead', task: undefined };
    const who = needWho(proposed, { tasks: [], milestones: [] }, [leadSession]);
    expect(who).toBe('Refunds lead 提议改计划');
    const { h, run } = mount({ item: proposed, who });
    const head = find(h.value, (n) => n.props.className === 'rq-hd');
    // The icon of the board's edit plan button.
    expect((nodes(head.props.children)[0]!.type as { displayName?: string }).displayName).toBe(
      'Pencil',
    );
    expect(text(find(h.value, (n) => n.props.className === 'rq-who'))).toBe(who);
    expect(text(h.value)).toContain(zh('data.reason.planProposalAwaitingDecision'));
    expect(labels(h.value)).toEqual([
      zh('board.plan.proposal.accept'),
      zh('board.plan.proposal.reject'),
    ]);
    run.mockResolvedValue(null);
    button(h.value, zh('board.plan.proposal.accept')).props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith(
      'board.plan.proposal.resolve',
      {
        project_id: 'project-a',
        lead_session_id: 'lead-1',
        proposal_id: 'proposal-1',
        decision: 'accept',
      },
      null,
    );
  });

  it('opens the settings on the page of the project over its budget', () => {
    const { h, run } = mount({ item: overBudget });
    button(h.value, zh('board.needs.actions.budget')).props.onClick();
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      page: 'projects',
      detail: 'project-a',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('says how many plan decisions became notes and opens the plan entries of memory', () => {
    const { h, run } = mount({ item: planNotes });
    expect(text(h.value)).toContain(zhf('board.needs.memoryBudget', { count: 2 }));
    button(h.value, zh('board.needs.actions.memory')).props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'memory', memoryTab: 'entries' });
    expect(useMemoryView.getState().askedFilters).toEqual({ origin: 'plan' });
    expect(run).not.toHaveBeenCalled();
  });

  it('offers no interrupt on a card whose task is not stuck', () => {
    expect(labels(mount({ item: waiting, session: worker }).h.value)).not.toContain(
      zh('components.requestCard.interrupt'),
    );
    expect(
      labels(mount({ item: { ...stalled, reason: 'lead_turn_stalled' } }).h.value),
    ).not.toContain(zh('components.requestCard.interrupt'));
  });
});
