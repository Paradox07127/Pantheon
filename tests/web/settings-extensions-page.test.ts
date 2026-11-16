import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import type { ExtensionInventory } from '@/data/extensions';

const inventory: ExtensionInventory = {
  runtime: 'claude',
  mcp_servers: [
    { name: 'postgres', enabled: true },
    { name: 'sentry', enabled: false },
  ],
  plugins: [{ id: 'tools@market', enabled: true }],
  skills: [{ id: '/s/SKILL.md', name: 'review', path: '/s/SKILL.md', enabled: true }],
  apps: true,
  connectors: [{ name: 'drive', title: 'Drive', enabled: true }],
  hooks: [{ event: 'PreToolUse' }, { event: 'Stop', plugin: 'tools@market' }],
};

// The reads answer at once, so a string render shows the page with its inventory.
const reads = vi.hoisted(() => ({ calls: [] as unknown[][], loading: false, unsupported: false }));
const RAW = 'Runtime does not support extension inventory';
vi.mock('@/data/extensions', async (actual) => {
  const real = await actual<typeof import('@/data/extensions')>();
  return {
    ...real,
    useInventories: (...args: unknown[]) => {
      reads.calls.push(args);
      return {
        states: reads.loading
          ? {}
          : reads.unsupported
            ? Object.fromEntries(
                real.RUNTIMES.map((r) => [
                  r,
                  real.inventoryState({
                    ok: false,
                    error: { code: 'unsupported_capability', message: RAW },
                  }),
                ]),
              )
            : Object.fromEntries(
                real.RUNTIMES.map((r) => [
                  r,
                  { state: 'ready', inventory: { ...inventory, runtime: r } },
                ]),
              ),
        reload() {},
      };
    },
  };
});

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBoard } from '@/data/board';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { pageHeader } from '@/screens/settings/settings-header';
import { useSettingsView } from '@/screens/settings/view';
import { setLocaleSync, t } from '@/i18n';
import { zh, zhCatalog } from './i18n-setup.js';

const project = {
  id: 'alpha',
  revision: 3,
  name: 'Alpha app',
  roots: ['/work/alpha'],
  extension_overrides: {
    claude: {
      disabled_mcp_servers: [],
      disabled_plugins: ['old-lint@market'],
      disabled_skills: [],
      disable_apps: false,
      disable_hooks: false,
    },
  },
};

const ext = (id: string, values?: Record<string, string | number>) =>
  t({ id: `settings.extensions.${id}`, defaultMessage: '' }, values);
const REFRESH = zh('settings.extensions.refresh');
const MCP = zh('settings.extensions.mcp');
const IMPACT = zh('settings.extensions.impact');
const render = () => renderToStaticMarkup(createElement(ProjectSettingsScreen));
const header = (html: string) => html.slice(html.indexOf('<header'), html.indexOf('</header>'));
const body = (html: string) => html.slice(html.indexOf('class="ps-pane"'));
const section = (html: string, title: string) => {
  const start = html.indexOf(`<section class="ps-sec" aria-label="${title}">`);
  return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
};
const rowOf = (html: string, name: string) => {
  const at = html.indexOf(`>${name}<`);
  const start = html.lastIndexOf('<div class="ps-row"', at);
  return html.slice(start, html.indexOf('</div>', at));
};

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
  useSettingsView.setState({ page: 'extensions', detail: 'alpha', runtime: 'claude' });
  reads.calls = [];
  reads.loading = false;
  reads.unsupported = false;
});
afterEach(() => {
  setLocaleSync('zh-CN', zhCatalog());
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ page: 'general', detail: null });
});

describe('extensions page header', () => {
  it('puts the inventory refresh at the end of the header as a small button with an icon', () => {
    const html = render();
    const end = header(html).slice(header(html).indexOf('class="ps-hd-end"'));
    expect(end).toMatch(
      new RegExp(
        `<button type="button" class="btn ghost sm" data-setting-id="extensions.refresh"><svg[^>]*>.*?</svg>${REFRESH}</button>`,
      ),
    );
    expect(body(html)).not.toContain(REFRESH);
  });

  it('reads the inventory again when the header refresh is pressed', () => {
    render();
    const before = reads.calls.at(-1);
    const Tools = pageHeader('projects').tools as () => ReactElement<{ onClick: () => void }>;
    const button = Tools();
    button.props.onClick();
    render();
    expect(reads.calls.at(-1)).toEqual(['alpha', (before![1] as number) + 1]);
  });
});

