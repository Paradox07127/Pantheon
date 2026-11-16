import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, RuntimeStatus } from '@pantheon/protocol';
import {
  find,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
  type HookHost,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { failureText } from '@/data/needs-you';
import { HarnessPage } from '@/screens/settings/HarnessPage';
import { GeneralPage } from '@/screens/settings/GeneralPage';
import { Row } from '@/screens/settings/ProjectSettingsScreen';
import { SessionDefaults } from '@/screens/settings/SessionDefaultsPage';
import { searchSettings } from '@/screens/settings/settings-search';
import { useSettingsView } from '@/screens/settings/view';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const bridge = {
  answers: {} as Record<string, unknown>,
  commandAnswer: { ok: true, value: {} } as BridgeResult<unknown>,
  loginAnswer: { ok: true, value: undefined } as BridgeResult<void>,
  queries: [] as { method: string; params?: Record<string, string> }[],
  commands: [] as Command[],
  logins: [] as string[],
  async query(method: string, params?: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer;
  },
  async runtimeLogin(runtime: string): Promise<BridgeResult<void>> {
    bridge.logins.push(runtime);
    return bridge.loginAnswer;
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
  ...extra,
});
const writable = (runtime: string) => ({
  runtime,
  version: '1.0.0',
  capabilities: { write_isolation: { status: 'supported' } },
});
const model = (id: string, efforts: string[] = ['low', 'high']) => ({
  id,
  label: id,
  efforts,
  default_effort: efforts[0] ?? null,
  default: false,
  permission_modes: [] as string[],
});

async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const expand = (node: ReactElement<any>) =>
  (node.type as (props: unknown) => ReactNode)(node.props);
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);
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
  bridge.loginAnswer = { ok: true, value: undefined };
  bridge.queries = [];
  bridge.commands = [];
  bridge.logins = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ page: 'general' });
});

describe('auto git init setting', () => {
  const page = async () => {
    const general = await mount(() => GeneralPage());
    const shown = named(tree(general), 'AutoGitInitRow');
    return mount(() => expand(shown));
  };
  const toggle = (t: ReactNode) => labelled(t, zh('settings.projects.autoGitInit'));

  it('is a row of the general page, the switch at its end', async () => {
    bridge.answers['app.settings'] = { auto_git_init: true };
    const h = await page();
    const row = find(tree(h), (n) => n.type === Row);
    expect(row.props.label).toBe(zh('settings.projects.autoGitInit'));
    expect(find(row.props.children, (n) => n.type === 'input').props.type).toBe('checkbox');
  });

  it('shows the stored auto git init setting and writes the change with app.settings.set', async () => {
    bridge.answers['app.settings'] = { auto_git_init: true };
    const h = await page();
    expect(toggle(tree(h)).props.checked).toBe(true);
    toggle(tree(h)).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'app.settings.set',
        input: { auto_git_init: false },
        expected_revision: null,
      }),
    ]);
    expect(toggle(tree(h)).props.checked).toBe(false);
    expect(alerts(tree(h))).toEqual([]);
  });

  it('keeps the stored value and names the reason when the write fails', async () => {
    bridge.answers['app.settings'] = { auto_git_init: true };
    bridge.commandAnswer = {
      ok: false,
      error: { code: 'not_implemented', message: 'app.settings.set is not implemented' },
    };
    const h = await page();
    toggle(tree(h)).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(toggle(tree(h)).props.checked).toBe(true);
    expect(alerts(tree(h))).toEqual([
      failureText({ code: 'not_implemented', message: 'app.settings.set is not implemented' }),
    ]);
  });

  it('names the reason when the read fails', async () => {
    const h = await page();
    expect(alerts(tree(h))).toEqual([
      failureText({ code: 'unknown_route', message: 'app.settings' }),
    ]);
  });
});

