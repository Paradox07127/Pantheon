import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, RuntimeStatus } from '@pantheon/protocol';
import { find, type HookHost, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, toast: (() => {}) as (o: unknown) => void }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => mock.toast(options),
}));
import { Tip } from '@/components/Tip';
import { ReviewTab } from '@/screens/sessions/panel';
import { ModelMenu } from '@/screens/sessions/parts';
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { HarnessPage } from '@/screens/settings/HarnessPage';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const kind = {
  writer: zh('settings.harness.kind.writer'),
  reviewer: zh('settings.harness.kind.reviewer'),
  text: zh('settings.harness.kind.text'),
};
const enable = (runtime: string) =>
  t({ id: 'settings.harness.enable', defaultMessage: '' }, { runtime });
const reviewWith = (runtime: string) =>
  t({ id: 'sessions.panel.review.request', defaultMessage: '' }, { runtime });

type Command = { type: string; input: Record<string, unknown> };
type Capabilities = Record<string, boolean>;

const status = (runtime: string, capabilities: Capabilities): RuntimeStatus => ({
  runtime,
  enabled: true,
  installed: true,
  version: '1.0.0',
  min_version: null,
  version_ok: null,
  auth: { state: 'unknown' },
  checked_at: new Date().toISOString(),
  capabilities: Object.fromEntries(
    Object.entries(capabilities).map(([name, on]) => [
      name,
      { status: on ? 'supported' : 'unsupported', evidence: 'probe' },
    ]),
  ),
});
const NATIVE = { write_isolation: true, text_execution: true, read_isolation: true };
const grok = (extra: Capabilities = {}) =>
  status('grok', { write_isolation: false, text_execution: true, ...extra });

const bridge = {
  statuses: [] as RuntimeStatus[],
  commandAnswer: { ok: true, value: {} } as BridgeResult<unknown>,
  queries: [] as { method: string; params?: Record<string, string> }[],
  commands: [] as Command[],
  async query(method: string, params?: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    return method === 'runtime.status'
      ? { ok: true, value: bridge.statuses }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer;
  },
};

