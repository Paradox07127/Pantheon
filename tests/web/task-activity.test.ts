import { describe, expect, it } from 'vitest';
import type { BoardActivity, BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import {
  activityLine,
  displayStatus,
  phaseText,
  taskBadges,
} from '../../apps/web/src/screens/board/activity.js';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 3, 12);
const MIN = 60_000;

const task = (status: BoardTaskStatus, patch: Partial<Task> = {}): Task => ({
  id: 'lead:t1',
  title: 'import the ledger',
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
  ...patch,
});

const activity = (patch: Partial<BoardActivity>): BoardActivity => ({
  phase: 'thinking',
  since: NOW - 3 * MIN,
  health: 'fresh',
  attempt: 1,
  ...patch,
});

const waiting = (kind: 'approval' | 'input', summary: string) => ({
  kind,
  summary,
  approval_id: 'ap-1',
  since: NOW - 3 * MIN,
});

const running = (patch: Partial<BoardActivity>, task_patch: Partial<Task> = {}) =>
  task('running', { ...task_patch, activity: activity(patch) });

const recap = { headline: 'Ledger imported', needs_you: 'Keep the old ids?', happened: '', at: 0 };

describe('activity line', () => {
  it('names the tool call under way with its target and how long it has run', () => {
    expect(
      activityLine(running({ phase: 'tool', tool: { name: 'Bash', target: 'pnpm test' } }), NOW),
    ).toBe(`${zh('runs.table.verb.run')} pnpm test，3 分钟`);
    expect(activityLine(running({ phase: 'tool', tool: { name: 'Read' } }), NOW)).toBe(
      `${zh('runs.table.verb.read')}，3 分钟`,
    );
  });

  it('quotes the request a waiting session asks the user about', () => {
    const approval = running({
      phase: 'waiting_approval',
      waiting: waiting('approval', 'rm -rf dist'),
    });
    expect(activityLine(approval, NOW)).toBe('等待审批 rm -rf dist');
    const input = running({ phase: 'waiting_input', waiting: waiting('input', 'which branch?') });
    expect(activityLine(input, NOW)).toBe('等待回答 which branch?');
  });

  it.each<[string, Task, string | null]>([
    [
      'shows the failed turn error',
      running({ phase: 'idle', turn_error: 'rate limited' }),
      '回合失败：rate limited',
    ],
    [
      'shows what a queued task waits for',
      running({ phase: 'queued' }, { blockers: ['schema lands first', 'review'] }),
      '排队：schema lands first',
    ],
    [
      'says queued once when the blocker already says it',
      running(
        { phase: 'queued' },
        {
          blockers: ['Queued: waiting for dependencies'],
          blocker_codes: [{ code: 'queued' }],
          dispatch_wait: 'upstream',
        },
      ),
      zh('daemon.blocker.queued.upstream'),
    ],
    [
      'says a starting session is getting ready',
      running({ phase: 'starting' }),
      zh('board.task.phase.starting'),
    ],
    ['is empty for a task without activity', task('done'), null],
    [
      'names a sub-agent call by its verb, not the SDK tool name',
      running({ phase: 'tool', tool: { name: 'Task', target: 'Find the store' } }),
      `${zh('runs.table.verb.subagent')} Find the store，3 分钟`,
    ],
    [
      'shows the recap headline of an idle task',
      task('idle', { activity: activity({ phase: 'idle' }), recap, blockers: ['needs a key'] }),
      'Ledger imported',
    ],
    [
      'shows the recap headline of a task ready to merge',
      task('ready', { activity: activity({ phase: 'idle' }), recap }),
      'Ledger imported',
    ],
    [
      'shows what a waiting task needs from its recap',
      task('waiting', {
        activity: activity({ phase: 'waiting_input', waiting: waiting('input', 'which branch?') }),
        recap,
      }),
      'Keep the old ids?',
    ],
    [
      'keeps the tool call under way over the recap',
      running({ phase: 'tool', tool: { name: 'Read' } }, { recap }),
      `${zh('runs.table.verb.read')}，3 分钟`,
    ],
    [
      'keeps thinking under way over the recap',
      running({ phase: 'thinking' }, { recap }),
      '思考中，3 分钟',
    ],
    [
      'keeps the failed turn error over the recap',
      task('idle', { activity: activity({ phase: 'idle', turn_error: 'rate limited' }), recap }),
      '回合失败：rate limited',
    ],
    [
      'says a merge its gates failed is blocked without naming conflicts it has none of',
      task('ready', {
        activity: activity({ phase: 'idle' }),
        blockers: ['Merge blocked: gate_failed, 0 conflicting files'],
        blocker_codes: [{ code: 'merge_blocked', reason: 'gate_failed', conflicts: 0 }],
      }),
      `合并受阻：${zh('data.reason.gateFailed')}`,
    ],
    [
      'counts the conflicting files of a blocked merge that has some',
      task('ready', {
        activity: activity({ phase: 'idle' }),
        blockers: ['Merge blocked: gate_failed, 2 conflicting files'],
        blocker_codes: [{ code: 'merge_blocked', reason: 'gate_failed', conflicts: 2 }],
      }),
      `合并受阻：${zh('data.reason.gateFailed')}，2 个冲突文件`,
    ],
  ])('%s', (_, t, line) => {
    expect(activityLine(t, NOW)).toBe(line);
  });

  it('counts gate, merge and thinking time', () => {
    expect(activityLine(running({ phase: 'gate' }), NOW)).toBe('检查中，3 分钟');
    expect(activityLine(running({ phase: 'merging' }), NOW)).toBe('合并中，3 分钟');
    expect(activityLine(running({ phase: 'thinking' }), NOW)).toBe('思考中，3 分钟');
  });

  it('shows the first blocker of an idle task and nothing for an idle task without one', () => {
    expect(activityLine(running({ phase: 'idle' }, { blockers: ['needs a key'] }), NOW)).toBe(
      'needs a key',
    );
    expect(activityLine(running({ phase: 'idle' }), NOW)).toBeNull();
  });
});

