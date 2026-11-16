import type { QuotaWindow, RoleUsage, SessionRole } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import { runtimeColor } from '../../components/RuntimeGlyph';
import { t } from '../../i18n';
import { compareRuntimes, seriesOf, tokenText, usageSeries, type UsageFill } from './panels-model';

/* Usage stack */

export type UsageMetric = 'tokens' | 'cost';
/** Diagonal stripes over the runtime color; null draws the plain color. */
export type UsageHatch = 'fwd' | 'back' | null;

export interface StackSeries {
  key: string;
  runtime: string;
  label: string;
  color: string;
  hatch: UsageHatch;
}
export interface StackPart {
  series: StackSeries;
  value: number;
  tokens: number;
  cost_usd: number | null;
}
export interface StackDay {
  day: string;
  /** Bottom first; parts without a value are left out. */
  parts: StackPart[];
  total: number;
  /** Keys of the series used that day whose cost is not known; empty for tokens. */
  unknown: string[];
  /** Sessions that reported no tokens that day, counted once per runtime and model. */
  unreported: number;
}

const HATCH: Record<UsageFill, UsageHatch> = { solid: null, hatch: 'fwd', other: 'back' };

const addCost = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : a + b);

/** Each day's usage stacked by runtime, then by model in first-use order. */
export function usageStack(
  model: Pick<BoardModel, 'usage' | 'models'>,
  metric: UsageMetric,
): { series: StackSeries[]; days: StackDay[] } {
  const known = usageSeries(model.models);
  const byDay = new Map<string, Map<string, { tokens: number; cost_usd: number | null }>>();
  const unreported = new Map<string, number>();
  // Series keys by day with a row of unknown cost; the part keeps the sum of the known ones.
  const unknownCost = new Map<string, Set<string>>();
  const found = new Map<string, Omit<StackSeries, 'color'>>();
  for (const row of model.usage) {
    if (row.sessions_without_usage)
      unreported.set(row.day, (unreported.get(row.day) ?? 0) + row.sessions_without_usage);
    const s = seriesOf(known, row.runtime, row.model);
    if (!found.has(s.key))
      found.set(s.key, { key: s.key, runtime: s.runtime, label: s.label, hatch: HATCH[s.fill] });
    const parts = byDay.get(row.day) ?? new Map();
    byDay.set(row.day, parts);
    const part = parts.get(s.key) ?? { tokens: 0, cost_usd: null };
    part.tokens += row.tokens;
    part.cost_usd = addCost(part.cost_usd, row.cost_usd);
    parts.set(s.key, part);
    if (row.cost_usd === null)
      unknownCost.set(row.day, (unknownCost.get(row.day) ?? new Set()).add(s.key));
  }
  const rank = (s: Omit<StackSeries, 'color'>) => {
    const i = known.findIndex((k) => k.key === s.key);
    return i < 0 ? known.length : i;
  };
  const ordered = [...found.values()].sort(
    (a, b) => compareRuntimes(a.runtime, b.runtime) || rank(a) - rank(b),
  );
  const all: StackSeries[] = ordered.map((s) => ({ ...s, color: runtimeColor(s.runtime) }));
  // The chart spaces days evenly, so a day without usage between used days stays on the axis.
  const used = [...byDay.keys()].sort();
  for (let at = used[0]; at !== undefined && at < used[used.length - 1]!;) {
    const [y, m, d] = at.split('-').map(Number);
    const next = new Date(y!, m! - 1, d! + 1);
    at = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    if (!byDay.has(at)) byDay.set(at, new Map());
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, parts]) => {
      const list = all.flatMap((series): StackPart[] => {
        const part = parts.get(series.key);
        if (!part) return [];
        if (metric === 'tokens')
          return part.tokens > 0 ? [{ ...part, series, value: part.tokens }] : [];
        return part.cost_usd == null ? [] : [{ ...part, series, value: part.cost_usd }];
      });
      const unknown =
        metric === 'cost'
          ? all.filter((s) => unknownCost.get(day)?.has(s.key)).map((s) => s.key)
          : [];
      return {
        day,
        parts: list,
        total: list.reduce((sum, p) => sum + p.value, 0),
        unknown,
        unreported: unreported.get(day) ?? 0,
      };
    });
  const shown = new Set(days.flatMap((d) => [...d.parts.map((p) => p.series.key), ...d.unknown]));
  return { series: all.filter((s) => shown.has(s.key)), days };
}

/**
 * One series' value on a day, or the day's total without a key: null where only unknown costs make
 * it up; a series without usage that day is 0.
 */
export function stackValue(day: StackDay, key?: string): number | null {
  if (key === undefined) return day.parts.length || !day.unknown.length ? day.total : null;
  const part = day.parts.find((p) => p.series.key === key);
  return part ? part.value : day.unknown.includes(key) ? null : 0;
}