async function mounted<T>(body: () => T) {
  const h = mount(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string | undefined) =>
  find(t, (n) => n.props['aria-label'] === label);
const tips = (t: ReactNode) => nodes(t).filter((n) => n.type === Tip);
const statusQueries = () => bridge.queries.filter((q) => q.method === 'runtime.status');

let toasts: unknown[];
beforeEach(() => {
  bridge.statuses = [];
  bridge.commandAnswer = { ok: true, value: {} };
  bridge.queries = [];
  bridge.commands = [];
  toasts = [];
  mock.toast = (options) => toasts.push(options);
  mock.board = {
    board: { cursor: 1, projects: [{ id: 'project-a', name: 'Alpha' }] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('new session runtime picker', () => {
  const open = () =>
    mounted(() =>
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

  it('lists an ACP runtime from runtime.status and greys it out without write isolation', async () => {
    bridge.statuses = [grok({ read_isolation: true }), status('claude', NATIVE)];
    const h = await open();
    const menu = named(tree(h), 'ModelMenu');
    expect(menu.props.runtimes).toEqual(['claude', 'grok']);
    expect(menu.props.value.runtime).toBe('claude');
    expect(menu.props.unavailable).toEqual({ grok: zh('data.runtimeStatus.noWriteIsolation') });

    const picker = mount(() => ModelMenu(menu.props));
    picker.value.props.onOpenChange(true);
    picker.render();
    const tip = find(picker.value, (n) => n.type === Tip);
    expect(tip.props.content).toBe(zh('data.runtimeStatus.noWriteIsolation'));
    expect(tip.props.children.props).toMatchObject({ value: 'grok', disabled: true });
  });
});

describe('review runtime picker', () => {
  const reviews = { data: [] as never[], error: null, reload: () => {} };
  const tab = () =>
    mounted(() =>
      ReviewTab({
        sessionId: 'session-a',
        runtime: 'claude',
        reviews,
        files: [],
        readOnly: false,
        attached: new Set(),
        onAttach() {},
      }),
    );
  const radio = (t: ReactNode, runtime: string): ReactElement<any> =>
    find(
      labelled(t, zh('sessions.panel.review.reviewer')),
      (n) => n.props.value === runtime && 'disabled' in n.props,
    );
  const requestButton = (t: ReactNode): ReactElement<any> =>
    find(t, (n) => n.type === 'button' && text(n).startsWith('请 '));

  it('offers an ACP runtime with read isolation as the reviewer and asks it to review', async () => {
    bridge.statuses = [
      status('claude', NATIVE),
      status('codex', NATIVE),
      grok({ read_isolation: true }),
    ];
    const h = await tab();
    expect(radio(tree(h), 'grok').props.disabled).toBe(false);
    expect(text(requestButton(tree(h)))).toBe(reviewWith('Codex'));
    labelled(tree(h), zh('sessions.panel.review.reviewer')).props.onValueChange('grok');
    await h.flush();
    expect(text(requestButton(tree(h)))).toBe(reviewWith('grok'));
    requestButton(tree(h)).props.onClick();
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'review.request',
        input: { session_id: 'session-a', runtimes: ['grok'] },
      }),
    ]);
  });

  it('greys out an ACP runtime without read isolation and gives the reason', async () => {
    bridge.statuses = [
      status('claude', NATIVE),
      status('codex', NATIVE),
      grok({ read_isolation: false }),
    ];
    const h = await tab();
    expect(radio(tree(h), 'grok').props.disabled).toBe(true);
    expect(
      tips(labelled(tree(h), zh('sessions.panel.review.reviewer'))).map((n) => n.props.content),
    ).toEqual([zh('data.runtimeStatus.noReadIsolation')]);
  });
});

describe('harness page runtime settings', () => {
  const page = () => mounted(() => HarnessPage({ projectId: null }));
  const row = (h: HookHost<any>, runtime: string) => labelled(tree(h), runtime);

  it('lists the session kinds each runtime can hold', async () => {
    bridge.statuses = [status('claude', NATIVE), grok({ read_isolation: true })];
    const h = await page();
    const kinds = (runtime: string) =>
      nodes(labelled(row(h, runtime), zh('settings.harness.kinds')))
        .filter((n) => n.type === 'li')
        .map((n) => text(n));
    expect(kinds('Claude')).toEqual([kind.writer, kind.reviewer, kind.text]);
    expect(kinds('grok')).toEqual([kind.reviewer, kind.text]);
  });

  it('turns a runtime off with runtime.config.set and checks the runtimes again', async () => {
    bridge.statuses = [status('claude', NATIVE), grok()];
    const h = await page();
    const toggle = labelled(row(h, 'grok'), enable('grok'));
    expect(toggle.props.checked).toBe(true);
    toggle.props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'runtime.config.set',
        input: { runtime: 'grok', enabled: false },
      }),
    ]);
    expect(statusQueries().map((q) => q.params)).toEqual([{}, { refresh: 'true' }]);
    expect(toasts).toEqual([]);
  });

  it('lists a turned-off runtime from status so it can be turned back on', async () => {
    bridge.statuses = [status('claude', NATIVE), { ...status('agy', {}), enabled: false }];
    const h = await page();
    const toggle = labelled(row(h, 'agy'), enable('agy'));
    expect(toggle.props.checked).toBe(false);
    toggle.props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([{ runtime: 'agy', enabled: true }]);
  });

  it('saves the binary path on Enter, once', async () => {
    bridge.statuses = [grok()];
    const h = await page();
    const path = () =>
      labelled(
        row(h, 'grok'),
        t({ id: 'settings.harness.binary', defaultMessage: '' }, { runtime: 'grok' }),
      );
    path().props.onChange({ target: { value: ' /opt/grok/bin/grok ' } });
    await h.flush();
    path().props.onKeyDown({ key: 'Enter' });
    await h.flush();
    path().props.onBlur();
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { runtime: 'grok', binary: '/opt/grok/bin/grok' },
    ]);
  });

  it('says why the change was refused in the runtime group and keeps the runtimes as they were', async () => {
    bridge.statuses = [grok()];
    bridge.commandAnswer = {
      ok: false,
      error: { code: 'unsupported_capability', message: 'This daemon cannot configure runtimes' },
    };
    const h = await page();
    labelled(row(h, 'grok'), enable('grok')).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(toasts).toEqual([]);
    expect(text(find(row(h, 'grok'), (n) => n.props.role === 'alert'))).toContain(
      'This daemon cannot configure runtimes',
    );
    expect(statusQueries()).toHaveLength(1);
    expect(labelled(row(h, 'grok'), enable('grok')).props.checked).toBe(true);
  });
});
