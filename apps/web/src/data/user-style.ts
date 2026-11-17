import { useSyncExternalStore } from 'react';
import type { BridgeResult, UserStyleRead } from '@pantheon/protocol';
import { ipcFailure } from '../screens/settings/editors';
import { useBoard } from './board';
import { runCommand } from './commands';
import type { DaemonEvent } from './sync';

/** Read by the first-frame script in index.html; keep the two in step. */
export const USER_STYLE_KEY = 'pantheon.userStyle.v1';
const STYLE_ID = 'pt-user-style';

// null until the first read lands.
let userStyle: UserStyleRead | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getUserStyle = () => userStyle;

export function setUserStyle(next: UserStyleRead | null) {
  userStyle = next;
  listeners.forEach((listener) => listener());
}

/** The user stylesheet the daemon keeps; null until the first read lands. */
export function useUserStyle(): UserStyleRead | null {
  return useSyncExternalStore(subscribe, getUserStyle, getUserStyle);
}

// Only the newest read is kept, so an older answer landing late changes nothing.
let reads = 0;

/** Reads the user stylesheet into `useUserStyle`. */
export async function loadUserStyle(): Promise<void> {
  const bridge = window.pantheon;
  if (!bridge) return;
  const read = ++reads;
  const result = await bridge.query('style.read').catch(ipcFailure);
  if (read !== reads || !result.ok) return;
  setUserStyle(result.value as UserStyleRead);
}

export async function setUserStyleEnabled(enabled: boolean): Promise<BridgeResult<unknown>> {
  const result = await runCommand('style.enable', { enabled }, null);
  if (result.ok) await loadUserStyle();
  return result;
}

export async function clearUserStyle(): Promise<BridgeResult<unknown>> {
  const result = await runCommand('style.clear', {}, null);
  if (result.ok) await loadUserStyle();
  return result;
}

/** The CSS the page shows: the stylesheet while it is on, else none. */
export const shownCss = (style: UserStyleRead): string => (style.enabled ? style.css : '');

/** Puts the CSS in one style element last in the head, as text; empty CSS takes it away. */
export function applyUserStyle(css: string, doc: Document = document): void {
  // index.html paints the first frame from this copy, before the daemon answers.
  try {
    if (css) localStorage.setItem(USER_STYLE_KEY, css);
    else localStorage.removeItem(USER_STYLE_KEY);
  } catch {}
  let style = doc.getElementById(STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
  }
  style.textContent = css;
  if (doc.head.lastElementChild !== style) doc.head.append(style);
}

/** Moves the user stylesheet after whatever was added to the head since, so its rules win ties. */
export function keepUserStyleLast(doc: Document = document): void {
  const style = doc.getElementById(STYLE_ID);
  if (style && doc.head.lastElementChild !== style) doc.head.append(style);
}

const newest = (events: readonly DaemonEvent[]) => events.at(-1)?.sequence ?? 0;

/** Reads the stylesheet again on each style.changed event from now on; returns the stop. */
export function watchStyleChanged(): () => void {
  let last = newest(useBoard.getState().events);
  return useBoard.subscribe((state, before) => {
    // A read that failed while the daemon was away is made again once the stream is back.
    if (state.status.state === 'live' && before.status.state !== 'live') void loadUserStyle();
    if (state.events === before.events) return;
    if (state.resync !== before.resync) {
      last = newest(state.events);
      void loadUserStyle();
      return;
    }
    const fresh = state.events.filter((event) => event.sequence > last);
    last = Math.max(last, newest(state.events));
    if (fresh.some((event) => event.kind === 'style.changed')) void loadUserStyle();
  });
}
