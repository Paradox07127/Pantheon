import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, RuntimeStatus } from '@pantheon/protocol';
import {
  HookHost,
  deferred,
  find,
  mount as host,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { Collapsible } from '../../apps/web/node_modules/@base-ui/react/collapsible/index.mjs';
const mock = vi.hoisted(() => ({ toasts: [] as unknown[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => void mock.toasts.push(options),
}));
import { RuntimeGlyph } from '@/components/RuntimeGlyph';
import { useBoard } from '@/data/board';
import { HarnessPage } from '@/screens/settings/HarnessPage';
import { Row } from '@/screens/settings/ProjectSettingsScreen';
import { pageHeader } from '@/screens/settings/settings-header';
import { useSettingsView } from '@/screens/settings/view';
import { t } from '@/i18n';
import { zh, zhf } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown> };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const bridge = {
  answers: {} as Record<string, unknown>,
  commandAnswer: { ok: true, value: {} } as BridgeResult<unknown>,
  queries: [] as { method: string; params?: Record<string, string> }[],
  commands: [] as Command[],
  /** Holds back the answers to checks that skip the daemon's cache. */
  hold: null as Promise<void> | null,
  async query(method: string, params?: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    if (params?.refresh && bridge.hold) await bridge.hold;
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer;
  },
  async runtimeLogin(): Promise<BridgeResult<void>> {
    return { ok: true, value: undefined };
  },
};

const status = (runtime: string, extra: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  runtime,
  enabled: true,
  installed: true,
  version: '2.1.312',
  min_version: '2.1.312',
  version_ok: true,
  auth: { state: 'ok', email: 'dev@example.com', plan: 'max' },
  checked_at: new Date(Date.now() - 3 * 60_000).toISOString(),
  capabilities: {
    write_isolation: { status: 'supported', evidence: 'probe' },
    text_execution: { status: 'supported', evidence: 'probe' },
    read_isolation: { status: 'supported', evidence: 'probe' },
  },
  ...extra,
});
const quota = {
  windows: [{ window: 'five_hour', used_percent: 95, resets_at: Date.now() + 3_600_000 }],
  seen_at: Date.now(),
};

const [binary, account] = [zh('settings.runtimes.binary'), zh('settings.runtimes.account')];
const named = (id: string, defaultMessage: string, runtime: string) =>
  t({ id: `settings.harness.${id}`, defaultMessage }, { runtime });
async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const page = (projectId: string | null = null) => mount(() => HarnessPage({ projectId }));
const tree = (h: HookHost<any>) => h.value as ReactNode;
const group = (t: ReactNode, name: string) =>
  find(t, (n) => n.props.role === 'group' && n.props['aria-label'] === name);
const rows = (t: ReactNode) => nodes(t).filter((n): n is ReactElement<any> => n.type === Row);
const row = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === Row && n.props.label === label);
const buttons = (t: ReactNode, label: string) =>
  nodes(t).filter((n) => n.type === 'button' && text(n.props.children) === label);
const alerts = (t: ReactNode) =>
  nodes(t)
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));
const statusQueries = () => bridge.queries.filter((q) => q.method === 'runtime.status');

beforeEach(() => {
  bridge.answers = {};
  bridge.commandAnswer = { ok: true, value: {} };
  bridge.queries = [];
  bridge.commands = [];
  bridge.hold = null;
  mock.toasts = [];
  vi.stubGlobal('window', { pantheon: bridge });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ open: false, page: 'general' });
});

