import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ConnectionsStatus, GithubItems } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import {
  find,
  HookHost,
  mount as mountHook,
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
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { useSettingsView } from '@/screens/settings/view';
import { useDrafts } from '@/data/drafts';

const item = (number: number, extra: Partial<GithubItems['items'][number]> = {}) => ({
  number,
  title: `Item ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  state: 'open' as const,
  updated_at: '2026-11-01T00:00:00Z',
  ...extra,
});

let github: ConnectionsStatus['github'];
let command: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let openLink: ReturnType<typeof vi.fn>;

async function mount() {
  const h = mountHook(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [],
      onOpen: () => {},
      onClose: () => {},
    }),
  );
  // The connection read lands first, then the reads of the pull requests and issues.
  await h.flush();
  await h.flush();
  return h;
}
const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
const has = (h: HookHost<any>, label: string) => nodes(h.value).some(labelled(label));
const classed = (name: string) => (n: ReactElement<any>) =>
  String(n.props.className ?? '')
    .split(' ')
    .includes(name);
const rows = (h: HookHost<any>, group: string) =>
  nodes(find(h.value, labelled(group))).filter(classed('cr-sgm'));

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  useSettingsView.setState({ open: false, page: 'general' });
  mock.board = {
    board: { cursor: 1, projects: [{ id: 'project-a', name: 'Pantheon', roots: ['/w/p'] }] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  github = { state: 'signed_in', installed: true, signed_in: true, account: 'octo' };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  openLink = vi.fn(async () => ({ ok: true, value: null }));
  query = vi.fn(async (method: string, params: Record<string, string>) => {
    if (method === 'connections.status') return { ok: true, value: { github } };
    if (method === 'github.items')
      return {
        ok: true,
        value: {
          repo: 'acme/app',
          items:
            params.kind === 'pr'
              ? [item(12, { checks: 'failing' }), item(11), item(10), item(9)]
              : [item(30), item(29), item(28), item(27)],
        },
      };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('window', {
    pantheon: { query, command, openLink },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('offers the first three open pull requests and issues of the project', async () => {
  const h = await mount();
  expect(query).toHaveBeenCalledWith('github.items', { project_id: 'project-a', kind: 'pr' });
  expect(query).toHaveBeenCalledWith('github.items', { project_id: 'project-a', kind: 'issue' });
  expect(rows(h, zh('sessions.newWorkspace.openPulls')).map(text)).toEqual([
    `#12Item 12${zh('sessions.composeRefs.checksFailing')}`,
    '#11Item 11',
    '#10Item 10',
  ]);
  expect(rows(h, zh('sessions.newWorkspace.openIssues')).map(text)).toEqual([
    '#30Item 30',
    '#29Item 29',
    '#28Item 28',
  ]);
  const open = find(
    find(h.value, labelled(zh('sessions.newWorkspace.openPulls'))),
    (n) => n.type === 'button' && text(n) === zh('sessions.newWorkspace.openOnGithub'),
  );
  open.props.onClick();
  expect(openLink).toHaveBeenCalledWith('https://github.com/acme/app/pull/12');
});

it('refers a pull request and an issue picked from the offer and sends them', async () => {
  const h = await mount();
  rows(h, zh('sessions.newWorkspace.openPulls'))[0]!.props.onClick();
  h.render();
  rows(h, zh('sessions.newWorkspace.openIssues'))[1]!.props.onClick();
  h.render();
  expect(text(find(h.value, labelled('PR #12 Item 12')))).toContain('Item 12');
  expect(text(find(h.value, labelled('Issue #29 Item 29')))).toContain('Item 29');

  find(h.value, labelled('移除 Item 29')).props.onClick();
  h.render();
  expect(has(h, 'Issue #29 Item 29')).toBe(false);

  find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.onChange({
    target: { value: 'fix it' },
  });
  h.render();
  named(h.value, 'SendButton').props.onPress();
  await h.flush();
  expect((command.mock.calls[0] as any)[0].input.refs).toEqual([{ kind: 'pr', number: 12 }]);
});

it('says GitHub is not connected and goes to the connections settings', async () => {
  github = { state: 'signed_out', installed: true, signed_in: false };
  const h = await mount();
  expect(query.mock.calls.some((c: any) => c[0] === 'github.items')).toBe(false);
  expect(has(h, zh('sessions.newWorkspace.openPulls'))).toBe(false);
  const go = find(
    h.value,
    (n) => n.type === 'button' && text(n) === zh('sessions.newWorkspace.connectGithub'),
  );
  expect(text(find(h.value, classed('cr-sug')))).toContain(zh('sessions.newWorkspace.githubOff'));
  go.props.onClick();
  expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'connections' });
});
