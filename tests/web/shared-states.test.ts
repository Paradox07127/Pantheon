import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import { EmptyState } from '@/components/EmptyState';
import { useDelayed } from '@/lib/use-delayed';

const command = vi.fn();

beforeEach(() => {
  command.mockReset();
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: null })) },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('turns true only after the activity has lasted the delay, and false once it ends', () => {
  vi.useFakeTimers();
  let active = true;
  const h = mount(() => useDelayed(active));
  vi.advanceTimersByTime(299);
  expect(h.render()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(h.render()).toBe(true);
  active = false;
  expect(h.render()).toBe(false);
  active = true;
  expect(h.render()).toBe(false);
  vi.advanceTimersByTime(300);
  expect(h.render()).toBe(true);
});

it('never turns true for an activity shorter than the delay', () => {
  vi.useFakeTimers();
  let active = true;
  const h = mount(() => useDelayed(active, 300));
  vi.advanceTimersByTime(200);
  active = false;
  h.render();
  vi.advanceTimersByTime(500);
  expect(h.render()).toBe(false);
});

it('lays out an empty state as graphic, title, note and one button with its key cap', () => {
  const onClick = vi.fn();
  const tree = EmptyState({
    graphic: createElement('svg', { 'data-testid': 'glyph' }),
    title: 'Nothing waits for you',
    note: 'New requests show up here',
    action: {
      icon: createElement('svg', { 'data-testid': 'icon' }),
      label: 'New session',
      keys: 'Meta+N',
      onClick,
    },
  });
  const [graphic, title, note, button] = tree.props.children.filter(Boolean);
  expect(graphic.props.className).toBe('es-g');
  expect(graphic.props.children.props['data-testid']).toBe('glyph');
  expect(title.props.className).toBe('es-t');
  expect(text(title)).toBe('Nothing waits for you');
  expect(text(note)).toBe('New requests show up here');
  expect(button.type).toBe('button');
  expect(button.props['aria-keyshortcuts']).toBe('Meta+N');
  const inside = nodes(button.props.children);
  expect(inside[0]!.props['data-testid']).toBe('icon');
  expect(text(button)).toContain('New session');
  expect(find(button, (n) => n.props.className === 'kbd').props['aria-hidden']).toBe('true');
  button.props.onClick();
  expect(onClick).toHaveBeenCalledOnce();
});

it('leaves out the note and the button when none is given', () => {
  const tree = EmptyState({ graphic: createElement('svg'), title: 'No matches' });
  expect(tree.props.children.filter(Boolean)).toHaveLength(2);
});

it('draws an inline empty state as its one line of text, with no graphic or button', () => {
  const tree = EmptyState({ inline: true, title: 'No plan yet' });
  expect(text(tree)).toBe('No plan yet');
  expect(nodes(tree).filter((n) => n.type === 'svg' || n.type === 'button')).toEqual([]);
  expect(nodes(tree)).toHaveLength(1);
});
