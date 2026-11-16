import { useSyncExternalStore } from 'react';

export const SESSION_DISPLAY_KEY = 'pantheon.session-display.v1';

/** Which state glyphs keep their looping motion: all, only those waiting on the user, or none. */
export type StateMotion = 'all' | 'waiting' | 'off';
/** The session timeline: marks with their labels, the marks alone, or none. */
export type TimelineShow = 'labels' | 'marks' | 'off';
/** How a session's overview card first shows: open, folded to its header, or hidden. */
export type OverviewStart = 'open' | 'folded' | 'off';
/** What the send key does while a turn runs: queue the message, or steer the turn with it. */
export type RunningSend = 'queue' | 'steer';
/** Vendor marks in their own colours or in the text colour. */
export type VendorMarks = 'brand' | 'mono';

/** What a session's page shows and how, chosen in Session display. */
export interface SessionDisplay {
  state_motion: StateMotion;
  timeline: TimelineShow;
  overview: OverviewStart;
  /** The plan strip along the bottom of the session bar. */
  plan_bar: boolean;
  running_send: RunningSend;
  /** The model's reasoning blocks in the thread. */
  reasoning: boolean;
  vendor_marks: VendorMarks;
  /** The context ring, the context section of the overview and the token row of the session bar. */
  context_usage: boolean;
}

export const DEFAULT_SESSION_DISPLAY: SessionDisplay = {
  state_motion: 'all',
  timeline: 'labels',
  overview: 'open',
  plan_bar: true,
  running_send: 'queue',
  reasoning: true,
  vendor_marks: 'brand',
  context_usage: true,
};

const STATE_MOTIONS: readonly StateMotion[] = ['all', 'waiting', 'off'];
const TIMELINES: readonly TimelineShow[] = ['labels', 'marks', 'off'];
const OVERVIEWS: readonly OverviewStart[] = ['open', 'folded', 'off'];

const parse = (raw: string | null): unknown => {
  try {
    return JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
};

export function readSessionDisplay(raw: string | null): SessionDisplay {
  const value = parse(raw) as {
    state_motion?: unknown;
    timeline?: unknown;
    overview?: unknown;
    plan_bar?: unknown;
    running_send?: unknown;
    reasoning?: unknown;
    vendor_marks?: unknown;
    context_usage?: unknown;
  } | null;
  return {
    state_motion: STATE_MOTIONS.find((m) => m === value?.state_motion) ?? 'all',
    timeline: TIMELINES.find((m) => m === value?.timeline) ?? 'labels',
    overview: OVERVIEWS.find((m) => m === value?.overview) ?? 'open',
    plan_bar: value?.plan_bar !== false,
    running_send: value?.running_send === 'steer' ? 'steer' : 'queue',
    reasoning: value?.reasoning !== false,
    vendor_marks: value?.vendor_marks === 'mono' ? 'mono' : 'brand',
    context_usage: value?.context_usage !== false,
  };
}

/** Sets the state glyphs' motion on the body's data attributes, where the stylesheet reads it. */
export function applySessionDisplay(
  display: SessionDisplay,
  dataset: Record<string, string | undefined>,
) {
  dataset.stateMotion = display.state_motion;
}

function loadSessionDisplay(): SessionDisplay {
  try {
    return readSessionDisplay(localStorage.getItem(SESSION_DISPLAY_KEY));
  } catch {
    return DEFAULT_SESSION_DISPLAY;
  }
}

let display = loadSessionDisplay();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getSessionDisplay = () => display;

export function setSessionDisplay(patch: Partial<SessionDisplay>) {
  display = { ...display, ...patch };
  listeners.forEach((listener) => listener());
  try {
    localStorage.setItem(SESSION_DISPLAY_KEY, JSON.stringify(display));
  } catch {
    // The choice still applies for this session.
  }
}

export function useSessionDisplay(): SessionDisplay {
  return useSyncExternalStore(subscribe, getSessionDisplay, getSessionDisplay);
}

// Another window stored a change: this one follows it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_DISPLAY_KEY) return;
    display = readSessionDisplay(e.newValue);
    listeners.forEach((listener) => listener());
  });