describe('extensions runtime tabs', () => {
  it('shows one tab per runtime with its mark and name, the open one selected', () => {
    const html = body(render());
    const runtime = zh('settings.common.runtime');
    expect(html).toMatch(
      new RegExp(
        `role="tablist"[^>]*aria-label="${runtime}"|aria-label="${runtime}"[^>]*role="tablist"`,
      ),
    );
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)];
    expect(tabs.map((m) => m[1]!.replace(/<svg.*?<\/svg>/g, '<mark>'))).toEqual([
      '<mark>Claude',
      '<mark>Codex',
      '<mark>agy',
      '<mark>grok',
    ]);
    expect(tabs[0]![0]).toContain('aria-selected="true"');
    expect(tabs[1]![0]).toContain('aria-selected="false"');
    expect(html).not.toContain('rev 3');
  });

  it('says in the page language that a runtime lists no extensions, the tabs keeping only their names', () => {
    reads.unsupported = true;
    const html = body(render());
    expect(html).not.toContain(RAW);
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)];
    expect(tabs.map((m) => m[1]!.replace(/<svg.*?<\/svg>/g, '<mark>'))).toEqual([
      '<mark>Claude',
      '<mark>Codex',
      '<mark>agy',
      '<mark>grok',
    ]);
    expect(section(html, ext('tools', { runtime: 'Claude' }))).toContain(
      zh('settings.extensions.unsupported'),
    );
  });
});

describe('extensions items', () => {
  it('sets the name on the left and the switch on the right, a locked reason as a chip before it', () => {
    const html = body(render());
    const open = rowOf(html, 'postgres');
    expect(open).toMatch(
      new RegExp(
        `^<div class="ps-row"><span class="ps-row-nm"><span class="mono">postgres</span></span><span class="ps-row-ct"><input type="checkbox" class="ps-sw" aria-label="${ext('load', { name: 'postgres' })}" checked=""`,
      ),
    );
    const locked = rowOf(html, 'sentry');
    expect(locked).toMatch(
      new RegExp(
        `<span class="ps-row-ct"><span class="chip"><svg[^>]*>.*?</svg>${ext('machineOff')}</span><input type="checkbox" class="ps-sw" aria-label="${ext('load', { name: 'sentry' })}" disabled=""`,
      ),
    );
  });

  it('counts the loaded items at the end of the group title', () => {
    const mcp = section(body(render()), MCP);
    expect(mcp).toContain(
      `<h3>${MCP}</h3><span style="flex:1"></span><span class="mu ex-n">${ext('loaded', { loaded: 1, total: 2 })}</span>`,
    );
  });

  it('keeps the hooks in one row with their events as chips', () => {
    const hooks = section(body(render()), 'Hooks');
    expect(hooks.match(/class="ps-row"/g)).toHaveLength(1);
    expect(hooks).not.toContain('<ul');
    expect(hooks).toContain(ext('hooksCount', { count: 2 }));
    expect(hooks).toContain(
      '<span role="listitem" class="chip mono">PreToolUse</span><span role="listitem" class="chip mono">Stop</span>',
    );
    expect(hooks).toContain(
      `<input type="checkbox" class="ps-sw" aria-label="${ext('load', { name: 'Hooks' })}" checked=""`,
    );
  });

  it('takes the hooks group title and switch name from the catalog, loaded or loading', () => {
    setLocaleSync('zh-CN', { ...zhCatalog(), 'settings.extensions.hooks': '钩子' });
    const hooks = section(body(render()), '钩子');
    expect(hooks).toContain('<h3>钩子</h3>');
    expect(hooks).toContain(`aria-label="${ext('load', { name: '钩子' })}"`);
    reads.loading = true;
    expect(section(body(render()), '钩子')).toContain('<h3>钩子</h3>');
  });

  it('marks an entry the machine no longer lists with its kind and offers a small remove button', () => {
    const missing = section(body(render()), zh('settings.extensions.missing'));
    expect(missing).toContain(`<span class="mu ex-n">${ext('missingCount', { count: 1 })}</span>`);
    expect(missing).toMatch(
      new RegExp(
        `<span class="chip">${ext('plugins')}</span><span class="mono">old-lint@market</span>.*<button type="button" class="btn ghost sm">${ext('removeFromList')}</button>`,
      ),
    );
  });
});

describe('extensions save bar', () => {
  it('pins the effect of saving under the list, with the runtime name and the save button', () => {
    const html = body(render());
    const list = html.indexOf('class="ps-col"');
    const bar = html.indexOf(`<div class="ex-ft" role="group" aria-label="${IMPACT}">`);
    expect(bar).toBeGreaterThan(list);
    // The bar is not one of the list's sections.
    expect(section(html, IMPACT)).toBe('');
    const footer = html.slice(bar);
    expect(footer).toContain('<span class="mu">Claude</span>');
    expect(footer).not.toContain('rev 3');
    expect(footer).toContain(zh('settings.common.noChanges'));
    expect(footer).toContain(
      `<button type="button" class="btn pri" disabled="" aria-disabled="true">${zh('settings.common.save')}</button>`,
    );
  });
});
