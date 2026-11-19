import { afterEach, describe, expect, it } from 'vitest';
import type { BoardBlocker, BoardModel } from '@pantheon/protocol';
import { setLocaleSync } from '@/i18n';
import { eventSummary } from '@/data/logs';
import { blockerTexts, listedTitle, nextStepText } from '../../apps/web/src/lib/daemon-text.js';
import { taskBadges } from '../../apps/web/src/screens/board/activity.js';
import { zh, zhCatalog } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

afterEach(() => setLocaleSync('zh-CN', zhCatalog()));

const task = (
  blockers: string[],
  blocker_codes: BoardBlocker[] | undefined,
  patch: Partial<Task> = {},
): Task => ({
  id: 'lead:a',
  title: 'Export',
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'running',
  blockers,
  ...(blocker_codes ? { blocker_codes } : {}),
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

const STUCK = 'The user checks the stuck merge and cancels it if needed.';

describe('next steps the daemon writes', () => {
  it('words a known reason in the interface language', () => {
    expect(nextStepText({ reason: 'merge_stuck', next_step: STUCK })).toBe(
      zh('daemon.nextStep.mergeStuck'),
    );
    expect(
      nextStepText({
        reason: 'project_over_budget',
        next_step: 'over budget',
        project_budget: { used_input_tokens: 150, input_tokens: 100 },
      }),
    ).toContain('项目从设预算起已用 150 输入 token，预算 100；');
    expect(
      nextStepText({
        reason: 'plan_decisions_over_budget',
        next_step: '3 decisions from the plan did not fit',
        memory_notes: { count: 3, memory_ids: ['m1', 'm2', 'm3'] },
      }),
    ).toContain('计划里有 3 条决定超出记忆的决定预算');
    setLocaleSync('en', {});
    expect(nextStepText({ reason: 'merge_stuck', next_step: STUCK })).toBe(STUCK);
  });

  it("shows the daemon's text for a reason the interface does not know, and none without one", () => {
    expect(nextStepText({ reason: 'gate_failed', next_step: 'Fix the gate' })).toBe('Fix the gate');
    expect(nextStepText({ reason: 'merge_stuck' })).toBeUndefined();
  });
});

describe('board blockers the daemon writes', () => {
  const coded = task(
    [
      'Queued: waiting for dependencies (the session could not open: no runtime)',
      'Dependency “Parse” is not finished',
      'Merge blocked: conflict, 1 conflicting files',
    ],
    [
      { code: 'queued', error: 'no runtime' },
      { code: 'upstream', title: 'Parse' },
      { code: 'merge_blocked', reason: 'conflict', conflicts: 1 },
    ],
    { dispatch_wait: 'upstream' },
  );

  it('words each blocker by its code in the interface language', () => {
    expect(blockerTexts(coded)).toEqual([
      '排队中：等待依赖（会话开不起来：no runtime）',
      '依赖任务「Parse」未完成',
      '合并受阻：改动冲突，1 个冲突文件',
    ]);
    expect(taskBadges(task(['Turn failed'], [{ code: 'turn_failed' }]))).toEqual([
      { kind: 'blocked', label: '阻塞：回合失败' },
    ]);
    setLocaleSync('en', {});
    expect(blockerTexts(coded)).toEqual([
      'Queued: waiting for dependencies (the session could not open: no runtime)',
      'Dependency “Parse” is not finished',
      'Merge blocked: Changes conflict, 1 conflicting file',
    ]);
  });

  it("shows the daemon's text for a code the interface does not know or without codes", () => {
    const unknown = { code: 'paused' } as unknown as BoardBlocker;
    expect(
      blockerTexts(task(['Paused by the user', 'Turn failed'], [unknown, { code: 'turn_failed' }])),
    ).toEqual(['Paused by the user', zh('daemon.blocker.turnFailed')]);
    expect(blockerTexts(task(['Turn failed'], undefined))).toEqual(['Turn failed']);
    expect(
      blockerTexts(
        task(
          ['Merge blocked: odd_code, 0 conflicting files'],
          [{ code: 'merge_blocked', reason: 'odd_code', conflicts: 0 }],
        ),
      ),
    ).toEqual(['合并受阻：odd_code']);
  });
});

describe('listed session titles', () => {
  const at = new Date(2026, 10, 2, 9, 18).getTime();

  it('names a baseline session without a title by its start time', () => {
    expect(listedTitle({ title: '', baseline_started_at: at })).toMatch(/^摸底 11.02.* 09:18$/);
    setLocaleSync('en', {});
    expect(listedTitle({ title: '', baseline_started_at: at })).toMatch(/^Baseline 11.02.* 09:18$/);
    expect(listedTitle({ title: 'Own title', baseline_started_at: at })).toBe('Own title');
  });
});

describe('deleted session titles', () => {
  const deleted = (payload: unknown) =>
    eventSummary({
      sequence: 1,
      event_id: 'event-1',
      kind: 'session.deleted',
      aggregate_id: 'a',
      aggregate_revision: 1,
      project_id: 'project-a',
      causation_id: '',
      created_at: 1,
      payload,
    });

  it('names an untitled deleted session by its baseline start, else without a title', () => {
    const at = new Date(2026, 10, 2, 9, 18).getTime();
    expect(deleted({ title: '', baseline_started_at: at })).toMatch(
      /^删除会话 摸底 11.02.* 09:18$/,
    );
    expect(deleted({ title: '' })).toBe(zh('data.logs.sessionDeletedUntitled'));
    setLocaleSync('en', {});
    expect(deleted({ title: '' })).toBe('Deleted session');
  });
});
