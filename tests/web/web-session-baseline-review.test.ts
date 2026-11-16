import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectBaseline } from '@pantheon/domain';
import { find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, openSession: (_id: string) => {} }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSession: mock.openSession }),
}));
import { BaselineReview } from '@/screens/sessions/SessionsScreen';
import { zh, zhf } from './i18n-setup.js';

const session = {
  id: 'baseline-session-a',
  project_id: 'project-a',
  workspace_id: null,
  baseline: { baseline_id: 'baseline-a' },
} as any;
const baseline = (id: string, state: ProjectBaseline['state']): ProjectBaseline => ({
  id,
  revision: 2,
  project_id: 'project-a',
  state,
  facts_id: 'facts-a',
  dropped: 0,
  created_at: 1,
  result: { folders: [], workstreams: [], contradictions: [], findings: [], questions: [] },
});

let read: ProjectBaseline | null;
/** The project introduction's body; undefined for an introduction without one. */
let body: string | undefined;
const introRead = () => ({
  intro: {
    project_id: 'project-a',
    summary: 'A project',
    sources: [],
    features: [],
    modules: [],
    languages: [],
    weeks: [],
    heads: [],
    session_id: null,
    written_at: 1,
    ...(body !== undefined && { body }),
  },
  behind: 0,
  writing_session_id: null,
});
const render = (element: ReactElement<any>) =>
  (element.type as (props: unknown) => ReactNode)(element.props);
/** Renders the review and, when there is one, the form it opens and the task graph in it. */
async function mount() {
  const h = host(() => {
    const review = BaselineReview({ session }) as ReactElement<any> | null;
    if (!review) return review;
    const form = render(review);
    const graph = nodes(form).find(
      (n) => typeof n.type === 'function' && n.type.name === 'TaskGraph',
    );
    return { review, form, graph: graph && render(graph) };
  });
  await h.flush();
  return h;
}

