import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { SessionActivity } from '@pantheon/protocol';
import type { TurnView } from '@/data/transcript';
import { find, nodes, mount, unmountAll } from './web-hook-host.js';

vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));

import { ActivitySpark, TraceWaterfall } from '@/screens/sessions/RunCharts';
import { zh } from './i18n-setup.js';

let keys: EventTarget;
beforeEach(() => {
  keys = new EventTarget();
  vi.stubGlobal('window', keys);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const turn = (state: 'running' | 'completed'): TurnView => ({
  turn: {
    id: 'turn-1',
    revision: 1,
    project_id: 'project-a',
    session_id: 'session-main',
    input: 'input',
    kind: 'send',
    delivery: 'delivered',
    state,
  },
  at: 1_000,
  started_at: 1_000,
  ended_at: state === 'running' ? null : 4_000,
  text: '',
  usage: null,
  end: state === 'running' ? null : { state: 'completed', error: null },
  items: [],
});

const tipOf = (tree: unknown) =>
  nodes(tree as ReactElement).find(
    (n) => typeof n.type === 'function' && n.type.name === 'FloatTip',
  );
const turnBar = (tree: unknown) =>
  find(tree as ReactElement, (n) => String(n.props.className).startsWith('rn-turn'));
const focusEvent = {
  currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 20, top: 30 }) },
};
const escape = () => {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  keys.dispatchEvent(event);
  return event;
};

describe('trace waterfall tip', () => {
  it('follows the focused turn as it completes', () => {
    let turns = [turn('running')];
    const h = mount(() => TraceWaterfall({ turns, now: 3_000 }));
    turnBar(h.value).props.onFocus(focusEvent);
    h.render();
    expect(tipOf(h.value)!.props.content.rows).toContainEqual({
      label: zh('sessions.run.waterfall.result'),
      value: zh('sessions.run.tone.run'),
    });
    turns = [turn('completed')];
    h.render();
    expect(tipOf(h.value)!.props.content.rows).toEqual([
      { label: zh('sessions.run.waterfall.duration'), value: '3.0 秒' },
      { label: zh('sessions.run.waterfall.result'), value: zh('sessions.run.tone.ok') },
    ]);
  });

  it('closes on Escape and keeps the key from other Escape handlers', () => {
    const h = mount(() => TraceWaterfall({ turns: [turn('completed')], now: 5_000 }));
    turnBar(h.value).props.onFocus(focusEvent);
    h.render();
    expect(tipOf(h.value)).toBeDefined();
    expect(escape().defaultPrevented).toBe(true);
    h.render();
    expect(tipOf(h.value)).toBeUndefined();
    expect(escape().defaultPrevented).toBe(false);
  });
});

describe('activity sparkline tip', () => {
  const activity = (completed: number): SessionActivity => ({
    bucket_ms: 300_000,
    from: '2026-11-03T00:00:00.000Z',
    tools_completed: [completed, ...new Array(11).fill(0)],
  });
  const hover = (tree: unknown) =>
    find(tree as ReactElement, (n) => n.type === 'svg').props.onPointerMove({
      clientX: 1,
      clientY: 5,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 120 }) },
    });

  it('follows the hovered bucket as its count changes', () => {
    let data = activity(2);
    const h = mount(() => ActivitySpark({ activity: data }));
    hover(h.value);
    h.render();
    expect(tipOf(h.value)!.props.content.rows).toEqual([
      { label: zh('sessions.run.spark.tools'), value: '2' },
    ]);
    data = activity(3);
    h.render();
    expect(tipOf(h.value)!.props.content.rows).toEqual([
      { label: zh('sessions.run.spark.tools'), value: '3' },
    ]);
  });

  it('closes on Escape while the pointer stays', () => {
    const h = mount(() => ActivitySpark({ activity: activity(2) }));
    hover(h.value);
    h.render();
    expect(tipOf(h.value)).toBeDefined();
    escape();
    h.render();
    expect(tipOf(h.value)).toBeUndefined();
  });
});