describe('runtimes page header', () => {
  it('checks the runtimes again from a tool at the end of the header', async () => {
    bridge.answers['runtime.status'] = [status('claude')];
    const h = await page();
    expect(buttons(tree(h), zh('settings.harness.recheck'))).toEqual([]);
    const Tools = pageHeader('harness').tools as (props: { project: null }) => ReactNode;
    const tools = await mount(() => Tools({ project: null }));
    const [recheck] = buttons(tree(tools), zh('settings.harness.recheck'));
    expect(recheck!.props.className).toBe('btn ghost sm');
    recheck!.props.onClick();
    await h.flush();
    expect(statusQueries().map((q) => q.params)).toEqual([{}, { refresh: 'true' }]);
  });

  it('says the check is running, the tool off and busy, until the runtimes answer', async () => {
    bridge.answers['runtime.status'] = [status('claude')];
    const h = await page();
    const Tools = pageHeader('harness').tools as (props: { project: null }) => ReactNode;
    const tools = await mount(() => Tools({ project: null }));
    const tool = () => find(tree(tools), (n) => n.type === 'button');
    const held = deferred<void>();
    bridge.hold = held.promise;
    tool().props.onClick();
    await h.flush();
    tools.render();
    expect(text(tool())).toBe(zh('settings.harness.checking'));
    expect(tool().props.disabled).toBe(true);
    expect(tool().props['aria-busy']).toBe(true);

    held.resolve();
    await h.flush();
    tools.render();
    expect(text(tool())).toBe(zh('settings.harness.recheck'));
    expect(tool().props.disabled).toBe(false);
    expect(tool().props['aria-busy']).toBeUndefined();
  });
});

