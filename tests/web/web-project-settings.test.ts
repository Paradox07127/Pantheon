import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BridgeResult } from '@pantheon/protocol';
import { Sidebar } from '@/components/Sidebar';
import { useBoard } from '@/data/board';
import {
  autoClosedReason,
  canSave,
  changeLine,
  closedCount,
  inventoryState,
  loadState,
  missingFromInventory,
  readInventory,
  RUNTIMES,
  savedOverrides,
  selectionChanges,
  setClosed,
  setFlag,
  setOpened,
  type ExtensionInventory,
  type ExtensionOverrides,
} from '@/data/extensions';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const TRACING = 'tracing@codex-observability-plugin';

const inventory: ExtensionInventory = {
  runtime: 'codex',
  mcp_servers: [
    { name: 'code-search', enabled: true },
    { name: 'docs', enabled: false, plugin: 'docs@local-market' },
  ],
  plugins: [
    { id: TRACING, enabled: true },
    { id: 'docs@local-market', enabled: false },
  ],
  skills: [
    {
      id: '/Users/me/.codex/skills/review/SKILL.md',
      name: 'review',
      path: '/Users/me/.codex/skills/review/SKILL.md',
      enabled: true,
    },
    {
      id: '/Users/me/.codex/plugins/docs/skills/write-docs/SKILL.md',
      name: 'write-docs',
      enabled: false,
      path: '/Users/me/.codex/plugins/docs/skills/write-docs/SKILL.md',
      plugin: 'docs@local-market',
    },
  ],
  apps: true,
  connectors: [
    { name: 'calendar', title: 'Calendar', enabled: true },
    { name: 'drive', title: 'Drive', enabled: false },
  ],
  hooks: [{ event: 'SessionStart', plugin: TRACING }, { event: 'Stop' }],
};

const saved: ExtensionOverrides = {
  disabled_mcp_servers: ['code-search', 'removed-server'],
  disabled_plugins: ['gone@old-market'],
  disabled_skills: [
    '/Users/me/.codex/skills/review/SKILL.md',
    '/Users/me/.codex/skills/old/SKILL.md',
  ],
  disable_apps: true,
  disable_hooks: false,
};

const REVIEW = '/Users/me/.codex/skills/review/SKILL.md';
const NONE = savedOverrides({}, 'codex');
const loadedOf = (items: readonly { loaded: boolean }[]) => items.map((i) => i.loaded);

describe('settings pages', () => {
  it("lists the app pages, then the pages for every project, then a project's parts, and opens on the general app page", () => {
    const groups = SETTINGS_PAGES.map((p) => p.group);
    expect(groups.indexOf('global')).toBe(groups.lastIndexOf('app') + 1);
    expect(groups.indexOf('project')).toBe(groups.lastIndexOf('global') + 1);
    expect(useSettingsView.getState().page).toBe('general');
    expect(SETTINGS_PAGES.find((p) => p.key === 'general')).toMatchObject({
      label: zh('settings.pages.general'),
      group: 'app',
    });
  });

  it('switches to the chosen page', () => {
    useSettingsView.getState().setPage('gates');
    expect(useSettingsView.getState().page).toBe('gates');
    useSettingsView.getState().setPage('general');
  });
});

