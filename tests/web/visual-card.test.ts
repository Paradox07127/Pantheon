import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Visual } from '@pantheon/domain';
import { deferred, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { KlineChart } from '@/components/visual/KlineChart';
import { Drawing } from '@/components/visual/shared';
import { VisualBoundary, VisualCard, VisualsDrawing } from '@/components/visual/VisualCard';
import { toastManager } from '@/components/Toast';
import { useBoard } from '@/data/board';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

type NoticeShape = { heading: string; actions: { label: string; run: () => void }[] };

const visual = (over: Partial<Visual> & Pick<Visual, 'kind' | 'spec'>): Visual =>
  ({
    id: 'visual-1',
    revision: 1,
    project_id: 'project-1',
    session_id: 'session-1',
    title: 'Refund retries',
    created_at: 1,
    updated_at: 1,
    ...over,
  }) as Visual;

const kline = visual({
  kind: 'kline',
  spec: { candles: [{ time: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.5 }] },
});

// The card hands its frame the pin action; the frame draws the rest.
function card(props: Parameters<typeof VisualCard>[0]) {
  const outer = mount(() => VisualCard(props));
  const frame = named(outer.value, 'VisualFrame');
  const draw = frame.type as (props: unknown) => ReactNode;
  return { outer, inner: mount(() => draw(frame.props)) };
}

// The session that drew the visual, which can take a message now.
const drawer = {
  id: 'session-1',
  project_id: 'project-1',
  title: 'Refund lead',
  state: 'open',
  revision: 3,
};

// The boundary of a card after its renderer threw, with the error card it shows mounted.
function failedCard(boundary: ReactElement<any>, message: string) {
  const broken = new VisualBoundary(boundary.props);
  broken.state = VisualBoundary.getDerivedStateFromError(new Error(message));
  const shown = named(broken.render(), 'VisualError');
  return mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props));
}

const buttons = (tree: ReactNode, label: string) =>
  nodes(tree).filter((n) => n.type === 'button' && text(n) === label);

