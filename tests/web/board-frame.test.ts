import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { SessionTurn } from '@pantheon/domain';
import type { AttachmentMeta, BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import {
  type HookHost,
  deferred,
  find,
  mount,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { t } from '../../apps/web/src/i18n/index.js';
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import { useBoard } from '../../apps/web/src/data/board.js';
import { useDrafts } from '../../apps/web/src/data/drafts.js';
import { useShell } from '../../apps/web/src/store.js';
import type { DaemonEvent } from '../../apps/web/src/data/sync.js';
import {
  NeedsStrip,
  SinceStrip,
  useNeedImprovements,
} from '../../apps/web/src/screens/board/BoardFrame.js';
import { BoardView } from '../../apps/web/src/screens/board/BoardScreen.js';
import { LeadPanel } from '../../apps/web/src/screens/board/LeadPanel.js';
import { PublishBar, type PublishCommand } from '../../apps/web/src/screens/board/PublishBar.js';
import {
  LEAD_STATE,
  leadState,
  needActions,
  needCommand,
  needKey,
  needWhat,
  needWho,
  outOfScopeFiles,
  requirementSessionInput,
  requirementTarget,
  seenOf,
  sinceLast,
  type BoardLead,
  type BoardNeed,
} from '../../apps/web/src/screens/board/frame-model.js';
import type {
  RunBoardCommand,
  SnapshotSession,
} from '../../apps/web/src/screens/board/panels-model.js';

const NOW = Date.UTC(2026, 10, 1, 12);
const say = (id: string, values: Record<string, string | number>) =>
  t({ id, defaultMessage: '' }, values);
/** The label of a needs-you action button. */
const act = (key: string) => zh(`board.needs.actions.${key}`);
const reason = (key: string) => zh(`data.reason.${key}`);
const detailed = (why: string, detail: string) =>
  say('board.needs.reasonDetail', { reason: why, detail });
const leadLabel = (key: string) => zh(`board.leadStates.${key}`);
const OPEN = act('open');

const task = (
  id: string,
  status: BoardTaskStatus,
  extra: Partial<BoardModel['tasks'][number]> = {},
): BoardModel['tasks'][number] => ({
  id,
  title: id,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...extra,
});

const board = (tasks: BoardModel['tasks'], merged = 0): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    headline: null,
    counts: {
      running: 0,
      waiting: 0,
      ready: 0,
      failed: 0,
      merged,
      median_ms: null,
      tokens: 0,
      tokens_by_runtime: {},
      cost_usd: null,
    },
    lanes: [],
    tasks,
    edges: [],
    milestones: [],
    burnup: [],
    usage: [],
    models: [],
    merges: [],
    findings: [],
    risks: [],
  }) as unknown as BoardModel;

const merge = (at: number): BoardModel['merges'][number] => ({
  session_id: `merged-at-${at}`,
  title: '',
  merged_at: at,
  from_sha: null,
  sha: 'merge-sha',
  additions: 0,
  deletions: 0,
  story_id: null,
});

describe('since the last visit', () => {
  it('shows nothing on the first visit of a project', () => {
    expect(sinceLast(undefined, board([task('a', 'done')], 2))).toBeNull();
  });

  it('counts new merges, newly failed tasks and new lead questions', () => {
    const seen = {
      at: NOW - 3_600_000,
      status: {
        a: 'running',
        b: 'running',
        c: 'todo',
        d: 'todo',
        f: 'failed',
        g: 'running',
      } as Record<string, BoardTaskStatus>,
      blocked: ['d'],
    };
    const now = {
      ...board(
        [
          task('a', 'done', { ended_at: NOW - 60_000 }),
          task('b', 'waiting'),
          task('c', 'todo', { blocked_since: NOW - 60_000, blockers: ['upstream'] }),
          task('d', 'todo', { blocked_since: NOW - 7_200_000, blockers: ['upstream'] }),
          task('e', 'done', { ended_at: NOW - 30_000 }),
          task('f', 'failed'),
          task('g', 'failed'),
        ],
        3,
      ),
      merges: [merge(NOW - 30_000), merge(NOW - 60_000), merge(NOW - 7_200_000)],
      needs: [
        need({ kind: 'lead.question', created_at: NOW - 60_000 }),
        need({ kind: 'lead.question', created_at: NOW - 7_200_000 }),
        need({ created_at: NOW - 60_000 }),
      ],
    };
    expect(sinceLast(seen, now)).toEqual({ merged: 2, failed: 1, questions: 1 });
  });

  it('reports nothing when a task only starts waiting for an approval', () => {
    const read = seenOf(board([task('a', 'running')]));
    expect(sinceLast(read, board([task('a', 'waiting')]))).toBeNull();
  });

  it('reports nothing when a wider range only brings older tasks and merges into view', () => {
    const today = {
      ...board([task('a', 'running')], 1),
      merges: [merge(NOW - 60_000)],
    };
    const read = seenOf(today);
    const fortnight = {
      ...board(
        [
          task('a', 'running'),
          task('old-done', 'done', { ended_at: NOW - 3 * 86_400_000 }),
          task('old-failed', 'failed', { ended_at: NOW - 2 * 86_400_000 }),
        ],
        3,
      ),
      since: NOW - 14 * 86_400_000,
      merges: [merge(NOW - 60_000), merge(NOW - 3 * 86_400_000), merge(NOW - 5 * 86_400_000)],
    };
    expect(sinceLast(read, fortnight)).toBeNull();
  });

  it('still reports a new merge while an older one ages out of the range', () => {
    const read = seenOf({ ...board([], 1), merges: [merge(NOW - 23 * 3_600_000)] });
    const later = {
      ...board([], 1),
      since: NOW + 2 * 3_600_000 - 86_400_000,
      now: NOW + 2 * 3_600_000,
      merges: [merge(NOW + 3_600_000)],
    };
    expect(sinceLast(read, later)).toEqual({ merged: 1, failed: 0, questions: 0 });
  });

  it('shows nothing once read, and nothing when nothing changed', () => {
    const now = board(
      [task('a', 'done'), task('b', 'failed'), task('c', 'todo', { blocked_since: NOW })],
      4,
    );
    const read = seenOf(now);
    expect(read).toEqual({
      at: NOW,
      status: { a: 'done', b: 'failed', c: 'todo' },
    });
    expect(sinceLast(read, now)).toBeNull();
  });
});