describe('settings groups', () => {
  const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
  const groupLabels = (html: string) =>
    [...html.matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1]);

  beforeEach(() => vi.stubGlobal('window', {}));
  afterEach(() => {
    vi.unstubAllGlobals();
    useBoard.setState({ board: null });
    useSettingsView.setState({ page: 'general', detail: null });
  });
  const render = () => renderToStaticMarkup(createElement(ProjectSettingsScreen));

  it.each([
    ['with a project', [project]],
    ['without a project', []],
  ])('shows this computer and every project %s', (_name, projects) => {
    useBoard.setState({ board: { cursor: 0, projects, sessions: [] } as never });
    expect(groupLabels(render())).toEqual([zh('settings.nav.app'), zh('settings.nav.projects')]);
  });

  it('opens on the chosen page whichever project it is opened from', () => {
    useSettingsView.setState({ page: 'shortcuts' });
    useShell.getState().openSettings(null);
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      page: 'shortcuts',
      detail: null,
    });
    useSettingsView.setState({ open: false, page: 'workflow' });
    useShell.getState().openSettings('alpha');
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      page: 'workflow',
      detail: null,
    });
  });

  it('shows the data directory page, which needs the desktop bridge', () => {
    useBoard.setState({ board: { cursor: 0, projects: [], sessions: [] } as never });
    useSettingsView.setState({ page: 'data' });
    const html = render();
    expect(html).toContain('data-setting-id="data.folder"');
    expect(html).toContain(zh('settings.common.bridgeUnavailable'));
    vi.stubGlobal('window', { pantheon: {} });
    const waiting = render();
    expect(waiting).toContain('aria-busy="true"');
    expect(waiting).not.toContain(zh('settings.common.bridgeUnavailable'));
  });

  it('gives the gate no save button, since each change saves as it is made', () => {
    useBoard.setState({ board: { cursor: 0, projects: [project], sessions: [] } as never });
    useSettingsView.setState({ page: 'gates', detail: 'alpha' });
    const html = render();
    const start = html.indexOf(`aria-label="${zh('settings.gate.order')}"`);
    // The project's page goes on past the gate to blocks with save buttons.
    const gate = html.slice(start, html.indexOf('data-setting-id="worktrees.', start));
    expect(gate).toContain(zh('settings.gate.addStep'));
    expect(gate).not.toMatch(/<button type="button" class="btn pri"/);
  });

  it('opens no page for a removed project', () => {
    const removed = { ...project, id: 'beta', name: 'Beta app', removed_at: 1 };
    useBoard.setState({
      board: { cursor: 0, projects: [project, removed], sessions: [] } as never,
    });
    useSettingsView.setState({ page: 'projects', detail: 'beta' });
    expect(render()).not.toContain('data-setting-id="project.remove"');
    useSettingsView.setState({ detail: 'alpha' });
    expect(render()).toContain('data-setting-id="project.remove"');
  });

  it('lets the sidebar open settings without a current project', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        layout: { collapsed: false, width: 280, resize() {}, commit() {}, reset() {}, toggle() {} },
        projects: [],
        currentProjectId: null,
        onChooseProject() {},
        list: { data: [], loading: false, error: null, reload() {} },
        allNeeds: { items: [], loading: false, error: null, reload() {} },
      }),
    );
    const button = new RegExp(
      `<button[^>]*>(?:(?!</button>).)*${zh('app.screenName.settings')}</button>`,
    ).exec(html)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled');
  });
});