describe('phase text', () => {
  it('pairs the phase with how long it has lasted', () => {
    expect(phaseText(running({ phase: 'thinking' }), NOW)).toBe('思考中，3 分钟');
    expect(phaseText(running({ phase: 'waiting_approval' }), NOW)).toBe('待批准，3 分钟');
  });

  it('falls back to the status word without activity', () => {
    expect(phaseText(task('done'), NOW)).toBe(zh('board.task.status.done'));
  });

  it("leaves the phase's age off a stalled, looping or failed word, which began later", () => {
    const long = { phase: 'thinking' as const, since: NOW - 40 * MIN };
    expect(phaseText(running({ ...long, health: 'stalled' }), NOW)).toBe(
      zh('board.task.health.stalled'),
    );
    expect(phaseText(running({ ...long, health: 'looping' }), NOW)).toBe(
      zh('board.task.health.looping'),
    );
    expect(phaseText(running({ ...long, turn_error: 'rate limited' }), NOW)).toBe(
      zh('board.task.status.failed'),
    );
  });
});

describe('task badges', () => {
  it('lists every badge in order', () => {
    const all = running(
      {
        phase: 'waiting_approval',
        waiting: waiting('approval', 'push'),
        health: 'stalled',
        attempt: 2,
        handed_back: ['rebase_conflict', 'gate_failed'],
      },
      { blockers: ['needs a key', 'review'] },
    );
    expect(taskBadges(all)).toEqual([
      { kind: 'waiting', label: zh('board.task.phase.waitingApproval'), waits: 'approval' },
      { kind: 'blocked', label: '阻塞：needs a key；review' },
      { kind: 'stalled', label: zh('board.task.health.stalled') },
      { kind: 'attempt', label: '尝试第 2 次', count: 2 },
      { kind: 'handed_back', label: '交回：变基到源分支时有冲突；落回门禁没通过' },
    ]);
  });

  it('names the distinct reasons a task was handed back instead of counting hand-backs', () => {
    const once = running({ phase: 'thinking', handed_back: ['gate_failed'] });
    expect(taskBadges(once)).toEqual([{ kind: 'handed_back', label: '交回：落回门禁没通过' }]);
  });

  it('marks a looping turn and an answer the session waits for', () => {
    const looping = running({
      phase: 'waiting_input',
      waiting: waiting('input', 'which?'),
      health: 'looping',
    });
    expect(taskBadges(looping)).toEqual([
      { kind: 'waiting', label: zh('board.task.phase.waitingInput'), waits: 'question' },
      { kind: 'looping', label: zh('board.task.health.looping') },
    ]);
  });

  it('marks a task not started that only waits in the queue or on upstream as waiting, in the blockers words', () => {
    const queued = task('todo', {
      blockers: ['排队中：等待依赖', '依赖任务「A」未完成'],
      dispatch_wait: 'upstream',
    });
    expect(taskBadges(queued)).toEqual([
      { kind: 'upstream', label: '排队中：等待依赖；依赖任务「A」未完成' },
    ]);
    const unmet = task('todo', { blockers: ['依赖任务「A」未完成'], blocked_since: NOW - MIN });
    expect(taskBadges(unmet)).toEqual([{ kind: 'upstream', label: '依赖任务「A」未完成' }]);
  });

  it('keeps the blocked mark on a started task held up by a merge', () => {
    const held = running({ phase: 'idle' }, { blockers: ['合并受阻，2 个冲突文件'] });
    expect(taskBadges(held)).toEqual([{ kind: 'blocked', label: '阻塞：合并受阻，2 个冲突文件' }]);
  });

  it('shows no badge for a first attempt in good health', () => {
    expect(taskBadges(running({ phase: 'thinking' }))).toEqual([]);
    expect(taskBadges(task('todo'))).toEqual([]);
  });
});

