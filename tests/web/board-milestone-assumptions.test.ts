import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  runCommand: (() => {}) as any,
  toast: (() => {}) as any,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'as-id' }),
);
vi.mock('@/data/commands', () => ({
  runCommand: (...args: unknown[]) => mock.runCommand(...args),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (...args: unknown[]) => mock.toast(...args),
}));
import { GoalsSection } from '@/screens/board/GoalsSection';
import { MilestoneAssumptions } from '@/screens/board/MilestoneAssumptions';
import type { BoardMilestone } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

type Assumption = NonNullable<BoardMilestone['assumptions']>[number];

const NOW = Date.UTC(2026, 10, 18, 10);
const PAYLOAD = 'Staging keeps sending the v1 webhook payload until the rollout flag is on';
const SANDBOX = "Staging pays out through the provider's sandbox, never with live keys";
const INSTEAD = 'Send the v2 payload in staging from the start';

const task = (id: string, title: string, status: string) =>
  ({ id, title, status, milestone_id: 'ms-staging' }) as unknown as BoardModel['tasks'][number];
const TASKS = [
  task('t-config', 'Staging deploy config', 'done'),
  task('t-relay', 'Staging webhook relay', 'running'),
  task('t-smoke', 'Staging smoke tests', 'failed'),
  task('t-flag', 'Rollout flag wiring', 'todo'),
  task('t-list', 'Refund list page', 'ready'),
  task('t-key', 'Refund idempotency', 'running'),
];
const board = (version = 4, pending: object[] = []) =>
  ({
    now: NOW,
    tasks: TASKS,
    merges: [],
    milestones: [],
    leads: [
      {
        session_id: 'lead-1',
        title: 'Refunds v2 rollout',
        state: 'idle',
        plan_version: version,
        pending_edits: pending,
      },
    ],
  }) as unknown as BoardModel;
const assumption = (id: string, words: string, extra: Partial<Assumption> = {}): Assumption => ({
  id,
  text: words,
  affects: [],
  ...extra,
});
const PLAN = [
  assumption('payload', PAYLOAD, { affects: ['t-smoke', 't-flag'] }),
  assumption('sandbox', SANDBOX, { affects: ['t-config'] }),
];
const milestone = (assumptions?: Assumption[]): BoardMilestone => ({
  id: 'ms-staging',
  title: 'Staging rollout',
  session_ids: [],
  merged: 1,
  status: 'active',
  criteria: [],
  owner_session_id: 'lead-1',
  tasks: { done: 1, total: 4 },
  ...(assumptions && { assumptions }),
});
const opened = { task: [] as string[], session: [] as string[] };
const view = (assumptions: Assumption[] | (() => Assumption[]), model: () => BoardModel = board) =>
  mount((): ReactElement | null =>
    MilestoneAssumptions({
      model: model(),
      milestone: milestone(typeof assumptions === 'function' ? assumptions() : assumptions),
      projectId: 'payments',
      onOpenTask: (id: string) => opened.task.push(id),
      onOpenSession: (id: string) => opened.session.push(id),
    }),
  );

const rows = (tree: unknown) =>
  find(
    tree as ReactElement,
    (n) => n.type === 'ul' && n.props['aria-label'] === zh('board.assumptions.list'),
  )
    .props.children.flat(Infinity)
    .filter((n: unknown) => !!n) as ReactElement<any>[];
const row = (tree: unknown, words: string) => rows(tree).find((n) => text(n).includes(words))!;
const named = (tree: unknown, name: string) =>
  find(
    tree as ReactElement,
    (n) => n.type === 'button' && (n.props['aria-label'] === name || text(n) === name),
  );
const has = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).some(
    (n) => n.type === 'button' && (n.props['aria-label'] === name || text(n) === name),
  );
const input = (tree: unknown) =>
  find(
    tree as ReactElement,
    (n) => n.type === 'input' && n.props['aria-label'] === zh('board.assumptions.input'),
  );
const form = (tree: unknown) => find(tree as ReactElement, (n) => n.type === 'form');
const submit = () => ({ preventDefault() {} });

/** Opens the edit on the row, types the words and sends them. */
async function refute(h: ReturnType<typeof view>, words: string, instead: string) {
  named(row(h.value, words), zh('board.assumptions.refute')).props.onClick();
  h.render();
  input(row(h.value, words)).props.onChange({ target: { value: instead } });
  h.render();
  form(row(h.value, words)).props.onSubmit(submit());
  await h.flush();
}

beforeEach(() => {
  mock.runCommand = vi.fn(async () => ({ ok: true, value: { applied: false, edit_id: 'edit-1' } }));
  mock.toast = vi.fn();
  opened.task = [];
  opened.session = [];
});
afterEach(() => unmountAll());

