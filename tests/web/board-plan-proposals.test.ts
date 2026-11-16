import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { deferred, find, nodes, text, unmountAll, mount } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('@/data/commands', () => ({ runCommand }));
import { PlanProposals } from '@/screens/board/PlanProposals';
import { RuntimeGlyph } from '@/components/RuntimeGlyph';
import { toastManager } from '@/components/Toast';
import { failureText } from '@/data/needs-you';
import type { PlanOp, PlanProposal } from '@/data/plan-edit';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 13, 12);

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    lane_id: 'lead-1:main',
    status: 'todo',
    state: 'todo',
    blockers: [],
    segments: [],
    depends_on: [],
    planned: {},
    ...extra,
  }) as Task;

const newTask = (id: string, title: string, extra: object = {}) =>
  ({
    type: 'add_task',
    task: { id, title, goal: '', scope: [], depends_on: [], ...extra },
  }) as unknown as PlanOp;

const OPS: PlanOp[] = [
  { type: 'remove_task', task_id: 'c' },
  newTask('c1', 'Daily query', { task_type: 'feature', depends_on: ['a'] }),
  newTask('c2', 'Report page', { depends_on: ['c1'] }),
  { type: 'set_task', task_id: 'b', patch: { priority: 'high' } },
];

const proposal = (id: string, created_at: number, extra: Partial<PlanProposal> = {}) => ({
  id,
  lead_session_id: 'lead-1',
  reason: 'The diff report failed its gate three times',
  ops: OPS,
  base_version: 7,
  created_at,
  task_ids: ['c', 'b'],
  ...extra,
});

const board = (proposals: PlanProposal[] = [proposal('p-1', NOW)]): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    tasks: [task('a'), task('b'), task('c', { depends_on: ['a'] })],
    edges: [],
    leads: [
      {
        session_id: 'lead-1',
        title: 'Refunds lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 7,
        pending_edits: [],
        pending_proposals: proposals,
      },
    ],
  }) as unknown as BoardModel;

const lead = { id: 'lead-1', project_id: 'project-a', runtime: 'claude' } as SnapshotSession;

beforeEach(() => {
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: {} });
});
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

/** Each proposal card of the board, drawn with its own state. */
function cards(model: BoardModel) {
  const list = PlanProposals({ model, projectId: 'project-a', sessions: [lead] });
  return nodes(list)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'ProposalCard')
    .map((card) => mount(() => (card.type as (p: object) => ReactElement<any>)(card.props)));
}
const card = () => cards(board())[0]!;

const button = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);
const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const rows = (tree: ReactNode) => nodes(tree).filter((n) => n.props.className === 'bd-pp-row');
const sent = () => runCommand.mock.calls.map(([type, input, revision]) => [type, input, revision]);
const RESOLVE = { project_id: 'project-a', lead_session_id: 'lead-1', proposal_id: 'p-1' };

