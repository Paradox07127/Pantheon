import { useSyncExternalStore } from 'react';
import type { InsightsSection } from '../insights/InsightsScreen';
import type { OverviewSection } from './BoardScreen';

export type PanelSpan = 6 | 12;
/** Auto keeps the panel's own height; S, M and L cap its body (board.css). */
export type PanelHeight = 'auto' | 'S' | 'M' | 'L';
export interface PanelPlace {
  key: string;
  span: PanelSpan;
  height: PanelHeight;
  hidden: boolean;
}
/** Each tab's panels in the order they show, the project board's and the engineering board's. */
export type BoardLayout = Record<OverviewSection | InsightsSection, PanelPlace[]>;

const SPANS: readonly unknown[] = [6, 12];
const HEIGHTS: readonly unknown[] = ['auto', 'S', 'M', 'L'];

const places = (...list: [string, PanelSpan][]): PanelPlace[] =>
  list.map(([key, span]) => ({ key, span, height: 'auto', hidden: false }));

export const DEFAULT_LAYOUT: BoardLayout = {
  progress: places(['main', 12], ['table', 12], ['trend', 6], ['cycle', 6], ['stall', 12]),
  milestones: places(['milestones', 12], ['risks', 12]),
  iterations: places(['iterations', 12]),
  collab: places(['collab', 12]),
  workflow: places(['workflow', 12]),
  quality: places(
    ['qualityKpis', 12],
    ['qualityTrend', 12],
    ['qualityCycle', 6],
    ['mergesPerDay', 6],
    ['gateFailures', 12],
    ['findings', 6],
    ['matrix', 6],
    ['merges', 12],
    ['gates', 12],
  ),
  usage: places(['quota', 12], ['runtime', 12], ['usage', 12], ['roles', 12]),
  digest: places(['digest', 12]),
  signals: places(['signals', 12]),
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The stored layout over the defaults: stored order first, new panels after, anything unreadable from the defaults. */
export function mergeLayout(stored: unknown, defaults: BoardLayout): BoardLayout {
  const tabs = record(stored);
  const merged = {} as BoardLayout;
  for (const [tab, base] of Object.entries(defaults) as [keyof BoardLayout, PanelPlace[]][]) {
    const list = tabs && Array.isArray(tabs[tab]) ? (tabs[tab] as unknown[]) : [];
    const out: PanelPlace[] = [];
    for (const item of list) {
      const raw = record(item);
      const fallback = raw && base.find((p) => p.key === raw.key);
      if (!raw || !fallback || out.some((p) => p.key === fallback.key)) continue;
      out.push({
        key: fallback.key,
        span: SPANS.includes(raw.span) ? (raw.span as PanelSpan) : fallback.span,
        height: HEIGHTS.includes(raw.height) ? (raw.height as PanelHeight) : fallback.height,
        hidden: typeof raw.hidden === 'boolean' ? raw.hidden : fallback.hidden,
      });
    }
    merged[tab] = [...out, ...base.filter((p) => !out.some((o) => o.key === p.key))];
  }
  return merged;
}

const tabOf = (layout: BoardLayout, key: string) =>
  (Object.keys(layout) as (keyof BoardLayout)[]).find((tab) =>
    layout[tab].some((p) => p.key === key),
  );

function update(layout: BoardLayout, key: string, patch: Partial<PanelPlace>): BoardLayout {
  const tab = tabOf(layout, key);
  if (!tab) return layout;
  return { ...layout, [tab]: layout[tab].map((p) => (p.key === key ? { ...p, ...patch } : p)) };
}

/** Moves a panel before the shown panel above it or after the one below; at either end it stays. */
export function movePanel(layout: BoardLayout, key: string, step: -1 | 1): BoardLayout {
  const tab = tabOf(layout, key);
  if (!tab) return layout;
  const list = layout[tab];
  const from = list.findIndex((p) => p.key === key);
  let to = from + step;
  while (to >= 0 && to < list.length && list[to]!.hidden) to += step;
  if (to < 0 || to >= list.length) return layout;
  const next = list.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return { ...layout, [tab]: next };
}

export const setSpan = (layout: BoardLayout, key: string, span: PanelSpan) =>
  update(layout, key, { span });
export const setHeight = (layout: BoardLayout, key: string, height: PanelHeight) =>
  update(layout, key, { height });
export const setHidden = (layout: BoardLayout, key: string, hidden: boolean) =>
  update(layout, key, { hidden });

/* Storage */

const layoutKey = (projectId: string) => `pantheon.board.layout.${projectId}`;

// The layout changed on each project's board while the app runs.
let held: Readonly<Record<string, BoardLayout>> = {};
// The last read per project, so an unchanged stored value reads back as the same layout.
const lastRead = new Map<string, { raw: string | null; layout: BoardLayout }>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function storedLayout(projectId: string): BoardLayout {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(layoutKey(projectId));
  } catch {
    // Without storage the defaults apply.
  }
  const last = lastRead.get(projectId);
  if (last && last.raw === raw) return last.layout;
  let value: unknown = null;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    // An unreadable value is no stored layout.
  }
  const layout = mergeLayout(value, DEFAULT_LAYOUT);
  lastRead.set(projectId, { raw, layout });
  return layout;
}

export function readLayout(projectId: string): BoardLayout {
  return held[projectId] ?? storedLayout(projectId);
}

export function saveLayout(projectId: string, layout: BoardLayout) {
  held = { ...held, [projectId]: layout };
  listeners.forEach((listener) => listener());
  try {
    localStorage.setItem(layoutKey(projectId), JSON.stringify(layout));
  } catch {
    // The layout still holds until the app closes.
  }
}

/** The project's board layout; the defaults without a project. */
export function useBoardLayout(projectId: string | undefined): BoardLayout {
  const read = () => (projectId ? readLayout(projectId) : DEFAULT_LAYOUT);
  return useSyncExternalStore(subscribe, read, read);
}

/* Moving a key within an order */

/** Moves `key` to just before `before`, or to the end when `before` is null. */
export function moveBefore(order: readonly string[], key: string, before: string | null): string[] {
  const rest = order.filter((k) => k !== key);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** Moves `key` past its neighbour in `shown` towards `step`; at either end it stays. */
export function stepKey(
  order: readonly string[],
  shown: readonly string[],
  key: string,
  step: -1 | 1,
): string[] {
  const next = shown[shown.indexOf(key) + step];
  if (next === undefined) return [...order];
  if (step < 0) return moveBefore(order, key, next);
  const rest = order.filter((k) => k !== key);
  return [...rest.slice(0, rest.indexOf(next) + 1), key, ...rest.slice(rest.indexOf(next) + 1)];
}
