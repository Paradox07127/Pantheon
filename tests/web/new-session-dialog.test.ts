import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { ModelMenu } from '@/screens/sessions/ModelMenu';
import { KeyHint } from '@/components/Shortcuts';
import { useDrafts } from '@/data/drafts';
import { runShortcut } from '@/lib/shortcuts';

const session = (n: number) =>
  ({
    id: `session-${n}`,
    created_at: '2026-01-01T00:00:00.000Z',
    title: `Work ${n}`,
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: `workspace-${n}`,
    workspace_kind: 'linked_worktree',
    state: 'running',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    changes: null,
    merge: null,
  }) as const;

let command: ReturnType<typeof vi.fn>;
let statuses: unknown[] | null = null;
let factsEmpty: boolean | null = null;
async function mount(extra: Record<string, unknown> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const h = mountHook(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [session(1)],
      onOpen,
      onClose,
      ...extra,
    }),
  );
  await h.flush();
  return { h, onOpen, onClose };
}
const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
const classed = (name: string) => (n: ReactElement<any>) =>
  String(n.props.className ?? '')
    .split(' ')
    .includes(name);
const region = (h: HookHost<any>) => find(h.value, labelled(zh('sessions.composer.newSession')));
function type(h: HookHost<any>, input: string) {
  find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.onChange({
    target: { value: input },
  });
  h.render();
}
const press = (h: HookHost<any>, key: string) => {
  const event = {
    key,
    code: /^\d$/.test(key) ? `Digit${key}` : key,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    isDefaultPrevented: () => false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  region(h).props.onKeyDown(event);
  return event;
};

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
  statuses = null;
  factsEmpty = null;
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) =>
        method === 'project.head'
          ? {
              ok: true,
              value: { branch: 'main', sha: 'abcdef1234567', subject: 'Fix', uncommitted: 0 },
            }
          : method === 'runtime.status' && statuses
            ? { ok: true, value: statuses }
            : method === 'project.facts.read' && factsEmpty !== null
              ? {
                  ok: true,
                  value: { facts: null, collected_at: null, workstreams: [], empty: factsEmpty },
                }
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