describe('lead plan proposals on the board', () => {
  it('draws nothing without a pending proposal', () => {
    expect(PlanProposals({ model: board([]), projectId: 'project-a', sessions: [] })).toBeNull();
    const none = { ...board(), leads: [{ ...board().leads![0]!, pending_proposals: undefined }] };
    expect(PlanProposals({ model: none, projectId: 'project-a', sessions: [] })).toBeNull();
  });

  it("heads a card with the lead's runtime, its proposal and its reason side by side", () => {
    const h = card();
    const head = find(h.value, (n) => n.props.className === 'bd-pp-h');
    const [mark, title, why] = nodes(head.props.children);
    expect(mark!.type).toBe(RuntimeGlyph);
    expect(mark!.props.runtime).toBe('claude');
    expect(text(title)).toBe(zhf('board.plan.proposal.title', { lead: 'Refunds lead' }));
    expect(why!.props.className).toBe('bd-pp-why');
    expect(why!.props.title).toBe('The diff report failed its gate three times');
  });

  it('lists each op in order: removed and added tasks with their signs, others as changes', () => {
    const [removed, added, chained, other] = rows(card().value);
    expect(removed!.props['data-change']).toBe('remove');
    expect(text(removed)).toBe('−删除task c');
    expect(added!.props['data-change']).toBe('add');
    expect(text(added)).toBe('+新增Daily query功能依赖 task a');
    expect(text(chained)).toBe('+新增Report page依赖 Daily query');
    expect(other!.props['data-change']).toBeUndefined();
    expect(text(other)).toContain('task b');
    expect(find(other, (n) => n.props.className === 'bd-bn-ch')).toBeTruthy();
    expect(text(other)).toContain(zh('data.planEdit.priority.high'));
    // The signs are drawn only; the words say it to a screen reader.
    for (const row of [removed, added]) {
      expect(find(row, (n) => n.props.className === 'bd-pp-sign').props['aria-hidden']).toBe(
        'true',
      );
      expect(find(row, (n) => n.props.className === 'bd-vh')).toBeTruthy();
    }
  });

  it('accepts the proposal as the lead wrote it', async () => {
    const h = card();
    button(h.value, zh('board.plan.proposal.accept')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['board.plan.proposal.resolve', { ...RESOLVE, decision: 'accept' }, null],
    ]);
  });

  it('accepts the ops left after removing one and retitling a new task', async () => {
    const h = card();
    button(h.value, zh('board.plan.proposal.adjust')).props.onClick();
    h.render();
    labelled(h.value, zhf('board.plan.proposal.drop', { change: 'task c' })).props.onClick();
    h.render();
    labelled(
      h.value,
      zhf('board.plan.proposal.taskTitle', { title: 'Daily query' }),
    ).props.onChange({
      target: { value: '  Daily totals ' },
    });
    h.render();
    expect(rows(h.value)).toHaveLength(3);
    button(h.value, zh('board.plan.proposal.acceptEdited')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      [
        'board.plan.proposal.resolve',
        {
          ...RESOLVE,
          decision: 'accept',
          ops: [
            newTask('c1', 'Daily totals', { task_type: 'feature', depends_on: ['a'] }),
            OPS[2],
            OPS[3],
          ],
        },
        null,
      ],
    ]);
  });

  it('holds the edited accept while no op is left or a new task has no title', () => {
    const h = card();
    button(h.value, zh('board.plan.proposal.adjust')).props.onClick();
    h.render();
    labelled(
      h.value,
      zhf('board.plan.proposal.taskTitle', { title: 'Report page' }),
    ).props.onChange({ target: { value: ' ' } });
    h.render();
    expect(button(h.value, zh('board.plan.proposal.acceptEdited')).props.disabled).toBe(true);
    for (const name of ['task c', 'Daily query', 'Report page', 'task b']) {
      labelled(h.value, zhf('board.plan.proposal.drop', { change: name })).props.onClick();
      h.render();
    }
    expect(rows(h.value)).toHaveLength(0);
    expect(button(h.value, zh('board.plan.proposal.acceptEdited')).props.disabled).toBe(true);
    button(h.value, zh('board.plan.proposal.cancel')).props.onClick();
    h.render();
    expect(rows(h.value)).toHaveLength(4);
    expect(button(h.value, zh('board.plan.proposal.accept')).props.disabled).toBe(false);
  });

  it('rejects with the reason typed, sent by Enter', async () => {
    const h = card();
    button(h.value, zh('board.plan.proposal.reject')).props.onClick();
    h.render();
    labelled(h.value, zh('board.plan.proposal.rejectReason')).props.onChange({
      target: { value: ' Keep it one task ' },
    });
    h.render();
    labelled(h.value, zh('board.plan.proposal.rejectReason')).props.onKeyDown({
      key: 'Enter',
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    await h.flush();
    expect(sent()).toEqual([
      [
        'board.plan.proposal.resolve',
        { ...RESOLVE, decision: 'reject', reason: 'Keep it one task' },
        null,
      ],
    ]);
  });

  it('rejects without a reason from the button, and Escape goes back without sending', async () => {
    const h = card();
    button(h.value, zh('board.plan.proposal.reject')).props.onClick();
    h.render();
    labelled(h.value, zh('board.plan.proposal.rejectReason')).props.onKeyDown({
      key: 'Escape',
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    h.render();
    expect(
      nodes(h.value).some((n) => n.props['aria-label'] === zh('board.plan.proposal.rejectReason')),
    ).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    button(h.value, zh('board.plan.proposal.reject')).props.onClick();
    h.render();
    button(h.value, zh('board.plan.proposal.reject')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['board.plan.proposal.resolve', { ...RESOLVE, decision: 'reject' }, null],
    ]);
  });

  it('leaves Enter and Escape to an open input method composition in the reason', async () => {
    const h = card();
    button(h.value, zh('board.plan.proposal.reject')).props.onClick();
    h.render();
    labelled(h.value, zh('board.plan.proposal.rejectReason')).props.onChange({
      target: { value: '拆成' },
    });
    h.render();
    const composing = { nativeEvent: { isComposing: true }, preventDefault: vi.fn() };
    labelled(h.value, zh('board.plan.proposal.rejectReason')).props.onKeyDown({
      ...composing,
      key: 'Enter',
    });
    labelled(h.value, zh('board.plan.proposal.rejectReason')).props.onKeyDown({
      ...composing,
      key: 'Escape',
    });
    await h.flush();
    expect(runCommand).not.toHaveBeenCalled();
    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(labelled(h.value, zh('board.plan.proposal.rejectReason')).props.value).toBe('拆成');
  });

  it('holds all three buttons while the decision is in flight', async () => {
    const answer = deferred<unknown>();
    runCommand.mockReturnValue(answer.promise);
    const h = card();
    button(h.value, zh('board.plan.proposal.accept')).props.onClick();
    h.render();
    for (const label of [
      zh('board.plan.proposal.accept'),
      zh('board.plan.proposal.adjust'),
      zh('board.plan.proposal.reject'),
    ])
      expect(button(h.value, label).props.disabled).toBe(true);
    button(h.value, zh('board.plan.proposal.accept')).props.onClick();
    expect(runCommand).toHaveBeenCalledTimes(1);
    answer.resolve({ ok: false, error: { code: 'internal', message: 'boom' } });
    await h.flush();
    expect(button(h.value, zh('board.plan.proposal.accept')).props.disabled).toBe(false);
  });

  it('shows a failure in the card and keeps the edits made before it', async () => {
    const add = vi.spyOn(toastManager, 'add');
    const error = { code: 'revision_conflict', message: 'plan moved' };
    runCommand.mockResolvedValue({ ok: false, error });
    const h = card();
    button(h.value, zh('board.plan.proposal.adjust')).props.onClick();
    h.render();
    labelled(h.value, zhf('board.plan.proposal.drop', { change: 'task b' })).props.onClick();
    h.render();
    labelled(
      h.value,
      zhf('board.plan.proposal.taskTitle', { title: 'Report page' }),
    ).props.onChange({
      target: { value: 'Report view' },
    });
    h.render();
    button(h.value, zh('board.plan.proposal.acceptEdited')).props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(failureText(error));
    expect(rows(h.value)).toHaveLength(3);
    expect(
      labelled(h.value, zhf('board.plan.proposal.taskTitle', { title: 'Report page' })).props.value,
    ).toBe('Report view');
    expect(button(h.value, zh('board.plan.proposal.acceptEdited')).props.disabled).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('folds an added task and unfolds its whole contract', () => {
    const full = newTask('c3', 'Export job', {
      goal: 'Export the refunds nightly',
      scope: ['src/export', 'docs/export.md'],
      acceptance: ['pnpm test export', 'pnpm lint'],
      iteration: 'it-7',
      estimate: 3,
      workflow_id: 'careful',
      device: 'mac-mini',
      device_reason: 'Has the signing key',
      needs: ['gpu', 'signing'],
      uses: { 'license-seat': 2 },
      parallel: [
        { title: 'Writer', goal: 'Write the file', scope: ['src/w'], acceptance: ['t w'] },
        { title: 'Uploader', goal: 'Upload it', scope: ['src/u'], acceptance: ['t u'] },
      ],
    });
    const model = {
      ...board([proposal('p-1', NOW, { ops: [full] })]),
      iterations: [{ id: 'lead-1:it-7', title: 'Iteration 7', starts_on: '', ends_on: '' }],
    } as unknown as BoardModel;
    const h = cards(model)[0]!;
    const toggle = labelled(h.value, zhf('board.plan.proposal.contract', { title: 'Export job' }));
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(nodes(h.value).some((n) => n.type === 'dl')).toBe(false);
    toggle.props.onClick();
    h.render();
    expect(
      labelled(h.value, zhf('board.plan.proposal.contract', { title: 'Export job' })).props[
        'aria-expanded'
      ],
    ).toBe(true);
    const contract = find(h.value, (n) => n.type === 'dl');
    const fields = nodes(contract)
      .filter((n) => n.type === 'dt')
      .map((dt) => text(dt));
    const values = nodes(contract)
      .filter((n) => n.type === 'dd')
      .map((dd) => text(dd));
    const of = (field: string) => values[fields.indexOf(field)];
    expect(of(zh('data.planEdit.field.goal'))).toBe('Export the refunds nightly');
    expect(of(zh('data.planEdit.field.scope'))).toBe('src/exportdocs/export.md');
    expect(of(zh('data.planEdit.field.acceptance'))).toBe('pnpm test exportpnpm lint');
    expect(of(zh('data.planEdit.field.workflow'))).toBe('careful');
    expect(of(zh('data.planEdit.field.iteration'))).toBe('Iteration 7');
    expect(of(zh('data.planEdit.field.estimate'))).toBe('3 点');
    expect(of(zh('data.planEdit.field.device'))).toBe('mac-miniHas the signing key');
    expect(of(zh('data.planEdit.field.needs'))).toBe('gpusigning');
    expect(of(zh('data.planEdit.field.uses'))).toBe('license-seat × 2');
    expect(of(zh('data.planEdit.field.parts'))).toBe('Writer：Write the fileUploader：Upload it');
    // Folded, the row stays the line it was.
    expect(rows(h.value)).toHaveLength(1);
  });

  it('describes a milestone and an iteration change', () => {
    const ops: PlanOp[] = [
      { type: 'set_milestone', milestone_id: 'm1', patch: { title: 'Launch', due_on: null } },
      {
        type: 'set_iterations',
        iterations: [
          { id: 'it-8', title: 'Iteration 8', starts_on: '2026-11-23', ends_on: '2026-12-04' },
        ],
      },
    ];
    const [milestone, iterations] = rows(cards(board([proposal('p-1', NOW, { ops })]))[0]!.value);
    const changes = (row: ReactElement<any> | undefined) =>
      nodes(find(row, (n) => n.props.className === 'bd-bn-ch').props.children).filter(
        (n) => n.props.className === 'bd-diff',
      );
    expect(changes(milestone).map(text)).toEqual(['标题：Launch', '截止日期：无']);
    expect(changes(iterations).map(text)).toEqual([
      '迭代：无改为Iteration 8 2026-11-23 – 2026-12-04',
    ]);
  });

  it('orders the cards by when each proposal was made', () => {
    const titles = cards(
      board([
        proposal('p-late', NOW, { reason: 'later' }),
        proposal('p-early', NOW - 60_000, { reason: 'earlier' }),
      ]),
    ).map((h) => find(h.value, (n) => n.props.className === 'bd-pp-why').props.title);
    expect(titles).toEqual(['earlier', 'later']);
  });
});