const command = vi.fn(async (_command: unknown) => ({ ok: true, value: {} }));
beforeEach(() => {
  command.mockClear();
  vi.stubGlobal('window', {
    pantheon: { command },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  useBoard.setState({ board: null, events: [] });
  vi.unstubAllGlobals();
});

describe('visual card', () => {
  it.each([
    ['kline', kline.spec, 'KlineChart'],
    ['vega-lite', { mark: 'bar' }, 'VegaChart'],
    ['mermaid', { source: 'graph LR\na-->b' }, 'MermaidDiagram'],
    ['graph', { nodes: [{ id: 'a', label: 'a' }], edges: [] }, 'GraphDiagram'],
    ['html', { html: '<p>hi</p>' }, 'SandboxFrame'],
    ['table', { columns: [{ key: 'a', title: 'A', type: 'text' }], rows: [] }, 'TableVisual'],
  ] as const)('draws a %s visual with %s', (kind, spec, renderer) => {
    const { inner } = card({ visual: visual({ kind, spec } as never), size: 'M' });
    expect(named(inner.value, renderer).props.spec).toEqual(spec);
  });

  it('names a table by its kind and leaves its table roles in reach', () => {
    const table = visual({ kind: 'table', spec: { columns: [], rows: [] } });
    const { inner } = card({ visual: table, size: 'M' });
    const picture = find(inner.value, (n) => n.props.className === 'vis-body');
    expect(picture.props['aria-label']).toBe('Refund retries，表格，0 行和0 列');
    expect(picture.props.role).toBe('group');
  });

  it('labels the picture with the title, the kind and the counts of its header', () => {
    const { inner } = card({ visual: kline, size: 'M' });
    const picture = find(inner.value, (n) => n.props.className === 'vis-body');
    expect(picture.props['aria-label']).toBe('Refund retries，K 线，1 个点');
    // It holds the range control, which an image role would hide.
    expect(picture.props.role).toBe('group');
  });

  it.each([
    ['S', 160],
    ['M', 280],
    ['L', 420],
  ] as const)('gives size %s a picture %ipx high', (size, height) => {
    const { inner } = card({ visual: kline, size });
    expect(named(inner.value, 'KlineChart').props.height).toBe(height);
    expect(find(inner.value, (n) => n.props.className === 'vis-body').props.style.height).toBe(
      height,
    );
  });

  it('shows what a renderer threw in its own card and leaves the next card drawing', () => {
    const [first, second] = [kline, { ...kline, id: 'visual-2' }].map((shown) =>
      named(card({ visual: shown, size: 'M' }).inner.value, 'VisualBoundary'),
    );
    expect(first!.type).toBe(VisualBoundary);
    const shown = failedCard(first!, 'Parse error on line 2:\nExpecting a node').value;
    expect(text(find(shown, (n) => n.type === 'code'))).toBe(
      'Parse error on line 2:\nExpecting a node',
    );
    expect(
      nodes(second!.props.children).some((n) => n.type === named(second, 'KlineChart').type),
    ).toBe(true);
  });

  it('offers the spec from a picture that failed to draw', () => {
    const { inner } = card({ visual: kline, size: 'M' });
    const failed = failedCard(named(inner.value, 'VisualBoundary'), 'Bad candle');
    buttons(failed.value, zh('visual.card.viewSpec'))[0]!.props.onClick();
    inner.render();
    const specDialog = nodes(inner.value).find(
      (n) => n.props.open !== undefined && nodes(n).some((c) => c.props.className === 'vis-spec'),
    );
    expect(specDialog!.props.open).toBe(true);
  });

  it('asks the session that drew the visual to fix it with its title, kind and error', async () => {
    useBoard.setState({ board: { sessions: [drawer] } as never });
    const { inner } = card({ visual: kline, size: 'M' });
    const failed = failedCard(named(inner.value, 'VisualBoundary'), 'Bad candle');
    buttons(failed.value, zh('visual.error.fix'))[0]!.props.onClick();
    await failed.flush();
    const sent = command.mock.calls.at(-1)![0] as {
      type: string;
      expected_revision: number;
      input: { session_id: string; input: string };
    };
    expect(sent.type).toBe('session.send');
    expect(sent.expected_revision).toBe(3);
    expect(sent.input.session_id).toBe('session-1');
    expect(sent.input.input).toContain('Refund retries');
    expect(sent.input.input).toContain('kline');
    expect(sent.input.input).toContain('Bad candle');
  });

  it('holds the fix while it is sent and says there why it failed', async () => {
    useBoard.setState({ board: { sessions: [drawer] } as never });
    const reply = deferred<{ ok: false; error: { code: string; message: string } }>();
    command.mockImplementationOnce(() => reply.promise as never);
    const { inner } = card({ visual: kline, size: 'M' });
    const failed = failedCard(named(inner.value, 'VisualBoundary'), 'Bad candle');
    buttons(failed.value, zh('visual.error.fix'))[0]!.props.onClick();
    failed.render();
    const sending = buttons(failed.value, zh('visual.error.fix'))[0]!;
    expect(sending.props['aria-busy']).toBe(true);
    expect(sending.props.disabled).toBe(true);
    reply.resolve({ ok: false, error: { code: 'session_closed', message: 'Session is closed' } });
    await failed.flush();
    expect(buttons(failed.value, zh('visual.error.fix'))[0]!.props.disabled).toBe(false);
    expect(text(failed.value)).toContain('Session is closed');
  });

  it.each([
    ['offers a fix and the spec where a renderer failed', drawer, true],
    ['offers only the spec where a renderer failed for no session', null, false],
    [
      'offers only the spec where a renderer failed for a closed session',
      { ...drawer, state: 'closed' },
      false,
    ],
    [
      'offers only the spec where a renderer failed for a review session',
      { ...drawer, review_id: 'review-1' },
      false,
    ],
  ])('%s', (_, session, fix) => {
    useBoard.setState({ board: { sessions: session ? [session] : [] } as never });
    const { inner } = card({ visual: kline, size: 'M' });
    const failed = failedCard(named(inner.value, 'VisualBoundary'), 'Bad candle');
    expect(
      nodes(failed.value)
        .filter((n) => n.type === 'button')
        .map(text),
    ).toEqual([...(fix ? [zh('visual.error.fix')] : []), zh('visual.card.viewSpec')]);
  });

  it('says a pinned visual went onto the diagrams, opens them in memory and undoes the pin', async () => {
    const add = vi.spyOn(toastManager, 'add');
    const openProjectMemory = vi.fn();
    useShell.setState({ openProjectMemory });
    const { outer } = card({ visual: kline, size: 'S' });
    find(outer.value, (n) => n.props['aria-label'] === zh('visual.card.pin')).props.onClick();
    await outer.flush();
    const shown = add.mock.calls.at(-1)![0] as { data: { card: NoticeShape } };
    expect(shown.data.card.heading).toBe('已钉到图解：Refund retries');
    const [open, undo] = shown.data.card.actions;
    expect([open!.label, undo!.label]).toEqual([
      zh('visual.card.openDiagrams'),
      zh('visual.card.undoPin'),
    ]);
    open!.run();
    expect(openProjectMemory).toHaveBeenCalledWith('project-1', 'diagrams');
    undo!.run();
    await outer.flush();
    expect(command).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'visual.unpin', input: { visual_id: 'visual-1' } }),
    );
    add.mockRestore();
  });

  it('pins an unpinned visual at its size and unpins a pinned one', async () => {
    const { outer } = card({ visual: kline, size: 'S' });
    find(outer.value, (n) => n.props['aria-label'] === zh('visual.card.pin')).props.onClick();
    await outer.flush();
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'visual.pin', input: { visual_id: 'visual-1', size: 'S' } }),
    );
    const pinned = card({ visual: { ...kline, pin: { size: 'M', position: 0 } }, size: 'M' });
    find(
      pinned.outer.value,
      (n) => n.props['aria-label'] === zh('visual.card.unpin'),
    ).props.onClick();
    await pinned.outer.flush();
    expect(command).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'visual.unpin', input: { visual_id: 'visual-1' } }),
    );
  });
});

