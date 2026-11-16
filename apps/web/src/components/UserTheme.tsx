import { useEffect, useLayoutEffect, useState } from 'react';
import type { ThemeAppliedPayload, ThemeRead } from '@pantheon/protocol';
import { useLook } from '../data/layout';
import { failureText } from '../data/needs-you';
import {
  applyTheme,
  applyUserTheme,
  backdropSrc,
  FIRST_FRAME_KEY,
  forcedScheme,
  getUserThemes,
  loadThemes,
  useBackdropOn,
  useSystemReducedMotion,
  useUserThemes,
  watchThemeApplied,
} from '../data/theme';
import { t } from '../i18n';
import { onMac } from '../lib/shortcuts';
import { closeNotice, toast } from './Toast';
import './user-theme.css';

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** After a session applied a theme: a toast that undoes it, by its button or ⌘Z while shown. */
export async function themeApplied(applied: ThemeAppliedPayload): Promise<void> {
  await loadThemes();
  if (applied.by_session_id === undefined || applied.theme_id === null) return;
  const label =
    getUserThemes().list?.themes.find((theme) => theme.id === applied.theme_id)?.label ??
    applied.theme_id;
  const undo = () =>
    void applyTheme(applied.previous_theme_id ?? null).then((result) => {
      if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
    });
  const onKey = (e: KeyboardEvent) => {
    const mod = onMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || editable(e.target)) return;
    e.preventDefault();
    closeNotice(id);
    undo();
  };
  const id = toast({
    title: t(
      { id: 'components.userTheme.applied', defaultMessage: 'Applied theme “{label}”' },
      { label },
    ),
    action: { label: t({ id: 'components.userTheme.undo', defaultMessage: 'Undo' }), run: undo },
    onClose: () => window.removeEventListener('keydown', onKey),
  });
  window.addEventListener('keydown', onKey);
}

/** The applied theme's backdrop under the window, unless turned off or motion is reduced. */
export function ThemeBackdrop() {
  const theme = useUserThemes().active;
  const on = useBackdropOn();
  const systemReduced = useSystemReducedMotion();
  const look = useLook();
  const reduced = look.motion === 'system' ? systemReduced : look.motion === 'reduced';
  const svg = on && !reduced ? theme?.backdrop : undefined;
  // The window's canvas and sidebar let the backdrop through while it is drawn.
  useLayoutEffect(() => {
    if (svg === undefined) delete document.body.dataset.backdrop;
    else document.body.dataset.backdrop = '';
  }, [svg]);
  if (svg === undefined) return null;
  const glass = theme?.glass || null;
  return (
    <>
      <img className="ut-bd" src={backdropSrc(svg)} alt="" aria-hidden="true" />
      {glass && (
        <div
          className="ut-glass"
          aria-hidden="true"
          style={{
            backdropFilter: `blur(${glass.blur}px)`,
            background: `color-mix(in srgb, ${glass.tint} ${glass.opacity * 100}%, transparent)`,
          }}
        />
      )}
    </>
  );
}

/** Applies the saved theme the daemon says is current and returns it; every window runs it once. */
export function useUserTheme(): ThemeRead | null {
  const { list, active } = useUserThemes();
  useEffect(() => {
    void loadThemes();
    return watchThemeApplied((applied) => void themeApplied(applied));
  }, []);
  // Until the first read lands, the theme index.html put on the first frame stays.
  const loaded = list !== null;
  useLayoutEffect(() => {
    if (loaded) applyUserTheme(active);
  }, [loaded, active]);
  return active;
}

/** The scheme the first frame's copy of the theme holds the window in; null without one. */
function firstFrameForced(): 'light' | 'dark' | null {
  try {
    const copy = JSON.parse(localStorage.getItem(FIRST_FRAME_KEY) ?? 'null') as {
      forced?: unknown;
    } | null;
    return copy?.forced === 'light' || copy?.forced === 'dark' ? copy.forced : null;
  } catch {
    return null;
  }
}

/** The scheme the applied theme holds the window in; until the first read lands, the first frame's. */
export function useForcedScheme(): 'light' | 'dark' | null {
  const { list, active } = useUserThemes();
  const [kept] = useState(firstFrameForced);
  return list === null ? kept : forcedScheme(active);
}
