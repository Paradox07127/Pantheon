import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { RequestIndex } from '@/screens/sessions/SessionsScreen';
import { timelineNodes, type TimelineNode } from '@/screens/sessions/thread-model';
import { Tooltip } from '../../apps/web/node_modules/@base-ui/react/tooltip/index.mjs';
import { zh } from './i18n-setup.js';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const at = (hour: number, minute: number) => new Date(2026, 10, 12, hour, minute).getTime();

describe('timeline nodes', () => {
  const turns = [
    { id: 'turn-1', at: at(10, 0) },
    { id: 'turn-2', at: at(10, 20) },
  ];

  it('gives each turn with a key point a node at its time, numbered by its place', () => {
    const shown = timelineNodes({
      sessionId: 'lead-a',
      turns: [
        { id: 'turn-1', at: at(10, 0) },
        { id: 'turn-2', at: at(10, 20), summary: '修好登录后的跳转' },
      ],
      waits: [],
    });
    expect(shown.map((n) => [n.kind, n.at, n.label, n.name, n.turn])).toEqual([
      ['turn', at(10, 20), '修好登录后的跳转', '第 2 轮：修好登录后的跳转', 'turn-2'],
    ]);
  });

  it('has no nodes before the history arrives and nothing waits', () => {
    expect(timelineNodes({ sessionId: 'lead-a', turns, waits: [] })).toEqual([]);
  });
});

/** Every element of the tree, with the elements a trigger renders in place of itself. */
const all = (tree: unknown): ReactElement<any>[] =>
  nodes(tree as ReactElement).flatMap((n) => [n, ...(n.props.render ? all(n.props.render) : [])]);
const marks = (tree: unknown) =>
  all(tree).filter((n) => n.type === 'button' && n.props.className === 'ss-tlm');
const lines = (tree: unknown) =>
  all(tree).filter((n) => n.type === 'i' && n.props.className === 'ss-tla');

const node = (id: string, kind: TimelineNode['kind'], time: number, turn: string | null) => ({
  id,
  kind,
  at: time,
  label: `label of ${id}`,
  name: `name of ${id}`,
  turn,
});

function index(shown: TimelineNode[], scroller: unknown = { current: null }, slim = false) {
  // The thread's own listeners; the tests here call the marks' clicks.
  const thread = (scroller as { current: object | null }).current;
  if (thread) Object.assign(thread, { addEventListener() {}, removeEventListener() {} });
  return mount(() => RequestIndex({ nodes: shown, scroller: scroller as any, slim })).value;
}

