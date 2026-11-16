import { describe, expect, it, vi } from 'vitest';
import type { ExtensionInventory, McpServerState } from '@/data/extensions';
import { zh } from './i18n-setup.js';

const mock = vi.hoisted(() => ({
  servers: new Map<string, unknown>(),
  sessions: [] as unknown[],
  reconnectable: false,
}));
vi.mock('@/data/board', async (actual) => ({
  ...(await actual<object>()),
  useBoard: (select: (state: unknown) => unknown) => select({ board: { sessions: mock.sessions } }),
}));
vi.mock('@/screens/settings/view', async (actual) => ({
  ...(await actual<object>()),
  useSettingsView: (select: (state: unknown) => unknown) =>
    select({ page: 'extensions', runtime: 'claude', setRuntime() {} }),
}));
vi.mock('@/data/extensions', async (actual) => {
  const real = await actual<typeof import('@/data/extensions')>();
  const inventory = (runtime: string): ExtensionInventory => ({
    runtime,
    mcp_servers: [
      { name: 'docs', enabled: true },
      { name: 'tracker', enabled: true },
    ],
    plugins: [],
    skills: [],
    apps: false,
    connectors: [],
    hooks: [],
  });
  return {
    ...real,
    useInventories: () => ({
      states: Object.fromEntries(
        real.RUNTIMES.map((r) => [r, { state: 'ready', inventory: inventory(r) }]),
      ),
      reload() {},
    }),
    useMcpStatus: () => mock.servers,
    useMcpReconnectable: (session: string | undefined) => !!session && mock.reconnectable,
  };
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { t } from '@/i18n';
import { ExtensionsPage } from '@/screens/settings/ExtensionsPage';

const loadDocs = `aria-label="${t({ id: 'settings.extensions.load', defaultMessage: '' }, { name: 'docs' })}"`;

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const render = (servers: McpServerState[]) => {
  mock.servers = new Map(servers.map((s) => [s.name, s]));
  return renderToStaticMarkup(createElement(ExtensionsPage, { project: project as never }));
};
/** The markup of the switch row named `name`. */
const row = (html: string, name: string) =>
  html.split('class="ps-row"').find((r) => r.includes(`>${name}</span>`)) ?? '';

describe('extensions page MCP server states', () => {
  it('shows a connected server as connected by its switch', () => {
    const docs = row(render([{ name: 'docs', state: 'connected' }]), 'docs');
    expect(docs).toMatch(
      new RegExp(
        `data-s="ok"[^>]*></span><span>${zh('settings.extensions.mcpConnected')}</span>.*${loadDocs}`,
      ),
    );
  });

  it('shows a failed server as failed with its reason under the row', () => {
    const html = render([
      { name: 'docs', state: 'connected' },
      { name: 'tracker', state: 'failed', reason: 'spawn tracker-mcp ENOENT' },
    ]);
    const tracker = row(html, 'tracker');
    expect(tracker).toContain('data-s="bad"');
    expect(tracker).toContain(`<span>${zh('settings.extensions.mcpFailed')}</span>`);
    expect(tracker).toContain('<span class="ex-why">spawn tracker-mcp ENOENT</span>');
    expect(row(html, 'docs')).not.toContain('ex-why');
  });

  it('offers a reconnect on a server that is not connected, and none on a connected one', () => {
    mock.sessions = [{ id: 'live', project_id: 'alpha', runtime: 'claude', state: 'running' }];
    mock.reconnectable = true;
    const html = render([
      { name: 'docs', state: 'connected' },
      { name: 'tracker', state: 'failed', reason: 'spawn tracker-mcp ENOENT' },
    ]);
    mock.sessions = [];
    mock.reconnectable = false;
    expect(row(html, 'tracker')).toMatch(
      new RegExp(`<button[^>]*class="btn sm"[^>]*>${zh('settings.extensions.reconnect')}</button>`),
    );
    expect(row(html, 'docs')).not.toContain(zh('settings.extensions.reconnect'));
  });

  it('offers no reconnect when the live session cannot reconnect its servers', () => {
    mock.sessions = [{ id: 'live', project_id: 'alpha', runtime: 'claude', state: 'running' }];
    const html = render([{ name: 'tracker', state: 'failed', reason: 'spawn tracker-mcp ENOENT' }]);
    mock.sessions = [];
    expect(row(html, 'tracker')).not.toContain(zh('settings.extensions.reconnect'));
  });

  it('draws no state when the runtime reports none', () => {
    const html = render([]);
    expect(html).toContain(loadDocs);
    expect(html).not.toContain('hp-dot');
    expect(html).not.toContain(zh('settings.extensions.mcpUnknown'));
  });
});