describe('initial state', () => {
  it('inherits the machine setup when the project closed nothing', () => {
    expect(NONE).toEqual({
      disabled_mcp_servers: [],
      disabled_plugins: [],
      disabled_skills: [],
      disable_apps: false,
      disable_hooks: false,
    });
    expect(savedOverrides({ extension_overrides: { claude: saved } }, 'codex')).toEqual(NONE);
    const state = loadState(inventory, NONE);
    expect(loadedOf(state.mcp_servers)).toEqual(inventory.mcp_servers.map((s) => s.enabled));
    expect(loadedOf(state.plugins)).toEqual(inventory.plugins.map((p) => p.enabled));
    expect(loadedOf(state.skills)).toEqual(inventory.skills.map((s) => s.enabled));
    expect(loadedOf(state.connectors)).toEqual([false, false]);
    expect(state.hooks.loaded).toBe(true);
  });

  it('keeps each account connector off until the project opens it', () => {
    const opened = setOpened(NONE, 'enabled_user_connectors', 'calendar', true);
    expect(opened).toEqual({ ...NONE, enabled_user_connectors: ['calendar'] });
    expect(loadedOf(loadState(inventory, opened).connectors)).toEqual([true, false]);
    expect(loadedOf(loadState(inventory, { ...opened, disable_apps: true }).connectors)).toEqual([
      false,
      false,
    ]);
    const reopened = setOpened(saved, 'enabled_user_connectors', 'calendar', true);
    expect(reopened.disable_apps).toBe(false);
    expect(loadedOf(loadState(inventory, reopened).connectors)).toEqual([true, false]);
    const shut = setOpened(opened, 'enabled_user_connectors', 'calendar', false);
    expect(loadedOf(loadState(inventory, shut).connectors)).toEqual([false, false]);
    expect(selectionChanges(NONE, opened)).toEqual([
      { field: 'enabled_user_connectors', entry: 'calendar', closed: false },
    ]);
    expect(changeLine(selectionChanges(NONE, opened)[0]!, inventory, 'codex')).toEqual({
      action: zh('data.extensions.restore'),
      what: 'Apps Calendar',
    });
    expect(selectionChanges(opened, shut)).toEqual([
      { field: 'enabled_user_connectors', entry: 'calendar', closed: true },
    ]);
    expect(canSave(NONE, shut)).toBe(false);
  });

  it('drops the retired connector switch from a saved row', () => {
    const old = { ...NONE, enabled_user_apps: true } as ExtensionOverrides;
    expect(savedOverrides({ extension_overrides: { codex: old } }, 'codex')).toEqual(NONE);
  });

  it("takes the project's closing list off the machine setup", () => {
    expect(savedOverrides({ extension_overrides: { codex: saved } }, 'codex')).toBe(saved);
    const state = loadState(inventory, saved);
    expect(loadedOf(state.mcp_servers)).toEqual([false, false]);
    expect(loadedOf(state.plugins)).toEqual([true, false]);
    expect(loadedOf(state.skills)).toEqual([false, false]);
    expect(loadedOf(state.connectors)).toEqual([false, false]);
    expect(state.hooks.loaded).toBe(true);
  });

  it('gives the reason of an entry the assessment closed until the user turns it back on', () => {
    const project = {
      extension_auto: [
        {
          runtime: 'codex',
          kind: 'mcp_server' as const,
          name: 'code-search',
          reason: 'No workstream reads the code graph',
          baseline_id: 'baseline-1',
        },
        {
          runtime: 'codex',
          kind: 'skill' as const,
          name: REVIEW,
          reason: 'Reviews happen outside sessions',
          baseline_id: 'baseline-1',
          restored: true as const,
        },
      ],
    };
    expect(autoClosedReason(project, 'codex', 'disabled_mcp_servers', 'code-search')).toBe(
      'No workstream reads the code graph',
    );
    expect(autoClosedReason(project, 'claude', 'disabled_mcp_servers', 'code-search')).toBe(
      undefined,
    );
    expect(autoClosedReason(project, 'codex', 'disabled_plugins', 'code-search')).toBe(undefined);
    expect(autoClosedReason(project, 'codex', 'disabled_skills', REVIEW)).toBe(undefined);
    expect(autoClosedReason({}, 'codex', 'disabled_mcp_servers', 'code-search')).toBe(undefined);
  });

  it('turns off a server with the plugin that provides it', () => {
    const own: ExtensionInventory = {
      ...inventory,
      mcp_servers: [{ name: 'traces', enabled: true, plugin: TRACING }],
    };
    expect(loadState(own, NONE).mcp_servers[0]!.loaded).toBe(true);
    const off = setClosed(NONE, 'disabled_plugins', TRACING, true);
    expect(loadState(own, off).mcp_servers[0]!.loaded).toBe(false);
  });

  it('turns off a skill with the plugin that provides it', () => {
    const own: ExtensionInventory = {
      ...inventory,
      skills: [{ id: '/s/trace/SKILL.md', name: 'trace', enabled: true, plugin: TRACING }],
    };
    expect(loadState(own, NONE).skills[0]!.loaded).toBe(true);
    const off = setClosed(NONE, 'disabled_plugins', TRACING, true);
    expect(loadState(own, off).skills[0]!.loaded).toBe(false);
  });

  it('locks items the machine has off and servers a plugin provides', () => {
    const own: ExtensionInventory = {
      ...inventory,
      mcp_servers: [...inventory.mcp_servers, { name: 'traces', enabled: true, plugin: TRACING }],
      apps: false,
    };
    const state = loadState(own, NONE);
    expect(state.mcp_servers.map((s) => s.lock)).toEqual([
      null,
      { reason: 'machine_off' },
      { reason: 'plugin', plugin: TRACING },
    ]);
    expect(state.plugins.map((p) => p.lock)).toEqual([null, { reason: 'machine_off' }]);
    expect(state.skills.map((s) => s.lock)).toEqual([null, { reason: 'machine_off' }]);
    expect(state.connectors.map((c) => c.lock)).toEqual([null, { reason: 'machine_off' }]);
    expect(state.hooks).toEqual({ loaded: true, lock: null });
    expect(loadState({ ...own, hooks_enabled: false }, NONE).hooks).toEqual({
      loaded: false,
      lock: { reason: 'machine_off' },
    });
  });
});

