import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ApprovalQuestion, Improvement } from '@pantheon/domain';
import { find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { QuestionCard } from '../../apps/web/src/components/QuestionCard.js';
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import { useDrafts } from '../../apps/web/src/data/drafts.js';
import type { NeedItem } from '../../apps/web/src/screens/board/frame-model.js';
import type {
  BoardMilestone,
  BoardTask,
  RunBoardCommand,
  SnapshotMilestone,
  SnapshotSession,
} from '../../apps/web/src/screens/board/panels-model.js';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const approval: NeedItem = {
  source: { table: 'approvals', id: 'approval-1', revision: 4 },
  kind: 'permission',
  project_id: 'project-a',
  session_id: 'worker-1',
  status: 'pending',
  created_at: NOW - 60_000,
  reason: 'permission_requested',
  decision: 'permission',
  blocks: 0,
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: { action: 'Bash', input_summary: 'pnpm test', rule: 'Bash(pnpm test)' },
};

const question: NeedItem = {
  ...approval,
  source: { table: 'approvals', id: 'approval-2', revision: 2 },
  binding: { action: 'AskUserQuestion', input_summary: 'Which side wins?' },
  questions: [
    {
      question: 'Which side wins?',
      header: 'Sync',
      options: [
        { label: 'Server', description: 'Keep the server copy' },
        { label: 'Client', description: 'Keep the local copy' },
      ],
      multiSelect: false,
    },
  ],
};

const milestoneItem: NeedItem = {
  source: { table: 'milestones', id: 'milestone-1', revision: 3 },
  kind: 'milestone.ready_for_acceptance',
  project_id: 'project-a',
  session_id: 'lead-1',
  status: 'ready_for_acceptance',
  created_at: NOW - 30_000,
  reason: 'milestone_ready_for_acceptance',
  decision: 'milestone_accept',
  blocks: 0,
  actions: [{ command: 'milestone.accept', allowed: true }],
};

const proposalItem: NeedItem = {
  source: { table: 'improvements', id: 'improvement-1', revision: 1 },
  kind: 'improvement.candidate',
  project_id: 'project-a',
  status: 'candidate',
  created_at: NOW - 20_000,
  reason: 'improvement_awaiting_decision',
  decision: 'improvement',
  blocks: 0,
  actions: [{ command: 'improvement.decide', allowed: true }],
};

const blockedItem: NeedItem = {
  source: { table: 'sessions', id: 'worker-1', revision: 7 },
  kind: 'session.merge_blocked',
  project_id: 'project-a',
  status: 'open',
  created_at: NOW - 90_000,
  reason: 'merge_blocked',
  decision: 'other',
  blocks: 0,
  actions: [{ command: 'session.merge', allowed: true }],
  next_step: 'Resolve the conflict, then merge again',
};

const worker = {
  id: 'worker-1',
  revision: 7,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
  title: 'Serve exports',
  task: { lead_session_id: 'lead-1', id: 'exports' },
  merge: {
    state: 'blocked',
    reason: 'rebase_conflict',
    conflicts: ['src/export.ts', 'src/columns.ts'],
  },
} as unknown as SnapshotSession;

const lead = {
  id: 'lead-1',
  revision: 5,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 3,
  title: 'Plan exports',
} as unknown as SnapshotSession;

const milestoneView = {
  id: 'milestone-1',
  title: 'Search and redirects',
  session_ids: ['worker-1'],
  merged: 1,
  status: 'ready_for_acceptance',
  criteria: [{ text: 'Old links redirect', accepted: false }],
  owner_session_id: 'lead-1',
  tasks: { done: 2, total: 2 },
} as BoardMilestone;

const stored = {
  id: 'milestone-1',
  revision: 3,
  project_id: 'project-a',
  title: 'Search and redirects',
  required_sessions: ['worker-1'],
  criteria: ['Old links redirect'],
} as unknown as SnapshotMilestone;

const cells = [
  { id: 'lead-1:a', title: 'Redirect map', status: 'done', milestone_id: 'milestone-1' },
  { id: 'lead-1:b', title: 'Search index', status: 'done', milestone_id: 'milestone-1' },
] as unknown as BoardTask[];

const proposal = {
  id: 'improvement-1',
  revision: 1,
  project_id: 'project-a',
  source: 'lead',
  retrospective_ids: ['r1', 'r2', 'r3'],
  status: 'candidate',
  proposed_at: NOW - 20_000,
  change: { type: 'policy_change', param: 'max_parallel', from: 2, to: 3 },
} as unknown as Improvement;

type Props = Parameters<typeof RequestCard>[0];

function mount(props: Partial<Props> & Pick<Props, 'item'>) {
  const run = vi.fn<RunBoardCommand>(async () => null);
  const open = vi.fn();
  const h = host(() =>
    RequestCard({
      size: 'full',
      who: 'Serve exports',
      now: NOW,
      run,
      onOpenSession: open,
      ...props,
    } as Props),
  );
  return { h, run, open };
}
afterEach(unmountAll);
beforeEach(() => useDrafts.setState({ answers: {} }));

const buttons = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));
const button = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);
/** The question card a request card shows, rendered in a host of its own. */
const card = (tree: ReactNode) => host(() => QuestionCard(named(tree, 'QuestionCard').props));
const pick = (tree: ReactNode, label: string) =>
  find(
    tree,
    (n) => (n.props.role === 'radio' || n.props.role === 'checkbox') && text(n).includes(label),
  );