it('sits in the page as a section named for the new session, and starts from its keys', async () => {
  const { h } = await mount();
  expect(region(h).type).toBe('section');
  type(h, 'fix the board');
  region(h).props.onKeyDown({
    key: 'Enter',
    code: 'Enter',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    isDefaultPrevented: () => false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  await h.flush();
  expect((command.mock.calls[0] as any)[0]).toMatchObject({
    type: 'session.create',
    input: { input: 'fix the board' },
  });
});

it('closes on escape, from the box or the sessions in progress under it', async () => {
  const { h, onClose } = await mount();
  const escape = (prevented: boolean, at = region(h)) =>
    at.props.onKeyDown({
      key: 'Escape',
      code: 'Escape',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      isDefaultPrevented: () => prevented,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
  // An escape the completion list already took leaves the box open.
  escape(true);
  expect(onClose).toHaveBeenCalledTimes(0);
  escape(false);
  expect(onClose).toHaveBeenCalledTimes(1);
  const list = find(
    h.value,
    (n) =>
      typeof n.props.onKeyDown === 'function' &&
      nodes(n.props.children).some(labelled(zh('sessions.composer.inProgress'))),
  );
  escape(false, list);
  expect(onClose).toHaveBeenCalledTimes(2);
});

const fromScratch = (h: HookHost<any>) =>
  nodes(h.value).find(
    (n) => n.type === 'button' && text(n) === zh('sessions.composer.fromScratch'),
  ) as ReactElement<any> | undefined;

it('offers a start from scratch above the message box of an empty project', async () => {
  factsEmpty = true;
  const { h } = await mount();
  const start = fromScratch(h);
  expect(start).toBeDefined();
  const all = nodes(h.value);
  expect(all.indexOf(start!)).toBeLessThan(
    all.indexOf(find(h.value, labelled(zh('sessions.composer.firstMessage')))),
  );
  start!.props.onClick();
  await h.flush();
  expect(command).toHaveBeenCalledTimes(1);
  expect((command.mock.calls[0] as any)[0]).toMatchObject({
    type: 'session.create',
    input: { project_id: 'project-a', purpose: 'project_setup' },
  });
});

it('sends what the user wrote as the first message of a start from scratch', async () => {
  factsEmpty = true;
  const { h } = await mount();
  type(h, 'a habit tracker for runners');
  fromScratch(h)!.props.onClick();
  await h.flush();
  expect((command.mock.calls[0] as any)[0]).toMatchObject({
    input: { input: 'a habit tracker for runners', purpose: 'project_setup' },
  });
});

it('offers no start from scratch for a project with code, and starts a plain session from the box', async () => {
  factsEmpty = false;
  const { h } = await mount();
  expect(fromScratch(h)).toBeUndefined();
  type(h, 'fix the board');
  region(h).props.onKeyDown({
    key: 'Enter',
    code: 'Enter',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    isDefaultPrevented: () => false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  await h.flush();
  expect((command.mock.calls[0] as any)[0].input.purpose).toBeUndefined();
});

it('keeps the chosen runtime, model, effort and permission mode with the draft when it opens again', async () => {
  const chosen = { runtime: 'claude', backend: null, model: 'opus', effort: 'high' };
  const first = await mount();
  const picker = (h: HookHost<any>) => find(h.value, (n) => n.type === ModelMenu);
  picker(first.h).props.onChange(chosen);
  picker(first.h).props.onMode('plan');
  first.h.render();
  unmountAll();

  const { h } = await mount();
  expect(picker(h).props.value).toEqual(chosen);
  expect(picker(h).props.mode).toBe('plan');
});

it('starts a main agent while its toggle is on, and keeps the toggle with the draft', async () => {
  const conductor = zh('sessions.conductor.name');
  const toggle = (h: HookHost<any>) => find(h.value, labelled(conductor));
  const first = await mount();
  expect(toggle(first.h).props['aria-pressed']).toBe(false);
  const tip = find(
    first.h.value,
    (n) =>
      typeof n.type === 'function' &&
      n.type.name === 'Tip' &&
      n.props.children?.props?.['aria-label'] === conductor,
  );
  expect(tip.props.content).toBe(conductor);
  toggle(first.h).props.onClick();
  first.h.render();
  unmountAll();

  const { h } = await mount();
  expect(toggle(h).props['aria-pressed']).toBe(true);
  type(h, 'plan the release');
  press(h, 'Enter');
  await h.flush();
  expect((command.mock.calls[0] as any)[0]).toMatchObject({
    type: 'session.create',
    input: { input: 'plan the release', purpose: 'conductor' },
  });
});

it.each([
  ['the installed runtimes', null, ['claude', 'gemini']],
  ['the installed runtimes and a chosen one that is not', 'codex', ['claude', 'codex', 'gemini']],
])('offers %s in the model menu', async (_, chosen, offered) => {
  const status = (runtime: string, installed: boolean) => ({
    runtime,
    enabled: true,
    installed,
    auth: { state: 'ok' },
  });
  statuses = [
    status('gemini', true),
    status('grok', false),
    status('codex', false),
    status('claude', true),
  ];
  const { h } = await mount();
  const picker = () => find(h.value, (n) => n.type === ModelMenu);
  if (chosen)
    picker().props.onChange({ runtime: chosen, backend: null, model: null, effort: null });
  h.render();
  expect(picker().props.runtimes).toEqual(offered);
});

it('starts from the last button of the message row or the composer keys', async () => {
  const { h } = await mount();
  const row = nodes(h.value)
    .filter(
      (n) =>
        n.type === 'div' && nodes(n.props.children).some(labelled(zh('sessions.composer.addMenu'))),
    )
    .at(-1)!;
  const start = named(row, 'SendButton');
  expect(start.props).toMatchObject({
    label: zh('sessions.newWorkspace.begin'),
    pri: true,
    shortcut: 'dialog-next',
  });
  expect(start.props.icon).toBeUndefined();
  expect([row.props.children].flat(Infinity).filter(Boolean).at(-1)).toBe(start);

  type(h, 'fix the board');
  const pressed = press(h, 'Enter');
  await h.flush();
  expect(pressed.preventDefault).toHaveBeenCalled();
  expect(command).toHaveBeenCalledTimes(1);
  expect((command.mock.calls[0] as any)[0]).toMatchObject({
    type: 'session.create',
    input: { input: 'fix the board' },
  });
});

it('offers three sessions in progress with their keys and why they wait, the rest behind more', async () => {
  const recent = [1, 2, 3, 4, 5, 6, 7, 8].map(session);
  const needs = [
    {
      source: { table: 'approvals', id: 'approval-1', revision: 1 },
      kind: 'permission',
      project_id: 'project-a',
      session_id: 'session-2',
      status: 'open',
      created_at: 0,
      reason: 'permission_requested',
      actions: [],
      binding: { input_summary: 'pnpm migrate' },
    },
  ];
  const { h, onOpen } = await mount({ recent, needs });
  const rows = () => nodes(h.value).filter(classed('cr-sgm'));
  expect(rows()).toHaveLength(3);
  expect(rows().map((row) => find(row, (n) => n.type === KeyHint).props)).toEqual(
    [1, 2, 3].map((digit) => ({ id: 'session-number', digit })),
  );
  expect(text(find(rows()[1]!, classed('cr-sgs')))).toContain('pnpm migrate');

  const pressed = press(h, '3');
  expect(onOpen).toHaveBeenCalledWith('session-3');
  expect(pressed.stopPropagation).toHaveBeenCalled();

  const more = find(h.value, classed('cr-more'));
  expect(text(more)).toBe('还有 5 项');
  more.props.onClick();
  h.render();
  expect(rows()).toHaveLength(8);
  expect(nodes(h.value).some(classed('cr-more'))).toBe(false);
});

it('references another session from the add menu as a card in the box', async () => {
  const { h } = await mount();
  const trigger = find(h.value, (n) => n.type === Menu.SubmenuTrigger);
  expect(text(trigger)).toContain(zh('sessions.newWorkspace.referAnother'));
  const sub = find(h.value, (n) => n.type === Menu.SubmenuRoot);
  find(sub, (n) => n.type === Menu.Item && text(n).includes('Work 1')).props.onClick();
  h.render();
  expect(nodes(region(h)).some(labelled('Work 1'))).toBe(true);
});

it('opens the add menu on ⌘U and puts the keys on its button', async () => {
  const { h } = await mount();
  const add = () => find(h.value, (n) => n.type === Menu.Root && nodes(n).some(classed('cp-add')));
  expect(add().props.open).toBe(false);
  expect(runShortcut('attach')).toBe(true);
  h.render();
  expect(add().props.open).toBe(true);
  const trigger = find(add(), classed('cp-add'));
  expect(trigger.props['aria-keyshortcuts']).toBe('Meta+U');
  expect(find(trigger, (n) => n.type === KeyHint).props.id).toBe('attach');
});

it('puts the model keys on the model button', () => {
  const h = mountHook(() =>
    ModelMenu({
      runtimes: ['claude'],
      models: { claude: { state: 'ready', models: [] } },
      value: { runtime: 'claude', backend: null, model: null, effort: null },
      onChange: () => {},
    }),
  );
  const trigger = find(h.value, (n) => n.type === Menu.Trigger);
  expect(find(trigger, (n) => n.type === KeyHint).props.id).toBe('model-menu');
});

it('draws the reference card and suggestion rows with the small radius', () => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, '../../apps/web/src/screens/sessions/create.css'),
    'utf8',
  );
  const rule = (selector: string) =>
    css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
  expect(rule('.cr-card')).toContain('border-radius: var(--r-sm)');
  expect(rule('.cr-card')).toContain('padding: 0 var(--sp-1) 0 var(--sp-2)');
  expect(rule('.cr-sg')).toContain('border-radius: var(--r-sm)');
});
