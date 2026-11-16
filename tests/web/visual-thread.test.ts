import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Visual } from '@pantheon/domain';
const mock = vi.hoisted(() => ({
  read: { data: null, loading: true, error: null, gone: false } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    gone: boolean;
  },
  asked: [] as (string | null)[],
}));
vi.mock('@/data/visuals', async (actual) => ({
  ...(await actual<object>()),
  useVisual: (visualId: string | null) => {
    mock.asked.push(visualId);
    return mock.read;
  },
}));
import type { DaemonEvent } from '@/data/sync';
import { toolLabel } from '@/data/tool-calls';
import { buildTranscript, foldTurn, type SessionTurn } from '@/data/transcript';
import { Items } from '@/screens/sessions/parts';
import { zh } from './i18n-setup.js';

const turn = (id: string): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-main',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
});

let sequence = 0;
const event = (kind: string, aggregate_id: string, payload: unknown = {}): DaemonEvent => {
  sequence++;
  return {
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id,
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: 'cause',
    created_at: 1_000 + sequence,
    payload,
  };
};

const spec = { candles: [{ time: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.5 }] };
const drawInput = (title: string) => ({ title, kind: 'kline', spec });

/** The events of one draw call in a turn: the call, the drawing it makes and the call's result. */
const draw = (turnId: string, call: string, visualId: string, revision = 1, title = 'Refunds') => [
  event('agent.tool.started', 'session-main', {
    turn_id: turnId,
    tool_call_id: call,
    name: 'mcp__pantheon__draw',
    input: drawInput(title),
  }),
  event('visual.drawn', 'session-main', { visual_id: visualId, title, kind: 'kline', revision }),
  event('agent.tool.completed', 'session-main', {
    turn_id: turnId,
    tool_call_id: call,
    ok: true,
    output: JSON.stringify({ receipt: { visual_id: visualId, revision } }),
  }),
];
const said = (turnId: string, text: string) =>
  event('agent.message.delta', 'session-main', { turn_id: turnId, text });

const visualItems = (items: readonly { kind: string }[]) =>
  items.filter((item) => item.kind === 'visual');

beforeEach(() => {
  sequence = 0;
  mock.asked = [];
  mock.read = { data: null, loading: true, error: null, gone: false };
});

describe('drawn visuals in the thread', () => {
  it.each([
    [
      'places a drawing in the turn that drew it, after its draw call',
      () => [
        said('turn-1', 'first'),
        said('turn-2', 'Here it is'),
        ...draw('turn-2', 'call-1', 'visual-1'),
      ],
      1,
      ['text', 'tool', 'visual'],
      1,
    ],
    [
      'updates the drawing in place when the same visual is drawn again',
      () => [
        ...draw('turn-1', 'call-1', 'visual-1'),
        said('turn-1', 'drawn'),
        ...draw('turn-2', 'call-2', 'visual-1', 2),
      ],
      0,
      ['tool', 'visual', 'text'],
      2,
    ],
  ])('%s', (_, events, at, kinds, revision) => {
    const view = buildTranscript([turn('turn-1'), turn('turn-2')], events());
    const drawn = view.turns[at]!.items;
    expect(drawn.map((item) => item.kind)).toEqual(kinds);
    expect(drawn[kinds.indexOf('visual')]).toEqual({
      kind: 'visual',
      visual_id: 'visual-1',
      revision,
    });
    expect(visualItems(view.turns[1 - at]!.items)).toEqual([]);
  });

  it('gives two different visuals an item each', () => {
    const view = buildTranscript(
      [turn('turn-1')],
      [...draw('turn-1', 'call-1', 'visual-1'), ...draw('turn-1', 'call-2', 'visual-2')],
    );
    expect(visualItems(view.turns[0]!.items)).toEqual([
      { kind: 'visual', visual_id: 'visual-1', revision: 1 },
      { kind: 'visual', visual_id: 'visual-2', revision: 1 },
    ]);
  });

  it('keeps a drawing visible when a finished turn folds its work', () => {
    const view = buildTranscript(
      [turn('turn-1')],
      [
        said('turn-1', 'Drawing it'),
        ...draw('turn-1', 'call-1', 'visual-1'),
        said('turn-1', 'Done'),
      ],
    );
    const fold = foldTurn(view.turns[0]!.items);
    expect(fold?.work.map((item) => item.kind)).toEqual(['tool']);
    expect(fold?.kept.map((item) => item.kind)).toEqual(['visual']);
  });
});

