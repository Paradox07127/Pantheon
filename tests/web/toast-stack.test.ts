import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, toastManager } from '../../apps/web/src/components/Toast.js';
import { scrimFlag } from '../../apps/web/src/lib/root-flag.js';
import { FakeElement } from './web-fake-dom.js';
import { text } from './web-hook-host.js';
import { mountToastStore } from './web-toast-store.js';

// The stylesheet with the space around its punctuation taken out.
const css = () =>
  readFileSync(path.resolve(import.meta.dirname, '../../apps/web/src/components/toast.css'), 'utf8')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/\s+/g, ' ');

let mounted: ReturnType<typeof mountToastStore>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { activeElement: null });
  mounted = mountToastStore();
});
afterEach(() => {
  toastManager.close();
  mounted.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const byClass = (name: string) => mounted.items().filter((n) => n.props.className === name);

describe('toast stack', () => {
  it.each([
    [
      'draws a countdown line under a toast that can be undone, paused while held',
      { title: 'Session archived', action: { label: 'Undo', run() {} } },
    ],
    ['draws a countdown line under a toast without an action too', { title: 'Session deleted' }],
  ])('%s', (_, options) => {
    toast(options);
    const [life] = byClass('toast-life');
    expect(life?.props.style).toEqual({ animationDuration: '5000ms' });
  });

  it.each([
    ['.toast-life', 'height', '1.5px'],
    // Base UI marks the toasts expanded exactly while it holds their timers.
    ['.toast[data-expanded] .toast-life', 'animation-play-state', 'paused'],
    ['.toast-vp', 'width', 'min(320px,'],
    [
      ':root[data-needs-open] .toast-vp',
      'transform',
      'translateX(calc(-1 * (440px + var(--sp-2))))',
    ],
    ['.toast-body', 'min-height', '40px'],
    ['.toast:is([data-starting-style],[data-ending-style])', 'transform', 'translateX(12px)'],
  ])('sets %s %s to %s', (selector, property, value) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`(?:^|\\})${escaped}\\{([^}]*)\\}`).exec(css())?.[1] ?? '';
    expect(rule).toContain(`${property}:${value}`);
  });

  it('shows three toasts and folds the rest into a count', () => {
    for (const title of ['one', 'two', 'three', 'four', 'five']) toast({ title });
    expect(mounted.shown()).toEqual(['five', 'four', 'three']);
    expect(byClass('btn sm toast-more').map(text)).toEqual(['还有 2 条']);
  });

  it('keeps a failure for ten seconds and what needs the user until it is handled', () => {
    toast({ title: 'Saved' });
    toast({ title: 'Could not save', kind: 'failure' });
    toast({ title: 'Approve the command', kind: 'needs' });
    vi.advanceTimersByTime(5000);
    expect(mounted.shown()).toEqual(['Approve the command', 'Could not save']);
    vi.advanceTimersByTime(5000);
    expect(mounted.shown()).toEqual(['Approve the command']);
    vi.advanceTimersByTime(60_000);
    expect(mounted.shown()).toEqual(['Approve the command']);
  });

  it('folds the same notice coming again into one toast with a count', () => {
    toast({ title: 'Could not save', kind: 'failure' });
    vi.advanceTimersByTime(8000);
    toast({ title: 'Could not save', kind: 'failure' });
    expect(mounted.shown()).toEqual(['Could not save']);
    expect(byClass('toast-n').map(text)).toEqual(['2 次']);
    vi.advanceTimersByTime(9999);
    expect(mounted.shown()).toEqual(['Could not save']);
  });

  it('draws toasts without a shadow', () => {
    expect(css()).not.toContain('shadow');
  });
});

describe('modal scrims under the toast stack', () => {
  const marked = () => document.documentElement.hasAttribute('data-scrim-open');
  const scrim = () => {
    const el = new FakeElement(1, 'DIV', null);
    el.setAttribute('data-open', '');
    return el;
  };
  let changed: Map<FakeElement, () => void>;
  beforeEach(() => {
    changed = new Map();
    vi.stubGlobal('document', { documentElement: new FakeElement(1, 'HTML', null) });
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(private run: () => void) {}
        observe(el: FakeElement) {
          changed.set(el, this.run);
        }
        disconnect() {}
      },
    );
  });

  it('marks the root from the moment a scrim opens until the last open one starts to close', () => {
    const first = scrim();
    const second = scrim();
    const unmountFirst = scrimFlag(first as never)!;
    const unmountSecond = scrimFlag(second as never)!;
    expect(marked()).toBe(true);
    first.removeAttribute('data-open');
    changed.get(first)!();
    expect(marked()).toBe(true);
    second.removeAttribute('data-open');
    changed.get(second)!();
    expect(marked()).toBe(false);
    second.setAttribute('data-open', '');
    changed.get(second)!();
    expect(marked()).toBe(true);
    unmountFirst();
    expect(marked()).toBe(true);
    unmountSecond();
    expect(marked()).toBe(false);
  });

  it('has every modal scrim mark the root', () => {
    const src = path.resolve(import.meta.dirname, '../../apps/web/src');
    const backdrops = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        [...readFileSync(path.join(src, file), 'utf8').matchAll(/<\w+\.Backdrop\b[^>]*>/g)]
          .map(([tag]) => tag)
          .filter((tag) => /className="[\w-]+-scrim"/.test(tag))
          .map((tag) => `${file}: ${tag}`),
      );
    expect(backdrops.length).toBeGreaterThan(30);
    expect(backdrops.filter((tag) => !tag.includes('ref={scrimFlag}'))).toEqual([]);
  });
});
