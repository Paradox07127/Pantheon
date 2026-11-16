import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { find, mount, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { Thread } from '@/screens/sessions/Thread';
import { findMatches } from '@/screens/sessions/thread-model';
import { ThreadFind, useThreadFind } from '@/screens/sessions/ThreadFind';
import { zh } from './i18n-setup.js';

const turn = (id: string, input: string, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input,
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});
const event = (sequence: number, kind: string, payload: object) => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'session-a',
  aggregate_revision: sequence,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload,
});
const thread = () =>
  buildTranscript(
    [
      turn('turn-1', 'Check the webhook signature'),
      turn('turn-2', '[Lead] Rebase the webhook branch', { origin: 'lead' }),
    ],
    [
      event(1, 'agent.message.delta', { turn_id: 'turn-1', text: 'The Webhook reads the body.' }),
      event(2, 'agent.tool.started', {
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        name: 'Bash',
        input: { command: 'grep webhook' },
      }),
      event(3, 'agent.message.delta', { turn_id: 'turn-1', text: 'webhook webhook' }),
    ] as any,
  ).turns;

describe('search in the thread', () => {
  it("finds the query, case aside, in the user's messages and the agent's replies only", () => {
    expect(findMatches(thread(), 'WEBHOOK')).toEqual([
      { turn: 'turn-1', block: 'input', nth: 0 },
      { turn: 'turn-1', block: '0', nth: 0 },
      { turn: 'turn-1', block: '2', nth: 0 },
      { turn: 'turn-1', block: '2', nth: 1 },
      { turn: 'turn-2', block: 'input', nth: 0 },
    ]);
    expect(findMatches(thread(), 'Lead')).toEqual([]);
    expect(findMatches(thread(), '  ')).toEqual([]);
  });

  it('counts the text a reply draws, not its Markdown source', () => {
    const turns = buildTranscript([turn('turn-1', 'Check it')], [
      event(1, 'agent.message.delta', {
        turn_id: 'turn-1',
        text: 'See [the docs](https://example.com/webhook).',
      }),
      event(2, 'agent.tool.started', {
        turn_id: 'turn-1',
        tool_call_id: 'call-1',
        name: 'Bash',
        input: { command: 'ls' },
      }),
      event(3, 'agent.message.delta', { turn_id: 'turn-1', text: 'The **web**hook reads it.' }),
    ] as any).turns;
    expect(findMatches(turns, 'webhook')).toEqual([{ turn: 'turn-1', block: '2', nth: 0 }]);
  });

  afterEach(() => {
    unmountAll();
    useThreadFind.getState().close();
  });
  const bar = () => mount(() => ThreadFind({ turns: thread(), scroller: { current: null } }));
  const input = (h: HookHost<any>) => find(h.value, (n) => n.type === 'input');
  const count = (h: HookHost<any>) => text(find(h.value, (n) => n.props['aria-live'] === 'polite'));
  const button = (h: HookHost<any>, label: string): ReactElement<any> =>
    find(h.value, (n) => n.type === 'button' && n.props['aria-label'] === label);
  const type = (h: HookHost<any>, value: string) => {
    input(h).props.onChange({ target: { value } });
    h.render();
  };

  it('counts the matches and steps through them both ways, wrapping at the ends', () => {
    const h = bar();
    expect(input(h).props['aria-label']).toBe(zh('sessions.thread.find'));
    expect(count(h)).toBe('');
    expect(button(h, zh('sessions.thread.findNext')).props.disabled).toBe(true);
    type(h, 'webhook');
    expect(count(h)).toBe('第 1 / 共 5');
    button(h, zh('sessions.thread.findNext')).props.onClick();
    h.render();
    expect(count(h)).toBe('第 2 / 共 5');
    button(h, zh('sessions.thread.findPrevious')).props.onClick();
    h.render();
    button(h, zh('sessions.thread.findPrevious')).props.onClick();
    h.render();
    expect(count(h)).toBe('第 5 / 共 5');
    input(h).props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
    h.render();
    expect(count(h)).toBe('第 1 / 共 5');
    type(h, 'nothing like it');
    expect(count(h)).toBe(zh('sessions.thread.findNone'));
    expect(button(h, zh('sessions.thread.findPrevious')).props.disabled).toBe(true);
  });

  it('closes on Escape and gives focus back to what opened it', () => {
    const opener = { focus: vi.fn() };
    useThreadFind.getState().show('session-a', opener as any);
    const h = bar();
    const stop = vi.fn();
    const root = nodes(h.value).find((n) => n.props.role === 'search')!;
    root.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation: stop });
    expect(useThreadFind.getState().sessionId).toBeNull();
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalled();
  });

  it('closes from its close button and gives focus back too', () => {
    const opener = { focus: vi.fn() };
    useThreadFind.getState().show('session-a', opener as any);
    const h = bar();
    button(h, zh('sessions.thread.findClose')).props.onClick();
    expect(useThreadFind.getState().sessionId).toBeNull();
    expect(opener.focus).toHaveBeenCalledOnce();
  });

  it('takes focus again and selects its query when search is asked for while it is open', () => {
    useThreadFind.getState().show('session-a', null);
    const h = bar();
    type(h, 'webhook');
    const field = { focus: vi.fn(), select: vi.fn() };
    Object.assign(input(h).props.ref ?? {}, { current: field });
    useThreadFind.getState().show('session-a', null);
    h.render();
    expect(field.focus).toHaveBeenCalledOnce();
    expect(field.select).toHaveBeenCalledOnce();
  });
});

