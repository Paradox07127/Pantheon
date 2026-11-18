import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readBoardPage } from '../../apps/web/src/data/board-page.js';
import { BoardView } from '../../apps/web/src/screens/board/BoardScreen.js';
import { changesBoard } from '../../apps/web/src/data/board-view.js';
import { acceptanceEvidence } from '../../apps/web/src/screens/board/panels-model.js';
import { TaskGroups, taskGroups } from '../../apps/web/src/screens/board/TaskGroups.js';
import type { BoardModel, BoardTaskState, BoardTaskStatus } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';

describe('board view storage', () => {
  it.each<[string, (string | null)[], (key: string | null) => string | null]>([
    ['reads each stored view key back', ['now', 'history', 'canvas'], (key) => key],
    [
      'opens the now view for a former tab key',
      ['progress', 'milestones', 'tasks', 'commitments', 'quality', 'usage'],
      () => 'now',
    ],
    [
      'falls back to the now view for a missing or unknown value',
      [null, '', '"canvas"', 'flow'],
      () => 'now',
    ],
  ])('%s', (_name, keys, expected) => {
    for (const key of keys) expect(readBoardPage(key)).toBe(expected(key));
  });
});

const task = (id: string, status: BoardTaskStatus): BoardModel['tasks'][number] => ({
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
});

const board = (
  tasks: BoardModel['tasks'],
  edges: BoardModel['edges'] = [],
): Pick<BoardModel, 'tasks' | 'edges'> => ({ tasks, edges });

const planTask = (
  id: string,
  state: BoardTaskState,
  extra: Partial<BoardModel['tasks'][number]> = {},
): BoardModel['tasks'][number] => ({
  ...task(`lead-1:${id}`, state === 'merged' ? 'done' : 'running'),
  title: id,
  owner_session_id: 'lead-1',
  state,
  ...extra,
});

const asked = (task_id: string) =>
  ({
    source: { table: 'sessions', id: 'worker-asked', revision: 1 },
    task_id,
    unblocks: 0,
  }) as unknown as NonNullable<BoardModel['needs']>[number];

describe('first screen task groups', () => {
  const tasks = [
    planTask('done-a', 'merged'),
    planTask('todo-a', 'todo'),
    planTask('upstream-a', 'waiting_upstream'),
    planTask('accept-a', 'awaiting_acceptance'),
    planTask('run-a', 'running'),
    planTask('gate-a', 'gating'),
    planTask('claim-a', 'claimed'),
    planTask('blocked-a', 'blocked'),
    planTask('failed-a', 'failed'),
    planTask('approve-a', 'waiting_approval'),
    planTask('asked-a', 'running'),
    task('session-row', 'running'),
  ];
  const model = { tasks, needs: [asked('lead-1:asked-a')] };
  const html = (m: Pick<BoardModel, 'tasks' | 'needs'>) =>
    renderToStaticMarkup(createElement(TaskGroups, { model: m, onOpenTask() {} }));

  it('groups the plan tasks: yours, blocked or failed, running, awaiting acceptance, to do, merged', () => {
    expect(taskGroups(model).map((g) => [g.label, g.tasks.map((t) => t.title)])).toEqual([
      [zh('board.task.group.you'), ['approve-a', 'asked-a']],
      [zh('board.task.group.blocked'), ['blocked-a', 'failed-a']],
      [zh('board.task.group.running'), ['run-a', 'gate-a', 'claim-a']],
      [zh('board.task.group.acceptance'), ['accept-a']],
      [zh('board.task.group.todo'), ['todo-a', 'upstream-a']],
      [zh('board.task.group.merged'), ['done-a']],
    ]);
  });

  it('folds the merged group by default', () => {
    const out = html(model);
    expect(out).toContain(zh('board.task.group.merged'));
    expect(out).not.toContain('done-a');
    expect(out).toContain('run-a');
    expect(out.indexOf(zh('board.task.group.you'))).toBeLessThan(
      out.indexOf(zh('board.task.group.blocked')),
    );
    expect(out.indexOf(zh('board.task.group.todo'))).toBeLessThan(
      out.indexOf(zh('board.task.group.merged')),
    );
  });

  it('strikes the planned model through before the claimed one when they differ', () => {
    const out = html({
      tasks: [
        planTask('swapped', 'running', {
          planned: { runtime: 'codex', model: 'gpt-5.1-codex' },
          claim: { session_id: 'w1', runtime: 'claude', model: 'claude-sonnet-4-5' },
        }),
        planTask('kept', 'running', {
          planned: { runtime: 'codex', model: 'gpt-5.1-codex-mini' },
          claim: { session_id: 'w2', runtime: 'codex', model: 'gpt-5.1-codex-mini' },
        }),
      ],
      needs: [],
    });
    expect(out).toContain('<s>gpt-5.1-codex</s>');
    expect(out.match(/<s>/g)).toHaveLength(1);
    expect(out).toContain('claude-sonnet-4-5');
    expect(out).toContain('gpt-5.1-codex-mini');
  });
});

