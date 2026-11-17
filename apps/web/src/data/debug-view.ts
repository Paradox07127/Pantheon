import { askDebugAgent } from './ask-debug';

export type DebugLevel = 'region' | 'component' | 'element';
export interface DebugPick {
  /** The DOM element the pick stands for at its level. */
  element: Element;
  level: DebugLevel;
  /** data-debug-region of the nearest marked ancestor (or itself), e.g. 'board.progress'; null when none. */
  region: string | null;
  /** Outermost region first, then the component name and the element, e.g. ['board.publish-bar', 'PublishBar', 'Button', 'button.btn-ink']. */
  path: string[];
  /** From data-pt-src of the element (element level) or the region / component root; null in a packaged build. */
  source: string | null;
  /** Component display names from the pick's element outward, at most 6. */
  stack: string[];
  /** The props of the element's nearest component as pretty JSON, at most 4000 characters; null when the element has no React fiber. */
  props: string | null;
  /** A CSS selector that matches only the element, for the debug agent's app_dom; null when none was found. */
  selector: string | null;
  rect: { x: number; y: number; width: number; height: number };
  /** The first 200 characters of innerText. */
  text: string;
}
export interface DebugItem {
  pick: DebugPick;
  note: string;
  /** PNG data URL from captureRegion, or null. */
  image: string | null;
}

const PROPS_MAX = 4000;
const STACK_MAX = 6;
const IMAGES_MAX = 10;
// What one item of the message carries at most.
const SENT_PROPS_MAX = 1000;
const SENT_STACK_MAX = 3;
const SENT_TEXT_MAX = 100;

/** The part of a React fiber this file reads. */
interface Fiber {
  type: unknown;
  stateNode: unknown;
  memoizedProps: unknown;
  return: Fiber | null;
  alternate: Fiber | null;
}

const fiberOf = (element: Element): Fiber | null => {
  const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
  return key ? (element as unknown as Record<string, Fiber>)[key]! : null;
};

/** The display name of a function, class, forwardRef or memo component; null for anything else. */
function componentName(type: unknown): string | null {
  if (typeof type === 'function')
    return (type as { displayName?: string }).displayName || type.name || null;
  if (typeof type !== 'object' || type === null) return null;
  const { displayName, render, type: inner } = type as Record<string, unknown>;
  if (typeof render === 'function' || inner !== undefined)
    return (
      (displayName as string | undefined) ||
      componentName(typeof render === 'function' ? render : inner)
    );
  return null;
}

/** The named component fibers from the element's own fiber outward. */
function components(element: Element): { fiber: Fiber; name: string }[] {
  const found: { fiber: Fiber; name: string }[] = [];
  for (let fiber = fiberOf(element)?.return ?? null; fiber; fiber = fiber.return) {
    const name = componentName(fiber.type);
    if (name) found.push({ fiber, name });
  }
  return found;
}

const sameFiber = (a: Fiber | undefined, b: Fiber | undefined): boolean =>
  a !== undefined && b !== undefined && (a === b || a === b.alternate);

/** The outermost host element whose nearest component is the target's. */
function componentRoot(target: Element): Element {
  const nearest = components(target)[0]?.fiber;
  let root = target;
  while (root.parentElement && sameFiber(components(root.parentElement)[0]?.fiber, nearest))
    root = root.parentElement;
  return root;
}

/** The element and its ancestors, innermost first. */
function* outward(element: Element): Generator<Element> {
  for (let at: Element | null = element; at; at = at.parentElement) yield at;
}

const regionOf = (element: Element): Element | null =>
  [...outward(element)].find((at) => at.hasAttribute('data-debug-region')) ?? null;

const regionNames = (element: Element): string[] =>
  [...outward(element)]
    .map((at) => at.getAttribute('data-debug-region'))
    .filter((name) => name !== null)
    .reverse();

/** Component names below the element's innermost region, outermost first; the nearest 3 without a region. */
function componentPath(element: Element): string[] {
  const region = regionOf(element);
  const above = region ? components(region).map((c) => c.fiber) : [];
  const names: string[] = [];
  for (const { fiber, name } of components(element)) {
    if (above.some((f) => sameFiber(f, fiber))) break;
    if (names.at(-1) !== name) names.push(name);
  }
  return (region ? names : names.slice(0, 3)).reverse();
}

const elementName = (element: Element): string => {
  const first = element.getAttribute('class')?.trim().split(/\s+/)[0];
  const tag = element.tagName.toLowerCase();
  return first ? `${tag}.${first}` : tag;
};