describe('marks in the drawn thread', () => {
  interface FakeText {
    textContent: string;
    parentElement: { scrollIntoView: (options: unknown) => void };
    top: number;
  }
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  /**
   * One drawn turn whose blocks hold the given text nodes, each at a height on screen; it records the
   * marks painted on it and every scroll.
   */
  function drawn(blocks: [string, [string, number][]][]) {
    const scrolls: unknown[] = [];
    const observers: (() => void)[] = [];
    const highlights = new Map<string, { ranges: any[] }>();
    const element = { scrollIntoView: (options: unknown) => scrolls.push({ element: options }) };
    const texts = new Map(
      blocks.map(([find, list]) => [
        find,
        list.map(([textContent, top]): FakeText => ({ textContent, parentElement: element, top })),
      ]),
    );
    const turn = {
      dataset: { turn: 'turn-1' },
      querySelectorAll: () => [...texts.keys()].map((find) => ({ dataset: { find } })),
      scrollIntoView: element.scrollIntoView,
    };
    const root = {
      scrollTop: 100,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 50, height: 400 }),
      querySelectorAll: () => [turn],
      querySelector: () => turn,
      scrollTo: (options: unknown) => scrolls.push(options),
    };
    vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    vi.stubGlobal('CSS', { highlights, escape: (s: string) => s });
    vi.stubGlobal(
      'Highlight',
      class {
        ranges: unknown[];
        constructor(...ranges: unknown[]) {
          this.ranges = ranges;
        }
      },
    );
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(private changed: () => void) {}
        observe() {
          observers.push(this.changed);
        }
        disconnect() {
          observers.splice(observers.indexOf(this.changed), 1);
        }
      },
    );
    vi.stubGlobal('document', {
      createTreeWalker: (block: { dataset: { find: string } }) => {
        const list = texts.get(block.dataset.find)!;
        let i = 0;
        return { nextNode: () => list[i++] ?? null };
      },
      createRange: () => {
        const range = {
          startContainer: null as FakeText | null,
          start: null as [string, number] | null,
          end: null as [string, number] | null,
          setStart(node: FakeText, at: number) {
            range.startContainer = node;
            range.start = [node.textContent, at];
          },
          setEnd(node: FakeText, at: number) {
            range.end = [node.textContent, at];
          },
          getBoundingClientRect: () => ({ top: range.startContainer!.top, height: 20 }),
        };
        return range;
      },
    });
    return {
      root,
      texts,
      scrolls,
      observers,
      /** The start and end of each painted match. */
      marks: () => highlights.get('ss-find')?.ranges.map((r) => [r.start, r.end]) ?? [],
    };
  }
  const turns = () =>
    buildTranscript([turn('turn-1', 'webhook at the top\n\n…\n\nwebhook at the end')], [
      event(1, 'agent.message.delta', { turn_id: 'turn-1', text: 'const webhook = 1' }),
    ] as any).turns;
  function search(dom: ReturnType<typeof drawn>, query: string, list = turns()) {
    const h = mount(() => ThreadFind({ turns: list, scroller: { current: dom.root as any } }));
    find(h.value, (n) => n.type === 'input').props.onChange({ target: { value: query } });
    h.render();
    return h;
  }

  it('marks a match that runs across the nodes highlighting splits a code block into', () => {
    const dom = drawn([
      ['input', [['webhook at the top\n\n…\n\nwebhook at the end', 0]]],
      [
        '0',
        [
          ['const web', 0],
          ['hook = 1', 0],
        ],
      ],
    ]);
    search(dom, 'webhook');
    expect(dom.marks()).toEqual([
      [
        ['webhook at the top\n\n…\n\nwebhook at the end', 0],
        ['webhook at the top\n\n…\n\nwebhook at the end', 7],
      ],
      [
        ['webhook at the top\n\n…\n\nwebhook at the end', 23],
        ['webhook at the top\n\n…\n\nwebhook at the end', 30],
      ],
      [
        ['const web', 6],
        ['hook = 1', 4],
      ],
    ]);
  });

  it('marks the text the thread draws later, while the current match stays the same', () => {
    const dom = drawn([
      ['input', [['webhook at the top\n\n…\n\nwebhook at the end', 0]]],
      ['0', []],
    ]);
    search(dom, 'webhook');
    expect(dom.marks()).toHaveLength(2);
    dom.texts
      .get('0')!
      .push({ textContent: 'const webhook = 1', parentElement: {} as any, top: 0 });
    for (const changed of [...dom.observers]) changed();
    expect(dom.marks()).toHaveLength(3);
  });

  it('scrolls each match of one tall message to the middle of the thread', () => {
    const dom = drawn([
      [
        'input',
        [
          ['webhook at the top', 60],
          ['\n\n…\n\n', 300],
          ['webhook at the end', 2_000],
        ],
      ],
      ['0', [['const webhook = 1', 2_100]]],
    ]);
    const h = search(dom, 'webhook');
    find(
      h.value,
      (n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.thread.findNext'),
    ).props.onClick();
    h.render();
    // The thread's top, plus the match's distance below the thread's top, less half the room around it.
    expect(dom.scrolls).toEqual([
      { top: 100 + 60 - 50 - 190, behavior: 'auto' },
      { top: 100 + 2_000 - 50 - 190, behavior: 'auto' },
    ]);
  });
});