beforeEach(() => {
  read = null;
  body = undefined;
  mock.board = { board: { cursor: 1 }, events: [], resync: 0, status: { state: 'live' } };
  mock.openSession = vi.fn();
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({
        ok: true,
        value:
          method === 'project.facts.read'
            ? { workstreams: [], facts: null }
            : method === 'project.intro.read'
              ? introRead()
              : read,
      })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('shows the review form when the session baseline is the newest one and submitted', async () => {
  read = baseline('baseline-a', 'submitted');
  const h = await mount();
  expect(named(h.value!.review, 'ReviewBaseline').props.baseline).toEqual(read);
  expect(
    find(h.value!.form, (n) => n.props['aria-label'] === zh('projects.baseline.goal')),
  ).toBeTruthy();
});

it.each([
  ['a newer baseline', 'baseline-b', 'submitted'],
  ['a running baseline', 'baseline-a', 'running'],
  ['a confirmed baseline', 'baseline-a', 'confirmed'],
] as const)('shows nothing for %s', async (_, id, state) => {
  read = baseline(id, state);
  const h = await mount();
  expect(h.value).toBeNull();
});

it('waits for the next round after the user asked for more', async () => {
  read = { ...baseline('baseline-a', 'running'), rounds: [{ questions: [], answers: [], at: 1 }] };
  const h = await mount();
  expect(named(h.value!.review, 'ReviewBaseline').props.baseline).toEqual(read);
  expect(named(h.value!.form, 'RunningBaseline')).toBeTruthy();
});

it('opens the lead session once the baseline is confirmed', async () => {
  read = baseline('baseline-a', 'submitted');
  const h = await mount();
  h.value!.review.props.onConfirmed({ ...read, state: 'confirmed', lead_session_id: 'lead-a' });
  expect(mock.openSession).toHaveBeenCalledWith('lead-a');
});

it('stays where the viewer went when the confirmation lands after the thread closed', async () => {
  read = baseline('baseline-a', 'submitted');
  const h = await mount();
  const confirmed = h.value!.review.props.onConfirmed;
  h.unmount();
  confirmed({ ...read, state: 'confirmed', lead_session_id: 'lead-a' });
  expect(mock.openSession).not.toHaveBeenCalled();
});

const task = (id: string, title: string, depends_on: string[] = []) => ({
  id,
  title,
  workstream: 'paging',
  why: `Why ${title}`,
  scope: [`src/${id}.ts`],
  acceptance: [`pnpm test ${id}`, `pnpm lint ${id}`],
  depends_on,
  sources: [`file:src/${id}.ts`],
});
const withTasks = (tasks?: ReturnType<typeof task>[]): ProjectBaseline => {
  const submitted = baseline('baseline-a', 'submitted');
  return {
    ...submitted,
    result: {
      ...submitted.result!,
      workstreams: [
        {
          id: 'paging',
          title: 'Cursor paging',
          status: 'running',
          reason: 'Pages are slow',
          items: [],
          commits: [],
          next: [],
          blockers: [],
        },
      ],
      ...(tasks && { tasks }),
    },
  };
};
const block = (tree: ReactNode, id: string) =>
  nodes(tree).find((n) => n.props['aria-label'] === zh(id));

it('draws the next tasks along their dependencies and details the picked one', async () => {
  read = withTasks([
    task('a', 'Page by cursor'),
    task('b', 'Report on pages', ['a']),
    task('c', 'Docs'),
  ]);
  const h = await mount();
  expect(block(h.value!.form, 'projects.baseline.tasks.label')).toBeTruthy();
  const graph = find(h.value!.graph, (n) => n.props.role === 'group');
  expect(graph.props['aria-label']).toBe(
    zhf('projects.baseline.tasks.graph', { tasks: 3, deps: 1 }),
  );
  const buttons = () => nodes(h.value!.graph).filter((n) => n.type === 'button');
  expect(buttons().map((b) => b.props['aria-pressed'])).toEqual([true, false, false]);
  expect(text(buttons()[0])).toContain('Page by cursor');
  expect(text(buttons()[0])).toContain('Cursor paging');
  const detail = () => find(h.value!.graph, (n) => n.props['aria-live'] === 'polite');
  expect(text(detail())).toContain('src/a.ts');
  expect(find(detail(), (n) => n.props.children === 'pnpm test a')).toBeTruthy();
  expect(find(detail(), (n) => n.props.children === 'pnpm lint a')).toBeTruthy();
  buttons()[1]!.props.onClick();
  await h.flush();
  expect(buttons().map((b) => b.props['aria-pressed'])).toEqual([false, true, false]);
  expect(text(detail())).toContain('src/b.ts');
  expect(text(detail())).not.toContain('src/a.ts');
  expect(find(detail(), (n) => n.props.children === 'pnpm test b')).toBeTruthy();
});

it.each([
  ['an empty task list', []],
  ['no task list', undefined],
] as const)('leaves the next tasks out for %s', async (_, tasks) => {
  read = withTasks(tasks as ReturnType<typeof task>[] | undefined);
  const h = await mount();
  expect(block(h.value!.form, 'projects.baseline.tasks.label')).toBeUndefined();
  expect(h.value!.graph).toBeUndefined();
});

const mermaid = '```mermaid\ngraph LR\n  fetch --> reconcile\n```';
const withMermaid = `Intro\n\n${mermaid}\n\nMore text`;
const withCode = 'Intro\n\n```ts\nconst a = 1;\n```';
it.each([
  ['an introduction with a mermaid block', withMermaid, withMermaid],
  ['an introduction without one', withCode, withCode],
  ['no introduction body', undefined, null],
] as const)(
  'draws the whole introduction body as the main flow for %s',
  async (_, introBody, drawn) => {
    read = baseline('baseline-a', 'submitted');
    body = introBody;
    const h = await mount();
    const flow = block(h.value!.form, 'projects.baseline.flow.label');
    if (drawn === null) expect(flow).toBeUndefined();
    else expect(nodes(flow).map((n) => n.props.text)).toContain(drawn);
  },
);
