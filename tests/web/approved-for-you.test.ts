import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionForUser } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
  resolveTheme: () => 'light',
}));
vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
import { runCommand } from '@/data/commands';
import { NeedsPopover } from '@/components/NeedsPopover';
import { ApprovedForYou } from '@/screens/trace/ApprovedForYou';
import { zh, zhf } from './i18n-setup.js';

const AT = new Date(2026, 10, 17, 14, 2).getTime();

const byLead: DecisionForUser = {
  kind: 'prompt_approved',
  at: AT,
  approval_id: 'approval-lead',
  session_id: 'session-worker',
  decided_by: 'session:session-lead',
  tool: 'Bash',
  input_summary: 'git push origin refund-list',
};
const byRule: DecisionForUser = {
  kind: 'prompt_by_rule',
  at: AT - 60_000,
  approval_id: 'approval-rule',
  session_id: 'session-tests',
  rule: 'Bash(pnpm test:*)',
  tool: 'Bash',
  input_summary: 'pnpm test',
};
const power: DecisionForUser = {
  kind: 'power_used',
  at: AT - 120_000,
  power: 'plan_change',
  subject: 'plan-7',
  session_id: 'session-lead',
};
const deleted: DecisionForUser = {
  kind: 'prompt_approved',
  at: AT - 180_000,
  approval_id: 'approval-gone',
  decided_by: 'session:session-lead',
};
const answered: DecisionForUser = {
  kind: 'question_answered',
  at: AT - 240_000,
  lead_session_id: 'session-lead',
  question_id: 'question-timezone',
  session_id: 'session-worker',
  question: 'Which timezone closes a reconciliation day?',
  answer: 'UTC',
  citations: [{ kind: 'user_words', ref: 'close days the way the ledger does' }],
};
const overruled: DecisionForUser = {
  kind: 'question_answered',
  at: AT - 300_000,
  lead_session_id: 'session-lead',
  question_id: 'question-names',
  session_id: 'session-tests',
  question: 'Keep the old refund status names in the API?',
  answer: 'Yes, add the new ones alongside',
  citations: [{ kind: 'assumption', ref: 'The public API stays compatible' }],
  overruled: { answer: 'Rename them now', at: AT - 200_000 },
};

let decisions: Record<string, DecisionForUser[]>;
let query: ReturnType<typeof vi.fn>;

