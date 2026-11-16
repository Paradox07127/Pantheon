import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { useShell } from '../store';

/** What the viewer has seen of one session. */
export interface SeenRecord {
  seen_at: string;
  manual_unread: boolean;
}

export type SeenRecords = Readonly<Record<string, SeenRecord>>;

const KEY = 'pantheon.unread.';

// Project id → its records, or null when storage cannot be read.
const known = new Map<string, SeenRecords | null>();
const subscribers = new Set<() => void>();
let version = 0;

function load(projectId: string): SeenRecords | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY + projectId);
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, Partial<SeenRecord> | null>).flatMap(([id, r]) =>
        typeof r?.seen_at === 'string'
          ? [[id, { seen_at: r.seen_at, manual_unread: r.manual_unread === true }]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

/** The project's records; null when storage cannot be read, which leaves every session read. */
export function seenRecords(projectId: string | null): SeenRecords | null {
  if (!projectId) return null;
  if (!known.has(projectId)) known.set(projectId, load(projectId));
  return known.get(projectId)!;
}

function update(projectId: string | null, change: (records: SeenRecords) => SeenRecords) {
  const records = seenRecords(projectId);
  if (!projectId || !records) return;
  const next = change(records);
  if (next === records) return;
  known.set(projectId, next);
  try {
    localStorage.setItem(KEY + projectId, JSON.stringify(next));
  } catch {
    // The marks still apply for this session.
  }
  version++;
  for (const run of subscribers) run();
}

/** Activity after the viewer last saw the session, or a manual mark; no record is read. */
export const isUnread = (record: SeenRecord | undefined, session: WorkbenchSession): boolean =>
  !!record &&
  (record.manual_unread || Date.parse(session.last_activity_at) > Date.parse(record.seen_at));

/** Whether each of the project's sessions is unread by its stored record, read at each call. */
export const storedUnread =
  (projectId: string | null) =>
  (session: WorkbenchSession): boolean =>
    isUnread(seenRecords(projectId)?.[session.id], session);

const seen = (session: WorkbenchSession, manual_unread: boolean): SeenRecord => ({
  seen_at: session.last_activity_at,
  manual_unread,
});

const same = (a: SeenRecord | undefined, b: SeenRecord) =>
  a?.seen_at === b.seen_at && a.manual_unread === b.manual_unread;

/** Unread until the session is opened again. */
export const markUnread = (projectId: string | null, session: WorkbenchSession) =>
  update(projectId, (records) => ({
    ...records,
    [session.id]: {
      seen_at: records[session.id]?.seen_at ?? session.last_activity_at,
      manual_unread: true,
    },
  }));

export const markRead = (projectId: string | null, session: WorkbenchSession) =>
  update(projectId, (records) =>
    same(records[session.id], seen(session, false))
      ? records
      : { ...records, [session.id]: seen(session, false) },
  );

// Another window stored marks: they are read again.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(KEY)) return;
    known.delete(e.key.slice(KEY.length));
    version++;
    for (const run of subscribers) run();
  });

const subscribe = (run: () => void) => {
  subscribers.add(run);
  return () => subscribers.delete(run);
};
const snapshot = () => version;

/** The project's records, read again whenever a mark changes. */
export function useSeenRecords(projectId: string | null): SeenRecords | null {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return seenRecords(projectId);
}

const windowFocused = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Whether each of the project's sessions is unread. A session first listed counts as read; the
 * shown session is kept read while the window has focus, and showing it again clears a manual mark.
 */
export function useUnread(
  projectId: string | null,
  sessions: readonly WorkbenchSession[] | null,
  shownId: string | null,
): (session: WorkbenchSession) => boolean {
  useSeenRecords(projectId);
  const [focused, setFocused] = useState(() => typeof document !== 'undefined' && windowFocused());
  // The project, session and opening last marked read while shown; showing another one opens it.
  const opened = useRef<string | null>(null);
  // An opening counts only for the pane it opened; the other pane of two keeps its place.
  const openings = useShell((s) => (s.sessionId === shownId ? s.sessionOpened : -1));
  const shown = sessions?.find((s) => s.id === shownId) ?? null;

  useEffect(() => {
    const check = () => setFocused(windowFocused());
    // visibilitychange bubbles from the document to the window.
    const kinds = ['focus', 'blur', 'visibilitychange'];
    for (const kind of kinds) window.addEventListener(kind, check);
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, check);
    };
  }, []);

  useEffect(() => {
    if (!sessions) return;
    update(projectId, (records) => {
      const next: Record<string, SeenRecord> = {};
      for (const s of sessions) next[s.id] = records[s.id] ?? seen(s, false);
      const ids = Object.keys(records);
      return ids.length === sessions.length && ids.every((id) => id in next) ? records : next;
    });
  }, [projectId, sessions]);

  useEffect(() => {
    // Showing a session again after none was shown opens it.
    if (!shown) opened.current = null;
    if (!shown || !focused) return;
    const place = `${projectId}:${shown.id}:${openings}`;
    const opening = opened.current !== place;
    opened.current = place;
    update(projectId, (records) => {
      const was = records[shown.id];
      const now = seen(shown, !opening && (was?.manual_unread ?? false));
      return same(was, now) ? records : { ...records, [shown.id]: now };
    });
  }, [projectId, shown?.id, shown?.last_activity_at, focused, openings]);

  const stored = storedUnread(projectId);
  return (session) => {
    const record = seenRecords(projectId)?.[session.id];
    if (session.id === shown?.id && focused && !record?.manual_unread) return false;
    return stored(session);
  };
}