describe('main progress on the first screen', () => {
  const NOW = Date.UTC(2026, 10, 3, 12);
  const milestone: BoardModel['milestones'][number] = {
    id: 'ms-cur',
    title: 'importer ready',
    session_ids: [],
    merged: 0,
    status: 'active',
    criteria: [],
    owner_session_id: 'lead-1',
    tasks: { done: 0, total: 1 },
  };
  const board = (milestones: BoardModel['milestones']) =>
    ({
      since: NOW - 7 * 86_400_000,
      now: NOW,
      headline: null,
      counts: {
        running: 1,
        waiting: 0,
        ready: 0,
        failed: 0,
        merged: 0,
        reverted: 0,
        median_ms: null,
        tokens: 0,
        tokens_by_runtime: {},
        previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
        cost_usd: null,
      },
      lanes: [],
      tasks: [planTask('run-a', 'running', { milestone_id: 'ms-cur' })],
      edges: [],
      milestones,
      burnup: [],
      task_progress: {
        totals: {
          done: 0,
          running: 1,
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
      usage: [],
      models: [],
      merges: [],
      findings: [],
      risks: [],
    }) as BoardModel;
  const view = (milestones: BoardModel['milestones']) =>
    renderToStaticMarkup(
      createElement(BoardView, {
        model: board(milestones),
        page: 'now',
        loading: false,
        error: null,
        onRetry() {},
        range: 7,
        onRange() {},
        onPage() {},
        onOpenSession() {},
        onOpenStory() {},
        onOpenTrace() {},
      }),
    );

  it('shows the progress once, on the milestone card, else in the task progress strip', () => {
    const withCard = view([milestone]);
    expect(withCard.match(/class="bms-frac"/g)).toHaveLength(1);
    expect(withCard).not.toContain('class="bd-tp"');
    const without = view([]);
    expect(without.match(/class="bd-tp"/g)).toHaveLength(1);
    expect(without).not.toContain('bms-frac');
    for (const html of [withCard, without]) {
      expect(html).not.toContain('状态计数');
      expect(html).not.toContain('>任务完成</h2>');
    }
  });
});

describe('milestone acceptance evidence', () => {
  it('defaults to the merged sessions of the milestone in its own order', () => {
    const milestone = { session_ids: ['a', 'b', 'c', 'd', 'e'] };
    const merges = [{ session_id: 'c' }, { session_id: 'outside' }];
    const sessions = [
      { id: 'a', outcome: 'merged' as const },
      { id: 'b', outcome: 'discarded' as const },
      { id: 'd' },
      { id: 'other', outcome: 'merged' as const },
    ];
    expect(acceptanceEvidence(milestone, merges, sessions)).toEqual(['session:a', 'session:c']);
  });

  it('is empty when none of its sessions is merged', () => {
    expect(acceptanceEvidence({ session_ids: ['a'] }, [], [{ id: 'a' }])).toEqual([]);
  });
});

describe('board refresh', () => {
  const each = (name: string, kinds: string[]) =>
    kinds.map((kind): [string, string[]] => [`${name}${kind}`, [kind]]);
  it.each<[string, string[]]>([
    [
      'reads the board again when a review finding is recorded or resolved',
      ['review.finding_recorded', 'review.finding_resolved'],
    ],
    [
      'reads the board again when a plan changes or moves, or a worker reports',
      ['board.plan_updated', 'board.plan_transferred', 'task.reported'],
    ],
    ...each('reads the board again after ', [
      'task.stop_requested',
      'task.dispatch_failed',
      'task.dispatched',
      'board.lead_wake_failed',
      'session.merge_stuck',
    ]),
    ...each('reads the board again when a task is claimed, released or messaged: ', [
      'task.claimed',
      'task.released',
      'task.messaged',
    ]),
    ...each('reads the board again when what waits for the user changes: ', [
      'workflow.policy_changed',
      'workflow.step_changed',
      'workflow.definition_trial_completed',
      'workflow.definition_trial_decided',
      'board.plan_proposed',
      'board.plan_proposal_resolved',
      'improvement.status_changed',
      'lead.question_asked',
    ]),
  ])('%s', (_name, kinds) => {
    for (const kind of kinds) expect(changesBoard(kind)).toBe(true);
  });
});