describe('session defaults model', () => {
  const saved = {
    ...project,
    session_defaults: {
      runtime: 'claude',
      permission_mode: 'ask',
      model: 'claude-opus',
      effort: 'high',
    },
  };
  beforeEach(() => {
    bridge.answers.capabilities = [writable('claude'), writable('codex')];
    bridge.answers['runtime.status'] = [status('claude'), status('codex')];
    bridge.answers['runtime.models'] = [model('claude-opus'), model('claude-sonnet')];
  });
  const menu = (h: HookHost<any>) => named(tree(h), 'ModelMenu');

  it('starts from the saved model and saves a new one with its effort', async () => {
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    expect(menu(h).props.value).toEqual({
      runtime: 'claude',
      backend: null,
      model: 'claude-opus',
      effort: 'high',
    });
    expect(menu(h).props.runtimes).toEqual(['claude', 'codex']);
    menu(h).props.onChange({
      runtime: 'claude',
      backend: null,
      model: 'claude-sonnet',
      effort: 'low',
    });
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      {
        project_id: 'alpha',
        runtime: 'claude',
        permission_mode: 'ask',
        model: 'claude-sonnet',
        effort: 'low',
      },
    ]);
  });

  it('takes the runtime the model menu picks', async () => {
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    menu(h).props.onChange({ runtime: 'codex', backend: null, model: null, effort: null });
    await h.flush();
    expect(menu(h).props.value).toEqual({
      runtime: 'codex',
      backend: null,
      model: null,
      effort: null,
    });
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', runtime: 'codex', permission_mode: 'auto_edit' },
    ]);
  });

  const single = (h: HookHost<any>) => labelled(tree(h), zh('settings.defaults.leadModelForAll'));

  it('saves the one-model switch with the default model and keeps it across other edits', async () => {
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    expect(single(h).props).toMatchObject({ checked: false, disabled: false });
    single(h).props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands.at(-1)!.input).toEqual({
      project_id: 'alpha',
      runtime: 'claude',
      permission_mode: 'ask',
      model: 'claude-opus',
      effort: 'high',
      single_model: true,
    });
    const on = await mount(() =>
      SessionDefaults({
        project: {
          ...saved,
          session_defaults: { ...saved.session_defaults, single_model: true },
        } as never,
      }),
    );
    expect(single(on).props.checked).toBe(true);
    labelled(tree(on), zh('settings.defaults.permissionMode')).props.onValueChange('plan');
    await on.flush();
    expect(bridge.commands.at(-1)!.input).toMatchObject({
      permission_mode: 'plan',
      single_model: true,
    });
  });

  it('turns the one-model switch off and disables it while no default model is chosen', async () => {
    const h = await mount(() =>
      SessionDefaults({
        project: {
          ...saved,
          session_defaults: { ...saved.session_defaults, single_model: true },
        } as never,
      }),
    );
    menu(h).props.onChange({ runtime: 'claude', backend: null, model: null, effort: null });
    await h.flush();
    expect(single(h).props).toMatchObject({ checked: false, disabled: true });
    expect(bridge.commands.at(-1)!.input).toEqual({
      project_id: 'alpha',
      runtime: 'claude',
      permission_mode: 'ask',
    });
  });

  it('offers more than four runtimes in the model menu', async () => {
    const five = ['claude', 'codex', 'agy', 'grok', 'other'];
    bridge.answers.capabilities = five.map(writable);
    bridge.answers['runtime.status'] = five.map((r) => status(r));
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    expect(menu(h).props.runtimes).toEqual(five);
  });

  it('greys out a runtime that cannot start a session and gives the reason', async () => {
    bridge.answers['runtime.status'] = [status('claude'), status('codex', { installed: false })];
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    expect(menu(h).props.unavailable).toEqual({ codex: zh('data.runtimeStatus.notInstalled') });
  });
});

