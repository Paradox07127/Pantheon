import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DebugLevel } from '@/data/debug-view';
import { FakeDocument, FakeElement, FakeNode } from './web-fake-dom.js';

vi.mock('@/data/ask-debug', () => ({ askDebugAgent: vi.fn(async () => {}) }));
import { askDebugAgent } from '@/data/ask-debug';

/** An element that answers the reads a debug pick makes. */
class LaidOutElement extends FakeElement {
  get parentElement(): LaidOutElement | null {
    return this.parentNode instanceof LaidOutElement ? this.parentNode : null;
  }
  get innerText() {
    return this.textContent;
  }
  getBoundingClientRect() {
    return { x: 10, y: 20, width: 300, height: 40 };
  }
}

const doc = new FakeDocument(LaidOutElement);
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  Node: FakeNode,
  Element: LaidOutElement,
  HTMLElement: LaidOutElement,
  addEventListener() {},
  removeEventListener() {},
};
doc.defaultView = win;
const container = doc.createElement('div');
doc.body.appendChild(container);
let root: import('react-dom/client').Root;
let button: LaidOutElement;

const REGION_SRC = 'apps/web/src/screens/board/BoardView.tsx:12:5';
const COMPONENT_SRC = 'apps/web/src/screens/board/MilestoneProgress.tsx:42:7';

function find(node: FakeNode, tag: string): LaidOutElement | null {
  if (node instanceof LaidOutElement && node.tagName === tag) return node;
  for (const child of node.childNodes) {
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  for (const name of ['Node', 'Element', 'HTMLElement'] as const) vi.stubGlobal(name, win[name]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === 'display' ? 'flex' : '0px'),
  }));
  const { act, createElement } = await import('react');
  function MilestoneProgress(_props: { counts: { merged: number }; onPick: () => void }) {
    return createElement(
      'div',
      { 'data-pt-src': COMPONENT_SRC },
      createElement('button', { className: 'btn-ink' }, 'x'),
    );
  }
  // The region mark sits on a component's own root, as on the app's screens.
  function MilestoneCard(props: { counts: { merged: number }; onPick: () => void }) {
    return createElement(
      'section',
      { 'data-debug-region': 'board.progress', 'data-pt-src': REGION_SRC },
      createElement(MilestoneProgress, props),
    );
  }
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
  await act(async () =>
    root.render(createElement(MilestoneCard, { counts: { merged: 3 }, onPick: () => {} })),
  );
  button = find(container, 'BUTTON')!;
});

afterAll(async () => {
  const { act } = await import('react');
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it.each([
  {
    level: 'region',
    tag: 'SECTION',
    path: ['board.progress'],
    source: REGION_SRC,
    text: 'x',
    nearest: 'MilestoneCard',
  },
  {
    level: 'component',
    tag: 'DIV',
    path: ['board.progress', 'MilestoneProgress'],
    source: COMPONENT_SRC,
    text: 'x',
    nearest: 'MilestoneProgress',
  },
  {
    level: 'element',
    tag: 'BUTTON',
    path: ['board.progress', 'MilestoneProgress', 'button.btn-ink'],
    source: null,
    text: 'x',
    nearest: 'MilestoneProgress',
  },
] as const)(
  'picks the $level under the pointer',
  async ({ level, tag, path, source, text, nearest }) => {
    const { pickAt } = await import('@/data/debug-view');
    const pick = pickAt(button as never, level as DebugLevel);
    expect(pick).toMatchObject({
      level,
      region: 'board.progress',
      path,
      source,
      text,
      rect: { x: 10, y: 20, width: 300, height: 40 },
    });
    expect((pick.element as never as LaidOutElement).tagName).toBe(tag);
    expect(pick.stack[0]).toBe(nearest);
    expect(pick.props).toContain('"merged": 3');
    expect(pick.props).toContain('"onPick": "[function]"');
    expect(pick.styles).toMatchObject({ display: 'flex', gap: '0px' });
  },
);

it('drills in from the region to the component to the element', async () => {
  const { drillIn, pickAt } = await import('@/data/debug-view');
  const region = pickAt(button as never, 'region');
  const component = drillIn(region, button as never);
  const element = drillIn(component, button as never);
  expect([region.level, component.level, element.level]).toEqual([
    'region',
    'component',
    'element',
  ]);
  expect(drillIn(element, button as never)).toBe(element);
});

it('sends the items as one report with the images in item order', async () => {
  const { pickAt, sendDebugItems } = await import('@/data/debug-view');
  await sendDebugItems([
    { pick: pickAt(button as never, 'component'), note: 'bar is cut off', image: 'data:a' },
    { pick: pickAt(button as never, 'element'), note: '', image: null },
    { pick: pickAt(button as never, 'region'), note: 'wrong count', image: 'data:c' },
  ]);
  const asked = vi.mocked(askDebugAgent).mock.calls.at(-1)![0];
  expect(asked.title).toBe('Debug view: 3 items');
  expect(asked.images).toEqual(['data:a', 'data:c']);
  expect(asked.detail).toContain('board.progress > MilestoneProgress > button.btn-ink');
  expect(asked.detail).toContain(`Source: ${COMPONENT_SRC}`);
  expect(asked.detail).toContain('Note: bar is cut off');
  expect(asked.detail).toContain('```json\n{\n  "counts"');
});
