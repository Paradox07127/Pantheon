import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Visual } from '@pantheon/domain';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { VisualCard } from '@/components/visual/VisualCard';
import { useBoard } from '@/data/board';
import { useShell } from '@/store';
import { dayText } from '@/lib/time-text';
import { zh, zhf } from './i18n-setup.js';

const visual = (over: Partial<Visual> & Pick<Visual, 'kind' | 'spec'>): Visual =>
  ({
    id: 'visual-1',
    revision: 1,
    project_id: 'project-1',
    session_id: 'session-1',
    title: 'Refund retries',
    created_at: 1,
    updated_at: new Date(2026, 0, 2, 11, 20).getTime(),
    ...over,
  }) as Visual;

const kline = visual({
  kind: 'kline',
  spec: {
    candles: [
      { time: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: '2026-01-05', open: 1.5, high: 2, low: 1, close: 1.8 },
    ],
  },
});

// The card hands its frame the pin action and the header facts; the frame draws the rest.
function card(props: Parameters<typeof VisualCard>[0]) {
  const outer = mount(() => VisualCard(props));
  const frame = named(outer.value, 'VisualFrame');
  const draw = frame.type as (props: unknown) => ReactNode;
  return mount(() => draw(frame.props)).value;
}

const head = (tree: ReactNode) => find(tree, (n) => n.props.className === 'vis-h');
const labelled = (tree: ReactNode, label: string) =>
  nodes(tree).filter((n) => n.props['aria-label'] === label);
const buttons = (tree: ReactNode, name: string) =>
  nodes(tree).filter((n) => n.type === 'button' && text(n) === name);

beforeEach(() => {
  vi.stubGlobal('window', {
    pantheon: { command: vi.fn() },
    addEventListener() {},
    removeEventListener() {},
  });
  useBoard.setState({
    board: {
      projects: [{ id: 'project-1', name: 'Shop' }],
      sessions: [{ id: 'session-1', project_id: 'project-1', title: 'Refund lead', state: 'open' }],
    } as never,
  });
});
afterEach(() => {
  unmountAll();
  useBoard.setState({ board: null });
  vi.unstubAllGlobals();
});