describe('the draw call and its card', () => {
  const render = (verbose = false) => {
    const view = buildTranscript([turn('turn-1')], draw('turn-1', 'call-1', 'visual-1'));
    return renderToStaticMarkup(
      createElement(Items, {
        items: view.turns[0]!.items,
        verbose,
        ended: true,
        folders: [],
        sessionId: 'session-main',
        owner: 'turn-1',
      }),
    );
  };

  it('labels a draw call with the verb and the kind, and the title of the visual as prose', () => {
    const drawKind = (kind: string) => `${zh('visual.tool.draw')}，${zh(`visual.kind.${kind}`)}`;
    expect(toolLabel('mcp__pantheon__draw', drawInput('Refunds'))).toEqual({
      title: drawKind('kline'),
      detail: 'Refunds',
      prose: true,
    });
    expect(
      toolLabel('pantheon.draw', { server: 'pantheon', tool: 'draw', arguments: drawInput('Q3') }),
    ).toEqual({ title: drawKind('kline'), detail: 'Q3', prose: true });
    expect(
      toolLabel('mcp__pantheon__draw', { title: 'Backoff', kind: 'graph', spec: {} }).title,
    ).toBe(drawKind('graph'));
  });

  it('labels a call that writes a sandboxed page as writing a page', () => {
    expect(
      toolLabel('mcp__pantheon__draw', { title: 'Backoff', kind: 'html', spec: { html: '<p>' } }),
    ).toEqual({ title: zh('visual.tool.writePage'), detail: 'Backoff', prose: true });
  });

  it('shows the draw call as one folded row without the spec, which opening it shows', () => {
    const html = render();
    expect(html).toContain(zh('visual.tool.draw'));
    expect(html).toContain('Refunds');
    expect(html).not.toContain('candles');
    // The drawing under the row is the call's result; its receipt is not.
    expect(html).not.toContain('visual_id');
    expect(render(true)).toContain('candles');
  });

  it('draws the visual by its id inline under the call', () => {
    mock.read = {
      data: {
        id: 'visual-1',
        revision: 1,
        project_id: 'project-a',
        session_id: 'session-main',
        title: 'Refunds',
        kind: 'kline',
        spec,
        created_at: 1,
        updated_at: 1,
      } satisfies Visual,
      loading: false,
      error: null,
      gone: false,
    };
    const html = render();
    expect(mock.asked).toContain('visual-1');
    expect(html).toMatch(/<section class="vis" data-inline="true" aria-label="Refunds">/);
    expect(html).toContain('height:280px');
    expect(html.indexOf(zh('visual.tool.draw'))).toBeLessThan(html.indexOf('class="vis"'));
  });

  it('draws the visual at the height it was drawn for', () => {
    mock.read = {
      data: {
        id: 'visual-1',
        revision: 1,
        project_id: 'project-a',
        session_id: 'session-main',
        title: 'Refunds',
        kind: 'kline',
        spec,
        size: 'L',
        created_at: 1,
        updated_at: 1,
      } satisfies Visual,
      loading: false,
      error: null,
      gone: false,
    };
    expect(render()).toContain('height:420px');
  });

  it('shows the data source of an opened draw call, and nothing for a call without one', () => {
    const opened = (input: unknown) => {
      const view = buildTranscript(
        [turn('turn-1')],
        [
          event('agent.tool.started', 'session-main', {
            turn_id: 'turn-1',
            tool_call_id: 'call-1',
            name: 'mcp__pantheon__draw',
            input,
          }),
        ],
      );
      return renderToStaticMarkup(
        createElement(Items, {
          items: view.turns[0]!.items,
          verbose: true,
          ended: true,
          folders: [],
          sessionId: 'session-main',
          owner: 'turn-1',
        }),
      );
    };
    expect(opened({ ...drawInput('Refunds'), source: 'refunds.daily days=64' })).toContain(
      `<pre aria-label="${zh('visual.card.dataSource')}">refunds.daily days=64</pre>`,
    );
    expect(opened(drawInput('Refunds'))).not.toContain(zh('visual.card.dataSource'));
  });

  it('says so in place of the card once the visual is deleted', () => {
    mock.read = { data: null, loading: false, error: null, gone: true };
    const html = render();
    expect(html).toContain(`<p class="vis-gone">${zh('visual.card.deleted')}</p>`);
    expect(html).not.toContain('role="alert"');
  });
});
