import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { RoleUsage } from '@pantheon/domain';
import { Empty, useFloatTip, useSize, type TipContent } from '../../components/ChartParts';
import { Failure } from '../../components/PanelBoundary';
import { useDailyUsage, useRoleUsage } from '../../data/project-usage';
import { t } from '../../i18n';
import { tokenText } from '../../lib/number-text';
import {
  dailyStack,
  metricValue,
  niceScale,
  ROLE_LABEL,
  roleBars,
  roleColor,
  ROLES,
  scaleSteps,
  unreportedTurns,
  type StackDay,
  type UsageMetric,
} from './usage-model';

/** How many days the daily chart covers, today included. */
export const USAGE_DAYS = 14;

const OPEN_KEY = 'pantheon.projectUsage.open.';

function loadOpen(projectId: string): boolean {
  try {
    return localStorage.getItem(OPEN_KEY + projectId) === '1';
  } catch {
    return false;
  }
}

/** Whether the usage section is open, kept per project. */
function useUsageOpen(projectId: string) {
  const [stored, setStored] = useState(() => ({ projectId, open: loadOpen(projectId) }));
  if (stored.projectId !== projectId) setStored({ projectId, open: loadOpen(projectId) });
  const choose = (open: boolean) => {
    setStored({ projectId, open });
    try {
      if (open) localStorage.setItem(OPEN_KEY + projectId, '1');
      else localStorage.removeItem(OPEN_KEY + projectId);
    } catch {
      // The choice holds in this window only.
    }
  };
  return [stored.open, choose] as const;
}

const valueText = (metric: UsageMetric, value: number) =>
  metric === 'tokens' ? tokenText(value) : String(value);

/** An axis step: tokens keep one decimal in thousands so adjacent steps read apart. */
const tickText = (metric: UsageMetric, value: number) =>
  metric === 'tokens' && value >= 1e3 && value < 1e6
    ? `${Number((value / 1e3).toFixed(1))}k`
    : valueText(metric, value);

const tokensText = (row: RoleUsage) => tokenText(row.input_tokens + row.output_tokens);

const pct = (share: number) => `${share * 100}%`;

/** One bar per role: input with its cached part striped, then output, and the token total. */
export function RoleBars({ rows }: { rows: readonly RoleUsage[] }) {
  const tip = useFloatTip();
  const bars = roleBars(rows);
  if (bars.length === 0)
    return <Empty text={t({ id: 'project.usage.empty', defaultMessage: 'No usage yet' })} />;
  const input = t({ id: 'project.usage.input', defaultMessage: 'Input' });
  const cachedInput = t({ id: 'project.usage.cachedInput', defaultMessage: 'Cached input' });
  const output = t({ id: 'project.usage.output', defaultMessage: 'Output' });
  return (
    <>
      <div className="pj-ulg">
        <span>
          <i className="pj-usw pj-usw-in" />
          {input}
        </span>
        <span>
          <i className="pj-usw pj-usw-cache" />
          {cachedInput}
        </span>
        <span>
          <i className="pj-usw pj-usw-out" />
          {output}
        </span>
      </div>
      <div className="pj-urs">
        {bars.map(({ role, label, input: inShare, output: outShare, cached, row }) => {
          const content: TipContent = {
            head: label,
            rows: [
              { label: input, value: tokenText(row.input_tokens) },
              {
                label: cachedInput,
                value: row.cached_input_tokens == null ? '-' : tokenText(row.cached_input_tokens),
              },
              { label: output, value: tokenText(row.output_tokens) },
              {
                label: t({ id: 'project.usage.sessions', defaultMessage: 'Sessions' }),
                value: String(row.sessions),
              },
              {
                label: t({ id: 'project.usage.turns', defaultMessage: 'Turns' }),
                value: String(row.turns),
              },
            ],
          };
          return (
            <div
              className="pj-ur"
              key={role}
              onPointerMove={(e) => tip.show(e, content)}
              onPointerLeave={tip.hide}
            >
              <span className="pj-url">{label}</span>
              <span
                className="pj-urb"
                role="img"
                aria-label={t(
                  {
                    id: 'project.usage.roleLabel',
                    defaultMessage:
                      '{role}: input {input}, cached {cached}, output {output}, {turns, plural, one {# turn} other {# turns}}',
                  },
                  {
                    role: label,
                    input: tokenText(row.input_tokens),
                    cached:
                      row.cached_input_tokens == null
                        ? t({ id: 'project.usage.notReported', defaultMessage: 'not reported' })
                        : tokenText(row.cached_input_tokens),
                    output: tokenText(row.output_tokens),
                    turns: row.turns,
                  },
                )}
              >
                {inShare > 0 && (
                  <i
                    className="pj-uin"
                    style={{ width: pct(inShare), backgroundColor: roleColor(role) }}
                  >
                    {cached > 0 && <i className="pj-ucache" style={{ width: pct(cached) }} />}
                  </i>
                )}
                {outShare > 0 && (
                  <i
                    className="pj-uout"
                    style={{
                      width: pct(outShare),
                      backgroundColor: `color-mix(in srgb, ${roleColor(role)} 45%, var(--sf))`,
                    }}
                  />
                )}
              </span>
              <span className="pj-un">{tokensText(row)}</span>
            </div>
          );
        })}
      </div>
      {tip.node}
    </>
  );
}