describe('header count', () => {
  it('counts every closed item, flags included', () => {
    expect(closedCount(NONE)).toBe(0);
    expect(closedCount(saved)).toBe(6);
  });
});

describe('entries not in the inventory', () => {
  it('lists closed entries the machine no longer has, skills by ID', () => {
    expect(missingFromInventory(saved, inventory)).toEqual({
      disabled_mcp_servers: ['removed-server'],
      disabled_plugins: ['gone@old-market'],
      disabled_skills: ['/Users/me/.codex/skills/old/SKILL.md'],
    });
  });

  it('lists nothing when every closed entry is in the inventory', () => {
    expect(missingFromInventory(NONE, inventory)).toEqual({
      disabled_mcp_servers: [],
      disabled_plugins: [],
      disabled_skills: [],
    });
  });

  it('can remove such an entry from the closing list', () => {
    const s = setClosed(saved, 'disabled_plugins', 'gone@old-market', false);
    expect(s.disabled_plugins).toEqual([]);
    expect(missingFromInventory(s, inventory).disabled_plugins).toEqual([]);
    expect(selectionChanges(saved, s)).toEqual([
      { field: 'disabled_plugins', entry: 'gone@old-market', closed: false },
    ]);
  });
});

describe('assembling the overrides', () => {
  it('sets all five fields from the switches', () => {
    let s = NONE;
    s = setClosed(s, 'disabled_mcp_servers', 'code-search', true);
    s = setClosed(s, 'disabled_plugins', TRACING, true);
    s = setClosed(s, 'disabled_skills', REVIEW, true);
    s = setFlag(s, 'disable_apps', true);
    s = setFlag(s, 'disable_hooks', true);
    expect(s).toEqual({
      disabled_mcp_servers: ['code-search'],
      disabled_plugins: [TRACING],
      disabled_skills: [REVIEW],
      disable_apps: true,
      disable_hooks: true,
    });
  });

  it('does not add an entry twice', () => {
    const s = setClosed(saved, 'disabled_mcp_servers', 'code-search', true);
    expect(s.disabled_mcp_servers.filter((n) => n === 'code-search')).toHaveLength(1);
  });
});

