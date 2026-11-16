import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { RoleUsage } from '@pantheon/domain';
import type { BoardModel, RuntimeStatus } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { currentProject, useCurrentProject } from '../../data/current-project';
import { useNow } from '../../data/needs-you';
import { useRuntimeStatus } from '../../data/runtime-status';
import { sessionTitle } from '../../data/transcript';
import { useQuery } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import {
  DataTable,
  Empty,
  niceScale,
  Panel,
  runtimeColor,
  scaleSteps,
  useFloatTip,
  useSize,
  ViewToggle,
  type TipContent,
} from './Charts';
import { compareRuntimes, runtimeName, tokenText, usdText } from './panels-model';
import { dayTick } from './progress-model';
import { QueryBody, useKindTick } from './Tables';
import {
  RING_GAP,
  quotaUsed,
  quotaWindowText,
  ringRuntimes,
  roleBars,
  usageRing,
  usageStack,
  stackValue,
  type StackDay,
  type StackPart,
  type StackSeries,
  type UsageMetric,
  type UsageTargets,
} from './usage-model';
import './usage.css';
import './repo.css';

/* Usage rings */

const RING = { size: 132, r: 52, stroke: 12 };

function UsageRing({
  runtime,
  used,
  target,
  unreported,
}: {
  runtime: string;
  used: number;
  target: number | null;
  unreported: number;
}) {
  const ring = usageRing(used, target, unreported);
  const name = runtimeName(runtime);
  const c = RING.size / 2;
  const around = 2 * Math.PI * RING.r;
  const arc = (start: number, sweep: number, className: string) => (
    <circle
      className={className}
      cx={c}
      cy={c}
      r={RING.r}
      strokeWidth={RING.stroke}
      strokeDasharray={`${sweep * around} ${around}`}
      transform={`rotate(${start * 360 - 90} ${c} ${c})`}
    />
  );
  return (
    <figure className="us-ring">
      <svg
        width={RING.size}
        height={RING.size}
        role="img"
        aria-label={
          ring.open || (unreported > 0 && !used)
            ? `${name} ${ring.text}`
            : t(
                {
                  id: 'board.usage.ringLabel',
                  defaultMessage: '{runtime} {used} / {target}, {share}',
                },
                {
                  runtime: name,
                  used: `${tokenText(used)}${unreported > 0 ? '+' : ''}`,
                  target: tokenText(target!),
                  share: ring.text,
                },
              )
        }
        style={{ color: runtimeColor(runtime) }}
      >
        {ring.open ? arc(RING_GAP / 2, 1 - RING_GAP, 'us-rtrk') : arc(0, 1, 'us-rtrk')}
        {ring.sweep > 0 && arc(ring.start, ring.sweep, 'us-rarc')}
        <text className="us-rv" x={c} y={c} textAnchor="middle" dominantBaseline="central">
          {ring.text}
        </text>
      </svg>
      <figcaption className="us-rn">{name}</figcaption>
    </figure>
  );
}

/** `targets` are the project's token targets by runtime. */
export function UsageRings({ model, targets = {} }: { model: BoardModel; targets?: UsageTargets }) {
  const unreported = model.counts.sessions_without_usage_by_runtime ?? {};
  const runtimes = ringRuntimes(model.counts.tokens_by_runtime, unreported);
  const names = (list: string[]) => listText(...list.map(runtimeName));
  const quiet = listText(
    runtimes.unused.length > 0 &&
      t(
        { id: 'board.usage.unusedRuntimes', defaultMessage: 'No usage: {runtimes}' },
        { runtimes: names(runtimes.unused) },
      ),
    runtimes.unreported.length > 0 &&
      t(
        { id: 'board.usage.unreportedRuntimes', defaultMessage: 'Usage not reported: {runtimes}' },
        { runtimes: names(runtimes.unreported) },
      ),
  );
  return (
    <Panel title={t({ id: 'board.usage.byRuntime', defaultMessage: 'By runtime, selected range' })}>
      {runtimes.rings.length === 0 ? (
        <Empty text={quiet} />
      ) : (
        <>
          <div className="us-rings">
            {runtimes.rings.map((runtime) => (
              <UsageRing
                key={runtime}
                runtime={runtime}
                used={model.counts.tokens_by_runtime[runtime] ?? 0}
                target={targets[runtime] ?? null}
                unreported={unreported[runtime] ?? 0}
              />
            ))}
          </div>
          {quiet && <p className="us-quiet">{quiet}</p>}
        </>
      )}
    </Panel>
  );
}