describe('since-last strip', () => {
  const stubStorage = () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
  };

  it('stays closed when the range widens without anything new, and opens on a new merge', () => {
    stubStorage();
    let model: BoardModel = { ...board([task('a', 'running')], 1), merges: [merge(NOW - 60_000)] };
    const h = mount(() => SinceStrip({ projectId: 'project-a', model }));
    expect(h.value).toBeNull();
    model = {
      ...board(
        [task('a', 'running'), task('old-done', 'done', { ended_at: NOW - 86_400_000 * 3 })],
        2,
      ),
      since: NOW - 14 * 86_400_000,
      merges: [merge(NOW - 60_000), merge(NOW - 86_400_000 * 3)],
    };
    h.render();
    expect(h.value).toBeNull();
    model = {
      ...model,
      now: NOW + 60_000,
      merges: [merge(NOW + 30_000), ...model.merges],
    };
    h.render();
    expect(text(h.value)).toContain(say('board.frame.since.mergedCount', { count: 1 }));
  });
});

const need = (extra: Partial<BoardNeed>): BoardNeed => ({
  source: { table: 'approvals', id: 'approval-1', revision: 3 },
  kind: 'permission',
  project_id: 'project-a',
  session_id: 'worker-1',
  status: 'pending',
  created_at: NOW - 60_000,
  reason: 'permission_requested',
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: { action: 'Bash', input_summary: 'pnpm test', rule: 'Bash(pnpm test)' },
  unblocks: 0,
  ...extra,
});

const keys = (item: BoardNeed) => needActions(item).map((a) => [a.key, a.label, a.reason]);

describe('needs-you strip buttons', () => {
  it('approves or rejects a workflow step that waits for the user', () => {
    const step = need({
      source: { table: 'workflow_step_runs', id: 'step-run-1', revision: 2 },
      kind: 'workflow.approval',
      session_id: 'lead-1',
      task_id: 'lead-1:task-a',
      status: 'waiting',
      reason: 'workflow_approval',
      step_title: 'Security sign-off',
      actions: [
        { command: 'workflow.step.decide', allowed: true },
        { command: 'workflow.step.decide', allowed: true },
      ],
      binding: undefined,
    });
    expect(keys(step)).toEqual([
      ['approve', act('approveStep'), null],
      ['reject', act('rejectStep'), null],
      ['open', OPEN, null],
    ]);
    expect(needWhat(step)).toBe(detailed(reason('workflowApproval'), 'Security sign-off'));
    expect(needCommand(step, 'approve')).toEqual({
      type: 'workflow.step.decide',
      input: { step_run_id: 'step-run-1', decision: 'approve' },
      revision: null,
    });
    expect(needCommand(step, 'reject')).toEqual({
      type: 'workflow.step.decide',
      input: { step_run_id: 'step-run-1', decision: 'reject' },
      revision: null,
    });
  });

  it.each([
    [
      'offers allow once, allow for the session and deny on a permission request',
      [need({})],
      [
        ['approve', act('approve'), null],
        ['approve_session', act('approveSession'), null],
        ['reject', act('reject'), null],
      ],
    ],
    [
      'offers no allow for the session on a request without a rule',
      [need({ binding: { action: 'Bash', input_summary: 'pnpm test' } })],
      [
        ['approve', act('approve'), null],
        ['reject', act('reject'), null],
      ],
    ],
    [
      'only opens the session of a permission request whose input is unknown',
      [need({ binding: { action: 'Bash' } }), need({ binding: undefined })],
      [['open', OPEN, null]],
    ],
    [
      'sends a question to its session to be answered there',
      [need({ binding: { action: 'AskUserQuestion' } })],
      [['answer', act('answer'), null]],
    ],
    [
      'answers a relayed question on the board and opens the thread that asked it',
      [
        need({
          source: { table: 'board_plans', id: 'lead-1', revision: 6 },
          kind: 'lead.question',
          session_id: 'lead-1',
          reason: 'lead_question',
          actions: [{ command: 'lead.question.answer', allowed: true }],
          question: {
            id: 'question-1',
            at: NOW,
            question: 'Which side wins?',
            options: [],
            recommended: '',
            assumption: '',
            blocks: [],
            source: { session_id: 'worker-1', approval_id: 'approval-9' },
          },
        }),
      ],
      [
        ['reply', act('reply'), null],
        ['open', act('viewThread'), null],
      ],
    ],
    [
      'only opens the session of a failed or reconciling session',
      (['session.failed', 'session.reconciling'] as const).map((kind) =>
        need({ source: { table: 'sessions', id: 'worker-1', revision: 7 }, kind, actions: [] }),
      ),
      [['open', OPEN, null]],
    ],
  ])('%s', (_, items, expected) => {
    for (const item of items) expect(keys(item), item.kind).toEqual(expected);
  });

  it('turns the answer buttons off with the backend reason', () => {
    const off = need({
      actions: [
        { command: 'approval.respond', allowed: false, disabled_reason: 'revision_conflict' },
      ],
    });
    expect(needActions(off).map((a) => a.reason)).toEqual(
      Array(3).fill(reason('revisionConflict')),
    );
  });

  it('offers the budget setting, which sends nothing itself, on a project over its budget', () => {
    const over = need({
      source: { table: 'workflow_policies', id: 'project-a', revision: 4 },
      kind: 'project.over_budget',
      session_id: undefined,
      status: 'over_budget',
      reason: 'project_over_budget',
      actions: [{ command: 'workflow.policy.set', allowed: true }],
      binding: undefined,
      project_budget: { used_input_tokens: 150, input_tokens: 100 },
    });
    expect(keys(over)).toEqual([['budget', act('budget'), null]]);
    expect(needCommand(over, 'budget')).toBeNull();
    expect(needWho(over, { tasks: [], milestones: [] }, [])).toBe(reason('projectOverBudget'));
  });

  it('offers to stop a background task that has run too long, by its id', () => {
    const long = need({
      source: { table: 'sessions', id: 'own-1', revision: 3 },
      kind: 'session.failed',
      session_id: undefined,
      status: 'running',
      reason: 'background_task_long',
      actions: [{ command: 'session.background.stop', allowed: true }],
      binding: undefined,
      background: { id: 'bg-7', kind: 'shell', description: 'pnpm dev', started_at: 0 },
    });
    expect(keys(long)).toEqual([
      ['stop_background', act('stopBackground'), null],
      ['open', OPEN, null],
    ]);
    expect(needCommand(long, 'stop_background')).toEqual({
      type: 'session.background.stop',
      input: { session_id: 'own-1', background_id: 'bg-7' },
      revision: null,
    });
    expect(needWhat(long)).toBe(detailed(reason('backgroundTaskLong'), 'pnpm dev'));
  });

  it('offers a merge retry beside opening the session on a blocked merge, and a gate run on a failed gate', () => {
    const session = { table: 'sessions' as const, id: 'worker-1', revision: 7 };
    const blocked = need({
      source: session,
      kind: 'session.merge_blocked',
      reason: 'merge_blocked',
      actions: [{ command: 'session.merge', allowed: false, disabled_reason: 'no_changes' }],
    });
    expect(keys(blocked)).toEqual([
      ['merge', act('merge'), reason('noChanges')],
      ['open', OPEN, null],
    ]);
    const gate = need({ source: session, kind: 'session.gate_failed', reason: 'gate_failed' });
    expect(keys({ ...gate, actions: [] })).toEqual([
      ['merge', act('merge'), null],
      ['gates', act('gates'), null],
      ['open', OPEN, null],
    ]);
  });
});

