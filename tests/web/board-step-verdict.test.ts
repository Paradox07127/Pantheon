import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { RequestCard } from '@/components/RequestCard';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { needActions, needCommand, type BoardNeed } from '@/screens/board/frame-model';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { runtimeName } from '@/components/RuntimeGlyph';

type Task = BoardModel['tasks'][number];
type StepRun = NonNullable<Task['step_runs']>[number];

const NOW = Date.UTC(2026, 10, 12, 12);
const noop = () => {};
const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;

const stepRun = (extra: Partial<StepRun>): StepRun => ({
  id: 'step-run-1',
  slot: 'before_merge',
  step_id: 'check-export',
  workflow_id: 'project-a',
  title: 'Check the export',
  kind: 'prompt',
  state: 'running',
  session_id: 'session-1',
  created_at: NOW - 60_000,
  ...extra,
});

const task = (runs: StepRun[]): Task =>
  ({
    id: 'lead-1:export',
    owner_session_id: 'lead-1',
    title: 'Reconciliation CSV export',
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'waiting',
    state: 'waiting_approval',
    blockers: [],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'pass',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
    claim: { session_id: 'session-1', runtime: 'claude', model: null },
    step_runs: runs,
  }) as Task;

const need = (status: string): BoardNeed =>
  ({
    source: { table: 'workflow_step_runs', id: 'step-run-1', revision: 2 },
    kind: 'workflow.approval',
    project_id: 'project-a',
    session_id: 'session-1',
    task_id: 'lead-1:export',
    status,
    created_at: NOW - 60_000,
    reason: 'workflow_approval',
    decision: 'other',
    primary: 'workflow.step.decide',
    step_title: 'Check the export',
    actions: [
      { command: 'workflow.step.decide', allowed: true, decision: 'approve' },
      { command: 'workflow.step.decide', allowed: true, decision: 'reject' },
    ],
    unblocks: 1,
  }) as BoardNeed;

const run = vi.fn(async (..._args: unknown[]) => null as string | null);

/** The drawer's workflow step section, drawn from the props the drawer gives it; undefined without one. */
function section(runs: StepRun[], needs: BoardNeed[] = []) {
  const drawer = mount(() =>
    TaskDrawer({
      model: {
        since: NOW - 86_400_000,
        now: NOW,
        lanes: [],
        edges: [],
        merges: [],
        tasks: [task(runs)],
        needs,
      } as unknown as BoardModel,
      taskId: 'lead-1:export',
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
      tell: { sessions: [lead], run },
    }),
  );
  const element = nodes(drawer.value).find(
    (n) => typeof n.type === 'function' && n.type.name === 'WorkflowStep',
  );
  return (
    element && mount(() => (element.type as (p: object) => ReactNode)(element.props as object))
  );
}

