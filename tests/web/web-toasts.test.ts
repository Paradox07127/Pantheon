import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../../apps/web/src/components/Toast.js';
import { mountToastStore } from './web-toast-store.js';

const CSS = readFileSync(path.resolve(import.meta.dirname, '../../apps/web/src/index.css'), 'utf8');

let mounted: ReturnType<typeof mountToastStore>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { activeElement: null });
  mounted = mountToastStore();
});
afterEach(() => {
  mounted.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('toast layer', () => {
  it('shows the newest three toasts and hides the older ones', () => {
    for (const title of ['one', 'two', 'three', 'four']) toast({ title });
    expect(mounted.shown()).toEqual(['four', 'three', 'two']);
    expect(CSS).toMatch(/\.tst\[data-limited\]\{[^}]*display:none/);
  });

  it('dismisses a toast after five seconds', () => {
    toast({ title: 'Session archived' });
    vi.advanceTimersByTime(4999);
    expect(mounted.shown()).toEqual(['Session archived']);
    vi.advanceTimersByTime(1);
    expect(mounted.shown()).toEqual([]);
  });

  it('holds toasts while the pointer is over them or they have focus', () => {
    const { store } = mounted;
    toast({ title: 'Session archived' });
    vi.advanceTimersByTime(2000);
    // What the viewport does on mouse enter and leave.
    store.pauseTimers();
    store.set('hovering', true);
    vi.advanceTimersByTime(10_000);
    expect(mounted.shown()).toEqual(['Session archived']);
    store.set('hovering', false);
    store.resumeTimers();
    vi.advanceTimersByTime(2999);
    expect(mounted.shown()).toEqual(['Session archived']);
    // What the viewport does on keyboard focus.
    store.set('focused', true);
    store.pauseTimers();
    vi.advanceTimersByTime(10_000);
    expect(mounted.shown()).toEqual(['Session archived']);
    store.set('focused', false);
    store.resumeTimers();
    vi.advanceTimersByTime(1);
    expect(mounted.shown()).toEqual([]);
  });

  it('runs its one action and closes', () => {
    const run = vi.fn();
    toast({ title: 'Session archived', action: { label: 'Undo', run } });
    const [shown] = mounted.store.state.toasts;
    expect(shown!.actionProps?.children).toBe('Undo');
    shown!.actionProps?.onClick?.({} as never);
    expect(run).toHaveBeenCalledOnce();
    expect(mounted.shown()).toEqual([]);
  });

  it('draws toasts on the popover surface without a shadow', () => {
    const rule = CSS.match(/\n\.tst\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('background:var(--ov)');
    expect(rule).toContain('border:var(--hair) solid var(--bd-ov)');
    expect(rule).toContain('backdrop-filter:blur(var(--blur-md))');
    expect(rule).not.toContain('shadow');
  });
});