/* Subscription quota */

/** A row per runtime that reported quota, by its most used window; nothing when none did. */
export function QuotaBars({ statuses, now }: { statuses: readonly RuntimeStatus[]; now: number }) {
  const rows = statuses
    .flatMap((s) => {
      const windows = s.quota?.windows ?? [];
      if (windows.length === 0) return [];
      const most = windows.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
      return [{ runtime: s.runtime, window: most }];
    })
    .sort((a, b) => compareRuntimes(a.runtime, b.runtime));
  if (rows.length === 0) return null;
  return (
    <Panel title={t({ id: 'insights.quota.title', defaultMessage: 'Subscription quota' })}>
      <div className="us-ql">
        {rows.map(({ runtime, window: w }) => {
          const used = quotaUsed(w);
          return (
            <div className="us-qr" key={runtime}>
              <span className="us-qn">
                <RuntimeGlyph runtime={runtime} size={14} />
                {runtimeName(runtime)}
              </span>
              <span
                className="us-qb"
                role="meter"
                aria-label={t(
                  { id: 'insights.quota.meter', defaultMessage: '{runtime} quota used' },
                  { runtime: runtimeName(runtime) },
                )}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={w.used_percent}
              >
                {used > 0 && (
                  <i style={{ flexGrow: used, backgroundColor: runtimeColor(runtime) }} />
                )}
                {used < 100 && <i style={{ flexGrow: 100 - used }} />}
              </span>
              <span className="us-qp">{`${Math.round(w.used_percent)}%`}</span>
              <span className="us-qt">{quotaWindowText(w, now)}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** The quota the runtime status last reported, as the harness settings show it. */
export function QuotaPanel() {
  const { read } = useRuntimeStatus();
  const now = useNow(60_000);
  return read.state === 'ready' ? <QuotaBars statuses={read.statuses} now={now} /> : null;
}

/* Usage stack */

function Swatch({ series }: { series: Pick<StackSeries, 'color' | 'hatch'> }) {
  return (
    <i
      className={`us-sw${series.hatch ? ` us-sw-${series.hatch}` : ''}`}
      style={{ backgroundColor: series.color }}
    />
  );
}

const metricText = (metric: UsageMetric, value: number) =>
  metric === 'tokens' ? tokenText(value) : usdText(value);
const cellText = (metric: UsageMetric, value: number | null) =>
  value === null ? '—' : metricText(metric, value);
// A token total leaves out the sessions that reported none, so it is only the known part.
const totalText = (metric: UsageMetric, value: number | null, unreported: number) =>
  `${cellText(metric, value)}${metric === 'tokens' && unreported > 0 ? '+' : ''}`;

function StackChart({ days, metric }: { days: StackDay[]; metric: UsageMetric }) {
  const [setBox, size] = useSize();
  const [hover, setHover] = useState<number | null>(null);
  const tip = useFloatTip();
  const patternId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const W = size.w;
  const H = size.h;
  const m = { l: 48, r: 16, t: 8, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = days.length;
  const scale = niceScale(Math.max(...days.map((d) => d.total)), metric === 'tokens');
  const step = pw / n;
  const bw = Math.min(28, step * 0.6);
  const CX = (i: number) => m.l + step * (i + 0.5);
  const Y = (v: number) => m.t + ph - (v / scale.max) * ph;
  const base = Y(0);
  const every = Math.max(1, Math.ceil(44 / step));
  const total = days.reduce((sum, d) => sum + d.total, 0);
  const unreported = days.reduce((sum, d) => sum + d.unreported, 0);
  // A total that leaves unknown costs out is only the known part.
  const totalLabel = (unknown: boolean) =>
    unknown
      ? t({ id: 'board.charts.knownTotal', defaultMessage: 'Known total' })
      : t({ id: 'board.charts.total', defaultMessage: 'Total' });

  const onLeave = () => {
    setHover(null);
    tip.hide();
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = Math.floor((px - m.l) / step);
    const d = days[i];
    if (!d) return onLeave();
    setHover(i);
    const content: TipContent = {
      head: d.day,
      rows: [
        ...d.parts.map((p) => ({
          swatch: <Swatch series={p.series} />,
          label: p.series.label,
          value: `${tokenText(p.tokens)}, ${usdText(p.cost_usd)}`,
        })),
        {
          label: totalLabel(d.parts.length > 0 && d.unknown.length > 0),
          value: totalText(metric, stackValue(d), d.unreported),
        },
      ],
    };
    tip.show(e, content);
  };

  return (
    <div className="bp-chart" ref={setBox}>
      {n > 0 && pw > 0 && ph > 0 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={t(
            {
              id: 'board.usage.stackLabel',
              defaultMessage:
                'Usage, {metric, select, tokens {tokens} other {cost}} per day stacked by runtime, {totalLabel} {total}',
            },
            {
              metric,
              totalLabel: totalLabel(days.some((d) => d.unknown.length > 0)),
              total: totalText(metric, total, unreported),
            },
          )}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
          <defs>
            {(['fwd', 'back'] as const).map((hatch) => (
              <pattern
                key={hatch}
                id={`${patternId}-${hatch}`}
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform={`rotate(${hatch === 'fwd' ? 45 : -45})`}
              >
                <rect width="2.5" height="6" className="us-hatch" />
              </pattern>
            ))}
          </defs>
          {hover != null && (
            <rect className="bp-band on" x={m.l + step * hover} y={m.t} width={step} height={ph} />
          )}
          {scaleSteps(scale).map((v) => (
            <g key={v}>
              <line
                className={v ? 'bp-gln' : 'bp-axl'}
                x1={m.l}
                x2={m.l + pw}
                y1={Y(v)}
                y2={Y(v)}
              />
              <text className="bp-ax" x={m.l - 8} y={Y(v) + 4} textAnchor="end">
                {v ? metricText(metric, v) : 0}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            (n - 1 - i) % every === 0 ? (
              <text key={d.day} className="bp-ax" x={CX(i)} y={base + 16} textAnchor="middle">
                {dayTick(d.day)}
              </text>
            ) : null,
          )}
          {days.map((d, i) => {
            let top = base;
            const x = CX(i) - bw / 2;
            return (
              <g key={d.day}>
                {d.parts.map((p) => {
                  const h = (p.value / scale.max) * ph;
                  top -= h;
                  // A one pixel seam of the surface separates stacked segments.
                  const seam = Math.min(1, h / 2);
                  return (
                    <g key={p.series.key}>
                      <rect
                        x={x}
                        y={top + seam}
                        width={bw}
                        height={h - seam}
                        style={{ fill: p.series.color }}
                      />
                      {p.series.hatch && (
                        <rect
                          x={x}
                          y={top + seam}
                          width={bw}
                          height={h - seam}
                          fill={`url(#${patternId}-${p.series.hatch})`}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          <rect x="0" y="0" width={W} height={H} fill="transparent" />
        </svg>
      )}
      {tip.node}
    </div>
  );
}

// Runtimes past the ones with the most tokens fold into one series.
const SHOWN_RUNTIMES = 2;
const OTHER_KEY = '\u0001other';

/** Each day's usage stacked by runtime; past the two with the most tokens, the rest as one series. */
function runtimeStack(model: BoardModel, metric: UsageMetric) {
  const usage = model.usage.map((u) => ({ ...u, model: null }));
  const stack = usageStack({ usage, models: [] }, metric);
  const totals = new Map<string, number>();
  for (const u of usage) totals.set(u.runtime, (totals.get(u.runtime) ?? 0) + u.tokens);
  const ranked = [...totals].sort(([a, x], [b, y]) => y - x || compareRuntimes(a, b));
  const kept = new Set(
    ranked.length > SHOWN_RUNTIMES
      ? ranked.slice(0, SHOWN_RUNTIMES).map(([r]) => r)
      : totals.keys(),
  );
  const other: StackSeries = {
    key: OTHER_KEY,
    runtime: OTHER_KEY,
    label: t({ id: 'insights.usage.otherRuntimes', defaultMessage: 'Other' }),
    color: 'var(--mu)',
    hatch: null,
  };
  const own = new Map(
    stack.series.map((s) => [s.key, { ...s, label: runtimeName(s.runtime), hatch: null }]),
  );
  const seriesOf = (key: string): StackSeries => {
    const s = own.get(key)!;
    return kept.has(s.runtime) ? s : other;
  };
  const keyOf = new Map(stack.series.map((s) => [s.runtime, s.key]));
  const days: StackDay[] = stack.days.map((d) => {
    const parts: StackPart[] = [];
    for (const p of d.parts) {
      const series = seriesOf(p.series.key);
      const into = parts.find((q) => q.series === series);
      if (!into) parts.push({ ...p, series });
      else {
        into.value += p.value;
        into.tokens += p.tokens;
        into.cost_usd = p.cost_usd == null ? into.cost_usd : (into.cost_usd ?? 0) + p.cost_usd;
      }
    }
    parts.sort((a, b) => Number(a.series === other) - Number(b.series === other));
    // A series stays unknown when any model or runtime folded into it has no cost that day.
    const unknown =
      metric === 'cost'
        ? [
            ...new Set(
              usage
                .filter((u) => u.day === d.day && u.cost_usd === null)
                .map((u) => seriesOf(keyOf.get(u.runtime)!).key),
            ),
          ]
        : [];
    return { ...d, parts, unknown };
  });
  const shown = new Set(days.flatMap((d) => [...d.parts.map((p) => p.series.key), ...d.unknown]));
  const series = [...new Set(stack.series.map((s) => seriesOf(s.key)))]
    .filter((s) => shown.has(s.key))
    .sort((a, b) => Number(a === other) - Number(b === other));
  return { series, days };
}

/* The most used sessions */

const TOP_SESSIONS = 4;

/** The current project's sessions with the most tokens over all their turns; nothing without one. */
export function TopSessions() {
  const id = useId();
  const stored = useCurrentProject((s) => s.projectId);
  const board = useBoard((s) => s.board);
  const rows = useMemo(() => {
    const projectId = currentProject(board, stored)?.id;
    if (!board || !projectId) return [];
    return board.sessions
      .filter((s) => s.project_id === projectId && s.usage)
      .map((s) => ({
        id: s.id,
        title: sessionTitle(s, board),
        tokens: s.usage!.input_tokens + s.usage!.output_tokens,
      }))
      .filter((r) => r.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_SESSIONS);
  }, [board, stored]);
  if (rows.length === 0) return null;
  const most = rows[0]!.tokens;
  return (
    <section className="us-top" aria-labelledby={id}>
      <h3 id={id}>
        {t({ id: 'insights.usage.topSessions', defaultMessage: 'Most used sessions, all time' })}
      </h3>
      {rows.map((r) => (
        <div className="us-tr" key={r.id}>
          <span className="us-tn" title={r.title}>
            {r.title}
          </span>
          <span
            className="meter"
            role="img"
            aria-label={t(
              { id: 'insights.usage.topRow', defaultMessage: '{session}: {tokens} tokens' },
              { session: r.title, tokens: tokenText(r.tokens) },
            )}
            style={{ '--v': `${(r.tokens / most) * 100}%` } as CSSProperties}
          >
            <i />
          </span>
          <span className="us-n">{tokenText(r.tokens)}</span>
        </div>
      ))}
    </section>
  );
}

export function UsageStackPanel({ model }: { model: BoardModel }) {
  const [table, setTable] = useState(false);
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const { series, days } = useMemo(() => runtimeStack(model, metric), [model, metric]);
  const empty = !model.usage.some((u) => u.tokens > 0);
  const unreported = model.usage.some((u) => (u.sessions_without_usage ?? 0) > 0);
  return (
    <Panel
      title={t({ id: 'board.usage.stackTitle', defaultMessage: 'Usage, selected range' })}
      className="us-stack"
      tools={
        empty ? null : (
          <>
            <RadioGroup<UsageMetric>
              className="seg"
              aria-label={t({ id: 'board.usage.metric', defaultMessage: 'Usage unit' })}
              value={metric}
              onValueChange={(value) => setMetric(value)}
            >
              <Radio.Root value="tokens">token</Radio.Root>
              <Radio.Root value="cost">
                {t({ id: 'board.usage.cost', defaultMessage: 'Cost' })}
              </Radio.Root>
            </RadioGroup>
            <ViewToggle table={table} onToggle={() => setTable(!table)} />
          </>
        )
      }
    >
      <div className="us-split">
        <div className="us-main">
          {empty || !days.some((d) => d.parts.length > 0) ? (
            <div className="bp-chart">
              <Empty
                text={
                  empty
                    ? unreported
                      ? t({ id: 'board.usage.unreported', defaultMessage: 'Usage not reported' })
                      : t({ id: 'board.usage.empty', defaultMessage: 'No usage yet' })
                    : t({ id: 'board.usage.noKnownCost', defaultMessage: 'No known cost' })
                }
              />
            </div>
          ) : (
            <>
              <div className="us-lgd">
                {series.map((s) => (
                  <span key={s.key}>
                    <Swatch series={s} />
                    {s.label}
                    <span className="us-lgn">
                      {cellText(
                        metric,
                        days.some((d) => d.parts.some((p) => p.series.key === s.key))
                          ? days.reduce((sum, d) => sum + (stackValue(d, s.key) ?? 0), 0)
                          : null,
                      )}
                    </span>
                  </span>
                ))}
              </div>
              {table ? (
                <div className="bp-chart">
                  <DataTable
                    head={[
                      t({ id: 'board.charts.date', defaultMessage: 'Date' }),
                      ...series.map((s) => s.label),
                      t({ id: 'board.charts.total', defaultMessage: 'Total' }),
                    ]}
                    rows={days.map((d) => [
                      d.day,
                      ...series.map((s) => cellText(metric, stackValue(d, s.key))),
                      totalText(metric, stackValue(d), d.unreported),
                    ])}
                  />
                </div>
              ) : (
                <StackChart days={days} metric={metric} />
              )}
            </>
          )}
        </div>
        <TopSessions />
      </div>
    </Panel>
  );
}

/* Usage by role */

// Labels are getters, so each is read in the language loaded by then.
const ROLE_PARTS = [
  {
    get label() {
      return t({ id: 'board.usage.input', defaultMessage: 'Input' });
    },
    className: 'us-sw us-k-in',
  },
  {
    get label() {
      return t({ id: 'board.usage.cachedInput', defaultMessage: 'Cached input' });
    },
    className: 'us-sw us-k-in us-sw-fwd',
  },
  {
    get label() {
      return t({ id: 'board.usage.output', defaultMessage: 'Output' });
    },
    className: 'us-sw us-k-out',
  },
];

const pct = (share: number) => `${share * 100}%`;
const cachedText = (row: RoleUsage) =>
  row.cached_input_tokens == null ? '—' : tokenText(row.cached_input_tokens);

export function RoleUsageBars({ rows }: { rows: readonly RoleUsage[] }) {
  const tip = useFloatTip();
  const bars = roleBars(rows);
  if (bars.length === 0)
    return <Empty text={t({ id: 'board.usage.empty', defaultMessage: 'No usage yet' })} />;
  return (
    <>
      <div className="us-lgd">
        {ROLE_PARTS.map((p) => (
          <span key={p.label}>
            <i className={p.className} />
            {p.label}
          </span>
        ))}
      </div>
      <div className="us-roles">
        {bars.map(({ role, label, input, output, cached, row }) => {
          const content: TipContent = {
            head: label,
            rows: [
              {
                label: t({ id: 'board.usage.input', defaultMessage: 'Input' }),
                value: tokenText(row.input_tokens),
              },
              {
                label: t({ id: 'board.usage.cachedInput', defaultMessage: 'Cached input' }),
                value: cachedText(row),
              },
              {
                label: t({ id: 'board.usage.output', defaultMessage: 'Output' }),
                value: tokenText(row.output_tokens),
              },
              {
                label: t({ id: 'board.usage.sessions', defaultMessage: 'Sessions' }),
                value: String(row.sessions),
              },
              {
                label: t({ id: 'board.usage.turns', defaultMessage: 'Turns' }),
                value: String(row.turns),
              },
            ],
          };
          return (
            <div
              className="us-rrow"
              key={role}
              onPointerMove={(e) => tip.show(e, content)}
              onPointerLeave={tip.hide}
            >
              <span className="us-role">{label}</span>
              <span
                className="us-rbar"
                role="img"
                aria-label={t(
                  {
                    id: 'board.usage.roleLabel',
                    defaultMessage: '{role}: input {input} ({cache}), output {output}',
                  },
                  {
                    role: label,
                    input: tokenText(row.input_tokens),
                    cache:
                      row.cached_input_tokens == null
                        ? t({ id: 'board.usage.cacheUnknown', defaultMessage: 'cache unknown' })
                        : t(
                            { id: 'board.usage.cached', defaultMessage: 'cached {tokens}' },
                            { tokens: tokenText(row.cached_input_tokens) },
                          ),
                    output: tokenText(row.output_tokens),
                  },
                )}
              >
                {input > 0 && (
                  <i className="us-in" style={{ width: pct(input) }}>
                    {cached > 0 && <i className="us-cache" style={{ width: pct(cached) }} />}
                  </i>
                )}
                {output > 0 && <i className="us-out" style={{ width: pct(output) }} />}
              </span>
              <span className="us-n">{tokenText(row.input_tokens + row.output_tokens)}</span>
            </div>
          );
        })}
      </div>
      {tip.node}
    </>
  );
}

const projectParams = (project_id: string) => ({ project_id });
const acceptRows = (value: unknown): RoleUsage[] | null =>
  Array.isArray(value) ? (value as RoleUsage[]) : null;
const USAGE_KINDS: ReadonlySet<string> = new Set([
  'session.opened',
  'session.deleted',
  'turn.queued',
  'agent.usage.updated',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);
const usageKind = (kind: string) => USAGE_KINDS.has(kind);

export function RoleUsagePanel({ projectId }: { projectId: string }) {
  const [table, setTable] = useState(false);
  const tick = useKindTick(usageKind);
  const query = useQuery('project.usage.read', projectId, projectParams, acceptRows, tick);
  return (
    <Panel
      title={t({ id: 'board.usage.byRole', defaultMessage: 'By role, all time' })}
      className="bp-tbl"
      tools={
        query.data?.length ? <ViewToggle table={table} onToggle={() => setTable(!table)} /> : null
      }
    >
      <QueryBody query={query}>
        {(rows) =>
          table ? (
            <DataTable
              head={[
                t({ id: 'board.usage.role', defaultMessage: 'Role' }),
                t({ id: 'board.usage.sessions', defaultMessage: 'Sessions' }),
                t({ id: 'board.usage.turns', defaultMessage: 'Turns' }),
                t({ id: 'board.usage.input', defaultMessage: 'Input' }),
                t({ id: 'board.usage.cachedInput', defaultMessage: 'Cached input' }),
                t({ id: 'board.usage.output', defaultMessage: 'Output' }),
                t({ id: 'board.usage.modelMinutes', defaultMessage: 'Model time (minutes)' }),
              ]}
              rows={roleBars(rows).map(({ label, row }) => [
                label,
                String(row.sessions),
                String(row.turns),
                tokenText(row.input_tokens),
                cachedText(row),
                tokenText(row.output_tokens),
                String(Math.round(row.turn_ms / 60_000)),
              ])}
            />
          ) : (
            <RoleUsageBars rows={rows} />
          )
        }
      </QueryBody>
    </Panel>
  );
}
