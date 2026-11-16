import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
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
import { useDrafts } from '@/data/drafts';

const running = {
  id: 'session-r',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'Signature check',
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
  changes: { files: 2, additions: 61, deletions: 19 },
  merge: null,
} as const;

let command: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let head: Record<string, unknown>;
let keydown: ((e: unknown) => void) | null;

async function mount(recent: readonly WorkbenchSession[] = [running]) {
  const h = mountHook(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [...recent],
      onOpen: () => {},
      onClose: () => {},
    }),
  );
  await h.flush();
  return h;
}
const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
const has = (h: HookHost<any>, label: string) => nodes(h.value).some(labelled(label));
const classed = (name: string) => (n: ReactElement<any>) =>
  String(n.props.className ?? '')
    .split(' ')
    .includes(name);
const chip = (h: HookHost<any>) =>
  text(find(h.value, labelled(zh('sessions.composer.whereStarts'))));
function type(h: HookHost<any>, input: string) {
  find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.onChange({
    target: { value: input },
  });
  h.render();
}
function pick(h: HookHost<any>, workspace: 'worktree' | 'in_place') {
  find(h.value, labelled(zh('sessions.newWorkspace.where'))).props.onValueChange(workspace);
  h.render();
}
async function send(h: HookHost<any>) {
  type(h, 'check the signature');
  named(h.value, 'SendButton').props.onPress();
  await h.flush();
  expect(command).toHaveBeenCalledTimes(1);
  return (command.mock.calls[0] as any)[0].input;
}
function refer(h: HookHost<any>, at = 0) {
  const group = find(h.value, labelled(zh('sessions.composer.inProgress')));
  nodes(group)
    .filter((n) => n.type === 'button' && text(n) === zh('sessions.newWorkspace.referSession'))
    [at]!.props.onClick();
  h.render();
}

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    board: {
      cursor: 1,
      projects: [{ id: 'project-a', name: 'Pantheon', roots: ['/work/pantheon'] }],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  head = {
    branch: 'main',
    sha: 'abcdef1234567',
    subject: 'Fix the board',
    committed_at: 1,
    uncommitted: 0,
  };
  keydown = null;
  query = vi.fn(async (method: string) =>
    method === 'project.head'
      ? { ok: true, value: head }
      : { ok: false, error: { code: 'unknown_route', message: method } },
  );
  vi.stubGlobal('window', {
    pantheon: { query, command },
    addEventListener(type: string, listener: (e: unknown) => void) {
      if (type === 'keydown') keydown ??= listener;
    },
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('hides the start point and sends no start once the session changes the current folder', async () => {
  const h = await mount();
  expect(has(h, zh('sessions.newWorkspace.start'))).toBe(true);
  pick(h, 'in_place');
  expect(has(h, zh('sessions.newWorkspace.start'))).toBe(false);
  const input = await send(h);
  expect(input.workspace).toBe('in_place');
  expect('from' in input).toBe(false);
});

it('switches between a new worktree and the current folder with its keys', async () => {
  const h = await mount();
  expect(find(h.value, labelled(zh('sessions.newWorkspace.where'))).props.value).toBe('worktree');
  const press = { key: 'W', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false };
  keydown!({ ...press, preventDefault() {} });
  h.render();
  expect(find(h.value, labelled(zh('sessions.newWorkspace.where'))).props.value).toBe('in_place');
});

it('names the project, the folder and the start point on the chip as they change', async () => {
  const h = await mount();
  expect(chip(h)).toBe('Pantheon新工作树main');
  pick(h, 'in_place');
  expect(chip(h)).toBe('Pantheon当前目录main');
});

it('shows how far the branch is ahead and the uncommitted changes only when there are some', async () => {
  let h = await mount();
  const status = () => text(find(h.value, classed('cr-head')));
  expect(status()).toBe('mainabcdef1Fix the board');
  expect(nodes(h.value).some(classed('cr-dirty'))).toBe(false);
  unmountAll();

  head = { ...head, ahead_upstream: 2, uncommitted: 4 };
  h = await mount();
  expect(status()).toBe('mainabcdef1Fix the board领先上游 2');
  expect(text(find(h.value, classed('cr-dirty')))).toBe('4 个没提交的改动新工作树里看不到它们');
  pick(h, 'in_place');
  expect(text(find(h.value, classed('cr-dirty')))).toBe('4 个没提交的改动会话直接在它们上面改');
});

it('refers a session from its suggestion, starts from it and sends it along', async () => {
  const h = await mount();
  type(h, '');
  refer(h);
  const card = find(h.value, labelled('Signature check'));
  expect(text(card)).toContain('Signature check');
  expect(text(card)).toContain('+61');
  expect(text(card)).toContain('−19');
  expect(text(find(h.value, labelled(zh('sessions.newWorkspace.start'))))).toBe(
    '从 Signature check',
  );
  expect(chip(h)).toContain('Signature check');
  const input = await send(h);
  expect(input.refs).toEqual([{ kind: 'session', id: 'session-r' }]);
  expect(input.from).toEqual({ session_id: 'session-r' });
});

it('sends neither the reference nor its start once the reference is removed', async () => {
  const h = await mount();
  type(h, '');
  refer(h);
  find(h.value, labelled('移除 Signature check')).props.onClick();
  h.render();
  expect(has(h, 'Signature check')).toBe(false);
  expect(text(find(h.value, labelled(zh('sessions.newWorkspace.start'))))).toBe('从 main');
  const input = await send(h);
  expect('refs' in input).toBe(false);
  expect('from' in input).toBe(false);
});

it('keeps the referenced session with the draft when the dialog opens again', async () => {
  let h = await mount();
  type(h, '');
  refer(h);
  type(h, 'check the signature');
  unmountAll();
  h = await mount();
  expect(text(find(h.value, labelled('Signature check')))).toContain('Signature check');
  named(h.value, 'SendButton').props.onPress();
  await h.flush();
  const input = (command.mock.calls[0] as any)[0].input;
  expect(input.refs).toEqual([{ kind: 'session', id: 'session-r' }]);
  expect(useDrafts.getState().drafts).toEqual({});
});

it('keeps the chosen start point and folder with the draft when the dialog opens again', async () => {
  let h = await mount();
  type(h, '');
  refer(h);
  type(h, 'check the signature');
  unmountAll();
  h = await mount();
  expect(text(find(h.value, labelled(zh('sessions.newWorkspace.start'))))).toBe(
    '从 Signature check',
  );
  pick(h, 'in_place');
  unmountAll();
  h = await mount();
  expect(find(h.value, labelled(zh('sessions.newWorkspace.where'))).props.value).toBe('in_place');
  named(h.value, 'SendButton').props.onPress();
  await h.flush();
  const input = (command.mock.calls[0] as any)[0].input;
  expect(input.workspace).toBe('in_place');
  expect('from' in input).toBe(false);
  expect(useDrafts.getState().drafts).toEqual({});
});

it('starts from a session only once it is referenced, not when the references are full', async () => {
  const recent = Array.from({ length: 9 }, (_, i) => ({
    ...running,
    id: `session-${i}`,
    title: `Session ${i}`,
  })) as WorkbenchSession[];
  const h = await mount(recent);
  type(h, '');
  find(h.value, classed('cr-more')).props.onClick();
  h.render();
  for (let i = 0; i < 8; i++) refer(h, i);
  refer(h, 8);
  expect(has(h, 'Session 8')).toBe(false);
  expect(text(find(h.value, labelled(zh('sessions.newWorkspace.start'))))).toBe('从 Session 7');
  const input = await send(h);
  expect(input.from).toEqual({ session_id: 'session-7' });
});

it('checks the spelling of the first message', async () => {
  const h = await mount();
  expect(find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.spellCheck).toBe(true);
});
