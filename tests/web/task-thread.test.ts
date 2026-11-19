import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskThreadEntry } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { useTaskThread } from '@/data/task-thread';
import { TaskThread } from '@/screens/board/TaskThread';

type Task = BoardModel['tasks'][number];
type Tree = ReturnType<typeof nodes>[number];

const NOW = new Date(2026, 10, 1, 15, 0).getTime();
const AT = new Date(2026, 10, 1, 14, 5).getTime();
const noop = () => {};

const task = (id: string): Task => ({
  id,
  title: 'reconcile report',
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'running',
  blockers: [],
  segments: [
    {
      id: 'worker-1',
      session_id: 'worker-1',
      title: 'worker one',
      runtime: 'codex',
      model: 'gpt-codex',
      status: 'running',
      started_at: null,
      ended_at: null,
      tokens: 0,
    },
  ],
  additions: 3,
  deletions: 1,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
});

const merge: BoardModel['merges'][number] = {
  session_id: 'worker-1',
  title: 'worker one',
  merged_at: AT + 11,
  from_sha: '0123456789abcdef',
  sha: 'fedcba9876543210',
  additions: 184,
  deletions: 22,
  story_id: 'story-1',
};

const model = (tasks: Task[]): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [merge],
    milestones: [],
    tasks,
    needs: [
      {
        kind: 'lead.question',
        source: { table: 'board_plans', id: 'plan-1', revision: 1 },
        question: { id: 'q-open', question: 'Should a partial refund be its own endpoint?' },
      },
    ],
  }) as unknown as BoardModel;

const entry = (i: number, patch: Partial<TaskThreadEntry>): TaskThreadEntry =>
  ({ event_id: `event-${i}`, at: AT + i, text: '', ...patch }) as TaskThreadEntry;

const THREAD: TaskThreadEntry[] = [
  entry(0, { kind: 'dispatched', session_id: 'worker-1' }),
  entry(1, { kind: 'lead_message', session_id: 'worker-1', text: 'Build the daily diff.' }),
  entry(2, {
    kind: 'gate',
    session_id: 'worker-1',
    text: 'unit tests, typecheck',
    passed: false,
    commands: [
      { name: 'unit tests', passed: false },
      { name: 'lint', passed: true },
      { name: 'typecheck', passed: false },
    ],
  }),
  entry(3, { kind: 'report', session_id: 'worker-1', text: 'Diff query done.' }),
  entry(4, {
    kind: 'finding',
    session_id: 'worker-1',
    reviewer_session_id: 'reviewer-1',
    text: 'reconcile/diff.ts:88: Totals are summed as floats',
    location: 'reconcile/diff.ts:88',
    impact: 'Totals are summed as floats',
    blocking: true,
  }),
  entry(5, {
    kind: 'finding',
    session_id: 'worker-1',
    text: 'reconcile/report.ts:14: The header order differs',
    location: 'reconcile/report.ts:14',
    impact: 'The header order differs',
    blocking: false,
  }),
  entry(6, { kind: 'handed_back', session_id: 'worker-1', text: 'Fix the float sum.' }),
  entry(7, {
    kind: 'question',
    session_id: 'worker-1',
    question_id: 'q-done',
    text: 'Minor units or decimals?',
  }),
  entry(8, {
    kind: 'answer',
    session_id: 'worker-1',
    question_id: 'q-done',
    text: 'Minor units.',
    answered_by: 'lead',
    overruled: false,
  }),
  entry(9, {
    kind: 'question',
    session_id: 'worker-1',
    question_id: 'q-open',
    text: 'Should a partial refund be its own endpoint?',
  }),
  entry(10, { kind: 'question', question_id: 'q-lead', text: 'Which ledger is the truth?' }),
  entry(11, { kind: 'note', note_kind: 'runtime_unavailable', text: 'Moved the task to Codex.' }),
  entry(12, { kind: 'merged', session_id: 'worker-1' }),
  entry(13, {
    kind: 'gate',
    session_id: 'worker-1',
    passed: true,
    commands: [{ name: 'unit tests', passed: true }],
  }),
  entry(14, { kind: 'merge_blocked', session_id: 'worker-1', text: 'out_of_scope' }),
  entry(15, {
    kind: 'tracker_message',
    session_id: 'worker-1',
    text: 'Move the change back into reconcile/.',
  }),
];

let query: ReturnType<typeof vi.fn>;
let answer: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

const snapshot = (events: unknown[] = []) =>
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [],
      sessions: [
        { id: 'lead-1', project_id: 'project-a', title: 'lead' },
        { id: 'reviewer-1', project_id: 'project-a', title: 'reviewer' },
      ],
      session_turns: [],
      workspaces: [],
    } as never,
    events: events as never,
  });

beforeEach(() => {
  answer = { ok: true, value: THREAD };
  query = vi.fn(async () => answer);
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', { ...listeners, pantheon: { query } });
  snapshot();
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useBoard.setState({ board: null, events: [] });
});

