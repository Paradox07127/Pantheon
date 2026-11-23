import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BridgeResult, RuntimeStatus } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: { events: [] } as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { SidebarQuota } from '@/components/SidebarQuota';
import { runtimeQuotas } from '@/lib/usage-quota';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.parse('2026-11-23T09:00:00.000Z');
const MINUTE = 60_000;

const status = (runtime: string, over: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({
    runtime,
    enabled: true,
    installed: true,
    auth: { state: 'logged_in' },
    ...over,
  }) as RuntimeStatus;

const QUOTAS: RuntimeStatus[] = [
  status('claude', {
    quota: {
      windows: [
        { window: 'five_hour', used_percent: 37.6, resets_at: NOW + 200 * MINUTE },
        { window: 'seven_day', used_percent: 12, resets_at: NOW + 3000 * MINUTE },
      ],
      seen_at: NOW,
    },
  }),
  status('codex', {
    quota: {
      windows: [{ window: 'seven_day', used_percent: 96, resets_at: NOW + 90 * MINUTE }],
      seen_at: NOW,
    },
  }),
  status('gemini'),
];

let statuses: RuntimeStatus[];
const ok = (value: unknown): BridgeResult<unknown> => ({ ok: true, value });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval'] });
  statuses = QUOTAS;
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) =>
        method === 'runtime.status'
          ? ok(statuses)
          : { ok: false, error: { code: 'unknown_route', message: method } },
      ),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function quota(rail = false) {
  const h = mount(() => SidebarQuota({ rail }));
  await h.flush();
  return h.value as ReactElement | null;
}

const meters = (tree: ReactElement | null) => nodes(tree).filter((n) => n.props.role === 'meter');

describe('sidebar quota', () => {
  it('shows one meter per runtime that reports quota, named with its use and reset time', async () => {
    const tree = await quota();
    expect(find(tree, (n) => n.props.role === 'group').props['aria-label']).toBe(
      zh('components.sidebarQuota.label'),
    );
    const rows = meters(tree);
    expect(rows.map((n) => n.props['aria-valuenow'])).toEqual([38, 96]);
    expect(rows[0]!.props['aria-label']).toBe(
      zhf('components.sidebarQuota.runtime', {
        runtime: 'Claude',
        percent: 38,
        reset: '5 小时窗口，3 小时 20 分后重置',
      }),
    );
    expect(text(rows[0])).toContain('38%');
    expect(text(rows[0])).toContain('5 小时窗口，3 小时 20 分后重置');
    expect(text(rows[1])).toContain('7 天窗口，1 小时 30 分后重置');
  });

  it('lists every window of a runtime in its tooltip', async () => {
    const tree = await quota();
    const tip = find(
      tree,
      (n) =>
        typeof n.type === 'function' &&
        n.type.name === 'Tip' &&
        n.props.children === meters(tree)[0],
    );
    expect(tip.props.content).toContain('5 小时窗口，3 小时 20 分后重置');
    expect(tip.props.content).toContain(
      zhf('components.sidebarQuota.window', {
        percent: 12,
        window: '7 天窗口，50 小时 0 分后重置',
      }),
    );
  });

  it('draws one ring per runtime on the collapsed rail with the same name', async () => {
    const wide = meters(await quota()).map((n) => n.props['aria-label']);
    unmountAll();
    const rings = nodes(await quota(true)).filter((n) => n.props.role === 'img');
    expect(rings.map((n) => n.props['aria-label'])).toEqual(wide);
  });

  it('renders nothing when no runtime reports quota', async () => {
    statuses = [status('claude'), status('codex', { quota: { windows: [], seen_at: NOW } })];
    expect(await quota()).toBeNull();
    expect(await quota(true)).toBeNull();
  });

  it('shows the percent the tray computes from the same statuses', async () => {
    const shared = runtimeQuotas(QUOTAS).map((q) => [q.runtime, q.percent]);
    expect(shared).toEqual([
      ['claude', 38],
      ['codex', 96],
    ]);
    expect(meters(await quota()).map((n) => n.props['aria-valuenow'])).toEqual(
      shared.map(([, percent]) => percent),
    );
  });
});