describe('harness page', () => {
  const page = (projectId: string | null = null) => mount(() => HarnessPage({ projectId }));

  it('shows the version, account, plan and check time of each runtime from runtime.status', async () => {
    bridge.answers['runtime.status'] = [status('claude')];
    const h = await page();
    const claude = text(labelled(tree(h), 'Claude'));
    expect(claude).toContain('2.1.312');
    expect(claude).toContain('dev@example.com');
    expect(claude).toContain('max');
    expect(claude).toContain('3 分钟');
    expect(buttons(labelled(tree(h), 'Claude'), zh('settings.harness.logIn'))).toEqual([]);
    expect(bridge.queries.map((q) => q.method)).not.toContain('capabilities');
  });

  it('names the minimum version of a runtime that is too old', async () => {
    bridge.answers['runtime.status'] = [
      status('codex', { version: '0.100.0', min_version: '0.165.0', version_ok: false }),
    ];
    const h = await page();
    const codex = text(labelled(tree(h), 'Codex'));
    expect(codex).toContain('0.100.0');
    expect(codex).toContain('0.165.0');
  });

  it('says a runtime is missing and lists models only for installed ones', async () => {
    bridge.answers['runtime.status'] = [
      status('claude'),
      status('codex', { installed: false, version: null, auth: { state: 'unknown' } }),
    ];
    bridge.answers['runtime.models'] = [model('claude-opus')];
    const h = await page('harness-project');
    await h.flush();
    expect(text(labelled(tree(h), 'Codex'))).toContain(zh('settings.runtimes.noBinary'));
    expect(text(labelled(tree(h), 'Claude'))).toContain('claude-opus');
    expect(
      bridge.queries.filter((q) => q.method === 'runtime.models').map((q) => q.params?.runtime),
    ).toEqual(['claude']);
  });

  it('opens the login of a logged-out runtime and checks again', async () => {
    bridge.answers['runtime.status'] = [
      status('claude'),
      status('codex', { auth: { state: 'logged_out' } }),
    ];
    const h = await page();
    expect(text(labelled(tree(h), 'Codex'))).toContain(zh('settings.runtimes.signedOut'));
    button(labelled(tree(h), 'Codex'), zh('settings.harness.logIn')).props.onClick();
    await h.flush();
    expect(bridge.logins).toEqual(['codex']);
    expect(statusQueries().map((q) => q.params)).toEqual([{}, { refresh: 'true' }]);
  });

  it('names why the login could not open', async () => {
    bridge.answers['runtime.status'] = [status('codex', { auth: { state: 'logged_out' } })];
    bridge.loginAnswer = { ok: false, error: { code: 'ipc_failed', message: 'no terminal' } };
    const h = await page();
    button(labelled(tree(h), 'Codex'), zh('settings.harness.logIn')).props.onClick();
    await h.flush();
    expect(alerts(tree(h))).toHaveLength(1);
  });

  it('shows a failed read of the runtimes', async () => {
    const h = await page();
    expect(alerts(tree(h))).toHaveLength(1);
  });

  it('anchors the artifacts, isolation and session kind rows, and says what the isolation switch lets run', async () => {
    bridge.answers['runtime.status'] = [
      status('claude', { capabilities: { text_execution: { status: 'supported' } } as never }),
    ];
    const h = await page();
    const rows = nodes(labelled(tree(h), 'Claude')).filter((n) => n.type === Row);
    expect(rows.map((r) => r.props.settingId)).toEqual(
      expect.arrayContaining(['harness.artifacts', 'harness.unverifiedIsolation', 'harness.kinds']),
    );
    const isolation = rows.find((r) => r.props.settingId === 'harness.unverifiedIsolation')!;
    expect(isolation.props.hint).toBe(zh('settings.runtimes.unverifiedIsolationHint'));
    const found = (query: string) => searchSettings(query).map((hit) => hit.id);
    expect(found(zh('settings.runtimes.unverifiedIsolation'))).toContain(
      'harness.unverifiedIsolation',
    );
    expect(found(zh('settings.harness.artifacts'))).toContain('harness.artifacts');
    expect(found(zh('settings.harness.kinds'))).toContain('harness.kinds');
    expect(found(zh('settings.harness.quota'))).toContain('harness.quota');
  });

  it('shows the version number alone, whatever text the runtime prints around it', async () => {
    bridge.answers['runtime.status'] = [
      status('claude', { version: '2.1.325 (Claude Code)' }),
      status('codex', { version: 'codex-cli 0.169.0' }),
    ];
    const h = await page();
    expect(text(labelled(tree(h), 'Claude'))).toContain('2.1.325');
    expect(text(labelled(tree(h), 'Claude'))).not.toContain('Claude Code');
    expect(text(labelled(tree(h), 'Codex'))).toContain('0.169.0');
    expect(text(labelled(tree(h), 'Codex'))).not.toContain('codex-cli');
  });

  describe('backends', () => {
    // backend.list is read once across mounts; each test moves the clock past the earlier read.
    let clock = Date.now();
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime((clock += 10 * 60_000));
      bridge.answers['runtime.status'] = [status('claude')];
    });
    afterEach(() => vi.useRealTimers());
    const section = (h: HookHost<any>) =>
      nodes(tree(h)).filter((n) => n.props['data-setting-id'] === 'harness.backends');

    it('lists each configured backend with its address, runtimes and key', async () => {
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
        {
          id: 'vault',
          protocol: 'openai',
          base_url: 'https://vault.example.com/v1',
          models: [],
          runtimes: ['codex'],
          key: { keychain: 'pantheon-vault' },
        },
      ];
      const h = await page();
      const [shown] = section(h);
      expect(shown).toBeDefined();
      const router = text(labelled(shown, 'router'));
      expect(router).toContain('https://router.example.com');
      expect(router).toContain('anthropic');
      expect(router).toContain('Claude');
      expect(router).toContain('ROUTER_KEY');
      expect(router).toContain(zh('settings.runtimes.keyMissing'));
      const vault = text(labelled(shown, 'vault'));
      expect(vault).toContain('https://vault.example.com/v1');
      expect(vault).toContain('Codex');
      expect(vault).toContain(zh('settings.harness.backendKeychain'));
      expect(vault).toContain('pantheon-vault');
      expect(vault).not.toContain(zh('settings.runtimes.keyMissing'));
    });

    it('leaves out the backends when none is configured or the list cannot be read', async () => {
      bridge.answers['backend.list'] = [];
      expect(section(await page())).toEqual([]);
      vi.setSystemTime((clock += 10 * 60_000));
      delete bridge.answers['backend.list'];
      const failed = await page();
      expect(section(failed)).toEqual([]);
      expect(alerts(tree(failed))).toEqual([]);
    });
  });
});
