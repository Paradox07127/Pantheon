import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionForUser } from '@pantheon/protocol';
import { KeyRound, Play, ScrollText } from '../../apps/web/node_modules/lucide-react';
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
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
  resolveTheme: () => 'light',
}));
vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
import { NeedsPopover } from '@/components/NeedsPopover';
import { ApprovedForYou } from '@/screens/trace/ApprovedForYou';
import { TellBox } from '@/screens/changes/TellBox';
import { decisionRow, newestDecision, tellDecisionDraft } from '@/data/decisions-for-user';
import { setLocaleSync } from '@/i18n';
import { zh, zhCatalog, zhf } from './i18n-setup.js';

const AT = new Date(2026, 10, 17, 14, 2).getTime();

const byRule: DecisionForUser = {
  kind: 'prompt_by_rule',
  at: AT - 60_000,
  approval_id: 'approval-rule',
  session_id: 'session-tests',
  rule: 'Bash(pnpm test:*)',
  tool: 'Bash',
  input_summary: 'pnpm test',
};
const deleted: DecisionForUser = {
  kind: 'prompt_by_rule',
  at: AT - 180_000,
  approval_id: 'approval-gone',
  rule: 'Bash(git status)',
};

let decisions: Record<string, DecisionForUser[]>;
let query: ReturnType<typeof vi.fn>;

