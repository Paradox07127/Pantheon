import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  board: {} as any,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { ReadStatus } from '@/components/ReadStatus';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const READ_AT = new Date(2026, 10, 19, 15, 12).getTime();
const reconnect = vi.fn();
const reload = vi.fn();

/** The status as drawn, with the components it renders called through. */
function drawn(props: Parameters<typeof ReadStatus>[0]): ReactNode {
  const walk = (node: ReactNode): ReactNode => {
    if (!node || typeof node !== 'object' || !('props' in node)) return node;
    const element = node as ReactElement<any>;
    if (typeof element.type === 'function')
      return walk(mount(() => (element.type as (p: unknown) => ReactNode)(element.props)).value);
    return element;
  };
  return walk(mount(() => ReadStatus(props)).value);
}
const buttons = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'button');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 19, 15, 40));
  reconnect.mockReset();
  reload.mockReset();
  mock.board = { status: { state: 'offline', reason: 'closed' }, reconnect };
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

it('says once that the connection is down, when the data shown was read, and reconnects', () => {
  const tree = drawn({ label: 'Trace', stale: true, readAt: READ_AT, reload });
  expect(text(tree)).toBe(
    zh('components.readStatus.offline').replace('{time}', '15:12') +
      zh('components.readStatus.reconnect'),
  );
  const [button] = buttons(tree);
  expect(buttons(tree)).toHaveLength(1);
  expect(button!.props.disabled).toBe(false);
  button!.props.onClick();
  expect(reconnect).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
});

it('leaves a lost connection to the page status, naming only failures under it', () => {
  expect(drawn({ label: 'Trace', stale: true, readAt: READ_AT, reload, inner: true })).toBeNull();
  const failed = drawn({ label: 'Trace', stale: true, error: 'gone', reload, inner: true });
  expect(text(failed)).toContain('Trace读取失败');
});

it('holds the reconnect button while a connection is being made', () => {
  mock.board = { ...mock.board, status: { state: 'connecting' } };
  const [button] = buttons(drawn({ label: 'Trace', stale: true, readAt: READ_AT, reload }));
  expect(button!.props.disabled).toBe(true);
  expect(text(button)).toBe(zh('components.readStatus.reconnect'));
});

it('names the read that failed and retries that read', () => {
  mock.board = { ...mock.board, status: { state: 'live' } };
  const tree = drawn({
    label: 'Trace',
    stale: true,
    error: 'transport unavailable',
    readAt: READ_AT,
    reload,
  });
  expect(text(tree)).toContain('Trace读取失败');
  expect(text(tree)).not.toContain('15:12');
  const [button] = buttons(tree);
  expect(text(button)).toBe(zh('components.readStatus.retry'));
  button!.props.onClick();
  expect(reload).toHaveBeenCalledOnce();
  expect(reconnect).not.toHaveBeenCalled();
});

it('shows no time while connected', () => {
  mock.board = { ...mock.board, status: { state: 'live' } };
  expect(drawn({ label: 'Trace', readAt: READ_AT, reload })).toBeNull();
  const kept = drawn({ label: 'Trace', stale: true, refreshing: true, readAt: READ_AT, reload });
  expect(text(kept)).not.toContain('15:12');
  expect(nodes(kept).some((n) => n.type === 'time')).toBe(false);
});