describe('runtimes page groups', () => {
  it('gives each runtime its own group of named rows, the switch in its head row', async () => {
    bridge.answers['runtime.status'] = [status('claude')];
    bridge.answers['runtime.models'] = [
      {
        id: 'claude-opus',
        label: 'claude-opus',
        efforts: [],
        default_effort: null,
        default: false,
      },
    ];
    const h = await page('alpha');
    await h.flush();
    const claude = group(tree(h), 'Claude');
    const models = zh('settings.harness.models');
    expect(rows(claude).map((r) => r.props.label)).toEqual([
      binary,
      zh('settings.search.harnessArgs'),
      account,
      zh('settings.harness.artifacts'),
      zh('settings.harness.kinds'),
      models,
    ]);
    const head = find(claude, (n) => n.props['data-setting-id'] === 'harness.enable');
    expect(find(head, (n) => n.type === RuntimeGlyph).props.runtime).toBe('claude');
    expect(text(head)).toContain('2.1.312');
    expect(text(head)).toContain('3 分钟');
    expect(find(head, (n) => n.type === 'input').props['aria-label']).toBe(
      named('enable', 'Enable {runtime}', 'Claude'),
    );
    expect(text(row(claude, models))).toContain('claude-opus');
  });

  it('orders the runtime groups by the runtime table, not by the daemon', async () => {
    bridge.answers['runtime.status'] = ['fixture', 'grok', 'agy', 'codex', 'claude'].map((r) =>
      status(r),
    );
    const h = await page();
    const heads = nodes(tree(h)).filter((n) => n.props['data-setting-id'] === 'harness.enable');
    expect(heads.map((head) => find(head, (n) => n.type === RuntimeGlyph).props.runtime)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'fixture',
    ]);
  });

  it('folds the runtimes that are not installed into one closed group at the end, named with its count', async () => {
    const missing = { installed: false, version: null, auth: { state: 'unknown' as const } };
    bridge.answers['runtime.status'] = [
      status('grok', missing),
      status('codex'),
      status('agy', missing),
      status('claude'),
    ];
    const h = await page();
    const runtimes = (t: ReactNode) =>
      nodes(t)
        .filter((n) => n.props['data-setting-id'] === 'harness.enable')
        .map((head) => find(head, (n) => n.type === RuntimeGlyph).props.runtime);
    expect(runtimes(tree(h))).toEqual(['claude', 'codex', 'agy', 'grok']);
    const fold = find(tree(h), (n) => n.type === Collapsible.Root);
    expect(fold.props.defaultOpen).toBe(false);
    expect(runtimes(find(fold, (n) => n.type === Collapsible.Panel))).toEqual(['agy', 'grok']);
    const header = text(find(fold, (n) => n.type === Collapsible.Trigger));
    expect(header).toContain(zh('settings.harness.notInstalled'));
    expect(header).toContain('2');
  });

  it('shows the account with its plan and that it is connected', async () => {
    bridge.answers['runtime.status'] = [status('claude')];
    const h = await page();
    const shown = text(row(group(tree(h), 'Claude'), account));
    expect(shown).toContain('dev@example.com');
    expect(shown).toContain('max');
    expect(shown).toContain(zh('settings.runtimes.connected'));
  });

  it('hides the account email until the user shows it, and hides it again', async () => {
    bridge.answers['runtime.status'] = [status('claude')];
    const h = await page();
    const email = () =>
      find(row(group(tree(h), 'Claude'), account), (n) => text(n) === 'dev@example.com');
    expect(email().type).toBe('button');
    expect(email().props['aria-label']).toBe(zh('settings.runtimes.showEmail'));
    expect(email().props['data-hidden']).toBe('');
    email().props.onClick();
    await h.flush();
    expect(email().props['aria-label']).toBe(
      t({ id: 'settings.runtimes.hideEmail', defaultMessage: '' }, { email: 'dev@example.com' }),
    );
    expect(email().props['data-hidden']).toBeUndefined();
    email().props.onClick();
    await h.flush();
    expect(email().props['data-hidden']).toBe('');
  });

  it('says a runtime without an account check is connected, and one whose check failed is not', async () => {
    const connection = (connected: boolean) => ({
      connected,
      held_session_count: 0,
      held_session_ids: [],
    });
    bridge.answers['runtime.status'] = [
      status('grok', { auth: { state: 'unknown' }, connection: connection(true) }),
      status('agy', { auth: { state: 'unknown' }, connection: connection(false) }),
    ];
    const h = await page();
    const state = (runtime: string) => {
      const shown = row(group(tree(h), runtime), account);
      return [find(shown, (n) => n.props['data-s'] !== undefined).props['data-s'], text(shown)];
    };
    expect(state('grok')).toEqual(['ok', zh('settings.runtimes.connected')]);
    expect(state('agy')).toEqual(['bad', zh('settings.runtimes.disconnected')]);
  });

  it('names why a runtime is not connected on its account row', async () => {
    const reason = 'spawn agy ENOENT';
    bridge.answers['runtime.status'] = [
      status('agy', {
        auth: { state: 'unknown' },
        connection: { connected: false, reason, held_session_count: 0, held_session_ids: [] },
      }),
    ];
    const h = await page();
    expect(text(row(group(tree(h), 'agy'), account))).toBe(
      zhf('settings.runtimes.disconnectedBecause', { reason }),
    );
  });

  it('says a signed-out account is not signed in and offers the login there', async () => {
    bridge.answers['runtime.status'] = [status('codex', { auth: { state: 'logged_out' } })];
    const h = await page();
    const shown = row(group(tree(h), 'Codex'), account);
    expect(text(shown)).toContain(zh('settings.runtimes.signedOut'));
    expect(buttons(shown, zh('settings.harness.logIn'))).toHaveLength(1);
  });

  it('draws neither the quota nor a link to the engineering board for it', async () => {
    bridge.answers['runtime.status'] = [status('codex', { quota })];
    const h = await page('alpha');
    const codex = group(tree(h), 'Codex');
    expect(nodes(codex).filter((n) => n.props.role === 'meter')).toEqual([]);
    expect(rows(codex).filter((r) => r.props.settingId === 'harness.quota')).toEqual([]);
    expect(buttons(codex, '看用量')).toEqual([]);
  });

  it('says no executable was found and asks for its path', async () => {
    bridge.answers['runtime.status'] = [
      status('agy', { installed: false, version: null, auth: { state: 'unknown' } }),
    ];
    const h = await page();
    const agy = group(tree(h), 'agy');
    expect(text(find(agy, (n) => n.props['data-setting-id'] === 'harness.enable'))).toContain(
      zh('settings.runtimes.noBinary'),
    );
    expect(rows(agy).map((r) => r.props.label)).toEqual([binary]);
    const path = find(row(agy, binary), (n) => n.type === 'input');
    expect(path.props.placeholder).toBe(named('binary', 'Binary path of {runtime}', 'agy'));
  });

  it('publishes Claude artifacts by default and saves the switch turned off, a switch only Claude has', async () => {
    bridge.answers['runtime.status'] = [status('claude'), status('codex')];
    const h = await page();
    const label = zh('settings.harness.artifacts');
    const publish = () => find(group(tree(h), 'Claude'), (n) => n.props['aria-label'] === label);
    expect(publish().props.checked).toBe(true);
    expect(nodes(group(tree(h), 'Codex')).some((n) => n.props['aria-label'] === label)).toBe(false);
    bridge.answers['runtime.status'] = [status('claude', { artifacts: false }), status('codex')];
    publish().props.onChange({ target: { checked: false } });
    await h.flush();
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([{ runtime: 'claude', artifacts: false }]);
    expect(publish().props.checked).toBe(false);
  });

  it('offers a switch to allow a runtime without verified write isolation, and none to Claude or Codex', async () => {
    const unverified = {
      write_isolation: { status: 'unsupported' as const, evidence: 'probe' },
      text_execution: { status: 'supported' as const, evidence: 'probe' },
    };
    const statuses = (extra: Partial<RuntimeStatus> = {}) => [
      status('claude'),
      status('codex'),
      status('grok', { capabilities: unverified, ...extra }),
    ];
    bridge.answers['runtime.status'] = statuses();
    const h = await page();
    const label = zh('settings.runtimes.unverifiedIsolation');
    const labelled = (n: ReactElement<any>) => n.props['aria-label'] === label;
    const allow = () => find(group(tree(h), 'grok'), (n) => n.type === 'input' && labelled(n));
    expect(allow().props.checked).toBe(false);
    for (const name of ['Claude', 'Codex'])
      expect(nodes(group(tree(h), name)).some(labelled)).toBe(false);
    bridge.answers['runtime.status'] = statuses({ unverified_isolation: true });
    allow().props.onChange({ target: { checked: true } });
    await h.flush();
    await h.flush();
    expect(bridge.commands.map(({ type, input }) => ({ type, input }))).toEqual([
      { type: 'runtime.config.set', input: { runtime: 'grok', unverified_isolation: true } },
    ]);
    expect(allow().props.checked).toBe(true);
  });

  it('names a refused change inside the runtime group, not in a toast', async () => {
    bridge.answers['runtime.status'] = [status('claude'), status('codex')];
    bridge.commandAnswer = {
      ok: false,
      error: { code: 'unsupported_capability', message: 'This daemon cannot configure runtimes' },
    };
    const h = await page();
    const enable = named('enable', 'Enable {runtime}', 'Codex');
    find(group(tree(h), 'Codex'), (n) => n.props['aria-label'] === enable).props.onChange({
      target: { checked: false },
    });
    await h.flush();
    expect(mock.toasts).toEqual([]);
    expect(alerts(group(tree(h), 'Claude'))).toEqual([]);
    const [why] = alerts(group(tree(h), 'Codex'));
    expect(why).toContain('This daemon cannot configure runtimes');
  });
});

describe('runtimes page backends', () => {
  let clock = Date.now();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((clock += 60 * 60_000));
    bridge.answers['runtime.status'] = [status('claude')];
  });
  afterEach(() => vi.useRealTimers());

  it('lists the backends in their own group with the runtime mark and an unset key', async () => {
    bridge.answers['backend.list'] = [
      {
        id: 'router',
        protocol: 'anthropic',
        base_url: 'https://router.example.com',
        models: [],
        runtimes: ['claude'],
        key: { env: 'ROUTER_KEY' },
        key_present: false,
      },
    ];
    const h = await page();
    const section = find(tree(h), (n) => n.props.title === zh('settings.harness.backends'));
    const router = find(section, (n) => n.props['aria-label'] === 'router');
    expect(find(router, (n) => n.type === RuntimeGlyph).props.runtime).toBe('claude');
    const shown = text(router);
    expect(shown).toContain('Claude');
    expect(shown).toContain('ROUTER_KEY');
    expect(shown).toContain(zh('settings.runtimes.keyMissing'));
  });
});
