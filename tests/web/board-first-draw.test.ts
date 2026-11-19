import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, mount, named, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import type { BoardPage } from '../../apps/web/src/data/board-page.js';
import { BoardView } from '../../apps/web/src/screens/board/BoardScreen.js';
import type { BoardNeed } from '../../apps/web/src/screens/board/frame-model.js';
import type { SnapshotSession } from '../../apps/web/src/screens/board/panels-model.js';
import { useShell } from '../../apps/web/src/store.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const proposal: BoardNeed = {
  source: { table: 'improvements', id: 'improvement-1', revision: 1 },
  kind: 'improvement.candidate',
  project_id: 'project-a',
  status: 'candidate',
  created_at: NOW - 60_000,
  reason: 'improvement_awaiting_decision',
  actions: [{ command: 'improvement.decide', allowed: true }],
  unblocks: 0,
} as BoardNeed;

const board = (): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    headline: { text: 'Ship the importer', by_session: null, updated_at: NOW },
    counts: {
      running: 1,
      waiting: 0,
      ready: 0,
      failed: 0,
      merged: 0,
      median_ms: null,
      tokens: 0,
      tokens_by_runtime: {},
      cost_usd: null,
    },
    lanes: [],
    tasks: [],
    edges: [],
    milestones: [],
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
    needs: [proposal],
  }) as unknown as BoardModel;

const hosts: HookHost<any>[] = [];
afterEach(() => {
  unmountAll();
  hosts.splice(0).forEach((h) => h.unmount());
});

const noop = () => {};
const view = (props: Partial<Parameters<typeof BoardView>[0]>) =>
  BoardView({
    loading: false,
    error: null,
    onRetry: noop,
    page: 'tasks',
    onPage: noop,
    projectId: 'project-a',
    onOpenSession: noop,
    onOpenStory: noop,
    onOpenTrace: noop,
    model: null,
    ...props,
  });

/** Which parts of the view under the bar, and of the bar's actions, the tree holds. */
function parts(tree: ReactNode) {
  const all = nodes(tree);
  const has = (className: string) => all.some((n) => n.props.className === className);
  const element = (name: string) => {
    try {
      return !!named(tree, name);
    } catch {
      return false;
    }
  };
  return {
    publish: has('bd-pub'),
    actions: has('tb-end'),
    plan: element('LeadPlan'),
    main: element('MainView'),
  };
}

const none = {
  publish: false,
  actions: false,
  plan: false,
  main: false,
};
const full = { publish: true, actions: true, plan: true, main: true };

describe('board first draw', () => {
  it('draws everything under the view tabs in one go once the board and its sessions are in', () => {
    const sessions: SnapshotSession[] = [];
    let props: Partial<Parameters<typeof BoardView>[0]> = {
      model: board(),
      sessionsPending: true,
      actions: undefined,
    };
    // Not rendered until the first step.
    const h = new HookHost(() => view(props));
    hosts.push(h);
    const seen: ReturnType<typeof parts>[] = [];
    const step = (next: typeof props) => {
      props = { ...props, ...next };
      h.render();
      seen.push(parts(h.value));
    };

    // The board read lands first, the sessions next.
    step({});
    step({
      sessionsPending: false,
      actions: { milestones: [], sessions, run: async () => null },
    });
    // A read that runs again later updates in place.
    step({ model: board(), loading: true });

    expect(seen).toEqual([none, full, full]);
  });

  it('tells the notice cards its needs-you list is not in before the first draw, and empty when it draws without one', () => {
    useShell.setState({ boardWaits: new Set(['approval-of-another-project']) });
    let props: Partial<Parameters<typeof BoardView>[0]> = { sessionsPending: true, loading: true };
    const h = mount(() => view(props));
    expect(useShell.getState().boardWaits).toBeNull();
    props = { sessionsPending: false, loading: false, error: 'The daemon is offline' };
    h.render();
    expect(useShell.getState().boardWaits).toEqual(new Set());
  });

  it('tells the notice cards every approval its needs-you list holds, on the chart or not, on the overview only', () => {
    const approval = {
      source: { table: 'approvals', id: 'approval-1', revision: 1 },
      kind: 'permission',
      project_id: 'project-a',
      session_id: 'worker-1',
      task_id: 'lead-1:migrate',
      status: 'pending',
      created_at: NOW - 60_000,
      reason: 'permission_requested',
      actions: [{ command: 'approval.respond', allowed: true }],
      unblocks: 0,
    } as BoardNeed;
    const model = {
      ...board(),
      tasks: [
        {
          id: 'lead-1:migrate',
          owner_session_id: 'lead-1',
          title: 'migrate',
          goal: '',
          scope: [],
          lane_id: null,
          milestone_id: null,
          depends_on: [],
          planned: {},
          additions: null,
          deletions: null,
          checks: 'none',
          started_at: null,
          ended_at: null,
          last_progress_at: null,
          blocked_since: null,
          turn_running: false,
          status: 'waiting',
          state: 'waiting_approval',
          blockers: [],
          segments: [],
          activity: {
            phase: 'waiting_approval',
            since: NOW - 60_000,
            health: 'fresh',
            attempt: 1,
            waiting: {
              kind: 'approval',
              summary: 'pnpm migrate',
              approval_id: 'approval-1',
              since: NOW - 60_000,
            },
          },
        },
      ],
      needs: [
        proposal,
        approval,
        {
          ...approval,
          source: { table: 'approvals', id: 'approval-2', revision: 1 },
          session_id: 'direct-1',
          task_id: undefined,
        },
      ],
    } as unknown as BoardModel;
    const actions = { milestones: [], sessions: [], run: async () => null };
    let page: BoardPage = 'overview';
    const h = mount(() => view({ model, actions, page }));
    expect(useShell.getState().boardWaits).toEqual(new Set(['approval-1', 'approval-2']));
    page = 'tasks';
    h.render();
    expect(useShell.getState().boardWaits).toEqual(new Set());
  });
});