beforeEach(() => {
  decisions = { alpha: [byRule, deleted], beta: [] };
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

it.each([
  'approval.approved',
  'approval.rejected',
  'approval.refused',
  'approval.resolved',
  'session.main_agent_decided',
  'session.deleted',
])('reads the decisions again after %s, which can add or remove a row', (kind) => {
  const event = (sequence: number, kind: string) => ({ sequence, kind }) as never;
  expect(newestDecision([event(1, 'approval.requested'), event(2, kind)])).toBe(2);
  expect(newestDecision([event(1, 'session.turn.delivery')])).toBe(0);
});

const closed: Extract<DecisionForUser, { kind: 'main_agent_action' }> = {
  kind: 'main_agent_action',
  at: AT - 240_000,
  event_id: 'event-close',
  session_id: 'session-worker',
  action: 'close',
  main_agent_session_id: 'session-lead',
  reason: 'The other try landed',
};

it.each([
  ['spawn', 'trace.approved.action.spawn'],
  ['interrupt', 'trace.approved.action.interrupt'],
  ['close', 'trace.approved.action.close'],
  ['ready', 'trace.approved.action.ready'],
] as const)(
  'says what the main agent did with %s, with its reason as it wrote it',
  (action, id) => {
    const item = { ...closed, action };
    expect(decisionRow(item)).toEqual({
      key: 'event-close',
      kind: 'main_agent_action',
      at: closed.at,
      action: zh(id),
      code: false,
      by: expect.any(String),
      rule: null,
      sessionId: 'session-worker',
      mainAgent: { sessionId: 'session-lead', answers: [], decided: 'The other try landed' },
    });
    expect(decisionRow({ ...item, reason: undefined }).mainAgent!.decided).toBeNull();
  },
);

it.each([
  ['spawn', 'Start a session', '起一个会话'],
  ['interrupt', 'Interrupt its turn', '打断它的回合'],
  ['close', 'Close the session and discard its worktree', '关掉会话并丢弃工作树'],
  ['ready', 'Land the work', '落地这份工作'],
] as const)(
  'names what the main agent decided with %s, not that it already happened',
  (action, english, chinese) => {
    const row = decisionRow({ ...closed, action });
    expect(row.action).toBe(chinese);
    expect(tellDecisionDraft(row, 'Fix login')).toBe(`关于「Fix login」的「${chinese}」：\n`);
    setLocaleSync('en', {});
    try {
      expect(decisionRow({ ...closed, action }).action).toBe(english);
    } finally {
      setLocaleSync('zh-CN', zhCatalog());
    }
  },
);

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
  const columns = (tree: unknown) =>
    nodes(table(tree))
      .filter((n) => n.props.role === 'columnheader')
      .map((n) => text(n));
  /** The cell of row under the column named name. */
  const cell = (tree: unknown, row: ReactElement, name: string) =>
    nodes(row).filter((n) => n.props.role === 'cell')[columns(tree).indexOf(name)]!;
  const icons = (node: ReactElement) =>
    nodes(node).filter((n) => n.type === ScrollText || n.type === KeyRound);

  it('reads what was decided today for the project', async () => {
    await page();
    expect(query).toHaveBeenCalledWith('project.decisions', {
      project_id: 'alpha',
      since: String(dayStart(0)),
    });
  });

  it('names the columns', async () => {
    const h = await page();
    expect(columns(h.value)).toEqual([
      zh('trace.approved.column.action'),
      zh('trace.approved.column.by'),
      zh('trace.approved.column.rule'),
      zh('trace.approved.column.task'),
      zh('trace.approved.column.when'),
    ]);
  });

  it('lists only a prompt a stored rule answered, with who decided and its rule, and links its session', async () => {
    decisions.alpha = [byRule];
    const h = await page();
    expect(rows(h.value)).toHaveLength(1);
    const row = rowOf(h.value, 'pnpm test');
    expect(text(row)).toContain(zh('trace.approved.by.rule'));
    expect(text(cell(h.value, row, zh('trace.approved.column.rule')))).toBe('Bash(pnpm test:*)');
    expect(icons(cell(h.value, row, zh('trace.approved.column.by'))).map((n) => n.type)).toEqual([
      ScrollText,
    ]);
    expect(text(link(row)!)).toBe('Refund idempotency');
    link(row)!.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-tests');
  });

  it('shows a row of a deleted session without a link', async () => {
    const h = await page();
    expect(rows(h.value)).toHaveLength(2);
    const row = rows(h.value).find(
      (r) =>
        text(cell(h.value, r, zh('trace.approved.column.action'))) === zh('trace.approved.prompt'),
    )!;
    expect(text(row)).toContain(zh('trace.approved.by.rule'));
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

  it('shows what the main agent answered with its title, each question to its answer and the reason, and tells it about the answer from the row', async () => {
    const byMain: DecisionForUser = {
      kind: 'answered_by_main_agent',
      at: AT - 120_000,
      approval_id: 'approval-main',
      session_id: 'session-worker',
      tool: 'AskUserQuestion',
      question: 'Which package manager?',
      answers: { 'Which package manager?': 'pnpm', 'Which checks?': 'lint, test' },
      decision: 'approve',
      reason: 'The workspace uses pnpm',
      main_agent_session_id: 'session-lead',
    };
    decisions.alpha = [byMain];
    const h = await page();
    const row = rowOf(h.value, 'Which package manager?');
    expect(text(cell(h.value, row, zh('trace.approved.column.by')))).toContain('Refunds rollout');
    expect(text(cell(h.value, row, zh('trace.approved.column.action')))).toBe(
      [
        zhf('trace.approved.answer', { question: 'Which package manager?', answer: 'pnpm' }),
        zhf('trace.approved.answer', { question: 'Which checks?', answer: 'lint, test' }),
        zhf('trace.approved.answered', { reason: 'The workspace uses pnpm' }),
      ].join(''),
    );
    expect(text(cell(h.value, row, zh('trace.approved.column.rule')))).toBe('');

    const tell = nodes(row).find(
      (n) => n.type === 'button' && n.props['aria-label'] === zh('trace.approved.tellMain'),
    )!;
    expect(tell.props['aria-expanded']).toBe(false);
    tell.props.onClick();
    h.render();
    const box = find(h.value, (n) => n.type === TellBox);
    expect(box.props).toMatchObject({
      session: { id: 'session-lead' },
      main: null,
      draft: zhf('trace.approved.tellDraft', { action: 'Which package manager?' }),
    });
  });

  it('shows what the main agent did to a session with its reason, opens that session from the task and tells the main agent about it from the row', async () => {
    decisions.alpha = [closed];
    const h = await page();
    const row = rowOf(h.value, zh('trace.approved.action.close'));
    const action = cell(h.value, row, zh('trace.approved.column.action'));
    expect(text(action)).toBe(`${zh('trace.approved.action.close')}The other try landed`);
    expect(nodes(action).filter((n) => n.type === Play || n.type === KeyRound)).toEqual([
      expect.objectContaining({ type: Play }),
    ]);
    expect(text(cell(h.value, row, zh('trace.approved.column.by')))).toContain('Refunds rollout');
    expect(text(cell(h.value, row, zh('trace.approved.column.rule')))).toBe('');
    const task = link(cell(h.value, row, zh('trace.approved.column.task')))!;
    expect(text(task)).toBe('Refund list page');
    task.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-worker');

    nodes(row)
      .find((n) => n.type === 'button' && n.props['aria-label'] === zh('trace.approved.tellMain'))!
      .props.onClick();
    h.render();
    expect(find(h.value, (n) => n.type === TellBox).props).toMatchObject({
      session: { id: 'session-lead' },
      draft: zhf('trace.approved.tellActionDraft', {
        action: zh('trace.approved.action.close'),
        task: 'Refund list page',
      }),
    });
  });

  it('says so when nothing was decided without the user', async () => {
    decisions.alpha = [];
    const h = await page();
    expect(text(h.value)).toContain(zh('trace.approved.empty'));
    expect(() => table(h.value)).toThrow();
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
        text(n).includes(zhf('components.needsPopover.approved', { count: 3 })),
    );

  it('counts what was approved today across the projects and opens the list', async () => {
    decisions.beta = [{ ...byRule, approval_id: 'approval-beta' }];
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
