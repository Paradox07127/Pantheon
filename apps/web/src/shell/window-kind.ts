import { useEffect } from 'react';

/** What this window shows: the whole app, one project, or one session alone. */
export type ShownWindow =
  { kind: 'main' | 'project' } | { kind: 'session'; project_id: string; session_id: string };

/** The desktop shell's context of this window; a page outside the desktop app is the main window. */
export function shownWindow(): ShownWindow {
  const context = globalThis.window?.pantheon?.windowContext?.();
  if (context?.kind === 'session' && context.project_id && context.session_id)
    return { kind: 'session', project_id: context.project_id, session_id: context.session_id };
  return { kind: context?.kind === 'project' ? 'project' : 'main' };
}

/** Refuses files dragged over or dropped where no drop zone took them, so the page does not open them. */
export function refuseStrayFiles(e: DragEvent) {
  // Window listeners run after React's, so a drop zone has already called preventDefault.
  if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none';
}

/** Tells the desktop shell it can show the window once the frame after this commit is painted. */
export function readyAfterPaint(): () => void {
  // A frame's callbacks run before it is painted; the task they queue runs after.
  const frame = requestAnimationFrame(() => setTimeout(() => window.pantheon?.ready()));
  return () => cancelAnimationFrame(frame);
}

/** The app shell, or the page drawn in its place, is the first content of the main and project windows. */
export function FirstContent() {
  useEffect(readyAfterPaint, []);
  return null;
}