const lead = (session_id: string, state: BoardLead['state'], updated_at: number): BoardLead => ({
  session_id,
  title: session_id,
  state,
  inbox: 0,
  updated_at,
});

const session = (
  id: string,
  state: SnapshotSession['state'],
  extra: Partial<SnapshotSession> = {},
): SnapshotSession =>
  ({
    id,
    revision: 4,
    project_id: 'project-a',
    runtime: 'fixture',
    state,
    turn_count: 1,
    ...extra,
  }) as SnapshotSession;

describe('needs-you items the backend keeps without an answer', () => {
  const sessionSource = { table: 'sessions' as const, id: 'worker-1', revision: 7 };

  it('only opens the session of a voided request or an undelivered answer', () => {
    for (const reason of ['permission_voided', 'answer_undelivered'] as const)
      expect(keys(need({ reason, actions: [] }))).toEqual([['open', OPEN, null]]);
  });

  it('offers a continue message where the backend allows session.send', () => {
    const item = need({
      source: sessionSource,
      kind: 'session.failed',
      reason: 'continuation_limit_reached',
      actions: [{ command: 'session.send', allowed: true }],
    });
    expect(keys(item)).toEqual([
      ['continue', act('continue'), null],
      ['open', OPEN, null],
    ]);
    expect(needCommand(item, 'continue')).toEqual({
      type: 'session.send',
      input: { session_id: 'worker-1', input: expect.any(String) },
      revision: 7,
    });
  });

  it('updates the board for a closed lead and names a failed dispatch by its task', () => {
    const plan = { table: 'board_plans' as const, id: 'lead-1', revision: 2 };
    const closed = need({
      source: plan,
      kind: 'session.failed',
      session_id: 'lead-1',
      reason: 'lead_closed',
      actions: [{ command: 'board.sync', allowed: false, disabled_reason: 'permission_denied' }],
    });
    expect(keys(closed)).toEqual([
      ['sync', act('sync'), reason('permissionDenied')],
      ['open', OPEN, null],
    ]);
    expect(needCommand(closed, 'sync')).toEqual({
      type: 'board.sync',
      input: { project_id: 'project-a' },
      revision: null,
    });
    const dispatch = need({
      source: plan,
      kind: 'session.failed',
      session_id: 'lead-1',
      task_id: 'lead-1:a',
      reason: 'task_dispatch_failed',
      actions: [],
    });
    expect(keys(dispatch)).toEqual([['open', OPEN, null]]);
    const model = board([{ ...task('lead-1:a', 'todo'), title: 'Serve exports' }]);
    expect(needWho(dispatch, model, [session('lead-1', 'open', { title: 'Plan exports' })])).toBe(
      'Serve exports',
    );
    expect(needKey(dispatch)).not.toBe(needKey(closed));
  });

  it('keys two plan proposals of one lead apart', () => {
    const proposal = (request_id: string) =>
      ({
        source: { table: 'board_plans', id: 'lead-1', revision: 3 },
        kind: 'board.plan.proposal',
        request_id,
      }) as Parameters<typeof needKey>[0];
    expect(needKey(proposal('proposal-1'))).not.toBe(needKey(proposal('proposal-2')));
  });

  it('lists the files of a merge blocked out of scope and merges them anyway', () => {
    const worker = session('worker-1', 'open', {
      merge: { state: 'blocked', reason: 'out_of_scope', conflicts: ['README.md', 'src/x.ts'] },
    });
    const item = need({
      source: sessionSource,
      kind: 'session.merge_blocked',
      reason: 'merge_blocked',
      actions: [{ command: 'session.merge', allowed: true }],
    });
    expect(outOfScopeFiles(worker)).toEqual(['README.md', 'src/x.ts']);
    expect(needWhat(item, worker)).toBe(detailed(reason('mergeBlocked'), reason('outOfScope')));
    expect(needActions(item, worker).map((a) => [a.key, a.label, a.reason])).toEqual([
      ['merge_out_of_scope', act('mergeOutOfScope'), null],
      ['open', OPEN, null],
    ]);
    expect(needCommand(item, 'merge_out_of_scope')).toEqual({
      type: 'session.merge',
      input: { session_id: 'worker-1', allow_out_of_scope: true },
      revision: 7,
    });
    expect(needCommand(item, 'merge')?.input).toEqual({ session_id: 'worker-1' });
    const conflict = session('worker-1', 'open', {
      merge: { state: 'blocked', reason: 'rebase_conflict' },
    });
    expect(outOfScopeFiles(conflict)).toBeNull();
  });

  it('says a voided request or an undelivered answer waits for the session, not for an answer', () => {
    expect(needWhat(need({ reason: 'permission_voided', actions: [] }))).toBe(
      reason('permissionVoided'),
    );
    expect(needWhat(need({ reason: 'answer_undelivered', status: 'approved', actions: [] }))).toBe(
      reason('answerUndelivered'),
    );
  });

  it('shows a lead whose latest turn failed as failed', () => {
    expect(LEAD_STATE.failed).toEqual({ label: leadLabel('failed'), dot: 'failed' });
  });

  it('says a waiting lead waits for an answer or an approval by what it asked', () => {
    const waiting = (kind: 'approval' | 'input'): BoardLead => ({
      ...lead('lead-1', 'waiting', NOW),
      waiting: { kind, summary: 'Which database?', approval_id: 'approval-1', since: NOW },
    });
    expect(leadState(waiting('input'))).toEqual({ label: leadLabel('waiting'), dot: 'waiting' });
    expect(leadState(waiting('approval'))).toEqual({
      label: leadLabel('waitingApproval'),
      dot: 'waiting',
    });
    expect(leadState(lead('lead-1', 'idle', NOW))).toEqual({
      label: leadLabel('idle'),
      dot: 'idle',
    });
  });
});

