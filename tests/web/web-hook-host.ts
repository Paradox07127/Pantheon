import type { ReactElement, ReactNode } from 'react';

type Effect = { deps?: unknown[]; cleanup?: () => void };
let active: HookHost<unknown> | null = null;
const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Runs hooks and effect cleanup deterministically while transport promises are controlled by a test. */
export class HookHost<T> {
  slots: unknown[] = [];
  effects: (() => void)[] = [];
  cursor = 0;
  dirty = true;
  value!: T;
  constructor(
    private body: () => T,
    private commit?: (value: T) => void,
  ) {}
  render(): T {
    // React's own nested-update limit; a synchronous loop here would also outrun vitest's testTimeout.
    let passes = 0;
    do {
      if (++passes > 50) throw new Error('Too many re-renders: state changes after every render');
      this.dirty = false;
      this.cursor = 0;
      active = this as HookHost<unknown>;
      try {
        this.value = this.body();
      } finally {
        active = null;
      }
      this.commit?.(this.value);
      for (const effect of this.effects.splice(0)) effect();
    } while (this.dirty);
    return this.value;
  }
  async flush() {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
      if (this.dirty) this.render();
    }
    return this.value;
  }
  unmount() {
    for (const slot of this.slots) (slot as Effect | undefined)?.cleanup?.();
  }
}
function host() {
  if (!active) throw new Error('Hook outside host');
  return active;
}
export const hooks = {
  useState<T>(initial: T | (() => T)) {
    const h = host(),
      i = h.cursor++;
    if (!(i in h.slots))
      h.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      h.slots[i],
      (next: T | ((before: T) => T)) => {
        const value =
          typeof next === 'function' ? (next as (before: T) => T)(h.slots[i] as T) : next;
        if (!Object.is(h.slots[i], value)) {
          h.slots[i] = value;
          h.dirty = true;
        }
      },
    ] as const;
  },
  useRef<T>(initial: T) {
    const h = host(),
      i = h.cursor++;
    return (h.slots[i] ??= { current: initial });
  },
  useEffect(effect: () => void | (() => void), deps?: unknown[]) {
    const h = host(),
      i = h.cursor++,
      before = h.slots[i] as Effect | undefined;
    if (before && same(before.deps, deps)) return;
    const slot: Effect = { deps };
    h.slots[i] = slot;
    h.effects.push(() => {
      before?.cleanup?.();
      slot.cleanup = effect() ?? undefined;
    });
  },
  useMemo<T>(fn: () => T, deps?: unknown[]) {
    const h = host(),
      i = h.cursor++,
      before = h.slots[i] as { deps?: unknown[]; value: T } | undefined;
    if (before && same(before.deps, deps)) return before.value;
    const value = fn();
    h.slots[i] = { deps, value };
    return value;
  },
  useCallback<T>(fn: T, deps?: unknown[]) {
    return hooks.useMemo(() => fn, deps);
  },
  useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) {
    return snapshot();
  },
};
export function nodes(tree: ReactNode): ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<any>;
  // LoadError has no hooks, so its alert and retry button are walked as drawn.
  if (typeof node.type === 'function' && node.type.name === 'LoadError')
    return [node, ...nodes((node.type as (props: unknown) => ReactNode)(node.props))];
  return [
    node,
    ...nodes(node.props.children),
    ...nodes(node.props.footer),
    ...nodes(node.props.meta),
    ...nodes(node.props.action),
  ];
}
export function find(
  tree: ReactNode,
  predicate: (node: ReactElement<any>) => boolean,
): ReactElement<any> {
  const node = nodes(tree).find(predicate);
  if (!node) throw new Error('Expected element missing');
  return node;
}
export const named = (tree: ReactNode, name: string) =>
  find(tree, (n) => typeof n.type === 'function' && n.type.name === name);
export function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object' && 'props' in tree) {
    const node = tree as ReactElement<any>;
    // DiffCounts, LoadError and an inline EmptyState have no hooks and keep their text out of props.children, so render them here.
    if (
      typeof node.type === 'function' &&
      (node.type.name === 'DiffCounts' ||
        node.type.name === 'LoadError' ||
        (node.type.name === 'EmptyState' && node.props.inline))
    )
      return text((node.type as (props: unknown) => ReactNode)(node.props));
    // Clip keeps its whole text in the DOM, given as a prop.
    if (typeof node.type === 'function' && node.type.name === 'Clip') return node.props.text;
    return text(node.props.children);
  }
  return tree === null || tree === undefined || typeof tree === 'boolean' ? '' : String(tree);
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * React with its hooks run by `HookHost`, for `vi.mock('react', async (actual) =>
 * (await import('./web-hook-host.js')).reactMock(actual))`; `layoutEffect` runs
 * `useLayoutEffect` as `useEffect`; `useId` makes every `useId()` return that string.
 */
export async function reactMock(
  actual: () => Promise<object>,
  options: { layoutEffect?: boolean; useId?: string } = {},
) {
  const { useId } = options;
  return {
    ...(await actual()),
    ...hooks,
    ...(options.layoutEffect ? { useLayoutEffect: hooks.useEffect } : {}),
    ...(useId === undefined ? {} : { useId: () => useId }),
  };
}

const mounted: HookHost<any>[] = [];
/** Renders `body` once in a host that `unmountAll` cleans up. */
export function mount<T>(body: () => T): HookHost<T> {
  const h = new HookHost(body);
  mounted.push(h);
  h.render();
  return h;
}
export function unmountAll() {
  mounted.splice(0).forEach((h) => h.unmount());
}