describe('the enlarged visual', () => {
  const inspector = (tree: ReactNode) =>
    find(tree, (n) => n.type === 'aside' && n.props['aria-label'] === zh('visual.card.inspector'));

  it('shows the spec, the counts, the data source and the Esc key beside the picture', () => {
    const sourced = { ...kline, source: 'market-data.ohlc symbol=ACME days=64' };
    const { inner } = card({ visual: sourced, size: 'M' });
    const aside = inspector(inner.value);
    expect(text(find(aside, (n) => n.props.className === 'vis-spec'))).toContain('"candles"');
    expect(text(aside)).toContain(zh('visual.card.dataSource'));
    expect(text(find(aside, (n) => n.type === 'pre' && n.props.className === 'vis-insp-src'))).toBe(
      'market-data.ohlc symbol=ACME days=64',
    );
    const zoom = find(
      inner.value,
      (n) => n.props.className === 'vis-dlg pop' && nodes(n).includes(aside),
    );
    expect(text(find(zoom, (n) => n.props.className === 'vis-meta'))).toBe('1 个点');
    expect(text(find(zoom, (n) => n.props.className === 'kbd'))).toBe('Esc');
  });

  it('leaves the data source out when the visual names none', () => {
    const { inner } = card({ visual: kline, size: 'M' });
    expect(text(inspector(inner.value))).not.toContain(zh('visual.card.dataSource'));
  });
});

describe('a visual whose spec failed its check', () => {
  const invalid = visual({
    kind: 'kline',
    spec: { candles: 'not a list' } as never,
    error: [
      { message: 'High is below open', path: ['series', 0, 'data', 41, 'high'] },
      { message: 'Low is above close', path: ['series', 0, 'data', 42, 'low'] },
    ],
  });

  it('shows the first issue and its field path in place of the picture', () => {
    useBoard.setState({ board: { sessions: [drawer] } as never });
    const { inner } = card({ visual: invalid, size: 'M' });
    expect(nodes(inner.value).some((n) => n.type === KlineChart)).toBe(false);
    const shown = named(inner.value, 'VisualError');
    const error = mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props)).value;
    expect(text(error)).toContain('High is below open');
    expect(text(find(error, (n) => n.type === 'code'))).toBe('series[0].data[41].high');
    expect(
      nodes(error)
        .filter((n) => n.type === 'button')
        .map(text),
    ).toEqual([zh('visual.error.fix'), zh('visual.card.viewSpec')]);
  });

  it('sends every issue with its path when the agent is asked to fix it', async () => {
    useBoard.setState({ board: { sessions: [drawer] } as never });
    const { inner } = card({ visual: invalid, size: 'M' });
    await named(inner.value, 'VisualError').props.onFix('series[0].data[41].high');
    const sent = command.mock.calls.at(-1)![0] as { input: { input: string } };
    expect(sent.input.input).toContain('series[0].data[41].high: High is below open');
    expect(sent.input.input).toContain('series[0].data[42].low: Low is above close');
  });
});

describe('a visual being drawn', () => {
  const drawing = (sequence: number, call: string, bytes: number, session = 'session-1') => ({
    sequence,
    event_id: `event-${sequence}`,
    kind: 'visual.drawing',
    aggregate_id: session,
    project_id: 'project-1',
    payload: { tool_call_id: call, received_bytes: bytes },
  });
  const other = (sequence: number, kind: string, payload: unknown = {}) => ({
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id: 'session-1',
    project_id: 'project-1',
    payload,
  });

  it('says how much of the spec arrived, else that it is drawing', () => {
    expect(text(mount(() => Drawing({ received: 1536 })).value)).toBe('已收到 1.5 KB');
    const waiting = mount(() => Drawing({}));
    expect(text(waiting.value)).toBe('');
  });

  it('holds a placeholder per draw call of the session until the call completes', () => {
    useBoard.setState({
      events: [
        drawing(1, 'call-old', 900),
        other(2, 'agent.turn.started'),
        drawing(3, 'call-1', 512),
        drawing(4, 'call-2', 100),
        drawing(5, 'call-1', 2048),
        drawing(6, 'call-3', 300, 'session-2'),
        other(7, 'agent.tool.completed', { tool_call_id: 'call-2', ok: true }),
      ] as never,
    });
    const shown = mount(() => VisualsDrawing({ sessionId: 'session-1' })).value;
    expect(
      nodes(shown)
        .filter((n) => n.type === Drawing)
        .map((n) => n.props.received),
    ).toEqual([2048]);
  });
});
