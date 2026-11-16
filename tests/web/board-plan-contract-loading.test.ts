import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'loading' } }),
}));
const { runCommand, reads } = vi.hoisted(() => ({
  runCommand: vi.fn(),
  reads: {
    current: {} as Record<string, unknown>,
    errors: {} as Record<string, string>,
    stale: new Set<string>(),
    reloads: 0,
  },
}));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/runtime-models', () => ({ useRuntimeModels: () => ({}) }));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (method: string) => ({
    read: reads.current[method] ?? null,
    error: reads.errors[method] ?? null,
    unavailable: false,
    loading: !(method in reads.current) && !(method in reads.errors),
    stale: reads.stale.has(method),
    reload() {
      reads.reloads++;
    },
  }),
}));
import { clearPlanEdit } from '@/data/plan-edit';
import { PlanEdit } from '@/screens/board/PlanEdit';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

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

const projectRead = {
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
          done_when: 'report',
          milestone: 'm-1',
        },
      ],
    },
  ],
  milestones: [
    {
      milestone: { key: 'm-1', title: 'First cut', owner_session_id: 'lead-1' },
    },
  ],
};

function fields() {
  const drawer = mount(() =>
    PlanEdit({ model, task, target, lead, run: async () => null, onClose() {} }),
  );
  const element = named(drawer.value, 'ContractFields');
  return mount(() => (element.type as (p: object) => ReactElement<any> | null)(element.props));
}
const group = (tree: unknown) =>
  find(tree as ReactNode, (n) => n.props.className === 'bd-ct' && n.props.role === 'group');
// The rows of the contract in order: each label, control and list by its name or class.
function rows(tree: unknown): string[] {
  const top = (node: ReactNode): ReactElement<any>[] =>
    Array.isArray(node)
      ? node.flatMap(top)
      : node && typeof node === 'object' && 'props' in node
        ? (node as ReactElement<any>).type === Fragment
          ? top((node as ReactElement<any>).props.children)
          : [node as ReactElement<any>]
        : [];
  return top(group(tree).props.children).map((n) =>
    n.props.className === 'bd-ct-l'
      ? `label:${text(n)}`
      : String(n.props['aria-label'] ?? n.props.className),
  );
}
const controls = (tree: unknown) =>
  nodes(group(tree).props.children).filter((n) => 'disabled' in n.props && n.props['aria-label']);
const label = (tree: unknown, name: string) =>
  find(tree as ReactNode, (n) => n.props['aria-label'] === name).props;

beforeEach(() => {
  runCommand.mockReset();
  reads.current = {
    'workflow.definition.list': [
      { id: 'project-a', name: 'Default', version: 2, is_default: true },
    ],
  };
  reads.errors = {};
  reads.stale = new Set();
  reads.reloads = 0;
});
afterEach(() => {
  unmountAll();
  clearPlanEdit('lead-1:a');
});

describe('the contract of a plan task before its read lands', () => {
  it('stands as its empty rows, disabled and busy', () => {
    const h = fields();
    expect(h.value).not.toBeNull();
    expect(group(h.value).props['aria-busy']).toBe(true);
    expect(rows(h.value).filter((r) => r.startsWith('label:'))).toEqual(
      ['goal', 'scope', 'acceptance', 'doneWhen', 'workflow', 'milestone'].map(
        (field) => `label:${zh(`board.plan.field.${field}`)}`,
      ),
    );
    expect(label(h.value, zh('board.plan.field.goal')).value).toBe('');
    expect(controls(h.value).length).toBeGreaterThan(0);
    expect(controls(h.value).every((n) => n.props.disabled === true)).toBe(true);
    expect(
      find(h.value, (n) => n.type === 'button' && text(n) === zh('board.plan.contract.save')).props
        .disabled,
    ).toBe(true);
    expect(nodes(h.value).some((n) => n.props.className === 'bd-ct-err')).toBe(false);
  });

  it('fills the same rows in place once the read answers, enabled', () => {
    const h = fields();
    const before = rows(h.value);
    reads.current['project.read'] = projectRead;
    h.render();
    expect(rows(h.value)).toEqual(before);
    expect(group(h.value).props['aria-busy']).toBeUndefined();
    expect(label(h.value, zh('board.plan.field.goal')).value).toBe('Add retries');
    expect(label(h.value, zhf('board.plan.contract.scopeItem', { n: 1 })).value).toBe('src/retry');
    expect(label(h.value, zh('board.plan.field.doneWhen')).value).toBe('report');
    expect(label(h.value, zh('board.plan.field.milestone')).value).toBe('m-1');
    expect(label(h.value, zh('board.plan.field.goal')).disabled).toBe(false);
    expect(label(h.value, zh('board.plan.field.milestone')).disabled).toBe(false);
  });
});

describe("the contract of a plan task whose read is not this mount's own", () => {
  const goal = (tree: unknown) => label(tree, zh('board.plan.field.goal'));
  const failure = (tree: unknown) => nodes(tree as ReactNode).find((n) => n.props.role === 'alert');

  it('shows a cached read disabled until this mount reads it again', () => {
    reads.current['project.read'] = projectRead;
    reads.stale.add('project.read');
    const h = fields();
    expect(goal(h.value).value).toBe('Add retries');
    expect(goal(h.value).disabled).toBe(true);
    reads.stale.delete('project.read');
    h.render();
    expect(goal(h.value).disabled).toBe(false);
  });

  it('shows why a first read failed, with a retry that reads again', () => {
    reads.errors['project.read'] = 'The daemon is not reachable';
    const h = fields();
    expect(goal(h.value).disabled).toBe(true);
    expect(text(failure(h.value))).toContain('The daemon is not reachable');
    find(
      failure(h.value),
      (n) => n.type === 'button' && text(n) === zh('components.retry'),
    ).props.onClick();
    expect(reads.reloads).toBe(1);
  });

  it('keeps a cached read disabled while its re-read failed', () => {
    reads.current['project.read'] = projectRead;
    reads.stale.add('project.read');
    reads.errors['project.read'] = 'The daemon is not reachable';
    const h = fields();
    expect(goal(h.value).disabled).toBe(true);
    expect(failure(h.value)).toBeDefined();
  });
});