describe('lead panel', () => {
  const panel = (leads: BoardLead[], sessions: SnapshotSession[] = [], onOpenSession = vi.fn()) =>
    mount(() =>
      LeadPanel({
        model: { ...board([]), leads } as BoardModel,
        sessions,
        onOpenSession,
        onOpenTask: vi.fn(),
      }),
    ).value;

  it('gives each lead a row with a state glyph of its own, opening its session', () => {
    const onOpenSession = vi.fn();
    const states: BoardLead['state'][] = ['running', 'waiting', 'idle', 'failed', 'closed'];
    const out = panel(
      [
        ...states.map((state) => lead(`lead-${state}`, state, NOW)),
        {
          ...lead('lead-approval', 'waiting', NOW),
          waiting: { kind: 'approval', summary: 'Run it?', approval_id: 'a-1', since: NOW },
        },
      ],
      [],
      onOpenSession,
    );
    const rows = nodes(out).filter((n) => n.props.className === 'btn bld-r');
    expect(rows).toHaveLength(6);
    expect(
      nodes(out)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'StateGlyph')
        .map((n) => n.props.name),
    ).toEqual(['running', 'question', 'idle', 'failed', 'discarded', 'approval']);
    rows[2]!.props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('lead-idle');
  });

  it("shows a lead's runtime from its session and leaves its model out", () => {
    const out = panel(
      [{ ...lead('lead-a', 'running', NOW), inbox: 3 }],
      [session('lead-a', 'running', { runtime: 'claude', reported_model: 'claude-opus-4-5' })],
    );
    expect(named(out, 'RuntimeGlyph').props.runtime).toBe('claude');
    expect(text(out)).not.toContain('claude-opus-4-5');
  });

  it('says what a lead does now, else its state', () => {
    const out = panel([
      {
        ...lead('lead-a', 'running', NOW),
        activity: {
          phase: 'tool',
          since: NOW - 5 * 60_000,
          tool: { name: 'Bash', target: 'pnpm test' },
          health: 'fresh',
          attempt: 1,
        },
      },
      lead('lead-b', 'idle', NOW),
    ]);
    expect(
      nodes(out)
        .filter((n) => n.props.className === 'bld-do')
        .map(text),
    ).toEqual([`${zh('runs.table.verb.run')} pnpm test`, leadLabel('idle')]);
  });

  it.each([
    ['names the task a relayed question came from', 'Export rows', true],
    ['leaves out a task named like its session', 'Serve exports', false],
  ])("shows the lead's relayed question as a card under its source: %s", (_, title, named_) => {
    const relayed = need({
      source: { table: 'board_plans', id: 'lead-1', revision: 6 },
      kind: 'lead.question',
      session_id: 'lead-1',
      request_id: 'question-1',
      created_at: NOW - 90_000,
      reason: 'lead_question',
      actions: [{ command: 'lead.question.answer', allowed: true }],
      binding: undefined,
      question: {
        id: 'question-1',
        at: NOW - 90_000,
        question: 'Which side wins?',
        options: ['Server', 'Client'],
        recommended: 'Server',
        assumption: '',
        blocks: ['exports'],
        source: { session_id: 'worker-1', approval_id: 'approval-9' },
      },
    });
    const onOpenSession = vi.fn();
    const out = mount(() =>
      LeadPanel({
        model: {
          ...board([task('lead-1:exports', 'running', { title })]),
          leads: [lead('lead-1', 'idle', NOW)],
          needs: [relayed],
        } as BoardModel,
        sessions: [
          session('lead-1', 'running', { title: 'Plan exports' }),
          session('worker-1', 'running', {
            title: 'Serve exports',
            task: { lead_session_id: 'lead-1', id: 'exports' },
          } as Partial<SnapshotSession>),
        ],
        onOpenSession,
        onOpenTask: vi.fn(),
        run: vi.fn<RunBoardCommand>(async () => null),
      }),
    ).value;
    const shown = mount(() => RequestCard(named(out, 'RequestCard').props)).value;
    const source: ReactNode = named(shown, 'QuestionCard').props.source;
    expect(named(source, 'RuntimeGlyph').props.runtime).toBe('fixture');
    expect(text(source)).toContain('Serve exports');
    expect(text(source).includes('Export rows')).toBe(named_);
    expect(text(source)).toContain(
      say('components.requestCard.waited', {
        duration: say('data.elapsed.minutes', { minutes: 1, seconds: '30' }),
      }),
    );
    find(source, (n) => n.type === 'button' && text(n) === act('viewThread')).props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('worker-1');
  });

  it('says what a waiting lead asked', () => {
    const out = panel([
      {
        ...lead('lead-a', 'waiting', NOW),
        activity: {
          phase: 'waiting_input',
          since: NOW - 5 * 60_000,
          waiting: { kind: 'input', summary: 'Which database?', approval_id: 'a-1', since: NOW },
          health: 'fresh',
          attempt: 1,
        },
      },
    ]);
    expect(text(find(out, (n) => n.props.className === 'bld-do'))).toBe('Which database?');
  });
});

