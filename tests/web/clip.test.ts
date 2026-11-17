import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
import { Clip } from '@/components/Clip';
import { Tip } from '@/components/Tip';
import { zh } from './i18n-setup.js';

const FULL = 'Rebuild the nightly refunds export with retries and a resumable cursor';

// The host has no layout: the drawn element is a box whose content is `content` px and whose room is `room` px.
const box = { content: 0, room: 0 };
const laidOut = {
  get scrollWidth() {
    return box.content;
  },
  get clientWidth() {
    return box.room;
  },
  get scrollHeight() {
    return box.content;
  },
  get clientHeight() {
    return box.room;
  },
};

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

/** Draws the clip into a box of the given size, as the browser would attach and measure it. */
function draw(lines: number, content: number, room: number) {
  box.content = content;
  box.room = room;
  const h = mount(() => Clip({ text: FULL, lines }));
  find(h.value, (n) => 'data-clip' in n.props).props.ref(laidOut);
  h.render();
  return h;
}
const drawn = (tree: ReactNode) => find(tree, (n) => 'data-clip' in n.props);
const button = (tree: ReactNode) => find(tree, (n) => n.type === 'button');

describe('text cut to fit its box', () => {
  it('shows a cut line whole in a tooltip on hover and keyboard focus', () => {
    const h = draw(1, 400, 120);
    const line = drawn(h.value);
    expect(line.props['data-clip']).toBe('cut');
    expect(line.props.tabIndex).toBe(0);
    const tip = find(h.value, (n) => n.type === Tip);
    expect(tip.props.content).toBe(FULL);
    // The tooltip opens on focus of its trigger: the focusable line itself.
    const tree = Tip(tip.props);
    const trigger = find(tree, (n) => n.props.render !== undefined).props.render;
    expect(trigger.props.tabIndex).toBe(0);
    expect(text(trigger)).toBe(FULL);
    expect(text(find(tree, (n) => n.props.className === 'tooltip'))).toBe(FULL);
  });

  it('leaves a line that fits without a tooltip and out of the tab order', () => {
    const h = draw(1, 120, 400);
    const line = drawn(h.value);
    expect(line.props['data-clip']).toBe('');
    expect(line.props.tabIndex).toBeUndefined();
    expect(nodes(h.value).some((n) => n.type === Tip)).toBe(false);
    expect(text(line)).toBe(FULL);
  });

  it('unfolds cut lines with a show-more button and folds them again', () => {
    const h = draw(2, 60, 40);
    expect(drawn(h.value).props['data-clip']).toBe('cut');
    expect(text(button(h.value))).toBe(zh('components.clip.more'));
    expect(button(h.value).props['aria-expanded']).toBe(false);
    button(h.value).props.onClick();
    h.render();
    expect(button(h.value).props['aria-expanded']).toBe(true);
    expect(text(button(h.value))).toBe(zh('components.clip.less'));
    expect(text(drawn(h.value))).toBe(FULL);
    button(h.value).props.onClick();
    h.render();
    expect(text(button(h.value))).toBe(zh('components.clip.more'));
  });

  it('draws no button under lines that fit', () => {
    const h = draw(2, 40, 40);
    expect(drawn(h.value).props['data-clip']).toBe('');
    expect(nodes(h.value).some((n) => n.type === 'button')).toBe(false);
  });
});
