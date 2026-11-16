import { useEffect } from 'react';
import { onMac } from './shortcuts';

const HOLD_MS = 400;

/**
 * Sets `data-cmd` on the body once ⌘ (Ctrl off macOS) alone has been held for 400ms, so the key
 * hints show; releasing it or leaving the window clears it. Returns the stop.
 */
export function holdModifier(): () => void {
  const modifier = onMac() ? 'Meta' : 'Control';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    delete document.body.dataset.cmd;
  };
  const down = (e: KeyboardEvent) => {
    if (e.key !== modifier) {
      // A shortcut is being pressed, not looked up.
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (timer !== undefined || document.body.dataset.cmd) return;
    timer = setTimeout(() => {
      timer = undefined;
      document.body.dataset.cmd = 'held';
    }, HOLD_MS);
  };
  const up = (e: KeyboardEvent) => {
    if (e.key === modifier) clear();
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', clear);
  return () => {
    clear();
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', clear);
  };
}

/** Mounts the held-modifier watch for the window's lifetime. */
export const useHeldModifier = () => useEffect(holdModifier, []);