describe('requirement box target', () => {
  it('opens a new session without a lead', () => {
    expect(requirementTarget(undefined, [])).toEqual({ kind: 'create' });
    expect(requirementTarget([], [session('lead-1', 'open')])).toEqual({ kind: 'create' });
  });

  it('sends to the newest lead when it is open and steers it while it runs', () => {
    const leads = [lead('lead-old', 'idle', NOW - 10), lead('lead-new', 'idle', NOW)];
    const open = [session('lead-old', 'open'), session('lead-new', 'open')];
    expect(requirementTarget(leads, open)).toEqual({ kind: 'send', session: open[1] });
    const running = [session('lead-old', 'open'), session('lead-new', 'running')];
    expect(requirementTarget(leads, running)).toEqual({ kind: 'steer', session: running[1] });
  });

  it('opens a new session when the newest lead cannot take input', () => {
    const leads = [lead('lead-old', 'idle', NOW - 10), lead('lead-new', 'closed', NOW)];
    expect(
      requirementTarget(leads, [session('lead-old', 'open'), session('lead-new', 'closed')]),
    ).toEqual({ kind: 'create' });
    expect(
      requirementTarget(leads, [
        session('lead-old', 'open'),
        session('lead-new', 'open', { stop_pending: true }),
      ]),
    ).toEqual({ kind: 'create' });
    expect(requirementTarget(leads, [session('lead-old', 'open')])).toEqual({ kind: 'create' });
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('publish bar', () => {
  const chooseFiles = vi.fn();
  const stubRuntimes = (runtimes: string[]) =>
    vi.stubGlobal('window', {
      pantheon: {
        query: async () => ({
          ok: true,
          value: runtimes.map((runtime) => ({
            runtime,
            enabled: true,
            installed: true,
            auth: { state: 'unknown' },
            version: null,
            min_version: null,
            version_ok: null,
            checked_at: new Date().toISOString(),
            capabilities: { write_isolation: { status: 'supported' } },
          })),
        }),
        chooseFiles,
      },
    });
  const ok = (value: unknown) => ({ ok: true as const, value });
  const refused = { ok: false as const, error: { code: 'invalid_state', message: 'refused' } };
  const box = (props: () => Partial<Parameters<typeof PublishBar>[0]>) =>
    mount(() =>
      PublishBar({
        projectId: 'project-a',
        leads: undefined,
        sessions: [],
        tasks: [],
        defaults: undefined,
        run: async () => ok({ id: 'lead-created' }),
        ...props(),
      }),
    );
  const field = (tree: unknown) => find(tree as any, (n) => n.type === 'textarea');
  const type = (h: HookHost<any>, value: string) => {
    field(h.value).props.onChange({ target: { value } });
    h.render();
  };
  const submit = (h: HookHost<any>) =>
    find(h.value, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
  const press = (h: HookHost<any>, keys: { metaKey?: boolean; ctrlKey?: boolean }) => {
    const preventDefault = vi.fn();
    field(h.value).props.onKeyDown({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault,
      ...keys,
    });
    return preventDefault;
  };
  const sendButton = (tree: unknown) =>
    find(tree as any, (n) => n.type === 'button' && n.props.type === 'submit');
  const turn = (state: SessionTurn['state'], extra: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-sent',
    revision: 1,
    project_id: 'project-a',
    session_id: 'lead-new',
    input: 'Ship the importer',
    kind: 'send',
    delivery: state === 'queued' ? 'pending' : 'delivered',
    state,
    ...extra,
  });
  const event = (sequence: number, kind: string, aggregate_id: string): DaemonEvent => ({
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id,
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: 'command-a',
    created_at: NOW,
    payload: {},
  });
  const daemon = (turns: SessionTurn[], events: DaemonEvent[] = []) =>
    useBoard.setState({
      board: { cursor: 5, projects: [], sessions: [], session_turns: turns, workspaces: [] },
      events,
      cursor: Math.max(5, ...events.map((e) => e.sequence)),
    });
  // The receipt is a component of its own; render the newest one from its props.
  const receipt = (tree: unknown) => {
    const card = named(tree as ReactNode, 'ReceiptCard');
    return (card.type as (props: unknown) => ReactNode)(card.props);
  };
  const currentStep = (tree: unknown) =>
    nodes(receipt(tree))
      .filter((n) => n.type === 'li' && n.props['aria-current'] === 'step')
      .map(text);
  const toLead = () => ({
    leads: [lead('lead-new', 'idle', NOW)],
    sessions: [session('lead-new', 'open')],
    run: (async (_type, input) =>
      ok({ ...turn('queued'), id: 'turn-sent', input: input.input })) as PublishCommand,
  });

  /** A bar that sent `requirement` to the lead. */
  const sent = async (requirement = 'Ship the importer') => {
    stubRuntimes([]);
    const h = box(toLead);
    type(h, requirement);
    submit(h);
    await h.flush();
    return h;
  };

  beforeEach(() => {
    chooseFiles.mockReset();
    daemon([]);
    useDrafts.setState({ drafts: {}, answers: {} });
  });

  it('takes a requirement of several lines', () => {
    stubRuntimes([]);
    const h = box(() => ({}));
    type(h, 'Ship the importer\nthen the exporter');
    expect(field(h.value).props.value).toBe('Ship the importer\nthen the exporter');
  });

  it('sends on Meta+Enter or Ctrl+Enter and leaves Enter to the new line', async () => {
    stubRuntimes([]);
    const run = vi.fn<PublishCommand>(async () => ok({ id: 'lead-created' }));
    const h = box(() => ({ run }));
    type(h, 'Ship the importer');
    expect(press(h, {})).not.toHaveBeenCalled();
    await h.flush();
    expect(run).not.toHaveBeenCalled();
    expect(press(h, { metaKey: true })).toHaveBeenCalledOnce();
    await h.flush();
    expect(run).toHaveBeenCalledOnce();
    type(h, 'Ship the exporter');
    press(h, { ctrlKey: true });
    await h.flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('sends the attachments left on the bar with the requirement', async () => {
    stubRuntimes([]);
    const meta = (id: string): AttachmentMeta => ({
      id,
      name: `${id}.csv`,
      mime: 'text/csv',
      size: 3,
    });
    chooseFiles.mockResolvedValueOnce({ ok: true, value: [meta('file-a'), meta('file-b')] });
    const sent: [string, Record<string, unknown>][] = [];
    const lead = toLead();
    const h = box(() => ({
      ...lead,
      run: async (type, input, revision) => {
        sent.push([type, input]);
        return lead.run(type, input, revision);
      },
    }));
    find(h.value, (n) => n.props['aria-label'] === zh('board.lead.publish.attach')).props.onClick();
    await h.flush();
    h.render();
    expect(chooseFiles).toHaveBeenCalledWith('project-a');
    const strip = named(h.value, 'AttachmentStrip');
    expect(strip.props.items.map((a: AttachmentMeta) => a.id)).toEqual(['file-a', 'file-b']);
    strip.props.onRemove('file-b');
    h.render();
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    expect(sent).toEqual([
      [
        'session.send',
        { session_id: 'lead-new', input: 'Ship the importer', attachments: ['file-a'] },
      ],
    ]);
    expect(named(h.value, 'AttachmentStrip').props.items).toEqual([]);
  });

  it('names the lead and its runtime the requirement goes to', () => {
    stubRuntimes([]);
    const h = box(() => ({
      leads: [{ ...lead('lead-new', 'idle', NOW), title: 'Plan exports' }],
      sessions: [session('lead-new', 'open', { runtime: 'codex' })],
    }));
    const to = find(h.value, (n) => n.props.className === 'pb-to');
    expect(text(to)).toBe('Plan exports');
    expect(named(to, 'RuntimeGlyph').props.runtime).toBe('codex');
  });

  it('shows a receipt whose current step follows the turn it sent', async () => {
    const h = await sent('Ship the importer\nwith a dry run first');
    expect(text(find(receipt(h.value), (n) => n.props.className === 'pb-rc-t'))).toBe(
      'Ship the importer',
    );
    expect(currentStep(h.value)).toEqual([zh('board.lead.publish.stepReceived')]);
    daemon([turn('queued')]);
    h.render();
    expect(currentStep(h.value)).toEqual([zh('board.lead.publish.stepQueued')]);
    daemon([turn('running')], [event(6, 'turn.running', 'turn-sent')]);
    h.render();
    expect(currentStep(h.value)).toEqual([zh('board.lead.publish.stepPlanning')]);
    daemon(
      [turn('running')],
      [event(6, 'turn.running', 'turn-sent'), event(7, 'board.plan_updated', 'lead-new')],
    );
    h.render();
    expect(currentStep(h.value)).toEqual([zh('board.lead.publish.stepTasks')]);
    daemon([turn('completed')]);
    h.render();
    expect(currentStep(h.value)).toEqual([]);
  });

  it('keeps a requirement steered into a running turn open until that turn ends', async () => {
    const h = await sent();
    const host = turn('running', { id: 'turn-host', input: 'Plan the week' });
    const steered = turn('completed', { kind: 'steer' });
    daemon([host, steered]);
    h.render();
    expect(currentStep(h.value)).toEqual([zh('board.lead.publish.stepPlanning')]);
    daemon([host, steered], [event(6, 'board.plan_updated', 'lead-new')]);
    h.render();
    expect(currentStep(h.value)).toEqual([zh('board.lead.publish.stepTasks')]);
    daemon(
      [{ ...host, state: 'completed' }, steered],
      [event(6, 'board.plan_updated', 'lead-new'), event(7, 'turn.completed', 'turn-host')],
    );
    h.render();
    expect(currentStep(h.value)).toEqual([]);
    expect(nodes(receipt(h.value)).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('says a requirement steered into a turn that was cancelled was cancelled', async () => {
    const h = await sent();
    daemon(
      [
        turn('cancelled', { id: 'turn-host', input: 'Plan the week' }),
        turn('completed', { kind: 'steer' }),
      ],
      [event(6, 'turn.cancelled', 'turn-host')],
    );
    h.render();
    expect(text(find(receipt(h.value), (n) => n.props.role === 'alert'))).toContain(
      zh('board.lead.publish.cancelled'),
    );
  });

  it('ends on its own turn a requirement whose steer was queued and ran after a failed turn', async () => {
    const h = await sent();
    daemon(
      [
        turn('failed', { id: 'turn-host', input: 'Plan the week' }),
        turn('completed', { kind: 'steer' }),
      ],
      [
        event(6, 'turn.failed', 'turn-host'),
        event(7, 'turn.running', 'turn-sent'),
        event(8, 'turn.completed', 'turn-sent'),
      ],
    );
    h.render();
    expect(currentStep(h.value)).toEqual([]);
    expect(nodes(receipt(h.value)).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('lists the tasks the plan gained after the send', async () => {
    stubRuntimes([]);
    let tasks = [task('lead-new:old', 'running')];
    const h = box(() => ({ ...toLead(), tasks }));
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    tasks = [
      task('lead-new:old', 'running'),
      task('lead-new:import', 'todo', { title: 'Import orders' }),
    ];
    daemon([turn('running')], [event(6, 'turn.running', 'turn-sent')]);
    h.render();
    expect(
      nodes(receipt(h.value)).some(
        (n) => n.props['aria-label'] === zh('board.lead.publish.created'),
      ),
    ).toBe(false);
    daemon(
      [turn('running')],
      [event(6, 'turn.running', 'turn-sent'), event(7, 'board.plan_updated', 'lead-new')],
    );
    h.render();
    const listed = find(
      receipt(h.value),
      (n) => n.props['aria-label'] === zh('board.lead.publish.created'),
    );
    expect(
      nodes(listed)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual(['Import orders']);
  });

  it('says on the receipt that the turn failed and why', async () => {
    const h = await sent();
    daemon([turn('failed', { delivery: 'failed', delivery_reason: 'runtime_unavailable' })]);
    h.render();
    const failed = find(receipt(h.value), (n) => n.props.role === 'alert');
    expect(text(failed)).toContain(zh('board.lead.publish.failed'));
    expect(text(failed)).toContain('runtime_unavailable');
    expect(currentStep(h.value)).toEqual([]);
  });

  it('drops the receipts when the project changes', async () => {
    stubRuntimes([]);
    let projectId = 'project-a';
    const lead = toLead();
    const h = box(() => ({ ...lead, projectId }));
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    expect(() => receipt(h.value)).not.toThrow();
    projectId = 'project-b';
    h.render();
    expect(() => receipt(h.value)).toThrow();
  });

  it('opens a session on a runtime this machine offers when the project names none', () => {
    expect(requirementSessionInput('project-a', undefined, 'Ship it', ['codex']).runtime).toBe(
      'codex',
    );
    expect(requirementSessionInput('project-a', undefined, 'Ship it', []).runtime).toBe('claude');
  });

  it('creates the session on a runtime the status report offers', async () => {
    stubRuntimes(['codex']);
    const sent: unknown[] = [];
    const run: PublishCommand = async (_type, input) => {
      sent.push(input);
      return ok({ id: 'lead-created' });
    };
    const h = box(() => ({ run }));
    await h.flush();
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    expect(sent).toMatchObject([{ runtime: 'codex', input: 'Ship the importer' }]);
  });

  it('drops the draft when the project changes', () => {
    stubRuntimes([]);
    let projectId = 'project-a';
    const h = box(() => ({ projectId }));
    type(h, 'Half a thought');
    projectId = 'project-b';
    h.render();
    expect(field(h.value).props.value).toBe('');
  });

  it('leaves the next project draft alone when a send from the previous project returns', async () => {
    stubRuntimes([]);
    let projectId = 'project-a';
    const reply = deferred<Awaited<ReturnType<PublishCommand>>>();
    const h = box(() => ({ projectId, run: () => reply.promise }));
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    projectId = 'project-b';
    h.render();
    expect(field(h.value).props.disabled).toBe(false);
    type(h, 'Draft for project b');
    reply.resolve(refused);
    await h.flush();
    expect(field(h.value).props.value).toBe('Draft for project b');
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('keeps the draft but sends nothing while disabled', async () => {
    stubRuntimes([]);
    const run = vi.fn<PublishCommand>(async () => ok({ id: 'lead-created' }));
    const h = box(() => ({ run, disabled: true }));
    type(h, 'Ship the importer');
    expect(sendButton(h.value).props.disabled).toBe(true);
    submit(h);
    await h.flush();
    expect(run).not.toHaveBeenCalled();
    expect(field(h.value).props.value).toBe('Ship the importer');
  });

  it('gives focus back to the input once the requirement is sent', async () => {
    stubRuntimes([]);
    const reply = deferred<Awaited<ReturnType<PublishCommand>>>();
    const h = box(() => ({ run: () => reply.promise }));
    type(h, 'Ship the importer');
    const focus = vi.fn();
    field(h.value).props.ref.current = { focus };
    submit(h);
    await h.flush();
    expect(field(h.value).props.disabled).toBe(true);
    reply.resolve(ok({ id: 'lead-created' }));
    await h.flush();
    expect(field(h.value).props.disabled).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('board new session while the board refreshes', () => {
  it('keeps the new-session action while a fresher board is being read', () => {
    const start = () => {};
    const noop = () => {};
    const h = mount(() =>
      BoardView({
        model: {
          ...board([task('lead-1:a', 'todo', { owner_session_id: 'lead-1' })]),
          task_progress: {
            totals: {
              done: 0,
              running: 0,
              waiting: 0,
              idle: 0,
              ready: 0,
              failed: 0,
              discarded: 0,
              not_started: 0,
            },
            daily: [],
            cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
          },
        } as BoardModel,
        loading: false,
        error: null,
        onRetry: noop,
        stale: true,
        range: 7,
        onRange: noop,
        page: 'now',
        onPage: noop,
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
        onStartTask: start,
      }),
    );
    // The panels sit in props other than children, so every prop is searched.
    const all = (value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] => {
      if (!value || typeof value !== 'object' || seen.has(value)) return [];
      seen.add(value);
      const props = 'props' in value ? (value.props as Record<string, unknown>) : null;
      const inner = Object.values(props ?? (value as object)).flatMap((v) => all(v, seen));
      return props ? [props, ...inner] : inner;
    };
    const given = all(h.value).filter((props) => 'onStartTask' in props);
    expect(given.length).toBeGreaterThan(0);
    expect(given.every((props) => props.onStartTask === start)).toBe(true);
  });
});

describe('needs-you row', () => {
  const row = (
    item: BoardNeed,
    run: RunBoardCommand,
    onOpenSession: (id: string) => void,
    stale = false,
  ) => {
    const strip = mount(() =>
      NeedsStrip({
        model: { ...board([]), needs: [item] },
        sessions: [],
        run,
        onOpenSession,
        stale,
      }),
    );
    const el = named(strip.value, 'RequestCard');
    return mount(() => (el.type as (props: unknown) => ReactNode)(el.props));
  };
  const button = (tree: unknown, label: string) =>
    find(tree as any, (n) => n.type === 'button' && text(n) === label);

  it('blocks commands based on stale evidence while keeping session navigation available', async () => {
    const run = vi.fn(async () => null);
    const open = vi.fn();
    const h = row(
      need({
        source: { table: 'sessions', id: 'worker-1', revision: 7 },
        kind: 'session.merge_blocked',
        reason: 'merge_blocked',
        actions: [{ command: 'session.merge', allowed: true }],
      }),
      run,
      open,
      true,
    );
    expect(button(h.value, act('merge')).props['aria-disabled']).toBe(true);
    button(h.value, act('merge')).props.onClick();
    await h.flush();
    expect(run).not.toHaveBeenCalled();
    button(h.value, OPEN).props.onClick();
    expect(open).toHaveBeenCalledWith('worker-1');
  });

  it('still opens the session while another action of the row runs', async () => {
    const blocked = need({
      source: { table: 'sessions', id: 'worker-1', revision: 7 },
      kind: 'session.merge_blocked',
      reason: 'merge_blocked',
      actions: [{ command: 'session.merge', allowed: true }],
    });
    const reply = deferred<string | null>();
    const opened: string[] = [];
    const h = row(
      blocked,
      () => reply.promise,
      (id) => opened.push(id),
    );
    button(h.value, act('merge')).props.onClick();
    await h.flush();
    expect(button(h.value, act('merge')).props['aria-disabled']).toBe(true);
    expect(button(h.value, OPEN).props['aria-disabled']).toBeUndefined();
    button(h.value, OPEN).props.onClick();
    expect(opened).toEqual(['worker-1']);
    reply.resolve(null);
    await h.flush();
  });

  it('shows the input of a permission request beside the buttons that allow it', () => {
    const summary = 'rm -rf dist && pnpm build';
    const h = row(
      need({ binding: { action: 'Bash', input_summary: summary } }),
      async () => null,
      () => {},
    );
    const shown = find(h.value, (n) => n.props.className === 'rq-cmd');
    expect(text(shown)).toBe(summary);
    expect(shown.props.title).toBe(summary);
    expect(nodes(h.value).some((n) => n.type === 'button' && text(n) === act('approve'))).toBe(
      true,
    );
  });
});

describe('needs-you proposal card', () => {
  it('shows the change a proposal makes, read from the project improvements', async () => {
    const improvement = {
      id: 'improvement-1',
      revision: 1,
      project_id: 'project-a',
      source: 'lead',
      retrospective_ids: ['r1', 'r2', 'r3'],
      status: 'candidate',
      proposed_at: NOW - 20_000,
      change: { type: 'policy_change', param: 'max_parallel', from: 2, to: 3 },
    };
    const query = vi.fn(async () => ({ ok: true, value: [improvement] }));
    vi.stubGlobal('window', { pantheon: { query } });
    useBoard.setState({
      board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    } as any);
    const model = {
      ...board([]),
      needs: [
        need({
          source: { table: 'improvements', id: 'improvement-1', revision: 1 },
          kind: 'improvement.candidate',
          session_id: undefined,
          status: 'candidate',
          reason: 'improvement_awaiting_decision',
          actions: [{ command: 'improvement.decide', allowed: true }],
          binding: undefined,
        }),
      ],
    };
    const strip = mount(() =>
      NeedsStrip({
        model,
        sessions: [],
        run: async () => null,
        onOpenSession: () => {},
        improvements: useNeedImprovements(model).read,
      }),
    );
    await strip.flush();
    expect(query).toHaveBeenCalledWith('improvement.list', { project_id: 'project-a' });
    const el = named(strip.value, 'RequestCard');
    expect(el.props.improvement).toEqual(improvement);
    const card = mount(() => (el.type as (props: unknown) => ReactNode)(el.props));
    expect(text(card.value)).toContain(
      say('data.workflowPolicy.change', {
        what: zh('data.workflowPolicy.param.maxParallel'),
        from: 2,
        to: 3,
      }),
    );
  });
});

describe('needs-you strip folding', () => {
  const fiveNeeds = () => {
    const needs = [1, 2, 3, 4, 5].map((n) =>
      need({ source: { table: 'approvals', id: `approval-${n}`, revision: 1 } }),
    );
    return mount(() =>
      NeedsStrip({
        model: { ...board([]), needs },
        sessions: [],
        run: async () => null,
        onOpenSession: () => {},
      }),
    );
  };

  it('folds an expanded list back to its first rows', () => {
    const h = fiveNeeds();
    const rows = () => nodes(h.value).filter((n) => n.type === named(h.value, 'RequestCard').type);
    expect(rows()).toHaveLength(3);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === say('board.frame.needs.more', { count: 2 }),
    ).props.onClick();
    h.render();
    expect(rows()).toHaveLength(5);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('board.frame.needs.less'),
    ).props.onClick();
    h.render();
    expect(rows()).toHaveLength(3);
  });

  it('tells the shell which waits its rows show, so the notice feed leaves only those out', () => {
    const h = fiveNeeds();
    expect([...useShell.getState().boardWaits!]).toEqual([
      'approval-1',
      'approval-2',
      'approval-3',
    ]);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === say('board.frame.needs.more', { count: 2 }),
    ).props.onClick();
    h.render();
    expect(useShell.getState().boardWaits!.size).toBe(5);
  });
});
