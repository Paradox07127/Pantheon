import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ConnectionsStatus } from '@pantheon/protocol';
import { find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { t } from '@/i18n';
import { ConnectionsPage } from '@/screens/settings/ConnectionsPage';
import { SetupScreen } from '@/screens/setup/SetupScreen';

type Service = ConnectionsStatus['huggingface'];
let value: Partial<ConnectionsStatus>;
const writeText = vi.fn(async () => {});

const CONNECTED = zh('settings.connections.githubConnected');
async function mount(body: () => ReactNode) {
  const h = host(body);
  await h.flush();
  return h;
}
// The host draws only the page's own function, so each service row is drawn here.
const service = (tree: ReactNode, name: string) => {
  const rows = nodes(tree)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'ServiceRow')
    .map((n) => (n.type as (props: unknown) => ReactNode)(n.props));
  return find(rows, (n) => n.props.role === 'group' && n.props['aria-label'] === name);
};
const dot = (row: ReactNode) => find(row, (n) => n.props['data-s'] !== undefined).props['data-s'];
const copy = (row: ReactNode) =>
  nodes(row).find((n: ReactElement<any>) => n.type === 'button' && text(n) === zh('setup.copy'));

beforeEach(() => {
  value = {
    github: { state: 'signed_in', installed: true, signed_in: true, account: 'octo' },
    huggingface: { state: 'signed_in', installed: true, signed_in: true, account: 'hf-user' },
    cloudflare: { state: 'signed_in', installed: true, signed_in: true, account: 'cf-user' },
  };
  writeText.mockClear();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      query: vi.fn(async (method: string) =>
        method === 'connections.status' ? { ok: true, value } : { ok: true, value: [] },
      ),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('hugging face and cloudflare rows', () => {
  it('shows a signed-in account with no command', async () => {
    const h = await mount(() => ConnectionsPage());
    const hf = service(h.value, 'Hugging Face');
    expect(dot(hf)).toBe('ok');
    expect(text(hf)).toContain(`${CONNECTED}hf-user`);
    expect(copy(hf)).toBeUndefined();
    expect(text(service(h.value, 'Cloudflare'))).toContain(`${CONNECTED}cf-user`);
  });

  it('draws the Hugging Face mark, named Hugging Face, and the Cloudflare initial', async () => {
    const h = await mount(() => ConnectionsPage());
    const mark = (row: ReactNode) => {
      const element = named(row, 'ServiceMark');
      return (element.type as (props: unknown) => ReactElement<any>)(element.props);
    };
    const hf = mark(service(h.value, 'Hugging Face'));
    const svg = (hf.type as (props: unknown) => ReactElement<any>)(hf.props);
    expect(text(find(svg, (n) => n.type === 'title'))).toBe('Hugging Face');
    expect(text(mark(service(h.value, 'Cloudflare')))).toBe('C');
  });

  it('asks for a sign-in with the login command to copy', async () => {
    value.cloudflare = { state: 'signed_out', installed: true, signed_in: false } as Service;
    const h = await mount(() => ConnectionsPage());
    const cf = service(h.value, 'Cloudflare');
    expect(dot(cf)).toBe('wait');
    expect(text(cf)).toContain(zh('settings.connections.needsSignIn'));
    expect(text(cf)).toContain('wrangler login');
    expect(copy(cf)!.props['aria-label']).toBe(
      t({ id: 'setup.copyCommand', defaultMessage: '' }, { command: 'wrangler login' }),
    );
    copy(cf)!.props.onClick();
    expect(writeText).toHaveBeenCalledWith('wrangler login');
  });

  it('says the tool is not installed and gives the install command to copy', async () => {
    value.huggingface = { state: 'missing', installed: false, signed_in: false } as Service;
    const h = await mount(() => ConnectionsPage());
    const hf = service(h.value, 'Hugging Face');
    expect(dot(hf)).toBe('idle');
    expect(text(hf)).toContain(zh('settings.connections.huggingfaceMissing'));
    copy(hf)!.props.onClick();
    expect(writeText).toHaveBeenCalledWith('pip install -U huggingface_hub');
  });

  it('lists both rows in the connections group of first-time setup', async () => {
    const h = await mount(() => SetupScreen());
    const group = find(h.value, (n) => n.props['aria-labelledby'] === 'su-g-cn');
    expect(text(service(group, 'Hugging Face'))).toContain('hf-user');
    expect(text(service(group, 'Cloudflare'))).toContain('cf-user');
  });
});
