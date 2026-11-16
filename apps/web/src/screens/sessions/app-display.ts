import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { toolState, type ToolItem, type ToolState, type Transcript } from '../../data/transcript';

export type AppMode = 'inline' | 'pip' | 'fullscreen';

/** The one interface of a session that shows outside the conversation. */
export interface AppPlace {
  call: string;
  mode: 'pip' | 'fullscreen';
  /** A docked interface put back in the conversation; the session bar's switch docks it again. */
  hidden?: boolean;
  /** Full screen opened from the dock goes back to it. */
  back?: 'pip';
}

/** By session id. */
export type AppPlaces = Readonly<Record<string, AppPlace>>;

const without = (places: AppPlaces, session: string): AppPlaces => {
  const { [session]: _gone, ...rest } = places;
  return rest;
};

/** Shows the call's interface in mode; any other interface of the session goes back inline. */
export function placeApp(
  places: AppPlaces,
  session: string,
  call: string,
  mode: AppMode,
): AppPlaces {
  const now = places[session];
  if (mode === 'inline') return now?.call === call ? without(places, session) : places;
  if (mode === 'pip') return { ...places, [session]: { call, mode } };
  const docked = now?.call === call && now.mode === 'pip' && !now.hidden;
  return { ...places, [session]: { call, mode, ...(docked && { back: 'pip' as const }) } };
}

/** The session bar's switch: hides the docked interface, or docks it again. */
export function toggleDock(places: AppPlaces, session: string): AppPlaces {
  const now = places[session];
  if (now?.mode !== 'pip') return places;
  return {
    ...places,
    [session]: { call: now.call, mode: 'pip', ...(!now.hidden && { hidden: true }) },
  };
}

/** Escape leaves full screen for where it was opened from; any other key changes nothing. */
export function escapeFullscreen(places: AppPlaces, session: string, key: string): AppPlaces {
  const now = places[session];
  if (key !== 'Escape' || now?.mode !== 'fullscreen') return places;
  return now.back
    ? { ...places, [session]: { call: now.call, mode: 'pip' } }
    : without(places, session);
}

export function appModeOf(places: AppPlaces, session: string, call: string): AppMode {
  const now = places[session];
  return now?.call === call && !now.hidden ? now.mode : 'inline';
}

/** A tool call with an interface and how far it got. */
export interface AppCall {
  item: ToolItem;
  state: ToolState;
}

/** The session's calls with an interface, in thread order. */
export function appCallsOf(view: Transcript): AppCall[] {
  const calls = view.turns.flatMap((turn) => {
    const ended = turn.end !== null || !['running', 'queued'].includes(turn.turn.state);
    return turn.items.flatMap((item) =>
      item.kind === 'tool' && item.app ? [{ item, state: toolState(item, ended) }] : [],
    );
  });
  for (const item of view.loose.items)
    if (item.kind === 'tool' && item.app) calls.push({ item, state: toolState(item, true) });
  return calls;
}

const NO_CALLS: readonly AppCall[] = [];

interface AppDisplay {
  places: AppPlaces;
  /** Each session's calls with an interface, as its thread last read them. */
  calls: Readonly<Record<string, readonly AppCall[]>>;
  /** How often each call's interface was reloaded; a new count loads it again. */
  reloads: Readonly<Record<string, number>>;
  /** The session whose dock and full screen the sessions screen shows. */
  hosted: string | null;
  place(session: string, call: string, mode: AppMode): void;
  toggleDock(session: string): void;
  escape(session: string, key: string): boolean;
  reload(call: string): void;
  setCalls(session: string, calls: readonly AppCall[]): void;
  host(session: string | null): void;
}

export const appDisplay = create<AppDisplay>((set, get) => ({
  places: {},
  calls: {},
  reloads: {},
  hosted: null,
  place: (session, call, mode) => set({ places: placeApp(get().places, session, call, mode) }),
  toggleDock: (session) => set({ places: toggleDock(get().places, session) }),
  escape: (session, key) => {
    const places = escapeFullscreen(get().places, session, key);
    if (places === get().places) return false;
    set({ places });
    return true;
  },
  reload: (call) => set({ reloads: { ...get().reloads, [call]: (get().reloads[call] ?? 0) + 1 } }),
  setCalls: (session, calls) => {
    const before = get().calls[session] ?? NO_CALLS;
    const same =
      before.length === calls.length &&
      before.every((c, i) => c.item === calls[i]!.item && c.state === calls[i]!.state);
    if (!same) set({ calls: { ...get().calls, [session]: calls } });
  },
  host: (session) => set({ hosted: session }),
}));

/** A value of the display state, read again when the state changes; select returns held values. */
export function useAppDisplay<T>(select: (state: AppDisplay) => T): T {
  const read = () => select(appDisplay.getState());
  return useSyncExternalStore(appDisplay.subscribe, read, read);
}