describe('assumptions of the selected milestone', () => {
  it('lists each assumption with the titles of the tasks resting on it, each opening its task', () => {
    const h = view(PLAN);
    expect(
      rows(h.value).map((n) => text(n).includes(PAYLOAD) || text(n).includes(SANDBOX)),
    ).toEqual([true, true]);
    const tasks = find(
      row(h.value, PAYLOAD),
      (n) => n.props['aria-label'] === zhf('board.assumptions.rests', { count: 2 }),
    );
    expect(text(tasks)).toContain('Staging smoke tests');
    expect(text(tasks)).toContain('Rollout flag wiring');
    expect(text(tasks)).not.toContain('Staging deploy config');
    find(
      tasks,
      (n) => n.type === 'button' && text(n).includes('Rollout flag wiring'),
    ).props.onClick();
    expect(opened.task).toEqual(['t-flag']);
  });

  it.each([
    ['with assumptions', PLAN, true],
    ['without assumptions', undefined, false],
  ] as const)(
    "the current milestone's flag in the goals holds the block only %s",
    (_, assumptions, drawn) => {
      const current = milestone(assumptions as Assumption[] | undefined);
      const goals = mount(() =>
        GoalsSection({
          model: {
            ...board(),
            milestones: [current],
            goals: [
              {
                id: 'g-staging',
                text: 'Refunds reach staging',
                order: 0,
                revision: 1,
                milestone_ids: [current.id],
                milestones: { done: 0, ready: 0, total: 1 },
                tasks: { done: 1, total: 4 },
                needs: 0,
              },
            ],
          } as BoardModel,
          projectId: 'payments',
          bar: null,
          current,
          onOpenNeeds: () => {},
          onOpenTasks: () => {},
          onOpenTask: () => {},
          onOpenSession: () => {},
        }),
      );
      const block = nodes(goals.value).find((n) => n.type === MilestoneAssumptions);
      expect(!!block).toBe(drawn);
      if (block) expect(mount(() => MilestoneAssumptions(block.props)).value).not.toBeNull();
    },
  );

  it('shows the first 4 of 6 assumptions and all 6 once unfolded', () => {
    const six = Array.from({ length: 6 }, (_, i) => assumption(`a${i}`, `assumption number ${i}`));
    const h = view(six);
    expect(rows(h.value)).toHaveLength(4);
    named(h.value, zhf('board.assumptions.showAll', { count: 6 })).props.onClick();
    h.render();
    expect(rows(h.value)).toHaveLength(6);
  });

  it('shows 3 of the tasks resting on an assumption and the rest behind a count', () => {
    const h = view([
      assumption('keys', 'Every refund call carries a key', {
        affects: ['t-config', 't-relay', 't-smoke', 't-flag', 't-list', 't-key'],
      }),
    ]);
    const tasks = () =>
      find(
        h.value as ReactElement,
        (n) => n.props['aria-label'] === zhf('board.assumptions.rests', { count: 6 }),
      );
    expect(text(tasks())).not.toContain('Rollout flag wiring');
    const more = find(
      tasks(),
      (n) => n.type === 'button' && text(n) === zhf('board.assumptions.more', { count: 3 }),
    );
    more.props.onClick();
    h.render();
    expect(text(tasks())).toContain('Refund idempotency');
  });
});

describe('saying an assumption is wrong', () => {
  it('sends a refute of the assumption on the lead plan version', async () => {
    const h = view(PLAN);
    await refute(h, PAYLOAD, INSTEAD);
    expect(mock.runCommand).toHaveBeenCalledWith(
      'board.plan.edit',
      {
        project_id: 'payments',
        lead_session_id: 'lead-1',
        base_version: 4,
        ops: [{ type: 'refute_assumption', assumption_id: 'payload', instead: INSTEAD }],
      },
      null,
    );
  });

  it('shows the sent words waiting for the lead before the board has them', async () => {
    const h = view(PLAN);
    await refute(h, PAYLOAD, INSTEAD);
    const r = row(h.value, PAYLOAD);
    expect(nodes(r).some((n) => n.type === 'input')).toBe(false);
    expect(text(r)).toContain(INSTEAD);
    expect(text(r)).toContain(zh('board.assumptions.pending'));
    expect(has(r, zh('board.assumptions.refute'))).toBe(false);
    expect(has(r, zhf('board.assumptions.withdrawLabel', { text: PAYLOAD }))).toBe(false);
  });

  it('sends nothing for empty words', async () => {
    const h = view(PLAN);
    await refute(h, PAYLOAD, '   ');
    expect(mock.runCommand).not.toHaveBeenCalled();
    expect(named(row(h.value, PAYLOAD), zh('board.assumptions.send')).props.disabled).toBe(true);
  });

  it('puts the row back on Esc', () => {
    const h = view(PLAN);
    named(row(h.value, PAYLOAD), zh('board.assumptions.refute')).props.onClick();
    h.render();
    input(row(h.value, PAYLOAD)).props.onKeyDown({ key: 'Escape', preventDefault() {} });
    h.render();
    expect(nodes(row(h.value, PAYLOAD)).some((n) => n.type === 'input')).toBe(false);
    expect(has(row(h.value, PAYLOAD), zh('board.assumptions.refute'))).toBe(true);
  });
});

