import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { inputSchemas, type BoardModel } from '@pantheon/protocol';
import { find, named, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'loading' } }),
}));
const { runCommand, reads } = vi.hoisted(() => ({
  runCommand: vi.fn(),
  reads: { current: {} as Record<string, unknown> },
}));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/runtime-models', () => ({ useRuntimeModels: () => ({}) }));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (method: string) => ({
    read: reads.current[method] ?? null,
    error: null,
    unavailable: false,
    loading: false,
    reload() {},
  }),
}));
import { clearPlanEdit } from '@/data/plan-edit';
import { PlanEdit } from '@/screens/board/PlanEdit';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 14, 12);
const task = {
  id: 'lead-1:a',
  owner_session_id: 'lead-1',
  title: 'task a',
  goal: 'goal a',
  scope: [],
  lane_id: 'lead-1:main',
  milestone_id: null,
  status: 'todo',
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
  state: 'todo',
  depends_on: [],
  planned: {},
  pending_edit: false,
} as unknown as BoardModel['tasks'][number];
const model = {
  since: NOW - 3_600_000,
  now: NOW,
  counts: { median_ms: null },
  lanes: [{ id: 'lead-1:main', title: 'main' }],
  merges: [],
  edges: [],
  milestones: [],
  tasks: [task],
  leads: [
    {
      session_id: 'lead-1',
      title: 'lead',
      state: 'idle',
      inbox: 0,
      updated_at: 0,
      plan_version: 3,
      pending_edits: [],
      rejected_edits: [],
    },
  ],
} as unknown as BoardModel;
const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;
const target = { projectId: 'project-a', leadId: 'lead-1', planId: 'a', taskId: 'lead-1:a' };

const projectRead = (planTask: object) => ({
  plans: [
    {
      lead_session_id: 'lead-1',
      plan_version: 3,
      pending_edits: [],
      tasks: [
        {
          id: 'a',
          title: 'task a',
          goal: 'Add retries',
          lane: 'main',
          depends_on: [],
          source: ['Add retries'],
          scope: ['src/retry'],
          acceptance: ['pnpm test'],
          ...planTask,
        },
      ],
    },
  ],
  milestones: [],
});

function fields() {
  const drawer = mount(() =>
    PlanEdit({ model, task, target, lead, run: async () => null, onClose() {} }),
  );
  const element = named(drawer.value, 'ContractFields');
  return mount(() => (element.type as (p: object) => ReactElement<any>)(element.props));
}
const label = (tree: unknown, name: string) =>
  find(tree as never, (n) => n.props['aria-label'] === name).props;

beforeEach(() => {
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
  reads.current = {
    'project.read': projectRead({}),
    'workflow.definition.list': [
      { id: 'project-a', name: 'Default', version: 2, is_default: true },
      { id: 'wf-fast', name: 'Fast', version: 1, is_default: false },
    ],
  };
});
afterEach(() => {
  unmountAll();
  clearPlanEdit('lead-1:a');
});

describe('the workflow a plan task takes', () => {
  it.each(
    [
      {
        name: "offers the default and each of the project's workflows and sends the one picked",
        named: undefined,
        picked: 'wf-fast',
        patch: { workflow_id: 'wf-fast' },
      },
      {
        name: 'sets a task that names a workflow back to the default one with null',
        named: 'wf-fast',
        picked: '',
        patch: { workflow_id: null },
      },
    ].map((row) => [row.name, row] as const),
  )('%s', async (_name, { named, picked, patch }) => {
    if (named) reads.current['project.read'] = projectRead({ workflow_id: named });
    const h = fields();
    const pick = () => label(h.value, zh('board.plan.field.workflow'));
    expect(pick().value).toBe(named ?? '');
    expect((pick().options as { value: string; label: string }[]).map((o) => o.label)).toEqual([
      zh('board.plan.field.pathDefault'),
      'Default',
      'Fast',
    ]);
    expect((pick().options as { value: string }[])[0]!.value).toBe('');
    pick().onChange(picked);
    h.render();
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('board.plan.contract.save'),
    ).props.onClick();
    await h.flush();
    const [, input] = runCommand.mock.calls[0]!;
    expect(input.ops).toEqual([{ type: 'set_task', task_id: 'a', patch }]);
    expect(
      inputSchemas['board.plan.edit'].safeParse({
        project_id: 'project-a',
        lead_session_id: 'lead-1',
        base_version: 3,
        ops: input.ops,
      }).success,
    ).toBe(true);
  });
});