const MARGIN = { l: 48, r: 16, t: 8, b: 24 };

/** Each day a bar of its roles' use stacked bottom up, with a y axis and every few days' date. */
export function DailyChart({ days, metric }: { days: StackDay[]; metric: UsageMetric }) {
  const [setBox, size] = useSize();
  const [hover, setHover] = useState<number | null>(null);
  const tip = useFloatTip();
  const m = MARGIN;
  const W = size.w;
  const H = size.h;
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = days.length;
  const scale = niceScale(Math.max(0, ...days.map((d) => d.total)));
  const step = pw / n;
  const bw = Math.min(28, step * 0.6);
  const CX = (i: number) => m.l + step * (i + 0.5);
  const Y = (v: number) => m.t + ph - (v / scale.max) * ph;
  const base = Y(0);
  const every = Math.max(1, Math.ceil(44 / step));
  const total = days.reduce((sum, d) => sum + d.total, 0);

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
    tip.show(e, {
      head: d.day,
      rows: [
        ...d.parts.map((p) => ({
          swatch: <i className="pj-usw" style={{ backgroundColor: roleColor(p.role) }} />,
          label: ROLE_LABEL[p.role],
          value: valueText(metric, p.value),
        })),
        {
          label: t({ id: 'project.usage.total', defaultMessage: 'Total' }),
          value: valueText(metric, d.total),
        },
      ],
    });
  };

  return (
    <div className="pj-uchart" ref={setBox}>
      {n > 0 && pw > 0 && ph > 0 && (
        <svg
          width={W}
          height={H}
          role="group"
          aria-label={t(
            {
              id: 'project.usage.dailyLabel',
              defaultMessage:
                '{metric, select, tokens {Tokens} other {Turns}} per day by role over {days, plural, one {# day} other {# days}}, {total} in all',
            },
            { metric, days: n, total: valueText(metric, total) },
          )}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
          {hover != null && (
            <rect className="pj-uband" x={m.l + step * hover} y={m.t} width={step} height={ph} />
          )}
          {scaleSteps(scale).map((v) => (
            <g key={v}>
              <line
                className={v ? 'pj-ugl' : 'pj-uaxl'}
                x1={m.l}
                x2={m.l + pw}
                y1={Y(v)}
                y2={Y(v)}
              />
              <text className="pj-uax" x={m.l - 8} y={Y(v) + 4} textAnchor="end">
                {tickText(metric, v)}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            (n - 1 - i) % every === 0 ? (
              <text key={d.day} className="pj-uax" x={CX(i)} y={base + 16} textAnchor="middle">
                {d.day.slice(5)}
              </text>
            ) : null,
          )}
          {days.map((d, i) => {
            let top = base;
            const x = CX(i) - bw / 2;
            return (
              <g
                key={d.day}
                data-day={d.day}
                className="pj-uday"
                tabIndex={0}
                role="img"
                aria-label={t(
                  { id: 'project.usage.dayLabel', defaultMessage: '{day}: {parts}, total {total}' },
                  {
                    day: d.day,
                    parts: d.parts
                      .map((p) => `${ROLE_LABEL[p.role]} ${valueText(metric, p.value)}`)
                      .join(t({ id: 'project.usage.listSeparator', defaultMessage: ', ' })),
                    total: valueText(metric, d.total),
                  },
                )}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {d.parts.map((p) => {
                  const h = (p.value / scale.max) * ph;
                  top -= h;
                  // A one pixel seam of the surface separates stacked segments.
                  const seam = Math.min(1, h / 2);
                  return (
                    <rect
                      key={p.role}
                      data-role={p.role}
                      x={x}
                      y={top + seam}
                      width={bw}
                      height={h - seam}
                      style={{ fill: roleColor(p.role) }}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {tip.node}
    </div>
  );
}

/** The two blocks of the open usage section, read only while it is open. */
export function UsageBody({ projectId }: { projectId: string }) {
  const roles = useRoleUsage(projectId);
  const daily = useDailyUsage(projectId, USAGE_DAYS);
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const days = daily.read ? dailyStack(daily.read, metric) : null;
  const unreported = daily.read ? unreportedTurns(daily.read) : 0;
  const byRole = t({ id: 'project.usage.byRole', defaultMessage: 'By role, all time' });
  const byDay = t(
    { id: 'project.usage.byDay', defaultMessage: 'Last {days} days' },
    { days: USAGE_DAYS },
  );
  const shown = days
    ? ROLES.filter((role) => days.some((d) => d.parts.some((p) => p.role === role)))
    : [];
  return (
    <>
      <section className="pj-ublk" aria-label={byRole} aria-busy={roles.loading || undefined}>
        <h3 className="pj-h2">{byRole}</h3>
        {roles.error && <Failure error={roles.error} onRetry={roles.reload} />}
        {roles.read && <RoleBars rows={roles.read} />}
      </section>
      <section className="pj-ublk" aria-label={byDay} aria-busy={daily.loading || undefined}>
        <div className="pj-ch">
          <h3 className="pj-h2">{byDay}</h3>
          <RadioGroup<UsageMetric>
            className="seg pj-end"
            aria-label={t({ id: 'project.usage.metric', defaultMessage: 'Usage unit' })}
            value={metric}
            onValueChange={setMetric}
          >
            <Radio.Root value="tokens">
              {t({ id: 'project.usage.tokens', defaultMessage: 'Tokens' })}
            </Radio.Root>
            <Radio.Root value="turns">
              {t({ id: 'project.usage.turns', defaultMessage: 'Turns' })}
            </Radio.Root>
          </RadioGroup>
        </div>
        {daily.error && <Failure error={daily.error} onRetry={daily.reload} />}
        {days && (
          <>
            <div className="pj-ulg">
              {shown.map((role) => (
                <span key={role}>
                  <i className="pj-usw" style={{ backgroundColor: roleColor(role) }} />
                  {ROLE_LABEL[role]}
                  <span className="pj-ulv">
                    {valueText(
                      metric,
                      days.reduce(
                        (sum, d) => sum + (d.parts.find((p) => p.role === role)?.value ?? 0),
                        0,
                      ),
                    )}
                  </span>
                </span>
              ))}
            </div>
            <DailyChart days={days} metric={metric} />
            {unreported > 0 && (
              <p className="pj-sub pj-unr">
                {t(
                  {
                    id: 'project.usage.unreported',
                    defaultMessage:
                      '{count, plural, one {# turn reported no usage} other {# turns reported no usage}}',
                  },
                  { count: unreported },
                )}
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}

/** The project's usage by role and by day, folded until the user opens it. */
export function UsagePanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useUsageOpen(projectId);
  const title = t({ id: 'project.usage.title', defaultMessage: 'Usage' });
  return (
    <Collapsible.Root
      className="pj-card"
      render={<section aria-label={title} />}
      open={open}
      onOpenChange={setOpen}
    >
      <h2 className="pj-h2">
        <Collapsible.Trigger className="pj-utg">
          <ChevronRight className="pj-uchev" aria-hidden="true" />
          {title}
        </Collapsible.Trigger>
      </h2>
      <Collapsible.Panel className="pj-ufold">
        <UsageBody projectId={projectId} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