describe('search key', () => {
  let keys: ((e: KeyboardEvent) => void)[] = [];
  afterEach(() => {
    unmountAll();
    useThreadFind.getState().close();
    vi.unstubAllGlobals();
  });

  it('opens the search bar of the shown thread on ⌘F, also from the composer', () => {
    keys = [];
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: KeyboardEvent) => void) =>
        type === 'keydown' && keys.push(fn),
      removeEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
        if (type === 'keydown') keys = keys.filter((k) => k !== fn);
      },
    });
    const box = { tagName: 'TEXTAREA', isContentEditable: false };
    vi.stubGlobal('document', { activeElement: box });
    const board = {
      cursor: 1,
      projects: [],
      workspaces: [],
      sessions: [
        {
          id: 'session-a',
          revision: 1,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'open',
          turn_count: 0,
        },
      ],
      session_turns: [],
    };
    mock.board = { board, events: [], resync: 0, status: { state: 'live' }, refresh() {} };
    mount(() =>
      Thread({
        board: board as any,
        sessionId: 'session-a',
        listed: null,
        needs: { items: [] } as any,
        parent: null,
        panels: [],
        onPanel() {},
        overview: true,
        onDiscarded() {},
      }),
    );
    const preventDefault = vi.fn();
    for (const key of [...keys])
      key({
        key: 'f',
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: box,
        preventDefault,
      } as any);
    expect(preventDefault).toHaveBeenCalled();
    expect(useThreadFind.getState()).toMatchObject({ sessionId: 'session-a', opener: box });
  });
});
