import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult } from '@pantheon/protocol';
import { find, mount as host, named, text, unmountAll, type HookHost } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const bridge = {
  answers: {} as Record<string, unknown>,
  commandAnswer: { ok: true, value: {} } as BridgeResult<unknown>,
  queries: [] as string[],
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    bridge.queries.push(method);
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer;
  },
};

async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
// Renders a component element the tree holds unrendered.
const expand = (node: ReactElement<any>) =>
  (node.type as (props: unknown) => ReactNode)(node.props);
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);

beforeEach(() => {
  bridge.answers = {};
  bridge.commandAnswer = { ok: true, value: {} };
  bridge.queries = [];
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
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

describe('settings navigation', () => {
  it('puts the harness page with the app pages and the default model with the pages for every project', () => {
    expect(SETTINGS_PAGES.map((p) => `${p.group}:${p.key}:${p.label}`)).toEqual(
      expect.arrayContaining([
        `app:harness:${zh('settings.pages.runtimes')}`,
        `global:defaults:${zh('settings.pages.defaults')}`,
      ]),
    );
    expect(SETTINGS_PAGES.map((p) => p.key)).not.toContain('experience');
  });

  it('switches to each new page from the navigation', async () => {
    const screen = await mount(() => ProjectSettingsScreen());
    const nav = named(tree(screen), 'SettingsNav');
    const links = expand(nav);
    for (const [label, key, page] of [
      [zh('settings.pages.defaults'), 'defaults', 'SessionDefaults'],
    ] as const) {
      button(links, label).props.onClick();
      expect(useSettingsView.getState().page).toBe(key);
      const shown = await mount(() => ProjectSettingsScreen());
      expect(named(expand(named(tree(shown), 'GlobalPage')), page).props.project).toBeNull();
    }
    button(links, zh('settings.pages.runtimes')).props.onClick();
    expect(useSettingsView.getState().page).toBe('harness');
    const shown = await mount(() => ProjectSettingsScreen());
    const app = named(tree(shown), 'AppPage');
    const harness = await mount(() => expand(app));
    expect(named(tree(harness), 'HarnessPage').props.projectId).toBe('alpha');
  });
});