beforeEach(() => {
  decisions = { alpha: [byLead, byRule, power, deleted], beta: [] };
  query = vi.fn(async (_method: string, params: { project_id: string }) => ({
    ok: true,
    value: { items: decisions[params.project_id] ?? [] },
  }));
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  mock.board = {
    board: {
      cursor: 1,
      projects: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
      sessions: [
        { id: 'session-worker', project_id: 'alpha', title: 'Refund list page' },
        { id: 'session-tests', project_id: 'alpha', title: 'Refund idempotency' },
        { id: 'session-lead', project_id: 'alpha', title: 'Refunds rollout' },
      ],
      session_turns: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = {
    openSession: vi.fn(),
    openProjectSession: vi.fn(),
    openProject: vi.fn(),
    openProjectApproved: vi.fn(),
  };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const dayStart = (daysBack: number) => {
  const day = new Date();
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysBack).getTime();
};

describe('approved for you', () => {
  const page = async () => {
    const h = mount(() => ApprovedForYou({ projectId: 'alpha', tabs: null }));
    await h.flush();
    return h;
  };
  const table = (tree: unknown) =>
    find(
      tree as ReactElement,
      (n) => n.props.role === 'table' && n.props['aria-label'] === zh('trace.approved.label'),
    );
  const rows = (tree: unknown) =>
    nodes(table(tree)).filter(
      (n) => n.props.role === 'row' && !nodes(n).some((c) => c.props.role === 'columnheader'),
    );
  const rowOf = (tree: unknown, words: string) => rows(tree).find((r) => text(r).includes(words))!;
  const link = (row: ReactElement) => nodes(row).find((n) => n.type === 'button');

  it('reads what was decided today for the project', async () => {
    await page();
    expect(query).toHaveBeenCalledWith('project.decisions', {
      project_id: 'alpha',
      since: String(dayStart(0)),
    });
  });

  it.each([
    [
      'a worker prompt the lead approved',
      'git push origin refund-list',
      [zh('trace.approved.by.lead')],
      'Refund list page',
      'session-worker',
    ],
    [
      'a prompt a stored rule answered',
      'pnpm test',
      [zh('trace.approved.by.rule'), 'Bash(pnpm test:*)'],
      'Refund idempotency',
      'session-tests',
    ],
    [
      'a power the lead used on its own',
      zh('trace.approved.power.planChange'),
      [zh('trace.approved.by.lead'), 'plan-7'],
      'Refunds rollout',
      'session-lead',
    ],
  ])('lists %s with who decided and links its session', async (_name, action, words, task, id) => {
    const h = await page();
    const row = rowOf(h.value, action);
    for (const word of words) expect(text(row)).toContain(word);
    expect(text(link(row)!)).toBe(task);
    link(row)!.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith(id);
  });

  it('shows a row of a deleted session without a link', async () => {
    const h = await page();
    expect(rows(h.value)).toHaveLength(4);
    const row = rowOf(h.value, zh('trace.approved.prompt'));
    expect(text(row)).toContain(zh('trace.approved.by.lead'));
    expect(link(row)).toBeUndefined();
  });

  it('reads the last 7 days once 7 days is picked', async () => {
    const h = await page();
    const range = find(
      h.value,
      (n) => n.props.role !== 'radio' && n.props['aria-label'] === zh('trace.approved.range'),
    );
    expect(range.props.value).toBe('today');
    range.props.onValueChange('week');
    h.render();
    await h.flush();
    expect(query).toHaveBeenLastCalledWith('project.decisions', {
      project_id: 'alpha',
      since: String(dayStart(6)),
    });
  });

  describe('the type filter', () => {
    const milestone: DecisionForUser = {
      kind: 'power_used',
      at: AT - 360_000,
      power: 'accept_milestone',
      subject: 'milestone-2',
      session_id: 'session-lead',
    };
    const filter = (tree: unknown) =>
      find(
        tree as ReactElement,
        (n) => n.props.role !== 'radio' && n.props['aria-label'] === zh('trace.approved.type'),
      );
    const segments = (tree: unknown) =>
      nodes(filter(tree).props.children).filter((n) => n.props.value !== undefined);
    const pick = (h: Awaited<ReturnType<typeof page>>, type: string) => {
      filter(h.value).props.onValueChange(type);
      h.render();
    };
    const actions = (tree: unknown) =>
      rows(tree).map((r) => text(nodes(r).find((n) => n.props.role === 'cell')!));

    beforeEach(() => {
      decisions.alpha = [byLead, byRule, power, deleted, answered, milestone];
    });

    it('names each type with its count in the range read', async () => {
      const h = await page();
      expect(segments(h.value).map((s) => s.props['aria-label'])).toEqual([
        zhf('trace.approved.type.count', { type: zh('trace.approved.type.all'), count: 6 }),
        zhf('trace.approved.type.count', { type: zh('trace.approved.type.permission'), count: 3 }),
        zhf('trace.approved.type.count', { type: zh('trace.approved.type.answer'), count: 1 }),
        zhf('trace.approved.type.count', { type: zh('trace.approved.type.planChange'), count: 1 }),
      ]);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('is the same arrow-key radio group as the time range', async () => {
      const h = await page();
      const range = find(
        h.value,
        (n) => n.props.role !== 'radio' && n.props['aria-label'] === zh('trace.approved.range'),
      );
      expect(filter(h.value).type).toBe(range.type);
      expect(segments(h.value).map((s) => s.type)).toEqual(
        Array(4).fill(segments(h.value)[0]!.type),
      );
      expect(filter(h.value).props.value).toBe('all');
    });

    it('shows its segments without counts while the rows load', async () => {
      query.mockImplementation(() => new Promise(() => {}));
      const h = mount(() => ApprovedForYou({ projectId: 'never-read', tabs: null }));
      await h.flush();
      expect(filter(h.value).props['aria-busy']).toBe(true);
      expect(segments(h.value).map((s) => [s.props['aria-label'], text(s)])).toEqual(
        ['all', 'permission', 'answer', 'planChange'].map((k) => [
          zh(`trace.approved.type.${k}`),
          zh(`trace.approved.type.${k}`),
        ]),
      );
    });

    it.each([
      [
        'permissions',
        'permission',
        3,
        ['git push origin refund-list', 'pnpm test', zh('trace.approved.prompt')],
      ],
      ['answers', 'answer', 1, [answered.question]],
      ['plan changes', 'plan_change', 1, [zh('trace.approved.power.planChange')]],
      [
        'all, with a power that has no type of its own',
        'all',
        6,
        [zh('trace.approved.power.acceptMilestone'), answered.question, 'pnpm test'],
      ],
    ])('narrows the table to %s', async (_name, type, count, words) => {
      const h = await page();
      pick(h, type);
      const shown = actions(h.value);
      expect(shown).toHaveLength(count);
      for (const word of words) expect(shown.some((a) => a.includes(word))).toBe(true);
    });

    it('keeps a type with no rows selectable and shows the empty state', async () => {
      decisions.alpha = [byLead];
      const h = await page();
      expect(segments(h.value)[2]!.props['aria-label']).toBe(
        zhf('trace.approved.type.count', { type: zh('trace.approved.type.answer'), count: 0 }),
      );
      expect(filter(h.value).props.disabled).toBe(false);
      pick(h, 'answer');
      expect(text(h.value)).toContain(zh('trace.approved.empty'));
      expect(() => table(h.value)).toThrow();
    });

    it('keeps the picked type when the range changes', async () => {
      const h = await page();
      pick(h, 'answer');
      find(
        h.value,
        (n) => n.props.role !== 'radio' && n.props['aria-label'] === zh('trace.approved.range'),
      ).props.onValueChange('week');
      h.render();
      await h.flush();
      expect(filter(h.value).props.value).toBe('answer');
      expect(actions(h.value)).toEqual([expect.stringContaining(answered.question)]);
    });
  });

  it('says so when nothing was decided without the user', async () => {
    decisions.alpha = [];
    const h = await page();
    expect(text(h.value)).toContain(zh('trace.approved.empty'));
    expect(() => table(h.value)).toThrow();
  });

  describe('a task session question the lead answered', () => {
    const overruleRoot = (row: ReactElement) => nodes(row).find((n) => !!n.props.onOpenChange);
    const dialog = (tree: unknown) =>
      find(
        tree as ReactElement,
        (n) => n.props['aria-label'] === zh('trace.approved.overrule.label'),
      );
    const button = (tree: ReactElement, name: string) =>
      find(tree, (n) => n.type === 'button' && text(n) === name);
    /** Opens the overrule dialog of the lead's answer, types answer into it and sends it. */
    const overrule = async (answer: string) => {
      decisions.alpha = [answered];
      const h = await page();
      overruleRoot(rowOf(h.value, answered.question))!.props.onOpenChange(true);
      h.render();
      find(dialog(h.value), (n) => n.type === 'textarea').props.onChange({
        target: { value: answer },
      });
      h.render();
      button(dialog(h.value), zh('trace.approved.overrule.send')).props.onClick();
      await h.flush();
      return h;
    };

    it('lists the question with the lead answer and what it cited', async () => {
      decisions.alpha = [answered];
      const h = await page();
      const row = rowOf(h.value, answered.question);
      for (const word of [
        'UTC',
        'close days the way the ledger does',
        zh('trace.approved.by.lead'),
        zh('trace.approved.overrule'),
      ])
        expect(text(row)).toContain(word);
      expect(text(link(row)!)).toBe('Refund list page');
    });

    it('sends the typed answer to overrule the lead', async () => {
      await overrule("Use the merchant's timezone");
      expect(runCommand).toHaveBeenCalledWith(
        'lead.question.overrule',
        {
          project_id: 'alpha',
          lead_session_id: 'session-lead',
          question_id: 'question-timezone',
          answer: "Use the merchant's timezone",
        },
        null,
      );
    });

    it('shows in the dialog why an overrule failed', async () => {
      vi.mocked(runCommand).mockResolvedValueOnce({
        ok: false,
        error: { code: 'invalid_state', message: 'The answer was already overruled' },
      });
      const h = await overrule('Rename them now');
      const alert = find(dialog(h.value), (n) => n.props.role === 'alert');
      expect(text(alert)).toContain('The answer was already overruled');
    });

    it('shows the user answer of an overruled one, without an overrule action', async () => {
      decisions.alpha = [overruled];
      const h = await page();
      const row = rowOf(h.value, overruled.question);
      expect(text(row)).toContain('Rename them now');
      expect(text(row)).toContain(zh('trace.approved.overruled'));
      expect(overruleRoot(row)).toBeUndefined();
    });
  });

  it('opens the delivery rules beside the list from the notifications button', async () => {
    const h = await page();
    const button = find(
      h.value,
      (n) => n.type === 'button' && n.props['aria-pressed'] !== undefined,
    );
    expect(button.props['aria-pressed']).toBe(false);
    button.props.onClick();
    h.render();
    expect(find(h.value, (n) => n.type === 'aside').props['aria-label']).toBe(
      zh('trace.approved.notifications'),
    );
  });
});

describe('the needs-you footer', () => {
  const trigger = createElement('button', { type: 'button' }, 'count');
  const open = async () => {
    const h = mount(() => NeedsPopover({ items: [], trigger }));
    find(h.value, (n) => !!n.props.onOpenChange).props.onOpenChange(true);
    h.render();
    await h.flush();
    return h;
  };
  const footer = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) =>
        n.type === 'button' &&
        text(n).includes(zhf('components.needsPopover.approved', { count: 5 })),
    );

  it('counts what was approved today across the projects and opens the list', async () => {
    decisions.beta = [byLead];
    const h = await open();
    expect(query).toHaveBeenCalledWith('project.decisions', {
      project_id: 'beta',
      since: String(dayStart(0)),
    });
    footer(h.value)!.props.onClick();
    expect(mock.shell.openProjectApproved).toHaveBeenCalledWith('alpha');
    h.render();
    expect(find(h.value, (n) => !!n.props.onOpenChange).props.open).toBe(false);
  });

  it('has no footer when nothing was approved today', async () => {
    decisions = { alpha: [], beta: [] };
    const h = await open();
    expect(query).toHaveBeenCalledTimes(2);
    expect(text(h.value)).toBe(zh('components.needsPopover.empty'));
    expect(nodes(h.value).filter((n) => n.type === 'button')).toEqual([]);
  });
});