describe('session timeline', () => {
  it('names each node by its time and name, shows its label, and draws only the three kinds of mark', () => {
    const tree = index([
      node('goal:a', 'goal', at(10, 14), 'turn-1'),
      node('turn:m', 'turn', at(10, 36), 'turn-2'),
      node('wait:w', 'wait', at(10, 39), null),
    ]);
    expect(marks(tree).map((n) => n.props['aria-label'])).toEqual([
      '10:14 name of goal:a',
      '10:36 name of turn:m',
      '10:39 name of wait:w',
    ]);
    expect(
      all(tree)
        .filter((n) => n.props.className === 'ss-tlg')
        .map((n) => n.props['data-kind']),
    ).toEqual(['goal', 'turn', 'wait']);
    expect(text(marks(tree)[0]!)).toBe('label of goal:a');
  });

  it('draws the line between two nodes as long as the distance between them in the thread', () => {
    const tops: Record<string, number> = {
      '[data-turn="turn-1"]': 0,
      '[data-turn="turn-2"]': 400,
      '[data-turn="turn-3"]': 500,
    };
    const tree = index(
      [
        node('goal:a', 'goal', at(10, 0), 'turn-1'),
        node('goal:b', 'goal', at(10, 1), 'turn-2'),
        node('goal:c', 'goal', at(10, 50), 'turn-3'),
      ],
      {
        current: {
          scrollTop: 0,
          clientHeight: 600,
          firstElementChild: {},
          getBoundingClientRect: () => ({ top: 0 }),
          querySelector: (selector: string) => ({
            getBoundingClientRect: () => ({ top: tops[selector] }),
          }),
          addEventListener() {},
          removeEventListener() {},
        },
      },
    );
    expect(lines(tree).map((n) => n.props.style.height)).toEqual([64, 22]);
  });

  it('keeps the part of the thread on screen on the last mark once the thread scrolls past it', () => {
    const tops: Record<string, number> = { '[data-turn="turn-1"]': 0, '[data-turn="turn-2"]': 100 };
    const onScreen = (scrollTop: number) => {
      const tree = index(
        [node('goal', 'goal', at(10, 0), 'turn-1'), node('goal:a', 'goal', at(10, 5), 'turn-2')],
        {
          current: {
            scrollTop,
            clientHeight: 600,
            firstElementChild: {},
            getBoundingClientRect: () => ({ top: 0 }),
            querySelector: (selector: string) => ({
              getBoundingClientRect: () => ({ top: tops[selector]! - scrollTop }),
            }),
            addEventListener() {},
            removeEventListener() {},
          },
        },
      );
      return all(tree).filter((n) => n.props.className === 'ss-tlv')[0]!.props.style;
    };
    expect(onScreen(2400)).toEqual(onScreen(1200));
    expect(onScreen(0)).not.toEqual(onScreen(1200));
  });

  const goal = (
    'Check raw body signatures on every webhook. ' +
    'Reject a request whose signature does not match, and log what it carried. '.repeat(5)
  ).slice(0, 300);
  const goalZh = (
    '校验每个 webhook 的原始请求体签名。' +
    '签名不符的请求直接拒绝，并记下它带来的内容。'.repeat(20)
  ).slice(0, 300);
  it.each([
    ['its first sentence', goal, '', 'Check raw body signatures on every webhook'],
    ['the session title', goal, 'Webhook signatures', 'Webhook signatures'],
    [
      'its first sentence when the title repeats it',
      goalZh,
      goalZh,
      '校验每个 webhook 的原始请求体签名',
    ],
  ])(
    'shows a long goal as %s on one line, the goal itself in its tooltip and name',
    (_, text_, title, shown) => {
      const tree = index(
        timelineNodes({
          sessionId: 'lead-a',
          turns: [{ id: 'turn-1', at: at(10, 0) }],
          waits: [{ id: 'approval-1', at: at(10, 5), turn: null, question: false }],
          goal: { text: text_, at: new Date(at(10, 0)).toISOString() },
          title,
        }),
      );
      const [mark] = all(tree).filter((n) => n.type === 'button');
      expect(text(mark!)).toBe(shown);
      expect(mark!.props['aria-label']).toContain(text_.slice(0, 200));
      const [tip] = all(tree).filter((n) => n.type === Tooltip.Popup);
      expect(text(tip!)).toContain(text_.slice(0, 200));
      expect(text(tip!).length).toBeLessThan(text_.length);
    },
  );

  it('measures the part on screen again when the thread alone grows taller', () => {
    const watched: { target: unknown; measure: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private measure: () => void) {}
        observe(target: unknown) {
          watched.push({ target, measure: this.measure });
        }
        disconnect() {}
      },
    );
    const thread = {
      scrollTop: 0,
      clientHeight: 300,
      firstElementChild: {},
      getBoundingClientRect: () => ({ top: 0 }),
      querySelector: (selector: string) => ({
        getBoundingClientRect: () => ({ top: selector === '[data-turn="turn-1"]' ? 0 : 600 }),
      }),
      addEventListener() {},
      removeEventListener() {},
    };
    const shown = [
      node('goal:a', 'goal', at(10, 0), 'turn-1'),
      node('goal:b', 'goal', at(10, 1), 'turn-2'),
    ];
    const scroller = { current: thread as any };
    const h = mount(() => RequestIndex({ nodes: shown, scroller }));
    const onScreen = () => find(h.value, (n) => n.props.className === 'ss-tlv').props.style;
    const current = () => marks(h.value).map((n) => n.props['aria-current']);
    const before = onScreen();
    expect(current()).toEqual(['true', undefined]);
    thread.clientHeight = 700;
    for (const one of watched) if (one.target === thread) one.measure();
    h.render();
    expect(onScreen()).not.toEqual(before);
    expect(current()).toEqual([undefined, 'true']);
  });

  it('keeps only the marks when slim', () => {
    const shown = [
      node('goal:a', 'goal', at(10, 0), 'turn-1'),
      node('goal:b', 'goal', at(10, 5), 'turn-2'),
    ];
    const [slim] = all(index(shown, { current: null }, true));
    expect(slim!.props['data-slim']).toBe(true);
    const [wide] = all(index(shown));
    expect(wide!.props['data-slim']).toBeUndefined();
  });

  it("scrolls the thread to a node's turn, or to the waiting card below the thread", () => {
    const target = { scrollIntoView: vi.fn(), getBoundingClientRect: () => ({ top: 900 }) };
    const querySelector = vi.fn((selector: string) =>
      selector === '[data-turn="turn-2"]' || selector === '[data-approval="w"]' ? target : null,
    );
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const shown = marks(
      index(
        [node('goal:a', 'goal', at(10, 0), 'turn-2'), node('wait:w', 'wait', at(10, 9), null)],
        {
          current: {
            querySelector,
            clientHeight: 600,
            getBoundingClientRect: () => ({ top: 100 }),
          },
        },
      ),
    );
    shown[0]!.props.onClick();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    shown[1]!.props.onClick();
    expect(querySelector).toHaveBeenLastCalledWith('[data-approval="w"]');
    expect(target.scrollIntoView).toHaveBeenLastCalledWith({ block: 'start', behavior: 'auto' });
  });

  it("draws a turn's key point with its own mark and scrolls to that turn on a click", () => {
    const target = { scrollIntoView: vi.fn(), getBoundingClientRect: () => ({ top: 300 }) };
    const querySelector = vi.fn((selector: string) =>
      selector === '[data-turn="turn-2"]' ? target : null,
    );
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const tree = index(
      timelineNodes({
        sessionId: 'lead-a',
        turns: [{ id: 'turn-2', at: at(10, 20), summary: '修好登录后的跳转' }],
        waits: [{ id: 'approval-1', at: at(10, 25), turn: null, question: false }],
      }),
      {
        current: { querySelector, clientHeight: 600, getBoundingClientRect: () => ({ top: 100 }) },
      },
    );
    const [mark] = marks(tree);
    expect(text(mark!)).toBe('修好登录后的跳转');
    const [glyph] = all(tree).filter((n) => n.props.className === 'ss-tlg');
    expect(glyph!.props['data-kind']).toBe('turn');
    expect(glyph!.props.children).toBeTruthy();
    mark!.props.onClick();
    expect(querySelector).toHaveBeenLastCalledWith('[data-turn="turn-2"]');
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });

  it('jumps at once to a node more than two screens away', () => {
    let top = 1301;
    const target = { scrollIntoView: vi.fn(), getBoundingClientRect: () => ({ top }) };
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const [mark] = marks(
      index(
        [node('goal:a', 'goal', at(10, 0), 'turn-1'), node('wait:w', 'wait', at(10, 9), null)],
        {
          current: {
            querySelector: () => target,
            clientHeight: 600,
            getBoundingClientRect: () => ({ top: 100 }),
          },
        },
      ),
    );
    mark!.props.onClick();
    expect(target.scrollIntoView).toHaveBeenLastCalledWith({ block: 'start', behavior: 'auto' });
    top = -1100;
    mark!.props.onClick();
    expect(target.scrollIntoView).toHaveBeenLastCalledWith({ block: 'start', behavior: 'smooth' });
  });

  it('keeps the rail in its column before its second node arrives, hidden from assistive tech', () => {
    const [empty] = all(index([], { current: null }, true));
    const lone = all(index([node('goal', 'goal', at(10, 0), 'turn-1')], { current: null }, true));
    const [filled] = all(
      index(
        [node('goal', 'goal', at(10, 0), 'turn-1'), node('goal:a', 'goal', at(10, 5), 'turn-1')],
        { current: null },
        true,
      ),
    );
    expect(empty?.type).toBe(filled!.type);
    expect(empty!.props.className).toBe(filled!.props.className);
    expect(empty!.props['data-slim']).toBe(filled!.props['data-slim']);
    expect(empty!.props['aria-hidden']).toBe(true);
    expect(filled!.props['aria-hidden']).toBeUndefined();
    expect(marks(lone)).toEqual([]);
    expect(lone[0]!.props['aria-hidden']).toBe(true);
  });
});