/* Key figures */

export interface Kpi {
  value: number | null;
  /** Change against the same number of days before the range, 1 = +100%; null without usage there. */
  change: number | null;
  /** One value per day of the range, oldest first. */
  bars: number[];
}
export interface UsageKpis {
  /** The range's days, oldest first; the last is today. */
  days: string[];
  tokens: Kpi;
  /** Only known costs count; null when none is known. */
  cost: Kpi;
  /** Tokens per calendar day of the range. */
  daily: Kpi;
  /** The runtime with the most tokens in the range and its tokens; null without usage. */
  runtime: Kpi & { runtime: string | null };
}

type UsageRow = BoardModel['usage'][number];

export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const change = (now: number | null, before: number | null) =>
  now == null || !before ? null : (now - before) / before;

/** The local days from the model's first day through the day of `now`, oldest first. */
export function rangeDays(model: Pick<BoardModel, 'since' | 'now'>): string[] {
  const last = localDay(new Date(model.now));
  const days: string[] = [];
  for (let d = new Date(model.since); days.length === 0 || days[days.length - 1]! < last;) {
    days.push(localDay(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return days;
}

/** The figure of the same number of days before a range of 1, 7 or 30 days; nothing without it. */
export function previousText(days: number, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (days === 1)
    return t({ id: 'board.previous.yesterday', defaultMessage: 'Yesterday {value}' }, { value });
  if (days === 7)
    return t({ id: 'board.previous.lastWeek', defaultMessage: 'Last week {value}' }, { value });
  if (days === 30)
    return t(
      { id: 'board.previous.days', defaultMessage: 'Previous {days} days {value}' },
      { days, value },
    );
  return undefined;
}

/** The usage page's key figures over the board's range, each against the days before it. */
export function kpis(model: Pick<BoardModel, 'usage' | 'since' | 'now' | 'counts'>): UsageKpis {
  const days = rangeDays(model);
  const last = days[days.length - 1]!;
  const first = days[0]!;
  const start = new Date(model.since);
  const before = localDay(
    new Date(start.getFullYear(), start.getMonth(), start.getDate() - days.length),
  );
  const current = model.usage.filter((u) => u.day >= first && u.day <= last);
  const previous = model.usage.filter((u) => u.day >= before && u.day < first);
  const sum = (rows: UsageRow[], pick: (u: UsageRow) => number) =>
    rows.reduce((n, u) => n + pick(u), 0);
  const perDay = (rows: UsageRow[], pick: (u: UsageRow) => number) =>
    days.map((day) =>
      sum(
        rows.filter((u) => u.day === day),
        pick,
      ),
    );
  const knownCost = (rows: UsageRow[]) =>
    rows.some((u) => u.cost_usd != null) ? sum(rows, (u) => u.cost_usd ?? 0) : null;
  const tokens = (u: UsageRow) => u.tokens;
  const seen = previous.length > 0;

  const nowTokens = sum(current, tokens);
  const nowCost = knownCost(current);
  const byRuntime = new Map<string, number>();
  for (const u of current) byRuntime.set(u.runtime, (byRuntime.get(u.runtime) ?? 0) + u.tokens);
  const [busiest] = [...byRuntime.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || compareRuntimes(a, b));
  const ofBusiest = (rows: UsageRow[]) => rows.filter((u) => u.runtime === busiest?.[0]);
  return {
    days,
    tokens: {
      value: nowTokens,
      change: change(nowTokens, model.counts.previous?.tokens ?? 0),
      bars: perDay(current, tokens),
    },
    cost: {
      value: nowCost,
      change: change(nowCost, model.counts.previous?.cost_usd ?? null),
      bars: perDay(current, (u) => u.cost_usd ?? 0),
    },
    daily: {
      value: nowTokens / days.length,
      change: change(nowTokens / days.length, (model.counts.previous?.tokens ?? 0) / days.length),
      bars: perDay(current, tokens),
    },
    runtime: {
      runtime: busiest?.[0] ?? null,
      value: busiest?.[1] ?? null,
      change: busiest && seen ? change(busiest[1], sum(ofBusiest(previous), tokens)) : null,
      bars: busiest ? perDay(ofBusiest(current), tokens) : days.map(() => 0),
    },
  };
}

/* Usage by role */

// Getters, so each label is read in the language loaded by then.
export const ROLE_LABEL: Record<SessionRole, string> = {
  get reviewer() {
    return t({ id: 'board.usageRoles.reviewer', defaultMessage: 'Review' });
  },
  get baseline() {
    return t({ id: 'board.usageRoles.baseline', defaultMessage: 'Baseline' });
  },
  get story() {
    return t({ id: 'board.usageRoles.story', defaultMessage: 'Change story' });
  },
  get main() {
    return t({ id: 'board.usageRoles.main', defaultMessage: 'Session' });
  },
};

export interface RoleBar {
  role: SessionRole;
  label: string;
  /** Shares of the longest bar. */
  input: number;
  output: number;
  /** Share of the input segment served from cache. */
  cached: number;
  row: RoleUsage;
}

/** One bar per role, longest first; cached input is part of input, not extra length. */
export function roleBars(rows: readonly RoleUsage[]): RoleBar[] {
  const total = (r: RoleUsage) => r.input_tokens + r.output_tokens;
  const max = Math.max(0, ...rows.map(total));
  return rows
    .slice()
    .sort((a, b) => total(b) - total(a))
    .map((row) => ({
      role: row.role,
      label: ROLE_LABEL[row.role],
      input: max ? row.input_tokens / max : 0,
      output: max ? row.output_tokens / max : 0,
      cached: row.input_tokens ? Math.min(1, (row.cached_input_tokens ?? 0) / row.input_tokens) : 0,
      row,
    }));
}

/* Usage rings */

export const RING_RUNTIMES = ['claude', 'codex'] as const;

/**
 * A ring for each runtime that used tokens, in table order; the always listed runtimes that used
 * none and those whose sessions reported none are named apart, without a ring.
 */
export function ringRuntimes(
  tokensByRuntime: Readonly<Record<string, number>>,
  unreportedByRuntime: Readonly<Record<string, number>>,
): { rings: string[]; unused: string[]; unreported: string[] } {
  const used = (runtime: string) => (tokensByRuntime[runtime] ?? 0) > 0;
  const unreported = Object.keys(unreportedByRuntime).filter(
    (runtime) => !used(runtime) && unreportedByRuntime[runtime]! > 0,
  );
  return {
    rings: Object.keys(tokensByRuntime).filter(used).sort(compareRuntimes),
    unused: RING_RUNTIMES.filter((runtime) => !used(runtime) && !unreported.includes(runtime)),
    unreported: unreported.sort(compareRuntimes),
  };
}
/** Share of an open ring left out at the top. */
export const RING_GAP = 0.1;

export interface UsageRing {
  open: boolean;
  /** Where the arc starts and how much of the circle it covers, clockwise from the top. */
  start: number;
  sweep: number;
  text: string;
}

/**
 * With a target the ring fills to used / target; without one it is an open ring with the value,
 * empty at 0. Sessions that reported no tokens make the value a known part, or unknown without any.
 */
export function usageRing(used: number, target: number | null, unreported: number): UsageRing {
  const plus = unreported > 0 ? '+' : '';
  if (target && target > 0)
    return {
      open: false,
      start: 0,
      sweep: Math.min(1, used / target),
      text:
        plus && !used
          ? t({ id: 'board.usageRing.unreported', defaultMessage: 'Not reported' })
          : `${Math.round((used / target) * 100)}%${plus}`,
    };
  return {
    open: true,
    start: RING_GAP / 2,
    sweep: used > 0 ? 1 - RING_GAP : 0,
    text:
      plus && !used
        ? t({ id: 'board.usageRing.unreported', defaultMessage: 'Not reported' })
        : `${tokenText(used)}${plus}`,
  };
}

/* Subscription quota */

export const quotaWindowName = (window: string) => {
  if (window === 'five_hour')
    return t({ id: 'settings.harness.quota.fiveHour', defaultMessage: '5 hours' });
  if (window === 'seven_day')
    return t({ id: 'settings.harness.quota.sevenDay', defaultMessage: '7 days' });
  return window;
};

/** The used share kept within 0 to 100, for the bar. */
export const quotaUsed = (w: QuotaWindow) => Math.min(Math.max(w.used_percent, 0), 100);

/** The window's name and, while it is ahead, how long until it resets. */
export function quotaWindowText(w: QuotaWindow, now: number): string {
  const minutes = w.resets_at === undefined ? 0 : Math.ceil((w.resets_at - now) / 60_000);
  return minutes > 0
    ? t(
        {
          id: 'insights.quota.resets',
          defaultMessage:
            '{window} window, resets in {hours, plural, =0 {} other {# h }}{minutes} min',
        },
        {
          window: quotaWindowName(w.window),
          hours: Math.floor(minutes / 60),
          minutes: minutes % 60,
        },
      )
    : t(
        { id: 'insights.quota.window', defaultMessage: '{window} window' },
        { window: quotaWindowName(w.window) },
      );
}

/* Usage targets */

export type UsageTargets = Partial<Record<string, number>>;

/** A typed target: null when empty, undefined when not a whole positive number. */
export function parseUsageTarget(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  const target = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(target) && target > 0 ? target : undefined;
}