describe('a refute the lead has not resolved', () => {
  const pending = [
    assumption('payload', PAYLOAD, {
      refuted: { edit_id: 'edit-7', instead: INSTEAD, state: 'pending' },
    }),
  ];

  it('shows the user words waiting for the lead and no refute button', () => {
    const h = view(pending);
    const r = row(h.value, PAYLOAD);
    expect(text(r)).toContain(INSTEAD);
    expect(text(r)).toContain(zh('board.assumptions.pending'));
    expect(has(r, zh('board.assumptions.refute'))).toBe(false);
  });

  it('withdraws the edit and sends the same words again from the notice Undo', async () => {
    const h = view(pending);
    named(
      row(h.value, PAYLOAD),
      zhf('board.assumptions.withdrawLabel', { text: PAYLOAD }),
    ).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'board.plan.edit.withdraw',
      { project_id: 'payments', lead_session_id: 'lead-1', edit_id: 'edit-7' },
      null,
    );
    const r = row(h.value, PAYLOAD);
    expect(text(r)).toContain(zh('board.assumptions.withdrawn'));
    expect(text(r)).not.toContain(zh('board.assumptions.pending'));
    const notice = mock.toast.mock.calls[0][0];
    expect(notice.action.label).toBe(zh('board.assumptions.undo'));
    notice.action.run();
    await h.flush();
    expect(mock.runCommand).toHaveBeenLastCalledWith(
      'board.plan.edit',
      {
        project_id: 'payments',
        lead_session_id: 'lead-1',
        base_version: 4,
        ops: [{ type: 'refute_assumption', assumption_id: 'payload', instead: INSTEAD }],
      },
      null,
    );
  });
});

describe('a refute the lead resolved', () => {
  it.each([
    ['applied', undefined, () => zh('board.assumptions.applied')],
    ['rejected', 'Live keys never touch staging', () => zh('board.assumptions.rejected')],
    ['withdrawn', undefined, () => zh('board.assumptions.withdrawn')],
  ] as const)('a refute %s says so on its row', (state, reason, words) => {
    const h = view([
      assumption('sandbox', SANDBOX, {
        refuted: {
          edit_id: 'edit-3',
          instead: 'Use the live keys with a cap',
          state,
          ...(reason && { reason }),
        },
      }),
    ]);
    const r = row(h.value, SANDBOX);
    expect(text(r)).toContain(words());
    if (reason) expect(text(r)).toContain(reason);
    expect(has(r, zh('board.assumptions.refute'))).toBe(true);
  });

  it("opens the lead's session from a refute the lead kept", () => {
    const h = view([
      assumption('sandbox', SANDBOX, {
        refuted: { edit_id: 'edit-3', instead: 'Use the live keys', state: 'rejected' },
      }),
    ]);
    named(
      row(h.value, SANDBOX),
      zhf('board.frame.lead.label', {
        name: 'Refunds v2 rollout',
        state: zh('board.leadStates.idle'),
      }),
    ).props.onClick();
    expect(opened.session).toEqual(['lead-1']);
  });
});

describe('a refute the daemon refused', () => {
  it('says on the row that the plan moved on and resends on the newest version', async () => {
    let version = 4;
    mock.runCommand = vi.fn(async () => ({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan is at version 5' },
    }));
    const h = view(PLAN, () => board(version));
    await refute(h, PAYLOAD, INSTEAD);
    version = 5;
    h.render();
    const r = row(h.value, PAYLOAD);
    const alert = find(r, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(zhf('board.assumptions.stale', { version: 5 }));
    expect(input(r).props['aria-invalid']).toBe(true);
    expect(mock.toast).not.toHaveBeenCalled();
    mock.runCommand = vi.fn(async () => ({
      ok: true,
      value: { applied: false, edit_id: 'edit-2' },
    }));
    named(r, zhf('board.plan.edit.retry', { version: 5 })).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'board.plan.edit',
      {
        project_id: 'payments',
        lead_session_id: 'lead-1',
        base_version: 5,
        ops: [{ type: 'refute_assumption', assumption_id: 'payload', instead: INSTEAD }],
      },
      null,
    );
  });

  it('says on the row that the plan no longer has the assumption and closes the edit', async () => {
    mock.runCommand = vi.fn(async () => ({
      ok: false,
      error: { code: 'not_found', message: 'Not found: assumption payload in the plan' },
    }));
    const h = view(PLAN);
    await refute(h, PAYLOAD, INSTEAD);
    const r = row(h.value, PAYLOAD);
    expect(text(find(r, (n) => n.props.role === 'alert'))).toContain(zh('board.assumptions.gone'));
    expect(nodes(r).some((n) => n.type === 'input')).toBe(false);
  });
});