/** Plain JSON of props: functions, elements, nodes, cycles and deep values become markers. */
function plain(value: unknown, depth: number, parents: readonly object[]): unknown {
  if (typeof value === 'function') return '[function]';
  if (typeof value !== 'object' || value === null) return value;
  if (typeof (value as { $$typeof?: unknown }).$$typeof === 'symbol') return '[element]';
  if (value instanceof Node) return '[node]';
  if (parents.includes(value)) return '[cycle]';
  if (depth > 4) return '[…]';
  const inside = [...parents, value];
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1, inside));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'children')
      .map(([key, item]) => [key, plain(item, depth + 1, inside)]),
  );
}

const propsJson = (props: unknown): string =>
  (JSON.stringify(plain(props, 0, []), null, 2) ?? 'null').slice(0, PROPS_MAX);

const regionSelector = (name: string) => `[data-debug-region="${name}"]`;

/** The nearest region (or body) and `tag:nth-of-type(n)` steps down to the element, when that names only the element. */
function selectorOf(element: Element): string | null {
  const region = regionOf(element);
  const top = region ?? document.body;
  const steps: string[] = [];
  for (let at = element; at !== top && at.parentElement; at = at.parentElement) {
    const tag = at.tagName;
    const n = [...at.parentElement.children].filter((c) => c.tagName === tag).indexOf(at);
    steps.unshift(`${tag.toLowerCase()}:nth-of-type(${n + 1})`);
  }
  const base = region ? regionSelector(region.getAttribute('data-debug-region')!) : 'body';
  const selector = [base, ...steps].join(' > ');
  const found = document.querySelectorAll(selector);
  return found.length === 1 && found[0] === element ? selector : null;
}

function pickOf(element: Element, level: DebugLevel): DebugPick {
  const region = regionOf(element);
  const named = components(element);
  const box = element.getBoundingClientRect();
  return {
    element,
    level,
    region: region?.getAttribute('data-debug-region') ?? null,
    path: [
      ...regionNames(element),
      ...(level === 'region' ? [] : componentPath(element)),
      ...(level === 'element' ? [elementName(element)] : []),
    ],
    source: element.getAttribute('data-pt-src'),
    stack: named
      .map((c) => c.name)
      .filter((name, i, all) => all[i - 1] !== name)
      .slice(0, STACK_MAX),
    props: named[0] ? propsJson(named[0].fiber.memoizedProps) : null,
    selector:
      level === 'region'
        ? regionSelector(region!.getAttribute('data-debug-region')!)
        : selectorOf(element),
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    // SVG elements have no innerText.
    text: ((element as HTMLElement).innerText ?? element.textContent ?? '').slice(0, 200),
  };
}

/** The pick under a pointer target at a level: region = nearest [data-debug-region] (falls back to the component level when none); component = root host element of the nearest function/class component; element = the element itself. */
export function pickAt(target: Element, level: DebugLevel): DebugPick {
  const region = level === 'region' ? regionOf(target) : null;
  if (region) return pickOf(region, 'region');
  if (level === 'element') return pickOf(target, 'element');
  return pickOf(componentRoot(target), 'component');
}

/** The next level inward from a pick, or the same pick at element level. */
export function drillIn(pick: DebugPick, target: Element): DebugPick {
  if (pick.level === 'element') return pick;
  return pickAt(target, pick.level === 'region' ? 'component' : 'element');
}

function itemText(item: DebugItem, index: number): string {
  const { pick } = item;
  const stack = pick.stack.slice(0, SENT_STACK_MAX);
  const text = pick.text.slice(0, SENT_TEXT_MAX);
  return [
    `${index + 1}. ${pick.path.join(' > ')}${stack[0] ? ` — ${stack[0]}` : ''}`,
    pick.source ? `Source: ${pick.source}` : '',
    pick.selector ? `Selector: ${pick.selector}` : '',
    item.note ? `Note: ${item.note}` : '',
    stack.length ? `Stack: ${stack.join(' < ')}` : '',
    text ? `Text: ${JSON.stringify(text)}` : '',
    // Pretty JSON has line breaks only between its tokens.
    pick.level !== 'region' && pick.props
      ? `Props: ${pick.props.replace(/\n\s*/g, '').slice(0, SENT_PROPS_MAX)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n   ');
}

/** Sends the user's request and the items to the debug session as one message with the images attached; same routing and fallbacks as askDebugAgent. */
export async function sendDebugItems(
  items: readonly DebugItem[],
  request: string,
): Promise<boolean> {
  // Sent to the model, so it stays in one language.
  return askDebugAgent({
    title: `Debug view: ${items.length} ${items.length === 1 ? 'item' : 'items'}`,
    request,
    detail: `Parts of the window the user picked (screenshots attached in the same order):\n\n${items
      .map(itemText)
      .join('\n\n')}`,
    images: items
      .map((item) => item.image)
      .filter((image): image is string => image !== null)
      .slice(0, IMAGES_MAX),
  });
}