describe('changes before saving', () => {
  const off = zh('data.extensions.turnOff');
  const on = zh('data.extensions.restore');

  it('lists each closing and restoring against the saved list', () => {
    const after = setOpened(
      setClosed(
        setClosed(saved, 'disabled_plugins', TRACING, true),
        'disabled_skills',
        REVIEW,
        false,
      ),
      'enabled_user_connectors',
      'calendar',
      true,
    );
    const changes = selectionChanges(saved, after);
    expect(changes).toEqual([
      { field: 'disabled_plugins', entry: TRACING, closed: true },
      { field: 'disabled_skills', entry: REVIEW, closed: false },
      { field: 'enabled_user_connectors', entry: 'calendar', closed: false },
      { field: 'disable_apps', entry: null, closed: false },
    ]);
    expect(changes.map((c) => changeLine(c, inventory, 'codex'))).toEqual([
      { action: off, what: `${zh('data.extensions.plugin')} ${TRACING}` },
      { action: on, what: `${zh('data.extensions.skill')} review` },
      { action: on, what: 'Apps Calendar' },
      { action: on, what: 'Apps' },
    ]);
  });

  it('names the apps switch after the runtime and keeps unlisted skills by ID', () => {
    const old = '/Users/me/.codex/skills/old/SKILL.md';
    expect(
      changeLine({ field: 'disable_apps', entry: null, closed: true }, inventory, 'claude'),
    ).toEqual({ action: off, what: zh('components.runtime.claudeConnectors') });
    expect(
      changeLine({ field: 'disable_hooks', entry: null, closed: true }, inventory, 'claude'),
    ).toEqual({ action: off, what: 'Hooks' });
    expect(
      changeLine({ field: 'disabled_skills', entry: old, closed: false }, inventory, 'codex'),
    ).toEqual({ action: on, what: `${zh('data.extensions.skill')} ${old}` });
  });

  it('has nothing to save after closing and reopening the same item', () => {
    expect(canSave(NONE, NONE)).toBe(false);
    const back = setClosed(
      setClosed(NONE, 'disabled_plugins', TRACING, true),
      'disabled_plugins',
      TRACING,
      false,
    );
    expect(selectionChanges(NONE, back)).toEqual([]);
    expect(canSave(NONE, back)).toBe(false);
    expect(canSave(NONE, setFlag(setFlag(NONE, 'disable_apps', true), 'disable_apps', false))).toBe(
      false,
    );
    const reopened = setClosed(
      setClosed(saved, 'disabled_mcp_servers', 'code-search', false),
      'disabled_mcp_servers',
      'code-search',
      true,
    );
    expect(canSave(saved, reopened)).toBe(false);
  });

  it('can save once a switch changes', () => {
    expect(canSave(NONE, setClosed(NONE, 'disabled_mcp_servers', 'code-search', true))).toBe(true);
    expect(canSave(NONE, setFlag(NONE, 'disable_hooks', true))).toBe(true);
  });
});

describe('inventory tab', () => {
  const bridge = (result: BridgeResult<unknown>) => ({ query: async () => result });

  it('has a tab for each runtime whose extensions the daemon lists, in table order, the first one open', () => {
    expect(RUNTIMES).toEqual(['claude', 'codex', 'agy', 'grok']);
    expect(useSettingsView.getInitialState().runtime).toBe('claude');
  });

  it('disables the tab of a runtime without an inventory and drops the daemon message', async () => {
    const message = 'Runtime does not support extension inventory';
    const result = await readInventory(
      bridge({ ok: false, error: { code: 'unsupported_capability', message, status: 409 } }),
      'project',
      'claude',
    );
    expect(inventoryState(result)).toEqual({ state: 'unsupported' });
  });

  it('reads the inventory with the project and runtime', async () => {
    let asked: unknown;
    const result = await readInventory(
      {
        query: async (method, params) => {
          asked = { method, params };
          return { ok: true, value: inventory };
        },
      },
      'project',
      'codex',
    );
    expect(asked).toEqual({
      method: 'extensions.inventory',
      params: { project_id: 'project', runtime: 'codex' },
    });
    expect(inventoryState(result)).toEqual({ state: 'ready', inventory });
  });

  it('keeps other errors with their code and message', async () => {
    const result = await readInventory(
      bridge({ ok: false, error: { code: 'adapter_failed', message: 'codex exited' } }),
      'project',
      'codex',
    );
    expect(inventoryState(result)).toEqual({
      state: 'error',
      code: 'adapter_failed',
      message: 'codex exited',
    });
  });

  it('refuses an incomplete result and a missing bridge', async () => {
    const bad = await readInventory(
      bridge({ ok: true, value: { runtime: 'codex' } }),
      'p',
      'codex',
    );
    expect(!bad.ok && bad.error.code).toBe('bad_response');
    const { connectors: _, ...unlisted } = inventory;
    const partial = await readInventory(bridge({ ok: true, value: unlisted }), 'p', 'codex');
    expect(!partial.ok && partial.error.code).toBe('bad_response');
    const none = await readInventory(undefined, 'p', 'codex');
    expect(!none.ok && none.error.code).toBe('bridge_unavailable');
  });
});