describe('visual card header', () => {
  it('counts the points of a candlestick chart and of a chart with inline values', () => {
    expect(text(head(card({ visual: kline, size: 'M' })))).toContain('2 个点');
    const chart = visual({
      kind: 'vega-lite',
      spec: { mark: 'bar', data: { values: [{ a: 1 }, { a: 2 }, { a: 3 }] } },
    });
    expect(text(head(card({ visual: chart, size: 'M' })))).toContain('3 个点');
  });

  it('counts the nodes and edges of a graph', () => {
    const graph = visual({
      kind: 'graph',
      spec: {
        nodes: [
          { id: 'a', label: 'a' },
          { id: 'b', label: 'b' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    });
    const shown = text(head(card({ visual: graph, size: 'M' })));
    expect(shown).toContain('2 个节点');
    expect(shown).toContain('1 条边');
  });

  it('counts the rows and columns of a table, each on its own', () => {
    const table = visual({
      kind: 'table',
      spec: {
        columns: [
          { key: 'name', title: 'Session', type: 'text' },
          { key: 'time', title: 'Time', type: 'number' },
        ],
        rows: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      },
    });
    const meta = find(
      head(card({ visual: table, size: 'M' })),
      (n) => n.props.className === 'vis-meta',
    );
    expect(nodes(meta.props.children).map(text)).toEqual(['3 行', '2 列']);
  });

  it('keeps the last picture greyed after a failed redraw, says so and retries the refresh', () => {
    const onRefresh = vi.fn();
    const shown = card({ visual: kline, size: 'M', onRefresh, failed: true });
    const status = find(head(shown), (n) => n.props.role === 'status');
    expect(text(status)).toBe(zh('visual.card.redrawFailed'));
    expect(buttons(shown, zh('visual.card.redraw'))).toEqual([]);
    const retry = find(shown, (n) => n.type === 'button' && text(n) === zh('visual.card.retry'));
    retry.props.onClick();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(find(shown, (n) => n.props.className === 'vis-body').props['data-stale']).toBe(true);

    const fine = card({ visual: kline, size: 'M', onRefresh });
    expect(nodes(fine).filter((n) => n.props.role === 'status')).toEqual([]);
    expect(find(fine, (n) => n.props.className === 'vis-body').props['data-stale']).toBeUndefined();
  });

  it('marks a sandboxed page and says it is offline', () => {
    const page = visual({ kind: 'html', spec: { html: '<p>hi</p>' } });
    const shown = head(card({ visual: page, size: 'M' }));
    expect(text(find(shown, (n) => n.props.className === 'chip'))).toBe(zh('visual.card.sandbox'));
    expect(text(shown)).toContain(zh('visual.card.offline'));
  });

  it('shows when the visual was last updated', () => {
    const shown = find(card({ visual: kline, size: 'M' }), (n) => n.type === 'time');
    expect(shown.props.dateTime).toBe(new Date(kline.updated_at).toISOString());
  });

  it('names the source session on the board and opens it', () => {
    const open = vi.fn();
    useShell.setState({ openProjectSession: open });
    const chip = labelled(card({ visual: kline, size: 'M' }), '来源会话：Refund lead');
    expect(chip).toHaveLength(1);
    expect(text(chip[0])).toBe('Refund lead');
    chip[0]!.props.onClick();
    expect(open).toHaveBeenCalledWith('project-1', 'session-1');
  });

  it('leaves the source session out in the conversation it came from', () => {
    const shown = card({ visual: kline, size: 'M', inline: true });
    expect(labelled(shown, '来源会话：Refund lead')).toEqual([]);
  });

  it('redraws only when the caller can, and holds still while a redraw runs', () => {
    expect(buttons(card({ visual: kline, size: 'M' }), zh('visual.card.redraw'))).toEqual([]);
    const onRefresh = vi.fn();
    const [button] = buttons(
      card({ visual: kline, size: 'M', onRefresh }),
      zh('visual.card.redraw'),
    );
    expect(button!.props['aria-label']).toBeUndefined();
    button!.props.onClick();
    expect(onRefresh).toHaveBeenCalledOnce();
    onRefresh.mockClear();
    const since = Date.now() - 42_000;
    const busy = card({
      visual: kline,
      size: 'M',
      onRefresh,
      refreshing: true,
      redrawSince: since,
    });
    const [held] = buttons(busy, zh('visual.card.redraw'));
    expect(held!.props['aria-disabled']).toBe(true);
    held!.props.onClick();
    expect(onRefresh).not.toHaveBeenCalled();
    const running = named(head(busy), 'RunningFor');
    expect(running.props).toEqual({ label: zh('components.running.redrawing'), since });
  });

  it('says a pinned visual was drawn at its time, and that one whose session is gone cannot be redrawn', () => {
    const onRefresh = vi.fn();
    const drawn = dayText(kline.updated_at, Date.now(), { time: true });
    const fine = card({ visual: kline, size: 'M', onRefresh });
    expect(text(head(fine))).toContain(zhf('visual.card.drawnAt', { time: drawn }));
    expect(text(head(fine))).not.toContain(zh('visual.card.cannotRedraw'));
    const orphan = card({ visual: kline, size: 'M', onRefresh, redrawable: false });
    const status = find(head(orphan), (n) => n.props.role === 'status');
    expect(text(status)).toBe(zh('visual.card.cannotRedraw'));
    const [off] = buttons(orphan, zh('visual.card.redraw'));
    expect(off!.props['aria-disabled']).toBe(true);
    off!.props.onClick();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('opens the spec as read-only text from an action shown on hover', () => {
    const shown = card({ visual: kline, size: 'M' });
    const [zoom] = labelled(shown, zh('visual.card.zoom'));
    const [spec] = labelled(shown, zh('visual.card.viewSpec'));
    expect(zoom!.props.className).toContain('vis-hov');
    expect(spec!.props.className).toContain('vis-hov');
    const pre = nodes(shown).find(
      (n: ReactElement<any>) => n.type === 'pre' && n.props.className === 'vis-spec',
    );
    expect(JSON.parse(text(pre))).toEqual(kline.spec);
  });

  it.each([
    ['.vis-body[data-stale]', 'filter', 'grayscale(1)'],
    ['.vis-hov', 'opacity', '0'],
    ['.vis:hover .vis-hov, .vis:focus-within .vis-hov', 'opacity', '1'],
    ['.vis-h', 'padding', '0 var(--sp-2) 0 var(--sp-3)'],
    [".vis-hov[aria-pressed='true']", 'opacity', '1'],
  ])('gives %s %s: %s in the stylesheet', (selector, property, value) => {
    const literal = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(visualCss()).toMatch(
      new RegExp(`${literal(selector)} \\{[^}]*${property}: ${literal(value)};`),
    );
  });

  it('draws a card in the conversation with the same edge, surface and icon as on the board', () => {
    expect(visualCss()).not.toContain('.vis[data-inline]');
  });

  it('tells after the counts in the conversation when the visual was updated', () => {
    const today = { ...kline, updated_at: new Date().setHours(11, 20, 0, 0) };
    const facts = nodes(head(card({ visual: today, size: 'M', inline: true }))).filter(
      (n) => n.props.className === 'vis-meta',
    );
    expect(text(facts[0])).toBe('2 个点11:20 更新');
  });

  it('hides the pin until hover or focus and keeps a pressed pin in view', () => {
    const [pin] = labelled(card({ visual: kline, size: 'M' }), zh('visual.card.pin'));
    expect(pin!.props.className).toContain('vis-hov');
    expect(pin!.props['aria-pressed']).toBe(false);
    const pinned = { ...kline, pin: { size: 'M' as const, position: 0 } };
    const [pressed] = labelled(card({ visual: pinned, size: 'M' }), zh('visual.card.unpin'));
    expect(pressed!.props['aria-pressed']).toBe(true);
    expect(nodes(pressed).map((n) => (n.type as { displayName?: string }).displayName)).toContain(
      'Pin',
    );
  });

  it('asks under the header before the page reaches the network, and lets the user deny it', () => {
    const page = visual({ kind: 'html', spec: { html: '<p>hi</p>' } });
    const outer = mount(() => VisualCard({ visual: page, size: 'M' }));
    const frame = named(outer.value, 'VisualFrame');
    const inner = mount(() => (frame.type as (props: unknown) => ReactNode)(frame.props));
    named(inner.value, 'SandboxFrame').props.onBlocked('https://api.example.com/rates');
    inner.render();
    const section = find(inner.value, (n) => n.type === 'section');
    const order = [section.props.children]
      .flat()
      .map((n: ReactElement<any> | false) => n && n.props.className);
    expect(order.slice(0, 3)).toEqual(['vis-h', 'vis-ask', 'vis-body']);
    const ask = find(inner.value, (n) => n.props.className === 'vis-ask');
    expect(text(find(ask, (n) => n.type === 'code'))).toBe('api.example.com');
    const buttons = nodes(ask).filter((n) => n.type === 'button');
    expect(buttons.map((b) => [text(b), b.props.className])).toEqual([
      [zh('visual.sandbox.allowOnce'), 'btn sm pri'],
      [zh('visual.sandbox.deny'), 'btn sm'],
    ]);
    buttons[1]!.props.onClick();
    inner.render();
    expect(nodes(inner.value).filter((n) => n.props.className === 'vis-ask')).toEqual([]);
  });
});

function visualCss() {
  return readFileSync(
    new URL('../../apps/web/src/components/visual/visual.css', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');
}