describe('display status', () => {
  it('puts a pending approval above a failure', () => {
    const t = task('failed', {
      activity: activity({
        phase: 'waiting_approval',
        waiting: waiting('approval', 'push'),
        turn_error: 'boom',
      }),
    });
    expect(displayStatus(t)).toBe('waiting');
    expect(displayStatus(running({ phase: 'waiting_input' }))).toBe('waiting');
  });

  it('puts a failure above a stalled turn', () => {
    expect(displayStatus(running({ phase: 'idle', turn_error: 'boom', health: 'stalled' }))).toBe(
      'failed',
    );
  });

  it('puts a stalled or looping turn above work under way', () => {
    expect(displayStatus(running({ phase: 'tool', health: 'stalled' }))).toBe('failed');
    expect(displayStatus(running({ phase: 'thinking', health: 'looping' }))).toBe('failed');
  });

  it('shows working and quiet turns as running, idle and queued ones as not started', () => {
    expect(displayStatus(running({ phase: 'tool' }))).toBe('running');
    expect(displayStatus(running({ phase: 'thinking', health: 'quiet' }))).toBe('running');
    expect(displayStatus(running({ phase: 'idle' }))).toBe('todo');
    expect(displayStatus(running({ phase: 'queued' }))).toBe('todo');
    expect(displayStatus(task('ready', { activity: activity({ phase: 'idle' }) }))).toBe('ready');
  });

  it('keeps the board status without activity', () => {
    expect(displayStatus(task('done'))).toBe('done');
  });

  it('shows a discarded or done task as such after its last turn failed', () => {
    const failedTurn = activity({ phase: 'idle', turn_error: 'boom' });
    const discarded = task('discarded', { activity: failedTurn });
    expect(displayStatus(discarded)).toBe('discarded');
    expect(phaseText(discarded, NOW)).toBe('已丢弃，3 分钟');
    expect(displayStatus(task('done', { activity: failedTurn }))).toBe('done');
  });
});

describe('cards read from the board', () => {
  it('words an idle task by the status its icon shows', () => {
    expect(phaseText(task('ready', { activity: activity({ phase: 'idle' }) }), NOW)).toBe(
      '待合并，3 分钟',
    );
  });

  it('leaves out a duration under a minute', () => {
    expect(phaseText(running({ phase: 'thinking', since: NOW - 20_000 }), NOW)).toBe(
      zh('board.task.phase.thinking'),
    );
    expect(activityLine(running({ phase: 'gate', since: NOW - 20_000 }), NOW)).toBe(
      zh('board.task.phase.gate'),
    );
  });

  it('shows the first blocker of a task without a session', () => {
    expect(activityLine(task('todo', { blockers: ['依赖任务「A」未完成'] }), NOW)).toBe(
      '依赖任务「A」未完成',
    );
    expect(activityLine(task('todo'), NOW)).toBeNull();
  });
});