const send = (tree: ReactNode) => button(tree, zh('components.questionCard.send'));

describe('request card', () => {
  it('allows a permission request once or for the session, or denies it, in place', async () => {
    const { h, run } = mount({ item: approval });
    expect(buttons(h.value)).toEqual([
      zh('board.needs.actions.approve'),
      zh('board.needs.actions.approveSession'),
      zh('board.needs.actions.reject'),
    ]);
    expect(text(h.value)).toContain('pnpm test');
    for (const [label, decision] of [
      [zh('board.needs.actions.approve'), 'approve'],
      [zh('board.needs.actions.approveSession'), 'approve_session'],
      [zh('board.needs.actions.reject'), 'reject'],
    ] as const) {
      const card = mount({ item: approval });
      button(card.h.value, label).props.onClick();
      await card.h.flush();
      expect(card.run).toHaveBeenCalledWith(
        'approval.respond',
        { approval_id: 'approval-1', decision },
        4,
      );
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('offers no allow for the session without a rule to keep', () => {
    const { h } = mount({
      item: { ...approval, binding: { action: 'Bash', input_summary: 'ls' } },
    });
    expect(buttons(h.value)).toEqual([
      zh('board.needs.actions.approve'),
      zh('board.needs.actions.reject'),
    ]);
  });

  it('turns a button the backend does not allow off and says why', async () => {
    const { h, run } = mount({
      item: {
        ...approval,
        actions: [
          { command: 'approval.respond', allowed: false, disabled_reason: 'revision_conflict' },
        ],
      },
    });
    const allow = button(h.value, zh('board.needs.actions.approve'));
    expect(allow.props['aria-disabled']).toBe(true);
    const tips = nodes(h.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Tip',
    );
    expect(tips.map((t) => t.props.content)).toContain(zh('data.reason.revisionConflict'));
    allow.props.onClick();
    await h.flush();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['compact', 'full'] as const)(
    'answers a single choice in the %s card only once it is picked and sent',
    async (size) => {
      const { h, run } = mount({ item: question, size });
      const asking = card(h.value);
      expect(send(asking.value).props['aria-disabled']).toBe(true);
      pick(asking.value, 'Client').props.onClick();
      asking.render();
      await h.flush();
      expect(run).not.toHaveBeenCalled();
      send(asking.value).props.onClick();
      await h.flush();
      expect(run).toHaveBeenCalledWith(
        'approval.respond',
        {
          approval_id: 'approval-2',
          decision: 'approve',
          answers: { 'Which side wins?': 'Client' },
        },
        2,
      );
    },
  );

  it('answers with typed words in the Other row, or denies the request', async () => {
    const typed = mount({ item: question });
    const asking = card(typed.h.value);
    expect(text(asking.value)).toContain('Keep the server copy');
    pick(asking.value, 'Server').props.onClick();
    asking.render();
    find(
      asking.value,
      (n) => n.props['aria-label'] === zh('components.questionCard.otherAnswer'),
    ).props.onChange({ target: { value: 'Ask me per note' } });
    asking.render();
    send(asking.value).props.onClick();
    await typed.h.flush();
    expect(typed.run).toHaveBeenCalledWith(
      'approval.respond',
      {
        approval_id: 'approval-2',
        decision: 'approve',
        answers: { 'Which side wins?': 'Ask me per note' },
      },
      2,
    );
    const denied = mount({ item: question });
    button(card(denied.h.value).value, zh('components.questionCard.deny')).props.onClick();
    await denied.h.flush();
    expect(denied.run).toHaveBeenCalledWith(
      'approval.respond',
      { approval_id: 'approval-2', decision: 'reject' },
      2,
    );
  });

  // What the card shows of one question: the options marked recommended and its own-words field.
  const looks = (tree: ReactNode) => {
    const own = nodes(tree).find((n) => n.type === 'input' || n.type === 'textarea');
    return {
      recommended: nodes(tree)
        .filter(
          (n) =>
            n.props.role === 'radio' && text(n).includes(zh('components.questionCard.recommended')),
        )
        .map((n) => ['Server', 'Client'].find((label) => text(n).includes(label))),
      own: own ? `${own.type}:${own.props.type ?? ''}` : null,
    };
  };
  it.each<[string, Partial<ApprovalQuestion>, string[], string | null]>([
    [
      'marks the recommended option with a visible chip',
      { recommended: 'Client' },
      ['Client'],
      'input:text',
    ],
    ['marks no option for an empty recommended', { recommended: '' }, [], 'input:text'],
    ['leaves the Other row out when the question takes no own words', { other: false }, [], null],
    ['takes a secret answer in a password input', { secret: true }, [], 'input:password'],
    [
      'takes a secret answer without options in a password input',
      { secret: true, options: [] },
      [],
      'input:password',
    ],
  ])('%s', (_, patch, recommended, own) => {
    const { h } = mount({
      item: { ...question, questions: [{ ...question.questions![0]!, ...patch }] },
    });
    expect(looks(card(h.value).value)).toEqual({ recommended, own });
  });

  it('sends every answer of a relayed question card through the lead', async () => {
    const relayed: NeedItem = {
      source: { table: 'board_plans', id: 'lead-1', revision: 6 },
      kind: 'lead.question',
      project_id: 'project-a',
      session_id: 'lead-1',
      request_id: 'question-1',
      status: 'pending',
      created_at: NOW - 90_000,
      reason: 'lead_question',
      decision: 'question',
      blocks: 0,
      actions: [{ command: 'lead.question.answer', allowed: true }],
      question: {
        id: 'question-1',
        at: NOW - 90_000,
        question: 'Which side wins?',
        options: ['Server', 'Client'],
        recommended: '',
        assumption: '',
        blocks: ['exports'],
        source: { session_id: 'worker-1', approval_id: 'approval-9' },
        questions: [
          question.questions![0]!,
          {
            question: 'Which checks?',
            header: '',
            multiSelect: true,
            options: [
              { label: 'lint', description: '' },
              { label: 'test', description: '' },
            ],
          },
        ],
      },
    };
    const { h, run } = mount({ item: relayed, session: worker, lead });
    const asking = card(h.value);
    for (const label of ['Server', 'lint', 'test']) {
      pick(asking.value, label).props.onClick();
      asking.render();
    }
    send(asking.value).props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith(
      'lead.question.answer',
      {
        project_id: 'project-a',
        lead_session_id: 'lead-1',
        question_id: 'question-1',
        answer: 'Server\nlint, test',
        answers: { 'Which side wins?': 'Server', 'Which checks?': 'lint, test' },
      },
      null,
    );
  });

  it('accepts a ready milestone through the acceptance dialog, with its criteria and cells', async () => {
    const evidence = [{ ref: 'session:worker-1', label: 'Serve exports' }];
    const { h, run } = mount({
      item: milestoneItem,
      who: 'Search and redirects',
      milestone: { milestone: milestoneView, stored, cells, evidence },
    });
    expect(buttons(h.value)).toContain(zh('board.needs.actions.accept'));
    expect(buttons(h.value)).not.toContain(zh('board.needs.actions.open'));
    expect(text(h.value)).toContain('Old links redirect');
    expect(nodes(h.value).filter((n) => n.props.className === 'bms-cell')).toHaveLength(2);
    button(h.value, zh('board.needs.actions.accept')).props.onClick();
    h.render();
    const dialog = named(h.value, 'AcceptDialog');
    expect(dialog.props.stored).toBe(stored);
    expect(dialog.props.evidence).toBe(evidence);
    const accept = host(() => (dialog.type as (props: unknown) => ReactElement<any>)(dialog.props));
    accept.value.props.onSubmit();
    await accept.flush();
    expect(run).toHaveBeenCalledWith(
      'milestone.accept',
      { milestone_id: 'milestone-1', evidence_refs: ['session:worker-1'], criteria_checked: [0] },
      3,
    );
  });

  it('turns the acceptance off until the board names the milestone', () => {
    const { h } = mount({ item: milestoneItem, who: 'Search and redirects' });
    expect(button(h.value, zh('board.needs.actions.accept')).props['aria-disabled']).toBe(true);
  });

  it('confirms or rejects a proposal and shows what it changes and the retrospectives it rests on', async () => {
    const { h } = mount({ item: proposalItem, improvement: proposal });
    expect(buttons(h.value)).toEqual([
      zh('board.needs.actions.confirm'),
      zh('board.needs.actions.decline'),
    ]);
    expect(text(h.value)).toContain('并发上限从 2 改成 3');
    expect(text(h.value)).toContain('3 次复盘');
    for (const [label, decision] of [
      [zh('board.needs.actions.confirm'), 'confirm'],
      [zh('board.needs.actions.decline'), 'reject'],
    ] as const) {
      const card = mount({ item: proposalItem, improvement: proposal });
      button(card.h.value, label).props.onClick();
      await card.h.flush();
      expect(card.run).toHaveBeenCalledWith(
        'improvement.decide',
        { project_id: 'project-a', improvement_id: 'improvement-1', decision },
        null,
      );
    }
  });

  it('retries a blocked merge or hands it to the lead, with the conflicting files and next step', async () => {
    const { h, run, open } = mount({ item: blockedItem, session: worker, lead });
    expect(buttons(h.value)).toEqual([
      zh('board.needs.actions.merge'),
      zh('board.needs.actions.handoff'),
      zh('board.needs.actions.open'),
    ]);
    expect(text(h.value)).toContain('src/export.ts');
    expect(text(h.value)).toContain('src/columns.ts');
    expect(text(h.value)).toContain('Resolve the conflict, then merge again');
    button(h.value, zh('board.needs.actions.merge')).props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith('session.merge', { session_id: 'worker-1' }, 7);
    const handed = mount({ item: blockedItem, session: worker, lead });
    button(handed.h.value, zh('board.needs.actions.handoff')).props.onClick();
    await handed.h.flush();
    expect(handed.run).toHaveBeenCalledWith(
      'session.send',
      { session_id: 'lead-1', input: expect.stringContaining('src/export.ts') },
      5,
    );
    button(h.value, zh('board.needs.actions.open')).props.onClick();
    expect(open).toHaveBeenCalledWith('worker-1');
  });

  it('runs the gates of a session whose gate failed again', async () => {
    const gate: NeedItem = {
      ...blockedItem,
      kind: 'session.gate_failed',
      reason: 'gate_failed',
      actions: [],
    };
    const { h, run } = mount({ item: gate });
    expect(buttons(h.value)).toEqual([
      zh('board.needs.actions.merge'),
      zh('board.needs.actions.gates'),
      zh('board.needs.actions.open'),
    ]);
    button(h.value, zh('board.needs.actions.gates')).props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith('session.gates.run', { session_id: 'worker-1' }, 7);
  });
});
