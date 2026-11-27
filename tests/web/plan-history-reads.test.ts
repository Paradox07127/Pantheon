import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useLandingRecords, usePlanHistory } from '@/data/plan-history';

let query: ReturnType<typeof vi.fn>;
// Each test reads its own project, so no answer cached by another test shows first.
let projects = 0;
let projectId: string;

beforeEach(() => {
  projectId = `history-project-${++projects}`;
  query = vi.fn(async (method: string) => ({
    ok: true,
    value: method === 'project.plan.history' ? { revisions: [] } : { landings: [] },
  }));
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const reads = (method: string) => query.mock.calls.filter(([called]) => called === method).length;

it.each([
  ['project.plan_updated', 2, 1],
  ['session.merged', 1, 2],
  ['session.merge_dropped', 1, 2],
  ['workspace.removed', 1, 2],
  ['turn.completed', 1, 1],
  ['session.write_detected', 1, 1],
])(
  'after %s reads the revisions and the landings again only when they can change',
  async (kind, plans, landings) => {
    const h = mount(() => [usePlanHistory(projectId), useLandingRecords(projectId)]);
    await h.flush();
    mock.board = { ...mock.board, events: [{ sequence: 9, kind, project_id: projectId }] };
    h.render();
    await h.flush();
    expect([reads('project.plan.history'), reads('project.landings.read')]).toEqual([
      plans,
      landings,
    ]);
  },
);
