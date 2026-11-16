import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, ConnectionsStatus } from '@pantheon/protocol';
import { deferred, find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { ConnectionsPage } from '@/screens/settings/ConnectionsPage';
import { Loading } from '@/screens/settings/ProjectSettingsScreen';
import { pageHeader } from '@/screens/settings/settings-header';

const signedIn: ConnectionsStatus['github'] = {
  state: 'signed_in',
  installed: true,
  signed_in: true,
  account: 'octo-dev',
  host: 'github.com',
  scopes: ['repo', 'workflow'],
};

let githubAnswer: Promise<BridgeResult<unknown>> | BridgeResult<unknown> | null = null;
const bridge = {
  methods: [] as string[],
  githubQueries: [] as (Record<string, string> | undefined)[],
  query: vi.fn(async (method: string, params?: Record<string, string>) => {
    bridge.methods.push(method);
    if (method === 'connections.status') bridge.githubQueries.push(params);
    return githubAnswer ?? { ok: true as const, value: { github: signedIn } };
  }),
};

const CONNECTED = zh('settings.connections.githubConnected');
async function mount(body: () => ReactNode) {
  const h = host(body);
  await h.flush();
  return h;
}
const row = (tree: ReactNode, name: string) =>
  find(tree, (n) => n.props.role === 'group' && n.props['aria-label'] === name);
const buttons = (tree: ReactNode) =>
  nodes(tree).filter((n): n is ReactElement<any> => n.type === 'button');
/** The hover name of the service mark in the row, drawn through its components. */
const markTitle = (tree: ReactNode) => {
  const draw = (element: ReactElement<any>) =>
    (element.type as (props: unknown) => ReactElement<any>)(element.props);
  const svg = draw(draw(named(tree, 'ServiceMark')));
  return text(find(svg, (n) => n.type === 'title'));
};

beforeEach(() => {
  githubAnswer = null;
  bridge.methods = [];
  bridge.githubQueries = [];
  vi.stubGlobal('window', { pantheon: bridge });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('connections page', () => {
  it('lists the services and leaves the runtimes to their own page', async () => {
    const h = await mount(() => ConnectionsPage());
    const services = nodes(h.value)
      .filter((n) => typeof n.type === 'function' && /Row$/.test(n.type.name))
      .map((n) => n.props.service ?? 'github');
    expect(services).toEqual(['github', 'huggingface', 'cloudflare']);
    expect(bridge.methods).toEqual(['connections.status']);
  });

  it('checks the services again past the cache from the header, busy until the check answers', async () => {
    const h = await mount(() => ConnectionsPage());
    const Tools = pageHeader('connections').tools as (props: { project: null }) => ReactNode;
    const tools = await mount(() => Tools({ project: null }));
    const recheck = () => buttons(tools.value)[0]!;
    expect(text(recheck())).toBe(zh('settings.connections.recheck'));
    expect(recheck().props.disabled).toBe(false);

    const services = deferred<BridgeResult<unknown>>();
    githubAnswer = services.promise;
    recheck().props.onClick();
    await h.flush();
    tools.render();
    expect(bridge.githubQueries.at(-1)).toEqual({ refresh: 'true' });
    expect(recheck().props.disabled).toBe(true);
    expect(recheck().props['aria-busy']).toBe(true);

    services.resolve({ ok: true, value: { github: signedIn } });
    await h.flush();
    tools.render();
    expect(recheck().props.disabled).toBe(false);
    expect(recheck().props['aria-busy']).toBeUndefined();
  });
});

describe('connections page github row', () => {
  // The host draws only the page's own function, so the row component is drawn here.
  const github = (tree: ReactNode) => {
    const shared = named(tree, 'GithubRow');
    return row((shared.type as (props: unknown) => ReactNode)(shared.props), 'GitHub');
  };
  const dot = (tree: ReactNode) => find(github(tree), (n) => n.props['data-s'] !== undefined);
  const account = (tree: ReactNode) =>
    text(find(github(tree), (n) => n.props.className === 'cn-acct'));
  const answerWith = (value: ConnectionsStatus['github']) => {
    githubAnswer = { ok: true, value: { github: value } };
  };

  it('draws the GitHub mark, named GitHub, before the name', async () => {
    const h = await mount(() => ConnectionsPage());
    expect(markTitle(github(h.value))).toBe('GitHub');
  });

  it('shows the signed-in account and host without its scopes', async () => {
    const h = await mount(() => ConnectionsPage());
    expect(dot(h.value).props['data-s']).toBe('ok');
    expect(account(h.value)).toBe(`${CONNECTED}octo-devgithub.com`);
    expect(text(github(h.value))).not.toContain('repo');
    expect(bridge.githubQueries).toEqual([{}]);
  });

  it.each([
    [
      'asks for a sign-in the way a runtime row does when gh is signed out',
      { state: 'signed_out', installed: true, signed_in: false },
      'wait',
      'settings.connections.needsSignIn',
    ],
    [
      'says gh is not installed',
      { state: 'missing', installed: false, signed_in: false },
      'idle',
      'settings.connections.githubMissing',
    ],
    [
      'says the sign-in is unknown when gh timed out, not signed out',
      { state: 'timeout', installed: true, signed_in: null },
      'unknown',
      'settings.connections.githubUnknown',
    ],
  ] as const)('%s', async (_, github, shown, id) => {
    answerWith(github as ConnectionsStatus['github']);
    const h = await mount(() => ConnectionsPage());
    expect(dot(h.value).props['data-s']).toBe(shown);
    expect(account(h.value)).toBe(zh(id));
  });

  it('says a missing CLI is not installed in the words a missing runtime uses', () => {
    const missing = zh('data.runtimeStatus.notInstalled');
    expect(zh('settings.connections.githubMissing')).toBe(`${missing} gh`);
    expect(zh('settings.connections.huggingfaceMissing')).toBe(`${missing} hf`);
    expect(zh('settings.connections.cloudflareMissing')).toBe(`${missing} wrangler`);
  });

  it('holds a placeholder until the first read answers', async () => {
    const pending = deferred<BridgeResult<unknown>>();
    githubAnswer = pending.promise;
    const h = await mount(() => ConnectionsPage());
    expect(nodes(github(h.value)).some((n) => n.props['data-s'] !== undefined)).toBe(false);
    expect(nodes(github(h.value)).some((n) => n.type === Loading)).toBe(true);
    pending.resolve({ ok: true, value: { github: signedIn } });
    await h.flush();
    expect(account(h.value)).toBe(`${CONNECTED}octo-devgithub.com`);
  });

  it('checks gh again past the cache, busy until the check answers', async () => {
    const h = await mount(() => ConnectionsPage());
    const recheck = () => buttons(github(h.value))[0]!;
    expect(recheck().props['aria-label']).toBe(zh('settings.connections.recheckGithub'));
    const pending = deferred<BridgeResult<unknown>>();
    githubAnswer = pending.promise;
    recheck().props.onClick();
    await h.flush();
    expect(bridge.githubQueries.at(-1)).toEqual({ refresh: 'true' });
    expect(recheck().props.disabled).toBe(true);
    expect(recheck().props['aria-busy']).toBe(true);

    pending.resolve({ ok: true, value: { github: { ...signedIn, account: 'octo-ops' } } });
    await h.flush();
    expect(recheck().props.disabled).toBe(false);
    expect(recheck().props['aria-busy']).toBeUndefined();
    expect(account(h.value)).toBe(`${CONNECTED}octo-opsgithub.com`);
  });

  it('shows a failed read in the row', async () => {
    githubAnswer = { ok: false, error: { code: 'daemon_unavailable', message: 'daemon down' } };
    const h = await mount(() => ConnectionsPage());
    const alert = find(github(h.value), (n) => n.props.role === 'alert');
    expect(text(alert)).not.toBe('');
  });
});