const show = async (id: string, onOpenSession: (id: string) => void = noop) => {
  const host = mount(() =>
    TaskThread({ model: model([task(id)]), task: task(id), onOpenSession, onOpenStory: noop }),
  );
  return host.flush();
};
const rows = (tree: Tree) => nodes(tree).filter((n) => n.type === 'li' && n.props['data-kind']);
const row = (tree: Tree, eventId: string) =>
  rows(tree).find((n) => n.key === eventId) ?? find(tree, () => false);
const buttons = (tree: Tree) => nodes(tree).filter((n) => n.type === 'button');
const openLabel = (title: string) => zhf('board.task.thread.openSession', { title });

describe('the thread of a task in its drawer', () => {
  it('reads the thread of the plan task and lists it in event order in the region Thread', async () => {
    const tree = await show('lead-1:t-order');
    expect(query).toHaveBeenCalledWith('task.thread', {
      project_id: 'project-a',
      lead_session_id: 'lead-1',
      task_id: 't-order',
    });
    const section = find(tree, (n) => n.type === 'section');
    const heading = find(tree, (n) => n.type === 'h3');
    expect(section.props['aria-labelledby']).toBe(heading.props.id);
    expect(text(heading)).toBe(zh('board.task.thread.heading'));
    const list = find(tree, (n) => n.type === 'ol');
    expect(list.props['aria-label']).toBe(
      zhf('board.task.thread.list', { title: 'reconcile report' }),
    );
    expect(rows(tree).map((n) => n.key)).toEqual(THREAD.map((e) => e.event_id));
  });

  it.each([
    ['event-0', zh('board.task.trace.dispatched')],
    ['event-1', zh('board.task.trace.leadMessage')],
    ['event-2', zh('board.task.trace.gateFailed')],
    ['event-3', zh('board.task.trace.report')],
    ['event-4', zh('board.task.thread.finding')],
    ['event-6', zh('board.task.trace.handback')],
    ['event-7', zh('board.task.thread.question')],
    ['event-8', zh('board.task.thread.answer')],
    ['event-11', zh('board.task.thread.note')],
    ['event-12', zh('board.task.trace.merged')],
    ['event-13', zh('board.task.trace.gatePassed')],
    ['event-14', zh('board.task.trace.mergeBlocked')],
    ['event-15', zh('board.task.thread.trackerMessage')],
  ])('names the entry %s "%s"', async (eventId, label) => {
    const tree = await show('lead-1:t-names');
    expect(text(row(tree, eventId))).toContain(label);
  });

  it('opens the session each entry came from: the lead, the reviewer, the worker', async () => {
    const open = vi.fn();
    const tree = await show('lead-1:t-open', open);
    const sessionButton = (eventId: string) =>
      buttons(row(tree, eventId)).find((n) => String(n.props['aria-label']).length > 0)!;
    expect(sessionButton('event-1').props['aria-label']).toBe(openLabel('lead'));
    expect(sessionButton('event-4').props['aria-label']).toBe(openLabel('reviewer'));
    expect(sessionButton('event-3').props['aria-label']).toBe(openLabel('worker one'));
    sessionButton('event-1').props.onClick();
    sessionButton('event-4').props.onClick();
    sessionButton('event-3').props.onClick();
    expect(open.mock.calls).toEqual([['lead-1'], ['reviewer-1'], ['worker-1']]);
    const note = row(tree, 'event-11');
    expect(buttons(note)).toEqual([]);
    expect(text(note)).toContain(zh('board.task.thread.pantheon'));
  });

  it('marks the blocking finding only, with its location and impact', async () => {
    const tree = await show('lead-1:t-finding');
    const blocking = row(tree, 'event-4');
    expect(text(blocking)).toContain('reconcile/diff.ts:88');
    expect(text(blocking)).toContain('Totals are summed as floats');
    expect(text(blocking)).toContain(zh('board.task.thread.blocking'));
    expect(text(row(tree, 'event-5'))).not.toContain(zh('board.task.thread.blocking'));
  });

  it('says why a merge was blocked and what Pantheon sent the session to fix it', async () => {
    const tree = await show('lead-1:t-blocked');
    expect(text(row(tree, 'event-14'))).toContain(zh('data.reason.outOfScope'));
    expect(text(row(tree, 'event-15'))).toContain('Move the change back into reconcile/.');
    expect(buttons(row(tree, 'event-15')).map((n) => n.props['aria-label'])).toEqual([
      openLabel('worker one'),
    ]);
  });

  it('lists the failed commands of a failed gate, and none of a passed one', async () => {
    const tree = await show('lead-1:t-gate');
    const failedList = (n: Tree) =>
      nodes(n).filter((x) => x.props['aria-label'] === zh('board.task.thread.failedCommands'));
    const [list] = failedList(row(tree, 'event-2'));
    expect(
      nodes(list)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual(['unit tests', 'typecheck']);
    expect(failedList(row(tree, 'event-13'))).toEqual([]);
  });

  it("gives the merged entry the board's commit range and changed lines", async () => {
    const tree = await show('lead-1:t-merged');
    const merged = row(tree, 'event-12');
    expect(text(merged)).toContain('0123456..fedcba9');
    expect(text(merged)).toContain('+184');
    expect(text(merged)).toContain('−22');
  });

  it('shows a merged entry without a board merge with no range or counts', async () => {
    answer = { ok: true, value: [entry(0, { kind: 'merged', session_id: 'other-1' })] };
    const tree = await show('lead-1:t-merged-bare');
    const merged = row(tree, 'event-0');
    expect(text(merged)).toBe(
      text(find(merged, (n) => n.type === 'time')) + zh('board.task.trace.merged') + 'other-1',
    );
  });

  it('says an open question waits for you without a button of its own', async () => {
    const tree = await show('lead-1:t-question');
    const open = row(tree, 'event-9');
    expect(text(open)).toContain(zh('board.task.thread.waits'));
    expect(buttons(open).map((n) => n.props['aria-label'])).toEqual([openLabel('worker one')]);
    expect(text(row(tree, 'event-7'))).not.toContain(zh('board.task.thread.waits'));
    expect(text(row(tree, 'event-7'))).not.toContain(zh('board.task.thread.notAnswered'));
    const lead = row(tree, 'event-10');
    expect(text(lead)).not.toContain(zh('board.task.thread.waits'));
    expect(text(lead)).toContain(zh('board.task.thread.notAnswered'));
  });

  it('jumps from the blocking count in the head to the first blocking finding', async () => {
    const focus = vi.fn();
    const getElementById = vi.fn(() => ({ focus }));
    vi.stubGlobal('document', { getElementById });
    const tree = await show('lead-1:t-jump');
    const jump = find(
      tree,
      (n) => n.props['aria-label'] === zhf('board.task.thread.blockingJump', { count: 1 }),
    );
    expect(text(jump)).toBe(zhf('board.task.thread.blockingCount', { count: 1 }));
    jump.props.onClick();
    expect(getElementById).toHaveBeenCalledWith(row(tree, 'event-4').props.id);
    expect(focus).toHaveBeenCalled();
  });

  it('shows a failed read with a retry instead of an empty thread', async () => {
    answer = { ok: false, error: { code: 'internal', message: 'thread store down' } };
    const host = mount(() =>
      TaskThread({
        model: model([task('lead-1:t-error')]),
        task: task('lead-1:t-error'),
        onOpenSession: noop,
        onOpenStory: noop,
      }),
    );
    const tree = await host.flush();
    expect(text(find(tree, (n) => n.props.role === 'alert'))).toContain('thread store down');
    expect(nodes(tree).some((n) => n.type === 'ol')).toBe(false);
    find(tree, (n) => n.type === 'button' && text(n) === zh('components.retry')).props.onClick();
    await host.flush();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('says None for a task with nothing in its thread', async () => {
    answer = { ok: true, value: [] };
    const tree = await show('lead-1:t-empty');
    expect(text(tree)).toContain(zh('board.task.trace.empty'));
    expect(nodes(tree).some((n) => n.type === 'ol')).toBe(false);
  });
});

describe('reading the thread again', () => {
  const event = (
    sequence: number,
    kind: string,
    aggregate_id: string,
    project_id = 'project-a',
  ) => ({
    sequence,
    kind,
    aggregate_id,
    project_id,
    payload: {},
  });

  it.each([
    ['a report to its lead', event(5, 'task.reported', 'lead-1'), 2],
    ['a gate run of its session', event(5, 'session.gate_checked', 'worker-1'), 2],
    ['a blocked merge of its session', event(5, 'session.merge_blocked', 'worker-1'), 2],
    ['a finding of any review in the project', event(5, 'review.finding_recorded', 'review-9'), 2],
    ['a report to another lead', event(5, 'task.reported', 'lead-2'), 1],
    ['a finished turn of its session', event(5, 'turn.completed', 'worker-1'), 1],
    ['a report in another project', event(5, 'task.reported', 'lead-1', 'project-b'), 1],
  ])('after %s, reads the given number of times', async (name, next, reads) => {
    vi.useFakeTimers();
    snapshot([event(1, 'task.reported', 'lead-1')]);
    const host = mount(() => useTaskThread('project-a', `lead-1:${name}`, ['worker-1']));
    await host.flush();
    snapshot([event(1, 'task.reported', 'lead-1'), next]);
    host.render();
    await vi.advanceTimersByTimeAsync(2_000);
    await host.flush();
    expect(query).toHaveBeenCalledTimes(reads);
  });
});
