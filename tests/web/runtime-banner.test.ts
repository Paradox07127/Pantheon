import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, RuntimeConnection, RuntimeStatus } from '@pantheon/protocol';
import { deferred, find, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { RuntimeBanner } from '@/components/RuntimeBanner';
import { useBoard } from '@/data/board';
import { useRuntimeStatus } from '@/data/runtime-status';

const status = (
  runtime: string,
  connection: RuntimeConnection,
  extra: Partial<RuntimeStatus> = {},
): RuntimeStatus => ({
  runtime,
  enabled: true,
  installed: true,
  version: '1.0.0',
  min_version: null,
  version_ok: null,
  auth: { state: 'ok' },
  checked_at: '2026-11-14T00:00:00.000Z',
  connection,
  ...extra,
});
const connected: RuntimeConnection = {
  connected: true,
  held_session_count: 0,
  held_session_ids: [],
};
const lost = (count: number): RuntimeConnection => ({
  connected: false,
  disconnected_since: '2026-11-14T09:00:00.000Z',
  reason: 'app-server exited',
  held_session_count: count,
  held_session_ids: Array.from({ length: count }, (_, i) => `session-${i}`),
});

let statuses: RuntimeStatus[] = [];
let reply: Promise<BridgeResult<unknown>> | BridgeResult<unknown> = { ok: true, value: null };
const bridge = {
  query: vi.fn(async () => ({ ok: true as const, value: statuses })),
  command: vi.fn(async (_command: unknown) => reply),
};

const mounted = async <T>(body: () => T) => {
  const h = mount(body);
  await h.flush();
  return h;
};
/** The banners now open, by the runtime each names. */
const banners = (tree: ReactNode) =>
  nodes(tree).filter((n) => n.props['data-runtime'] !== undefined && n.props.open);
const button = (tree: ReactNode) =>
  nodes(tree).find((n): n is ReactElement<any> => n.type === 'button')!;

beforeEach(() => {
  statuses = [];
  reply = { ok: true, value: null };
  bridge.query.mockClear();
  bridge.command.mockClear();
  useBoard.setState({ events: [] });
  vi.stubGlobal('window', { pantheon: bridge });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('runtime disconnection banner', () => {
  it('names the disconnected runtime and how many sessions it holds', async () => {
    statuses = [status('claude', connected), status('codex', lost(3))];
    const h = await mounted(() => RuntimeBanner());
    const [codex, ...rest] = banners(h.value);
    expect(rest).toEqual([]);
    expect(codex!.props['data-runtime']).toBe('codex');
    expect(text(find(codex, (n) => n.props.className === 'rb-name'))).toBe('Codex 断开了');
    expect(text(find(codex, (n) => n.props.className === 'rb-held'))).toBe(
      '3 个会话已暂停，改动都还在工作树里',
    );
    expect(text(button(codex))).toBe(zh('components.runtimeBanner.reconnect'));
  });

  it('leaves out the paused sessions when none are held', async () => {
    statuses = [status('codex', lost(0))];
    const h = await mounted(() => RuntimeBanner());
    const [codex] = banners(h.value);
    expect(nodes(codex).some((n) => n.props.className === 'rb-held')).toBe(false);
  });

  it('stacks one banner per disconnected runtime', async () => {
    statuses = [status('codex', lost(1)), status('claude', lost(2))];
    const h = await mounted(() => RuntimeBanner());
    expect(banners(h.value).map((b) => b.props['data-runtime'])).toEqual(['claude', 'codex']);
  });

  it('shows nothing for a runtime that is not installed', async () => {
    statuses = [
      status(
        'codex',
        { connected: false, held_session_count: 0, held_session_ids: [] },
        { installed: false, version: null },
      ),
    ];
    const h = await mounted(() => RuntimeBanner());
    expect(banners(h.value)).toEqual([]);
  });

  it('reconnects the runtime and drops the banner once the read shows it connected', async () => {
    statuses = [status('codex', lost(2))];
    const h = await mounted(() => RuntimeBanner());
    const pending = deferred<BridgeResult<unknown>>();
    reply = pending.promise;
    button(banners(h.value)[0]).props.onClick();
    await h.flush();
    const sent = bridge.command.mock.calls[0]![0] as { type: string; input: unknown };
    expect(sent.type).toBe('runtime.reconnect');
    expect(sent.input).toEqual({ runtime: 'codex' });
    const busy = button(banners(h.value)[0]);
    expect(busy.props['aria-busy']).toBe(true);
    expect(busy.props.disabled).toBe(true);

    const reads = bridge.query.mock.calls.length;
    statuses = [status('codex', connected)];
    pending.resolve({ ok: true, value: { runtime: 'codex', connected: true } });
    await h.flush();
    await h.flush();
    expect(bridge.query.mock.calls.length).toBe(reads + 1);
    expect(banners(h.value)).toEqual([]);
  });

  it('shows why a reconnect failed in the banner and lets it be tried again', async () => {
    statuses = [status('codex', lost(2))];
    reply = {
      ok: false,
      error: { code: 'runtime_reconnect_failed', message: 'codex: spawn codex ENOENT' },
    };
    const h = await mounted(() => RuntimeBanner());
    button(banners(h.value)[0]).props.onClick();
    await h.flush();
    const [codex] = banners(h.value);
    expect(text(find(codex, (n) => n.props.role === 'alert'))).toBe('spawn codex ENOENT');
    expect(button(codex).props.disabled).toBe(false);
    expect(button(codex).props['aria-busy']).toBe(false);
  });
});

describe('runtime status read', () => {
  it('reads again when a runtime connection change arrives', async () => {
    statuses = [status('codex', connected)];
    const h = await mounted(() => useRuntimeStatus());
    expect(bridge.query).toHaveBeenCalledTimes(1);
    useBoard.setState({
      events: [
        {
          sequence: 7,
          kind: 'runtime.connection_changed',
          project_id: 'project-a',
        } as never,
      ],
    });
    h.render();
    await h.flush();
    expect(bridge.query).toHaveBeenCalledTimes(2);
    expect(bridge.query).toHaveBeenLastCalledWith('runtime.status', {});
  });
});
