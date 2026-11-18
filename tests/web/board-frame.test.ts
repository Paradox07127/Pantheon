import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AgentProfile, SessionTurn } from '@pantheon/domain';
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
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { t } from '../../apps/web/src/i18n/index.js';
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import { MenuItem } from '../../apps/web/src/components/Menu.js';
import { useBoard } from '../../apps/web/src/data/board.js';
import { useDrafts } from '../../apps/web/src/data/drafts.js';
import {
  ASSISTANT,
  chooseRequestTarget,
  type RequestChoice,
} from '../../apps/web/src/data/request-target.js';
import { useShell } from '../../apps/web/src/store.js';
import type { DaemonEvent } from '../../apps/web/src/data/sync.js';
import { NeedsStrip, useNeedImprovements } from '../../apps/web/src/screens/board/BoardFrame.js';
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
  proposalCardId,
  requirementSessionInput,
  requirementTarget,
  requirementTargets,
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

const need = (extra: Partial<BoardNeed>): BoardNeed => ({
  source: { table: 'approvals', id: 'approval-1', revision: 3 },
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

  it('approves the plan of a lane that waits for the user, named by the lane and else by its id', () => {
    const held = (allowed: boolean, over: Partial<BoardNeed> = {}) =>
      need({
        source: { table: 'board_plans', id: 'lead-1', revision: 6 },
        kind: 'board.lane.approval',
        session_id: 'lead-1',
        request_id: 'lane-docs',
        reason: 'lane_plan_awaiting_approval',
        decision: 'plan_change',
        primary: 'board.lane.approve',
        actions: [
          allowed
            ? { command: 'board.lane.approve', allowed: true }
            : {
                command: 'board.lane.approve',
                allowed: false,
                disabled_reason: 'permission_denied',
              },
        ],
        binding: undefined,
        ...over,
      });
    expect(keys(held(true))).toEqual([['approve', act('approvePlan'), null]]);
    expect(keys(held(false))).toEqual([
      ['approve', act('approvePlan'), reason('permissionDenied')],
    ]);
    expect(needCommand(held(true), 'approve')).toEqual({
      type: 'board.lane.approve',
      input: { project_id: 'project-a', lead_session_id: 'lead-1', lane_id: 'lane-docs' },
      revision: null,
    });
    const lanes = [{ id: 'lead-1:lane-docs', title: 'Write the docs' }];
    expect(
      needWho(held(true, { lane_title: 'Docs lane' }), { tasks: [], milestones: [], lanes }, []),
    ).toBe('Docs lane');
    expect(needWho(held(true), { tasks: [], milestones: [], lanes }, [])).toBe('Write the docs');
    expect(needWho(held(true), { tasks: [], milestones: [], lanes: [] }, [])).toBe('lane-docs');
    expect(needWhat(held(true))).toBe(reason('lanePlanAwaitingApproval'));
    expect(needWhat(held(true, { plan_review_running: true }))).toBe(
      reason('lanePlanAwaitingApprovalReviewing'),
    );
    expect(needKey(held(true))).not.toBe(needKey(held(true, { request_id: 'lane-api' })));
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
    expect(LEAD_STATE.failed).toEqual({ label: leadLabel('failed'), glyph: 'failed' });
  });

  it('says a waiting lead waits for an answer or an approval by what it asked', () => {
    const waiting = (kind: 'approval' | 'input'): BoardLead => ({
      ...lead('lead-1', 'waiting', NOW),
      waiting: { kind, summary: 'Which database?', approval_id: 'approval-1', since: NOW },
    });
    expect(leadState(waiting('input'))).toEqual({ label: leadLabel('waiting'), glyph: 'question' });
    expect(leadState(waiting('approval'))).toEqual({
      label: leadLabel('waitingApproval'),
      glyph: 'approval',
    });
    expect(leadState(lead('lead-1', 'idle', NOW))).toEqual({
      label: leadLabel('idle'),
      glyph: 'idle',
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

  it("jumps from a lead's question line to its row in the needs-you strip, answering nothing in place", () => {
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
    useShell.setState({ askedNeed: null });
    const out = mount(() =>
      LeadPanel({
        model: {
          ...board([task('lead-1:exports', 'running')]),
          leads: [lead('lead-1', 'idle', NOW)],
          needs: [relayed],
        } as BoardModel,
        sessions: [session('lead-1', 'running', { title: 'Plan exports' })],
        onOpenSession: vi.fn(),
        onOpenTask: vi.fn(),
        run: vi.fn<RunBoardCommand>(async () => null),
      }),
    ).value;
    expect(nodes(out).some((n) => n.type === RequestCard)).toBe(false);
    expect(text(out)).not.toContain('Server');
    const jump = find(
      out,
      (n) =>
        n.type === 'button' &&
        n.props['aria-label'] ===
          say('board.lead.line.toQuestion', { question: 'Which side wins?' }),
    );
    expect(text(jump)).toBe('Which side wins?');
    jump.props.onClick();
    expect(useShell.getState().askedNeed).toBe('lead-1:question-1');
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

const agent = (id: string, template: AgentProfile['template'], name: string): AgentProfile =>
  ({
    id,
    revision: 1,
    project_id: 'project-a',
    template,
    name,
    role: 'AG',
    created_at: 1,
  }) as AgentProfile;

describe('requirement box target', () => {
  const agents = [
    agent('agent-assistant', 'assistant', 'Assistant'),
    agent('agent-triage', 'triage', 'Triage'),
  ];
  const targetOf = (choice: RequestChoice, sessions: SnapshotSession[]) =>
    requirementTarget(
      choice,
      requirementTargets('project-a', [lead('lead-new', 'idle', NOW)], sessions, agents),
    ).choice;

  it('targets the Assistant without a stored choice', () => {
    expect(targetOf(ASSISTANT, [session('lead-new', 'open')])).toEqual(ASSISTANT);
    expect(
      requirementTarget(ASSISTANT, requirementTargets('project-a', undefined, [], null)).choice,
    ).toEqual(ASSISTANT);
  });

  it('keeps a stored lead, direct session or resident that takes input', () => {
    const sessions = [
      session('lead-new', 'running'),
      session('direct-1', 'open'),
      session('triage-1', 'open', { resident: { kind: 'triage', agent_id: 'agent-triage' } }),
    ];
    for (const choice of [
      { kind: 'session', session_id: 'lead-new' },
      { kind: 'session', session_id: 'direct-1' },
      { kind: 'agent', agent_id: 'agent-triage' },
    ] as const)
      expect(targetOf(choice, sessions)).toEqual(choice);
  });

  it.each([
    ['archived', [session('direct-1', 'open', { archived_at: '2026-11-01T00:00:00Z' })]],
    ['gone', []],
    ['closed', [session('direct-1', 'closed')]],
    ['stopping', [session('direct-1', 'open', { stop_pending: true })]],
  ])('falls back to the Assistant for a stored session that is %s', (_, sessions) => {
    expect(targetOf({ kind: 'session', session_id: 'direct-1' }, sessions)).toEqual(ASSISTANT);
  });

  it('falls back to the Assistant for a stored resident that is archived', () => {
    const archived = { ...agents[1]!, archived_at: 2 };
    expect(
      requirementTarget(
        { kind: 'agent', agent_id: 'agent-triage' },
        requirementTargets('project-a', undefined, [], [agents[0]!, archived]),
      ).choice,
    ).toEqual(ASSISTANT);
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('publish bar', () => {
  const chooseFiles = vi.fn();
  let agentList: AgentProfile[] = [];
  const stubRuntimes = (runtimes: string[]) =>
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: {
        query: async (method: string) => ({
          ok: true,
          value:
            method === 'agent.list'
              ? agentList
              : runtimes.map((runtime) => ({
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
  // The daemon routes a request to the session it names, or to the Assistant's session lead-new.
  const toLead = () => ({
    leads: [lead('lead-new', 'idle', NOW)],
    sessions: [session('lead-new', 'open')],
    run: (async (_type, input) => {
      const target = input.target as { session_id?: string } | undefined;
      return ok({ session_id: target?.session_id ?? 'lead-new', turn_id: 'turn-sent' });
    }) as PublishCommand,
  });

  /** A bar that sent `requirement` to the Assistant. */
  const sent = async (requirement = 'Ship the importer') => {
    stubRuntimes([]);
    const h = box(toLead);
    type(h, requirement);
    submit(h);
    await h.flush();
    return h;
  };
  /** The button that opens the target menu. */
  const trigger = (tree: unknown) => named(tree as ReactNode, 'Menu').props.trigger;
  const choose = (h: HookHost<any>, value: string) => {
    named(h.value, 'MenuRadioGroup').props.onChange(value);
    h.render();
  };
  const targetLabel = (name: string) => say('board.lead.publish.target', { name });
  const ASSISTANT_NAME = zh('sessions.agents.template.assistant');

  beforeEach(() => {
    chooseFiles.mockReset();
    daemon([]);
    useDrafts.setState({ drafts: {}, answers: {} });
    agentList = [];
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    });
    for (const id of ['project-a', 'project-b', 'project-agents'])
      chooseRequestTarget(id, ASSISTANT);
    items.clear();
  });

  it('sends to the Assistant when the project has no stored target', async () => {
    stubRuntimes([]);
    const run = vi.fn(toLead().run);
    const h = box(() => ({ ...toLead(), run }));
    expect(trigger(h.value).props['aria-label']).toBe(targetLabel(ASSISTANT_NAME));
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    expect(run.mock.calls).toEqual([
      ['request.send', { project_id: 'project-a', input: 'Ship the importer' }, null],
    ]);
  });

  it('sends to a chosen direct session and keeps the choice when the bar is built again', async () => {
    stubRuntimes([]);
    const run = vi.fn(toLead().run);
    const props = () => ({
      ...toLead(),
      sessions: [
        session('lead-new', 'open'),
        session('direct-1', 'open', { title: 'Ledger export spike' }),
      ],
      run,
    });
    const h = box(props);
    choose(h, 'session:direct-1');
    expect(trigger(h.value).props['aria-label']).toBe(targetLabel('Ledger export spike'));
    type(h, 'Find the flaky test');
    submit(h);
    await h.flush();
    expect(run.mock.calls).toEqual([
      [
        'request.send',
        {
          project_id: 'project-a',
          input: 'Find the flaky test',
          target: { kind: 'session', session_id: 'direct-1' },
        },
        null,
      ],
    ]);
    unmountAll();
    expect(trigger(box(props).value).props['aria-label']).toBe(targetLabel('Ledger export spike'));
  });

  it('shows the Assistant for a stored session that was archived since', () => {
    stubRuntimes([]);
    const props = (archived_at?: string) => () => ({
      sessions: [session('direct-1', 'open', { title: 'Ledger export spike', archived_at })],
    });
    choose(box(props()), 'session:direct-1');
    unmountAll();
    const h = box(props('2026-11-01T00:00:00Z'));
    expect(trigger(h.value).props['aria-label']).toBe(targetLabel(ASSISTANT_NAME));
  });

  it('lists the Assistant, the other residents, the leads, the direct sessions, then New lead', async () => {
    stubRuntimes([]);
    agentList = [
      agent('agent-triage', 'triage', 'Triage'),
      agent('agent-assistant', 'assistant', 'Assistant'),
    ];
    const h = box(() => ({
      projectId: 'project-agents',
      leads: [{ ...lead('lead-new', 'waiting', NOW), title: 'Refunds v2 rollout' }],
      sessions: [
        session('assistant-1', 'open', {
          resident: { kind: 'assistant', agent_id: 'agent-assistant' },
        }),
        session('direct-1', 'open', { title: 'Ledger export spike' }),
        session('lead-new', 'open'),
        session('worker-1', 'open', { task: { id: 'lead-new:t1' } as SnapshotSession['task'] }),
        session('direct-2', 'closed', { title: 'Done already' }),
      ]
        .map((each) => ({ ...each, project_id: 'project-agents' }))
        // The snapshot holds every project's sessions.
        .concat(session('elsewhere-1', 'open', { title: 'Another project spike' })),
    }));
    await h.flush();
    h.render();
    expect(
      nodes(named(h.value, 'MenuRadioGroup').props.children)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'MenuRadioItem')
        .map(text),
    ).toEqual([
      ASSISTANT_NAME,
      zh('sessions.agents.template.triage'),
      'Refunds v2 rollout',
      'Ledger export spike',
      zh('board.lead.publish.newLead'),
    ]);
    expect(named(h.value, 'Menu').props.label).toBe(zh('board.lead.publish.targets'));
  });

  it('opens a resident that has no session yet and sends to it', async () => {
    stubRuntimes([]);
    agentList = [
      agent('agent-assistant', 'assistant', 'Assistant'),
      agent('agent-triage', 'triage', 'Triage'),
    ];
    const run = vi.fn<PublishCommand>(async (type) =>
      type === 'resident.open'
        ? ok({ id: 'triage-1' })
        : ok({ session_id: 'triage-1', turn_id: 'turn-sent' }),
    );
    const h = box(() => ({ projectId: 'project-agents', run }));
    await h.flush();
    choose(h, 'agent:agent-triage');
    type(h, 'Sort the new issues');
    submit(h);
    await h.flush();
    expect(run.mock.calls).toEqual([
      ['resident.open', { agent_id: 'agent-triage' }, null],
      [
        'request.send',
        {
          project_id: 'project-agents',
          input: 'Sort the new issues',
          target: { kind: 'session', session_id: 'triage-1' },
        },
        null,
      ],
    ]);
  });

  it('creates a lead with New lead as before, then targets the Assistant again', async () => {
    stubRuntimes(['codex']);
    const run = vi.fn<PublishCommand>(async () => ok({ id: 'lead-created' }));
    const h = box(() => ({ ...toLead(), run }));
    await h.flush();
    choose(h, 'create');
    expect(trigger(h.value).props['aria-label']).toBe(
      targetLabel(zh('board.lead.publish.newLead')),
    );
    type(h, 'Ship the importer');
    submit(h);
    await h.flush();
    expect(run.mock.calls).toEqual([
      [
        'session.create',
        requirementSessionInput('project-a', undefined, 'Ship the importer', ['codex']),
        null,
      ],
    ]);
    expect(text(find(receipt(h.value), (n) => n.props.className === 'pb-rc-t'))).toBe(
      'Ship the importer',
    );
    expect(trigger(h.value).props['aria-label']).toBe(targetLabel(ASSISTANT_NAME));
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
        'request.send',
        { project_id: 'project-a', input: 'Ship the importer', attachments: ['file-a'] },
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
    choose(h, 'session:lead-new');
    const to = trigger(h.value);
    expect(text(to)).toBe('Plan exports');
    expect(named(to, 'TargetIcon').props.runtime).toBe('codex');
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
    choose(h, 'create');
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
  /** The entries of the row's "More actions" menu. */
  const moreItems = (tree: unknown) =>
    nodes(named(tree as ReactNode, 'Menu').props.children).filter((n) => n.type === MenuItem);
  const moreItem = (tree: unknown, label: string) =>
    find(moreItems(tree), (n) => text(n) === label);

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
    moreItem(h.value, OPEN).props.onClick();
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
    expect(moreItem(h.value, OPEN).props.disabled).toBe(false);
    moreItem(h.value, OPEN).props.onClick();
    expect(opened).toEqual(['worker-1']);
    reply.resolve(null);
    await h.flush();
  });

  it('gives each row one action button and puts the rest in its More actions menu', () => {
    const rows: [BoardNeed, string, string[]][] = [
      [need({}), act('approve'), [act('approveSession'), act('reject')]],
      [
        need({
          source: { table: 'sessions', id: 'worker-1', revision: 7 },
          kind: 'session.merge_blocked',
          reason: 'merge_blocked',
          actions: [{ command: 'session.merge', allowed: true }],
        }),
        act('merge'),
        [OPEN],
      ],
    ];
    for (const [item, primary, rest] of rows) {
      const strip = mount(() =>
        NeedsStrip({
          model: { ...board([]), needs: [item] },
          sessions: [],
          run: async () => null,
          onOpenSession: () => {},
        }),
      );
      const card = named(strip.value, 'RequestCard');
      const h = row(
        item,
        async () => null,
        () => {},
      );
      expect(
        nodes(h.value)
          .filter((n) => n.type === 'button')
          .map((n) => text(n)),
      ).toEqual([primary]);
      const menu = named(h.value, 'Menu');
      expect(menu.props.trigger.props['aria-label']).toBe(
        zhf('components.requestCard.more', { name: card.props.who }),
      );
      expect(moreItems(h.value).map((n) => text(n))).toEqual(rest);
    }
  });

  it('says how many tasks a row blocks, and nothing for a row that blocks none', () => {
    const blocking = row(
      need({ blocks: 3 }),
      async () => null,
      () => {},
    );
    expect(text(blocking.value)).toContain(say('data.attention.blocks', { count: 3 }));
    const free = row(
      need({ blocks: 0 }),
      async () => null,
      () => {},
    );
    // The words before the count, which every count of blocked tasks starts with.
    const blocks = say('data.attention.blocks', { count: 7 }).split('7')[0]!.trim();
    expect(text(free.value)).not.toContain(blocks);
  });

  it('keeps a plan change row to one line, without who acts next under it', () => {
    const h = row(
      need({
        source: { table: 'board_plans', id: 'lead-1', revision: 6 },
        kind: 'board.plan.proposal',
        session_id: 'lead-1',
        reason: 'plan_proposal_awaiting_decision',
        decision: 'plan_change',
        actions: [{ command: 'board.plan.proposal.resolve', allowed: true }],
        next_step: 'plan_proposal_awaiting_decision',
      }),
      async () => null,
      () => {},
    );
    expect(text(h.value)).toContain(zh('data.attention.decision.planChange'));
    expect(text(h.value)).not.toContain(zh('daemon.nextStep.planProposalAwaitingDecision'));
    expect(nodes(h.value).filter((n) => n.type === 'p')).toEqual([]);
  });

  const proposal = (allowed: boolean) =>
    need({
      source: { table: 'board_plans', id: 'lead-1', revision: 6 },
      kind: 'board.plan.proposal',
      session_id: 'lead-1',
      request_id: 'proposal-1',
      reason: 'plan_proposal_awaiting_decision',
      decision: 'plan_change',
      primary: 'board.plan.proposal.resolve',
      actions: [
        allowed
          ? { command: 'board.plan.proposal.resolve', allowed: true }
          : {
              command: 'board.plan.proposal.resolve',
              allowed: false,
              disabled_reason: 'permission_denied',
            },
      ],
      binding: undefined,
    });

  it('decides a plan change with the ops the lead proposed where no proposals panel is beside the list', () => {
    const accept = zh('board.plan.proposal.accept');
    const reject = zh('board.plan.proposal.reject');
    expect(keys(proposal(false))).toEqual([
      ['approve', accept, reason('permissionDenied')],
      ['reject', reject, reason('permissionDenied')],
      ['board', act('board'), null],
    ]);
    const resolve = {
      project_id: 'project-a',
      lead_session_id: 'lead-1',
      proposal_id: 'proposal-1',
    };
    expect(needCommand(proposal(true), 'approve')).toEqual({
      type: 'board.plan.proposal.resolve',
      input: { ...resolve, decision: 'accept' },
      revision: null,
    });
    expect(needCommand(proposal(true), 'reject')).toEqual({
      type: 'board.plan.proposal.resolve',
      input: { ...resolve, decision: 'reject' },
      revision: null,
    });
  });

  it('gives a plan change row one button, which brings its card in the plan proposals panel into view, and neither accepts nor rejects it', () => {
    const run = vi.fn(async () => null);
    const h = row(proposal(true), run, () => {});
    expect(
      nodes(h.value)
        .filter((n) => n.type === 'button')
        .map((n) => text(n)),
    ).toEqual([act('proposal')]);
    expect(nodes(h.value).some((n) => n.type === MenuItem)).toBe(false);
    const card = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const getElementById = vi.fn(() => card);
    vi.stubGlobal('document', { getElementById });
    button(h.value, act('proposal')).props.onClick();
    expect(getElementById).toHaveBeenCalledWith(proposalCardId('proposal-1'));
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(card.focus).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('shows a lane waiting for plan approval by the lane title, approves its plan in place, and holds the button the backend refuses', async () => {
    const held = (allowed: boolean) =>
      need({
        source: { table: 'board_plans', id: 'lead-1', revision: 6 },
        kind: 'board.lane.approval',
        session_id: 'lead-1',
        request_id: 'lane-docs',
        reason: 'lane_plan_awaiting_approval',
        decision: 'plan_change',
        primary: 'board.lane.approve',
        actions: [
          allowed
            ? { command: 'board.lane.approve', allowed: true }
            : {
                command: 'board.lane.approve',
                allowed: false,
                disabled_reason: 'permission_denied',
              },
        ],
        binding: undefined,
      });
    const laneRow = (item: BoardNeed, run: RunBoardCommand) => {
      const strip = mount(() =>
        NeedsStrip({
          model: {
            ...board([]),
            lanes: [{ id: 'lead-1:lane-docs', title: 'Write the docs' }],
            needs: [item],
          },
          sessions: [],
          run,
          onOpenSession: () => {},
        }),
      );
      const el = named(strip.value, 'RequestCard');
      return mount(() => (el.type as (props: unknown) => ReactNode)(el.props));
    };
    const approve = `${act('approvePlan')} Write the docs`;
    const run = vi.fn<RunBoardCommand>(async () => null);
    const h = laneRow(held(true), run);
    const article = find(h.value, (n) => n.type === 'article');
    expect(article.props['aria-label']).toBe('Write the docs');
    expect(text(article)).toContain(reason('lanePlanAwaitingApproval'));
    const pressed = find(h.value, (n) => n.type === 'button' && n.props['aria-label'] === approve);
    expect(pressed.props['aria-disabled']).toBeUndefined();
    pressed.props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith(
      'board.lane.approve',
      { project_id: 'project-a', lead_session_id: 'lead-1', lane_id: 'lane-docs' },
      null,
    );

    const refused = vi.fn<RunBoardCommand>(async () => null);
    const off = laneRow(held(false), refused);
    const offButton = find(
      off.value,
      (n) => n.type === 'button' && n.props['aria-label'] === approve,
    );
    expect(offButton.props['aria-disabled']).toBe(true);
    offButton.props.onClick();
    await off.flush();
    expect(refused).not.toHaveBeenCalled();
  });

  it('names a failed session row by its reason, then by the session that failed', () => {
    const failed = need({
      source: { table: 'sessions', id: 'worker-1', revision: 7 },
      kind: 'session.failed',
      reason: 'session_failed',
      decision: 'other',
      actions: [],
    });
    const strip = mount(() =>
      NeedsStrip({
        model: { ...board([]), needs: [failed] },
        sessions: [{ id: 'worker-1', title: 'Serve exports' } as SnapshotSession],
        run: async () => null,
        onOpenSession: () => {},
      }),
    );
    const el = named(strip.value, 'RequestCard');
    const h = mount(() => (el.type as (props: unknown) => ReactNode)(el.props));
    const shown = nodes(h.value)
      .filter((n) => n.type === 'span' || n.type === 'b')
      .map((n) => text(n));
    expect(text(h.value).split(reason('sessionFailed'))).toHaveLength(2);
    expect(text(h.value).indexOf(reason('sessionFailed'))).toBeLessThan(
      text(h.value).indexOf('Serve exports'),
    );
    expect(shown).toContain(reason('sessionFailed'));
    expect(shown).toContain('Serve exports');
    expect(
      shown.filter((s) => s.includes(reason('sessionFailed')) && s.includes('Serve exports')),
    ).toEqual([]);
  });

  it("opens a question row's card in place from its one action", () => {
    const asked = need({
      source: { table: 'board_plans', id: 'lead-1', revision: 6 },
      kind: 'lead.question',
      session_id: 'lead-1',
      reason: 'lead_question',
      decision: 'question',
      actions: [{ command: 'lead.question.answer', allowed: true }],
      binding: undefined,
      question: {
        id: 'question-1',
        at: NOW,
        question: 'Which side wins?',
        options: ['Left', 'Right'],
        recommended: '',
        assumption: '',
        blocks: [],
      },
    });
    const h = row(
      asked,
      async () => null,
      () => {},
    );
    const cards = () =>
      nodes(h.value).filter((n) => typeof n.type === 'function' && n.type.name === 'QuestionCard');
    const reply = () => button(h.value, act('reply'));
    expect(cards()).toHaveLength(0);
    expect(reply().props['aria-expanded']).toBe(false);
    reply().props.onClick();
    h.render();
    expect(reply().props['aria-expanded']).toBe(true);
    expect(cards()).toHaveLength(1);
  });

  it("moves the focus to the next row's action once a row's action went through", async () => {
    const needs = [1, 2].map((n) =>
      need({ source: { table: 'approvals', id: `approval-${n}`, revision: 1 } }),
    );
    const strip = mount(() =>
      NeedsStrip({
        model: { ...board([]), needs },
        sessions: [],
        run: async () => null,
        onOpenSession: () => {},
      }),
    );
    find(strip.value, (n) => n.type === 'ul').props.ref.current = {
      children: needs.map(() => ({ scrollIntoView: () => {}, querySelector: () => null })),
    };
    const cards = nodes(strip.value)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'RequestCard')
      .map((el) => mount(() => (el.type as (props: unknown) => ReactNode)(el.props)));
    const targets = cards.map((card) => {
      const target = { focus: vi.fn() };
      button(card.value, act('approve')).props.ref?.(target);
      return target;
    });
    button(cards[0]!.value, act('approve')).props.onClick();
    await cards[0]!.flush();
    strip.render();
    expect(targets[1]!.focus).toHaveBeenCalled();
    expect(targets[0]!.focus).not.toHaveBeenCalled();
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

  it('shows every row once expanded, with no button to fold them back', () => {
    const h = fiveNeeds();
    const rows = () => nodes(h.value).filter((n) => n.type === named(h.value, 'RequestCard').type);
    // The rows are unrendered cards, so the strip's own buttons are the only ones in its tree.
    const stripButtons = () => nodes(h.value).filter((n) => n.type === 'button');
    expect(rows()).toHaveLength(3);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === say('board.frame.needs.more', { count: 2 }),
    ).props.onClick();
    h.render();
    expect(rows()).toHaveLength(5);
    expect(stripButtons()).toEqual([]);
  });

  it('tells the shell which waits its rows show, so the notice feed leaves only those out', () => {
    const h = fiveNeeds();
    expect([...useShell.getState().stripWaits!]).toEqual([
      'approval-1',
      'approval-2',
      'approval-3',
    ]);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === say('board.frame.needs.more', { count: 2 }),
    ).props.onClick();
    h.render();
    expect(useShell.getState().stripWaits!.size).toBe(5);
  });
});
