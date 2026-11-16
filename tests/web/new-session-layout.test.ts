import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
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
import { Popover } from '../../apps/web/node_modules/@base-ui/react/popover/index.mjs';
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { useDrafts } from '@/data/drafts';

const running = {
  id: 'session-r',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'Recent work',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-r',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
} as const;

let command: ReturnType<typeof vi.fn>;
async function mount(extra: { task?: { id: string; title: string; goal: string } } = {}) {
  const onOpen = vi.fn();
  const h = mountHook(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [running],
      onOpen,
      onClose: () => {},
      ...extra,
    }),
  );
  await h.flush();
  return { h, onOpen };
}
const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
const at = (h: HookHost<any>, predicate: (n: ReactElement<any>) => boolean) =>
  nodes(h.value).findIndex(predicate);
const box = (h: HookHost<any>) => find(h.value, labelled(zh('sessions.composer.firstMessage')));
function type(h: HookHost<any>, input: string) {
  box(h).props.onChange({ target: { value: input } });
  h.render();
}

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    board: { cursor: 1, projects: [{ id: 'project-a', name: 'Pantheon' }] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  const values: Record<string, unknown> = {
    'project.head': { branch: 'main', sha: 'abcdef1234567', subject: 'Fix the board' },
    'session.create.preview': {
      branch: null,
      base_sha: 'abcdef1234567',
      base_ref: 'refs/heads/main',
    },
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) =>
        method in values
          ? { ok: true, value: values[method] }
          : { ok: false, error: { code: 'unknown_route', message: method } },
      ),
      command,
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('stacks the task, the message box and its row, with the sessions in progress under the box', async () => {
  const { h } = await mount({
    task: { id: 'lead-1:api', title: 'Add the API', goal: 'Serve the board' },
  });
  const dialog = find(h.value, labelled(zh('sessions.composer.newSession')));
  expect(nodes(dialog)).toContain(box(h));
  const task = at(h, (n) => n.props.children === 'Add the API');
  const message = at(h, labelled(zh('sessions.composer.firstMessage')));
  const add = at(h, labelled(zh('sessions.composer.addMenu')));
  const where = at(h, labelled(zh('sessions.composer.whereStarts')));
  const project = at(h, labelled(zh('sessions.composer.newSessionProject')));
  expect(task).toBeGreaterThanOrEqual(0);
  expect(task).toBeLessThan(message);
  expect(message).toBeLessThan(add);
  expect(add).toBeLessThan(where);
  expect(where).toBeLessThan(project);
  expect(text(find(h.value, labelled(zh('sessions.composer.newSessionProject'))))).toContain(
    'Pantheon',
  );

  type(h, '');
  const again = find(h.value, labelled(zh('sessions.composer.newSession')));
  expect(nodes(again).some(labelled(zh('sessions.composer.inProgress')))).toBe(false);
  const all = nodes(h.value);
  expect(all.findIndex(labelled(zh('sessions.composer.inProgress')))).toBeGreaterThan(
    all.indexOf(nodes(again).at(-1)!),
  );
});

it('puts the add menu, where it starts and the model in the row under the message, and the start key after them', async () => {
  const { h } = await mount();
  const message = at(h, labelled(zh('sessions.composer.firstMessage')));
  const add = at(h, labelled(zh('sessions.composer.addMenu')));
  const where = at(h, labelled(zh('sessions.composer.whereStarts')));
  const model = at(h, (n) => typeof n.type === 'function' && n.type.name === 'ModelMenu');
  const send = at(h, (n) => typeof n.type === 'function' && n.type.name === 'SendButton');
  expect(message).toBeLessThan(add);
  expect(add).toBeLessThan(where);
  expect(where).toBeLessThan(model);
  expect(model).toBeLessThan(send);
  expect(named(h.value, 'ModelMenu').props).toMatchObject({ mode: 'ask' });
  expect(named(h.value, 'SendButton').props.label).toBe(zh('sessions.newWorkspace.begin'));
  expect(named(h.value, 'SendButton').props.icon).toBeUndefined();
  const items = nodes(h.value).filter((n) => n.props.className === 'cp-mil');
  expect(items.map(text)).toEqual([
    zh('sessions.composer.addFile'),
    zh('sessions.composer.mentionFile'),
    zh('sessions.newWorkspace.referAnother'),
    'Recent work',
    zh('sessions.composer.command'),
  ]);
});

it('creates the session with the same input as before', async () => {
  const { h } = await mount({
    task: { id: 'lead-1:api', title: 'Add the API', goal: 'Serve the board' },
  });
  type(h, 'start the API');
  named(h.value, 'SendButton').props.onPress();
  await h.flush();
  expect(command).toHaveBeenCalledTimes(1);
  expect((command.mock.calls[0] as any)[0]).toMatchObject({
    type: 'session.create',
    input: {
      project_id: 'project-a',
      runtime: 'claude',
      permission_mode: 'ask',
      input: 'start the API',
      task_id: 'lead-1:api',
    },
  });
  expect(Object.keys((command.mock.calls[0] as any)[0].input).sort()).toEqual([
    'input',
    'permission_mode',
    'project_id',
    'runtime',
    'task_id',
    'workspace',
  ]);
});

const headings = (h: HookHost<any>) =>
  nodes(h.value).filter((n) => typeof n.type === 'string' && /^h[1-6]$/.test(n.type));

it('heads the page with one neutral question that names neither the project nor the app', async () => {
  const { h } = await mount();
  expect(headings(h).map(text)).toEqual(['接下来做什么？']);
  expect(nodes(h.value).some((n) => n.type === 'img')).toBe(false);
  expect(at(h, (n) => n === headings(h)[0])).toBeLessThan(
    at(h, labelled(zh('sessions.composer.firstMessage'))),
  );
});

it('names the project, the folder and the start point on one chip that opens their controls', async () => {
  const { h } = await mount();
  const chip = find(h.value, labelled('会话在哪开始'));
  expect(text(chip)).toContain('Pantheon');
  expect(text(chip)).toContain(zh('sessions.newWorkspace.worktree'));
  expect(text(chip)).toContain('main');
  const popover = find(
    h.value,
    (n) => n.type === Popover.Root && nodes(n.props.children).includes(chip),
  );
  const popup = find(popover, (n) => n.type === Popover.Popup);
  expect(nodes(popup).some(labelled(zh('sessions.composer.newSessionProject')))).toBe(true);
  expect(nodes(popup).some(labelled(zh('sessions.newWorkspace.where')))).toBe(true);
  expect(nodes(popup).some(labelled(zh('sessions.newWorkspace.start')))).toBe(true);
});

it('keeps neither a cancel button nor a sentence on where it starts in the box', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { h } = await mount();
    vi.advanceTimersByTime(1_000);
    await h.flush();
    const dialog = find(h.value, labelled(zh('sessions.composer.newSession')));
    expect(nodes(dialog).some((n) => n.type === 'button' && text(n) === '取消')).toBe(false);
    expect(text(dialog)).not.toContain('新建工作树，从 main 的 abcdef1 开');
  } finally {
    vi.useRealTimers();
  }
});

it('lists the sessions in progress while the message is empty and opens the one picked', async () => {
  const { h, onOpen } = await mount();
  const group = find(h.value, labelled(zh('sessions.composer.inProgress')));
  const row = find(group, (n) => n.type === 'button' && text(n).includes('Recent work'));
  row.props.onClick();
  expect(onOpen).toHaveBeenCalledWith('session-r');

  type(h, 'something else');
  expect(nodes(h.value).some(labelled(zh('sessions.composer.inProgress')))).toBe(false);
});
