import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import type { RoutingCell } from '@pantheon/protocol';
import type { Improvement } from '@pantheon/domain';

const mock = vi.hoisted(() => ({ improvements: [] as unknown[] }));
const cell: RoutingCell = {
  domain: 'review',
  tier: 't1',
  first: { runtime: 'codex', model: 'gpt-5' },
  candidates: [],
  prior: null,
};
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useImprovements: () => ({ read: mock.improvements, error: null, reload() {} }),
  useRoutingTable: () => ({ read: { cells: [cell] }, error: null, reload() {} }),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { useBoard } from '@/data/board';
import { RetroPanel } from '@/screens/board/RetroPanel';
import { CategoryHeader } from '@/screens/settings/CategoryHeader';
import { ConnectionsPage } from '@/screens/settings/ConnectionsPage';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { registerPageHeader } from '@/screens/settings/settings-header';
import { SETTINGS_INDEX } from '@/screens/settings/settings-index';
import { SettingsNav } from '@/screens/settings/SettingsNav';
import { navPage, SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { useCurrentProject } from '@/data/current-project';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const project = {
  id: 'alpha',
  revision: 1,
  name: 'Alpha app',
  roots: ['/work/alpha'],
  gates: {},
};
const screen = () => renderToStaticMarkup(createElement(ProjectSettingsScreen));
const shownOn = (page: string) => {
  useSettingsView.setState({ page: page as never });
  return screen();
};

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
  useSettingsView.setState({ open: false, page: 'general', detail: null });
});

describe('settings navigation groups', () => {
  it('lists this computer, then every project, with no group named after a project', () => {
    const labels = (group: 'app' | 'global' | 'project') =>
      SETTINGS_PAGES.filter((p) => p.group === group).map((p) => p.label);
    const pages = (ids: string[]) =>
      ids.map((id) => zh(id === 'devices' ? 'settings.devices.title' : `settings.pages.${id}`));
    expect(labels('app')).toEqual(
      pages([
        'general',
        'appearance',
        'sessionDisplay',
        'diff',
        'runtimes',
        'openWith',
        'connections',
        'devices',
        'notifications',
        'shortcuts',
        'data',
        'about',
      ]),
    );
    expect(labels('global')).toEqual(
      pages(['workflow', 'defaults', 'usage', 'external', 'permissions', 'projects']),
    );
    expect(labels('project')).toEqual(pages(['gates', 'worktrees', 'extensions', 'project']));
    const nav = renderToStaticMarkup(createElement(SettingsNav, { page: 'general' }));
    const shown = [...nav.matchAll(/class="ps-page"[^>]*>.*?<\/span>([^<]*)</g)].map((m) => m[1]);
    expect(shown).toEqual([...labels('app'), ...labels('global')]);
    const groups = [...nav.matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual([zh('settings.nav.app'), zh('settings.nav.projects')]);
    expect(nav).not.toContain(project.name);
  });

  it('shows the same settings after the current project changes', () => {
    useCurrentProject.setState({ projectId: 'alpha' });
    useShell.getState().openSettings('alpha');
    const first = shownOn('workflow');
    useCurrentProject.setState({ projectId: 'beta' });
    useShell.getState().openSettings('beta');
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      page: 'workflow',
      detail: null,
    });
    expect(screen()).toBe(first);
    expect(first).toContain(
      `<h1>${zh('settings.pages.workflow')}</h1><span class="ps-chip">${zh('settings.nav.projects')}</span>`,
    );
  });

  it('gives the runtimes one page and leaves them off the connections page', () => {
    const runtimes = zh('settings.pages.runtimes');
    expect(SETTINGS_PAGES.filter((p) => p.label === runtimes).map((p) => p.key)).toEqual([
      'harness',
    ]);
    const html = renderToStaticMarkup(createElement(ConnectionsPage));
    expect(html).toContain(zh('settings.connections.github'));
    expect(html).not.toContain(runtimes);
    expect(html).not.toContain('Claude');
  });

  it("shows the routing table on a project's page, not under the default model", () => {
    const defaults = shownOn('defaults');
    expect(defaults).toContain('data-setting-id="defaults.runtime"');
    expect(defaults).not.toContain('data-setting-id="routing.first"');
    useSettingsView.setState({ detail: 'alpha' });
    const html = shownOn('projects');
    expect(html).toContain(`<h1>${zh('settings.pages.projects')}</h1>`);
    expect(html).toContain('data-setting-id="routing.first"');
  });

  it("ends a project's page with removing the project and holds no app-wide setting", () => {
    useSettingsView.setState({ detail: 'alpha' });
    const html = shownOn('project');
    expect(html).toContain(
      `<h1>${zh('settings.pages.projects')}</h1><span class="ps-chip">Alpha app</span>`,
    );
    const at = (id: string) => html.indexOf(`data-setting-id="${id}"`);
    expect(at('general.autoGitInit')).toBe(-1);
    const others = SETTINGS_INDEX.filter(
      (r) => r.page === 'project' && r.id !== 'project.remove' && !r.id.endsWith('.page'),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) expect(at(r.id)).toBeLessThan(at('project.remove'));
  });

  it('lands the gates page on projects', () => {
    expect(navPage('gates')).toBe('projects');
    expect(shownOn('gates')).toContain(`<h1>${zh('settings.pages.projects')}</h1>`);
  });
});

describe('settings page header frame', () => {
  it('scopes a page of this computer to this computer', () => {
    const chip = `<span class="ps-chip">${zh('settings.nav.app')}</span>`;
    expect(shownOn('harness')).toContain(`<h1>${zh('settings.pages.runtimes')}</h1>${chip}`);
    const header = renderToStaticMarkup(createElement(CategoryHeader, { page: 'data' }));
    expect(header).toContain(`<h1>${zh('settings.pages.data')}</h1>${chip}`);
  });

  it('puts a page tool at the header end, before the close', () => {
    registerPageHeader('connections', {
      tools: () => createElement('button', { type: 'button', className: 'btn ghost sm' }, 'Probe'),
    });
    try {
      const html = shownOn('connections');
      const end = /<span class="ps-hd-end">(.*?)<\/header>/.exec(html)?.[1] ?? '';
      expect(end).toMatch(/<button type="button" class="btn ghost sm">Probe<\/button>.*关闭设置/);
    } finally {
      registerPageHeader('connections', {});
    }
  });
});

describe('the retrospective proposals', () => {
  it('open the learned tab of memory', () => {
    mock.improvements = [
      { id: 'i1', status: 'candidate', retrospective_ids: [] } as unknown as Improvement,
    ];
    useShell.setState({ screen: 'board', memoryTab: 'overview' });
    const panel = RetroPanel({
      model: { now: 0, tasks: [] } as unknown as BoardModel,
      projectId: 'alpha',
      onOpenTask() {},
    });
    (panel.props as { num: { props: { onClick: () => void } } }).num.props.onClick();
    expect(useShell.getState().memoryTab).toBe('learned');
    expect(useShell.getState().screen).toBe('memory');
    expect(useSettingsView.getState().open).toBe(false);
  });
});
