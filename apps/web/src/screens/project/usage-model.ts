import type { RoleUsage, SessionRole } from '@pantheon/domain';
import type { ProjectUsageDaily } from '@pantheon/protocol';
import { t } from '../../i18n';

/** The roles in stack order, bottom first; each keeps its series colour by this place. */
export const ROLES: readonly SessionRole[] = [
  'user',
  'conductor',
  'spawned',
  'reviewer',
  'baseline',
  'story',
];

// Getters, so each label is read in the language loaded by then.
export const ROLE_LABEL: Record<SessionRole, string> = {
  get user() {
    return t({ id: 'project.usage.role.user', defaultMessage: 'Your sessions' });
  },
  get conductor() {
    return t({ id: 'project.usage.role.conductor', defaultMessage: 'Main agent' });
  },
  get spawned() {
    return t({
      id: 'project.usage.role.spawned',
      defaultMessage: 'Sessions the main agent started',
    });
  },
  get reviewer() {
    return t({ id: 'project.usage.role.reviewer', defaultMessage: 'Review' });
  },
  get baseline() {
    return t({ id: 'project.usage.role.baseline', defaultMessage: 'Baseline' });
  },
  get story() {
    return t({ id: 'project.usage.role.story', defaultMessage: 'Change story' });
  },
};

export const roleColor = (role: SessionRole): string => `var(--series-${ROLES.indexOf(role) + 1})`;

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

const tokens = (row: RoleUsage) => row.input_tokens + row.output_tokens;

/** One bar per role, longest first; cached input is part of input, not extra length. */
export function roleBars(rows: readonly RoleUsage[]): RoleBar[] {
  const max = Math.max(0, ...rows.map(tokens));
  return rows
    .slice()
    .sort((a, b) => tokens(b) - tokens(a) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
    .map((row) => ({
      role: row.role,
      label: ROLE_LABEL[row.role],
      input: max ? row.input_tokens / max : 0,
      output: max ? row.output_tokens / max : 0,
      cached: row.input_tokens ? Math.min(1, (row.cached_input_tokens ?? 0) / row.input_tokens) : 0,
      row,
    }));
}

/** Input plus output tokens, or turns. */
export type UsageMetric = 'tokens' | 'turns';

export const metricValue = (row: RoleUsage, metric: UsageMetric): number =>
  metric === 'tokens' ? tokens(row) : row.turns;

export interface StackPart {
  role: SessionRole;
  value: number;
}

export interface StackDay {
  day: string;
  /** Bottom first; roles without a value that day are left out. */
  parts: StackPart[];
  total: number;
}

/** Each day's use stacked by role, in the order the daemon gives the days. */
export function dailyStack(daily: ProjectUsageDaily, metric: UsageMetric): StackDay[] {
  return daily.days.map(({ date, roles }) => {
    const parts = ROLES.flatMap((role): StackPart[] => {
      const row = roles.find((r) => r.role === role);
      const value = row ? metricValue(row, metric) : 0;
      return value > 0 ? [{ role, value }] : [];
    });
    return { day: date, parts, total: parts.reduce((sum, p) => sum + p.value, 0) };
  });
}

/** Turns over all the days whose runtime reported no tokens. */
export const unreportedTurns = (daily: ProjectUsageDaily): number =>
  daily.days.reduce(
    (sum, day) => sum + day.roles.reduce((n, row) => n + row.turns_without_usage, 0),
    0,
  );

/** A y axis from 0 with about four whole-number steps that covers `max`. */
export function niceScale(max: number): { max: number; step: number } {
  if (max <= 0) return { max: 4, step: 1 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nm = raw / mag;
  const step = Math.max(1, Math.round((nm <= 1 ? 1 : nm <= 2 ? 2 : nm <= 5 ? 5 : 10) * mag));
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}

export function scaleSteps(scale: { max: number; step: number }): number[] {
  const values: number[] = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) values.push(v);
  return values;
}
