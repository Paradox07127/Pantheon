import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, 1] }),
}));
import { TaskDrawer, type shownStepRun } from '@/screens/board/TaskDrawer';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { runtimeName } from '@/components/RuntimeGlyph';

type Task = BoardModel['tasks'][number];
type StepRun = NonNullable<ReturnType<typeof shownStepRun>>;

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
  title: 'Check the export',
  kind: 'review',
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

const run = vi.fn(async (..._args: unknown[]) => null as string | null);

/** The drawer's workflow step section, drawn from the props the drawer gives it; undefined without one. */
function section(runs: StepRun[]) {
  const drawer = mount(() =>
    TaskDrawer({
      model: {
        since: NOW - 86_400_000,
        now: NOW,
        lanes: [],
        edges: [],
        merges: [],
        milestones: [],
        tasks: [task(runs)],
        needs: [],
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

const rows = (tree: unknown) => nodes(tree as never).filter((n) => n.type === 'li');

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

  it('reads the newest step run that was not skipped', () => {
    const reviewed = (id: string, state: StepRun['state'], summary: string) =>
      stepRun({ id, state, reviewers: [{ runtime: 'claude', verdict: 'pass', summary }] });
    const shown = section([
      reviewed('older-review', 'passed', 'The older round passed.'),
      reviewed('newer-review', 'failed', 'The newest round found a gap.'),
      reviewed('skipped-review', 'skipped', 'The skipped round says nothing.'),
    ])!;
    expect(rows(shown.value).map(text)).toEqual([
      `${runtimeName('claude')}${zh('board.task.step.reviewPass')}The newest round found a gap.`,
    ]);
  });

  it('shows no section for a step that asks for no verdict and has none', () => {
    expect(section([stepRun({ state: 'passed' })])).toBeUndefined();
  });
});
