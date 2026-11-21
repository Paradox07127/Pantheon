import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectBaseline } from '@pantheon/domain';
import type { SessionGates } from '@pantheon/protocol';
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
vi.mock('@/store', () => {
  const state = () => ({ openSession: mock.openSession, sessionRun: null });
  return { useShell: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
import { BaselineReview } from '@/screens/sessions/SessionsScreen';
import { FindGate, ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { ChecksTab } from '@/screens/sessions/panel';
import { zh } from './i18n-setup.js';

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
  result: {
    folders: [
      {
        root: '/work/a',
        gate: [
          { name: 'test', argv: ['pnpm', 'test'], sources: ['file:package.json'] },
          { name: 'lint', argv: ['pnpm', 'lint'], sources: ['file:package.json'] },
        ],
        setup: { argv: ['pnpm', 'install'], sources: ['file:package.json'] },
      },
    ],
  },
});

let read: ProjectBaseline | null;
let commands: { type: string; input: any }[];
const render = (element: ReactElement<any>) =>
  (element.type as (props: unknown) => ReactNode)(element.props);
/** Renders the review and, when there is one, the form it opens. */
async function mount() {
  const h = host(() => {
    const review = BaselineReview({ session }) as ReactElement<any> | null;
    if (!review) return review;
    return { review, form: render(review) };
  });
  await h.flush();
  return h;
}

beforeEach(() => {
  read = null;
  mock.board = {
    board: { cursor: 1 },
    events: [],
    resync: 0,
    status: { state: 'live' },
    refresh() {},
  };
  mock.openSession = vi.fn();
  commands = [];
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return {
          ok: true,
          value:
            command.type === 'project.baseline.start'
              ? { ...baseline('baseline-new', 'running'), session_id: 'baseline-session-new' }
              : { ...command.input, state: 'confirmed' },
        };
      }),
      query: vi.fn(async () => ({ ok: true, value: read })),
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
  const gates = find(h.value!.form, (n) => n.props['aria-label'] === zh('projects.baseline.gates'));
  expect(text(gates)).toContain('pnpm install');
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

it('confirms with only the baseline and the checked gate commands', async () => {
  const h = host(() => ReviewBaseline({ baseline: baseline('baseline-a', 'submitted') }));
  await h.flush();
  find(
    h.value,
    (n) =>
      typeof n.type === 'function' &&
      n.type.name === 'Button' &&
      n.props.label === zh('projects.baseline.confirmBaseline'),
  ).props.onPress();
  await h.flush();
  expect(commands.map((c) => c.type)).toEqual(['project.baseline.confirm']);
  expect(commands[0]!.input).toEqual({
    baseline_id: 'baseline-a',
    gates: [
      {
        root: '/work/a',
        commands: [
          { name: 'test', argv: ['pnpm', 'test'] },
          { name: 'lint', argv: ['pnpm', 'lint'] },
        ],
      },
    ],
  });
});

const noGates = { data: { configured: false, running: false, last: null } as SessionGates };
/** The checks tab without gate commands, with the find button it offers drawn in place. */
function checks(readOnly: boolean) {
  return host(() => {
    const tab = ChecksTab({
      gates: { ...noGates, error: null, reload: () => {} },
      readOnly,
      projectId: 'project-a',
      merging: false,
      busy: false,
      attached: new Set<string>(),
      onAttach: () => {},
      onRun: () => {},
      onSettings: () => {},
    });
    const offer = nodes(tab).find((n) => n.type === FindGate);
    return { tab, find: offer && render(offer) };
  });
}

it('offers to find gate commands beside the empty checks state, except read-only', async () => {
  const open = checks(false);
  await open.flush();
  expect(text(open.value.find)).toBe(zh('projects.baseline.findGate'));
  expect(
    nodes(open.value.find).some(
      (n) => n.type === 'button' && text(n) === zh('projects.baseline.findGate'),
    ),
  ).toBe(true);
  const shut = checks(true);
  await shut.flush();
  expect(shut.value.find).toBeUndefined();
  expect(text(shut.value.tab)).not.toContain(zh('projects.baseline.findGate'));
});

const press = (tree: ReactNode) =>
  find(
    tree,
    (n) => n.type === 'button' && text(n) === zh('projects.baseline.findGate'),
  ).props.onClick();

it('opens the running baseline session instead of starting another', async () => {
  read = { ...baseline('baseline-a', 'running'), session_id: 'baseline-session-a' };
  const h = host(() => FindGate({ project_id: 'project-a' }));
  await h.flush();
  press(h.value);
  await h.flush();
  expect(mock.openSession).toHaveBeenCalledWith('baseline-session-a');
  expect(commands).toEqual([]);
});

it('starts a baseline for the project without one and opens its session', async () => {
  read = null;
  const h = host(() => FindGate({ project_id: 'project-a' }));
  await h.flush();
  press(h.value);
  await h.flush();
  expect(commands.map((c) => [c.type, c.input])).toEqual([
    ['project.baseline.start', { project_id: 'project-a' }],
  ]);
  expect(mock.openSession).toHaveBeenCalledWith('baseline-session-new');
});