const heading = (tree: unknown) => {
  const shown = find(tree as never, (n) => n.type === 'section');
  const id = shown.props['aria-labelledby'];
  return text(find(shown, (n) => n.props.id === id));
};
const buttons = (tree: unknown) => nodes(tree as never).filter((n) => n.type === 'button');
const rows = (tree: unknown) => nodes(tree as never).filter((n) => n.type === 'li');
const imgNames = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.props.role === 'img')
    .map((n) => n.props['aria-label']);

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  run.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the workflow step in the task drawer', () => {
  it('lets the user count a step that ended without a verdict as passed or failed', async () => {
    const inconclusive = [stepRun({ state: 'inconclusive' })];
    const shown = section(inconclusive, [need('inconclusive')])!;
    expect(heading(shown.value)).toBe(zh('board.task.drawer.workflowStep'));
    const all = text(shown.value);
    expect(all).toContain('Check the export');
    expect(all).toContain(zh('board.task.step.noVerdict'));
    expect(all).toContain(zh('board.task.step.noVerdictLine'));
    expect(buttons(shown.value).map(text)).toEqual([
      zh('board.needs.actions.countPassed'),
      zh('board.needs.actions.countFailed'),
    ]);
    for (const [index, decision] of (['approve', 'reject'] as const).entries()) {
      run.mockClear();
      const fresh = section(inconclusive, [need('inconclusive')])!;
      await buttons(fresh.value)[index]!.props.onClick();
      expect(run).toHaveBeenCalledWith(
        'workflow.step.decide',
        { step_run_id: 'step-run-1', decision },
        null,
      );
    }
  });

  it('shows a passed step with its summary and the evidence the turn checked', () => {
    const shown = section([
      stepRun({
        state: 'passed',
        verdict: {
          verdict: 'pass',
          summary: 'The export writes one row per refund.',
          evidence: [
            { kind: 'command', ref: 'pnpm test --filter export', checked: true, exit_code: 0 },
            { kind: 'file', ref: 'src/refunds/export.ts', checked: true },
          ],
          turn_id: 'turn-1',
          at: NOW,
        },
      }),
    ])!;
    const all = text(shown.value);
    expect(all).toContain(zh('board.task.step.passed'));
    expect(all).toContain('The export writes one row per refund.');
    const evidence = rows(shown.value);
    expect(evidence.map(text)).toEqual([
      `pnpm test --filter export${zhf('board.task.step.exit', { code: 0 })}`,
      'src/refunds/export.ts',
    ]);
    expect(evidence.map(imgNames)).toEqual([
      [zh('board.task.step.checked')],
      [zh('board.task.step.checked')],
    ]);
    expect(buttons(shown.value)).toEqual([]);
  });

  it('shows a failed step with its evidence and that it went back to the lead', () => {
    const shown = section([
      stepRun({
        state: 'failed',
        finished_at: NOW - 180_000,
        verdict: {
          verdict: 'fail',
          summary: 'The CSV header misses the currency column.',
          evidence: [
            {
              kind: 'command',
              ref: 'node scripts/export-sample.mjs',
              checked: true,
              exit_code: 1,
            },
          ],
          turn_id: 'turn-1',
          at: NOW,
        },
      }),
    ])!;
    const all = text(shown.value);
    expect(all).toContain(zh('board.task.step.failed'));
    expect(all).toContain('The CSV header misses the currency column.');
    expect(all).toContain(zhf('board.task.step.exit', { code: 1 }));
    expect(all).toContain(zh('board.task.step.wentBack'));
  });

  it('lists each reviewer of a review step with the verdict it gave or none', () => {
    const shown = section([
      stepRun({
        title: 'Review the export',
        kind: 'review',
        state: 'passed',
        reviewers: [
          { runtime: 'claude', verdict: 'pass', summary: 'Columns match the ledger export.' },
          { runtime: 'codex' },
        ],
      }),
    ])!;
    expect(text(shown.value)).toContain('Review the export');
    expect(rows(shown.value).map(text)).toEqual([
      `${runtimeName('claude')}${zh('board.task.step.reviewPass')}Columns match the ledger export.`,
      `${runtimeName('codex')}${zh('board.task.step.reviewNone')}`,
    ]);
  });

  it('marks evidence the turn did not check as not checked', () => {
    const shown = section([
      stepRun({
        state: 'failed',
        verdict: {
          verdict: 'fail',
          summary: 'Lint not run.',
          evidence: [{ kind: 'command', ref: 'pnpm lint --filter export', checked: false }],
          turn_id: 'turn-1',
          at: NOW,
        },
      }),
    ])!;
    const [row] = rows(shown.value);
    expect(text(row)).toBe(`pnpm lint --filter export${zh('board.task.step.notChecked')}`);
    expect(imgNames(row)).toEqual([zh('board.task.step.unchecked')]);
  });

  it('shows no section for a step that asks for no verdict and has none', () => {
    expect(section([stepRun({ kind: 'command', state: 'passed' })])).toBeUndefined();
    expect(
      section([stepRun({ kind: 'approval', state: 'waiting' })], [need('waiting')]),
    ).toBeUndefined();
  });

  it('reads the newest step run that was not skipped', () => {
    const shown = section([
      stepRun({ state: 'inconclusive' }),
      stepRun({ id: 'step-run-2', title: 'Skipped step', state: 'skipped' }),
    ])!;
    expect(text(shown.value)).toContain(zh('board.task.step.noVerdict'));
  });
});

describe('a needs-you row for a step without a verdict', () => {
  it('counts the step as passed or failed, sending the same decisions as approve and reject', () => {
    const item = need('inconclusive');
    expect(needActions(item).map((a) => [a.key, a.label])).toEqual([
      ['approve', zh('board.needs.actions.countPassed')],
      ['reject', zh('board.needs.actions.countFailed')],
      ['open', zh('board.needs.actions.open')],
    ]);
    for (const decision of ['approve', 'reject'] as const)
      expect(needCommand(item, decision)).toEqual({
        type: 'workflow.step.decide',
        input: { step_run_id: 'step-run-1', decision },
        revision: null,
      });
  });

  it('keeps approve and reject for an approval step that waits', () => {
    expect(needActions(need('waiting')).map((a) => [a.key, a.label])).toEqual([
      ['approve', zh('board.needs.actions.approveStep')],
      ['reject', zh('board.needs.actions.rejectStep')],
      ['open', zh('board.needs.actions.open')],
    ]);
  });

  it('names the row No verdict with the step title, Count as passed first and Count as failed in its menu', () => {
    const row = mount(() =>
      RequestCard({
        item: need('inconclusive'),
        size: 'compact',
        who: 'Reconciliation CSV export',
        now: NOW,
        run,
        onOpenSession: noop,
      }),
    ).value;
    const all = text(row);
    expect(all).toContain(zh('board.needs.kind.noVerdict'));
    expect(all).toContain('Check the export');
    expect(all).not.toContain(zh('data.reason.workflowApproval'));
    // The menu's trigger is a prop of the menu, so the row's own buttons are the inline ones.
    expect(buttons(row).map((b) => b.props['aria-label'])).toEqual([
      `${zh('board.needs.actions.countPassed')} Reconciliation CSV export`,
    ]);
    const menu = nodes(row).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'MenuItem',
    );
    expect(menu.map(text)).toContain(zh('board.needs.actions.countFailed'));
  });
});
