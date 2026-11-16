import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  deferred,
  find,
  HookHost,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { useDrafts } from '@/data/drafts';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const HOUR = 3_600_000;
const branch = (name: string, sha: string, hoursAgo: number, checked_out = false) => ({
  name,
  sha,
  commit_time: Date.now() - hoursAgo * HOUR,
  checked_out,
});

let command: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let branches: () => Promise<unknown>;
const [start, filterLabel] = [zh('sessions.newWorkspace.start'), zh('sessions.startBranch.filter')];
const from = (name: string) =>
  t({ id: 'sessions.newWorkspace.from', defaultMessage: 'From {name}' }, { name });

async function mount(projectId = 'project-a') {
  const h = host(() =>
    NewSession({
      projectId,
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [],
      onOpen: () => {},
      onClose: () => {},
    }),
  );
  await h.flush();
  return h;
}
const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
const classed = (name: string) => (n: ReactElement<any>) =>
  String(n.props.className ?? '')
    .split(' ')
    .includes(name);
const startMenu = (h: HookHost<any>) =>
  find(h.value, (n) => n.type === Menu.Root && nodes(n.props.children).some(labelled(start)));
async function open(h: HookHost<any>) {
  startMenu(h).props.onOpenChange(true, {});
  await h.flush();
}
const rows = (h: HookHost<any>) => nodes(startMenu(h)).filter(classed('cr-bri'));
const reads = () =>
  query.mock.calls.filter((c: any) => c[0] === 'project.branches').map((c: any) => c[1]);
const trigger = (h: HookHost<any>) => text(find(h.value, labelled(start)));
function choose(h: HookHost<any>, name: string) {
  const row = rows(h).find((n) => text(find(n, classed('cr-brn'))) === name)!;
  find(startMenu(h), (n) => typeof n.props.onValueChange === 'function').props.onValueChange(
    row.props.value,
  );
  h.render();
}
async function send(h: HookHost<any>) {
  find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.onChange({
    target: { value: 'check the signature' },
  });
  h.render();
  named(h.value, 'SendButton').props.onPress();
  await h.flush();
  return (command.mock.calls.at(-1) as any)[0].input;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    board: {
      cursor: 1,
      projects: [
        { id: 'project-a', name: 'Pantheon', roots: ['/work/pantheon'] },
        { id: 'project-b', name: 'Payments', roots: ['/work/payments'] },
      ],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  branches = async () => ({
    ok: true,
    value: [
      branch('fix/rounding', '1111111aaaaaaa', 1.5),
      branch('main', 'abcdef1234567', 3.5, true),
      branch('old/report', '2222222bbbbbbb', 50),
    ],
  });
  query = vi.fn(async (method: string, params: Record<string, string>) =>
    method === 'project.head'
      ? {
          ok: true,
          value: { branch: 'main', sha: 'abcdef1234567', subject: 'Fix', uncommitted: 0 },
        }
      : method === 'session.create.preview'
        ? {
            ok: true,
            value: {
              branch: null,
              base_sha: params.from ? '1111111aaaaaaa' : 'abcdef1234567',
              base_ref: params.from
                ? `refs/heads/${JSON.parse(params.from).branch}`
                : 'refs/heads/main',
            },
          }
        : method === 'project.branches'
          ? branches()
          : { ok: false, error: { code: 'unknown_route', message: method } },
  );
  vi.stubGlobal('window', {
    pantheon: { query, command },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reads the branches of the project folder only once the start menu opens', async () => {
  const h = await mount();
  expect(reads()).toEqual([]);
  await open(h);
  expect(reads()).toEqual([{ project_id: 'project-a', root: '/work/pantheon' }]);
});

it('shows a loading row while the branches are read, then a failure with a retry', async () => {
  const first = deferred<unknown>();
  branches = () => first.promise;
  const h = await mount();
  await open(h);
  expect(text(find(startMenu(h), classed('cr-bst')))).toBe(zh('sessions.startBranch.loading'));
  first.resolve({ ok: false, error: { code: 'invalid_project', message: 'not a repository' } });
  await h.flush();
  expect(text(find(startMenu(h), classed('cr-bst')))).toContain('not a repository');
  expect(rows(h)).toEqual([]);
  branches = async () => ({ ok: true, value: [branch('main', 'abcdef1234567', 3, true)] });
  find(
    startMenu(h),
    (n) => text(n) === zh('sessions.startBranch.retry') && typeof n.props.onClick === 'function',
  ).props.onClick();
  await h.flush();
  expect(reads()).toHaveLength(2);
  expect(nodes(startMenu(h)).some(classed('cr-bst'))).toBe(false);
  expect(rows(h)).toHaveLength(1);
});

it('lists each branch with its short commit and age, the checked-out one first and marked', async () => {
  const h = await mount();
  await open(h);
  expect(rows(h).map((n) => text(n))).toEqual([
    'main当前abcdef13 小时',
    'fix/rounding11111111 小时',
    'old/report22222222 天',
  ]);
  const items = nodes(startMenu(h)).filter((n) => n.props.closeOnClick === true);
  expect(items.map((n) => text(n))[0]).toBe('main');
  expect(text(items[1])).toContain('main当前');
});

it('offers a filter over more than eight branches and keeps the names that contain it', async () => {
  const h = await mount();
  await open(h);
  expect(nodes(startMenu(h)).some(labelled(filterLabel))).toBe(false);
  branches = async () => ({
    ok: true,
    value: Array.from({ length: 9 }, (_, i) =>
      branch(i === 4 ? 'Feature/Refund' : `topic-${i}`, `${i}`.repeat(10), i),
    ),
  });
  await open(h);
  const filter = () => find(startMenu(h), labelled(filterLabel));
  filter().props.onChange({ target: { value: 'refund' } });
  h.render();
  expect(rows(h).map((n) => text(find(n, classed('cr-brn'))))).toEqual(['Feature/Refund']);
});

it('starts the session from the picked branch and names it on the trigger and the chip', async () => {
  const h = await mount();
  await open(h);
  choose(h, 'fix/rounding');
  expect(trigger(h)).toBe(from('fix/rounding'));
  expect(text(find(h.value, labelled(zh('sessions.composer.whereStarts'))))).toContain(
    'fix/rounding',
  );
  const input = await send(h);
  expect(input.from).toEqual({ branch: 'fix/rounding' });
});

it('leaves the start menu out and sends no start once the session changes the current folder', async () => {
  const h = await mount();
  await open(h);
  choose(h, 'fix/rounding');
  find(h.value, labelled(zh('sessions.newWorkspace.where'))).props.onValueChange('in_place');
  h.render();
  expect(nodes(h.value).some(labelled(start))).toBe(false);
  const input = await send(h);
  expect('from' in input).toBe(false);
});

it('drops the picked branch once another project folder is chosen', async () => {
  const h = await mount();
  await open(h);
  choose(h, 'fix/rounding');
  unmountAll();
  // The sessions screen keys the composer by project, so choosing another one mounts it again.
  const next = await mount('project-b');
  expect(trigger(next)).toBe(from('main'));
  await open(next);
  expect(reads().at(-1)).toEqual({ project_id: 'project-b', root: '/work/payments' });
  const input = await send(next);
  expect('from' in input).toBe(false);
});
