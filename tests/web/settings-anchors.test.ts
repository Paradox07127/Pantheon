import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import type { RuntimeStatus } from '@pantheon/protocol';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { ExtensionInventory } from '@/data/extensions';

const policy: WorkflowPolicy = {
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  improvement_mode: 'confirm',
  plan_changes: 'auto',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: [],
};
const status: RuntimeStatus = {
  runtime: 'codex',
  installed: true,
  version: '1.0.0',
  min_version: null,
  version_ok: null,
  auth: { state: 'unknown' },
  checked_at: '2026-01-01T00:00:00.000Z',
  enabled: true,
};
const inventory = (runtime: string): ExtensionInventory => ({
  runtime: runtime as never,
  mcp_servers: [{ name: 'docs', enabled: true }],
  plugins: [{ id: 'docs@market', enabled: true }],
  skills: [{ id: '/s/SKILL.md', name: 'review', path: '/s/SKILL.md', enabled: true }],
  apps: true,
  connectors: [{ name: 'drive', title: 'Drive', enabled: true }],
  hooks: [{ event: 'Stop' }],
});

// The pages' reads answer at once, so a string render shows each page with its data.
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useWorkflowPolicy: () => ({ read: policy, error: null, reload() {} }),
  useImprovements: () => ({ read: [], error: null, reload() {} }),
}));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({
    data: {
      settings: [
        { key: 'workflow_policy', builtin: policy, overrides: [] },
        { key: 'session_defaults', overrides: [] },
        { key: 'usage_targets', builtin: {}, overrides: [] },
        { key: 'external_events', builtin: 'off', overrides: [] },
        { key: 'auto_merge', builtin: false, overrides: [] },
      ],
      projects: [{ project_id: 'alpha', name: 'Alpha app', overridden: 0 }],
      permission_rules: [],
    },
    loading: false,
    error: null,
    reload() {},
  }),
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({
    read: { state: 'ready', statuses: [status] },
    runtimes: ['codex'],
    unavailable: {},
    refresh() {},
  }),
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeModels: () => ({
    codex: { state: 'ready', models: [{ id: 'gpt-5', permission_modes: [] }] },
  }),
}));
vi.mock('@/data/backends', () => ({
  useBackends: () => [
    {
      id: 'router',
      protocol: 'anthropic',
      base_url: 'https://router.example.com',
      models: [],
      runtimes: ['claude'],
      key: { env: 'ROUTER_KEY' },
      key_present: true,
    },
  ],
}));
vi.mock('@/data/extensions', async (actual) => {
  const real = await actual<typeof import('@/data/extensions')>();
  return {
    ...real,
    useInventories: () => ({
      states: Object.fromEntries(
        real.RUNTIMES.map((r) => [r, { state: 'ready', inventory: inventory(r) }]),
      ),
      reload() {},
    }),
  };
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBoard } from '@/data/board';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SETTINGS_INDEX } from '@/screens/settings/settings-index';
import { searchSettings } from '@/screens/settings/settings-search';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';

const project = {
  id: 'alpha',
  revision: 1,
  name: 'Alpha app',
  roots: ['/work/alpha'],
  gates: { '/work/alpha': [{ name: 'test', argv: ['pnpm', 'test'] }] },
};
// Only the desktop app answers the zoom factor, the shell settings, the logs and worktree folders.
const AFTER_MOUNT = [
  'about.logs',
  'worktrees.location',
  'appearance.zoom',
  'general.openAtLogin',
  'general.keepRunning',
  'general.trayIcon',
  'general.appIcon',
  'general.voiceInput',
  'general.voiceEngine',
  'general.autoArchiveMerged',
  'general.sessionRecap',
  'general.autoGitInit',
  'general.baselineRounds',
  'general.baselineVisuals',
  'editor.browser',
];
// Shown only for a runtime that has them: Claude, verified kinds, a quota.
const WHEN_THERE = ['harness.artifacts', 'harness.kinds', 'harness.quota'];

const anchors = (html: string) =>
  new Set([...html.matchAll(/data-setting-id="([^"]+)"/g)].map((m) => m[1]));

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ page: 'general', detail: null });
});

describe('setting anchors', () => {
  it.each(SETTINGS_PAGES.map((p) => p.key))(
    'the %s page holds an anchor for each setting',
    (key) => {
      // A part of a project's page shows on the projects page, with the project open.
      useSettingsView.setState({ page: key, detail: 'alpha' });
      const found = anchors(renderToStaticMarkup(createElement(ProjectSettingsScreen)));
      const missing = SETTINGS_INDEX.filter(
        (r) =>
          r.page === key &&
          !r.id.endsWith('.page') &&
          !AFTER_MOUNT.includes(r.id) &&
          !WHEN_THERE.includes(r.id),
      )
        .map((r) => r.id)
        .filter((id) => !found.has(id));
      expect(missing).toEqual([]);
    },
  );
});

describe('the handback limit', () => {
  it('is found on the gates page, at the row that holds it', () => {
    const hit = searchSettings('交回次数上限').find((h) => h.page === 'gates');
    expect(hit).toMatchObject({ id: 'gates.handbackLimit', page: 'gates', pageOnly: false });
    useSettingsView.setState({ page: 'gates', detail: 'alpha' });
    const html = renderToStaticMarkup(createElement(ProjectSettingsScreen));
    expect(anchors(html).has('gates.handbackLimit')).toBe(true);
  });
});
