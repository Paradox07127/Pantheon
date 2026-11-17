import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { useNow } from '../../data/needs-you';
import { Clip } from '../../components/Clip';
import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import {
  DataTable,
  Empty,
  niceScale,
  Panel,
  scaleSteps,
  spreadLabels,
  useFloatTip,
  useSize,
  ViewToggle,
} from './Charts';
import { durationText } from './panels-model';
import {
  bannerSegments,
  burnupPoints,
  cycleHistogram,
  dayTick,
  markerPlacement,
  stallRows,
  type BurnupPoints,
} from './progress-model';
import './progress.css';

/* Banner progress strip */

/** The plan's task totals in at most four parts, each labelled with its count. */
export function TaskProgressStrip({ totals }: { totals: BoardModel['task_progress']['totals'] }) {
  const parts = bannerSegments(totals);
  if (parts.length === 0) return null;
  return (
    <div
      className="bd-tp"
      role="img"
      aria-label={t(
        { id: 'board.taskProgress.label', defaultMessage: 'Task progress: {parts}' },
        {
          parts: parts
            .map((p) => `${p.label} ${p.count}`)
            .join(t({ id: 'board.charts.listSeparator', defaultMessage: ', ' })),
        },
      )}
    >
      {parts.map((p) => (
        <Tip key={p.key} content={p.label}>
          <span className="bd-tps" style={{ flexGrow: p.count }}>
            <i className={`bd-tpb bd-tp-${p.key}`} />
            <b>{p.count}</b>
          </span>
        </Tip>
      ))}
    </div>
  );
}

/* Task burn-up */

const SCOPE_SWATCH = <i className="bpc-swl scope" />;
const DONE_SWATCH = <i className="bpc-swl done" />;

function BurnupChart({ daily }: { daily: BoardModel['task_progress']['daily'] }) {
  const [setBox, size] = useSize();
  const [hover, setHover] = useState<number | null>(null);
  const tip = useFloatTip();
  const points: BurnupPoints = burnupPoints(daily);
  const W = size.w;
  const H = size.h;
  const m = { l: 32, r: 72, t: 14, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = daily.length;
  const scale = niceScale(points.max, true);
  const X = (i: number) => m.l + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
  const Y = (v: number) => m.t + ph - (v / scale.max) * ph;
  const every = Math.max(1, Math.ceil(52 / (pw / Math.max(1, n - 1))));
  const last = daily[n - 1];

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px - m.l) / (pw / (n - 1)))));
    const d = daily[i];
    if (!d) return;
    setHover(i);
    const tick = points.ticks.find((t) => t.index === i);
    tip.show(e, {
      head: d.day,
      rows: [
        {
          swatch: SCOPE_SWATCH,
          label: t({ id: 'board.trend.scope', defaultMessage: 'Scope' }),
          value: d.scope == null ? '—' : String(d.scope),
        },
        {
          swatch: DONE_SWATCH,
          label: t({ id: 'board.trend.done', defaultMessage: 'Done' }),
          value: String(d.done),
        },
        ...(tick
          ? [
              {
                label: t({ id: 'board.trend.change', defaultMessage: 'Added / removed' }),
                value: tick.title,
              },
            ]
          : []),
      ],
    });
  };
  const onLeave = () => {
    setHover(null);
    tip.hide();
  };

  const line = (run: { index: number; value: number }[]) =>
    run.map((p) => `${X(p.index).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const labels =
    last && pw > 0
      ? spreadLabels(
          [
            ...(last.scope == null
              ? []
              : [
                  {
                    y: Y(last.scope) + 4,
                    text: t(
                      { id: 'board.trend.scopeCount', defaultMessage: 'Scope {count}' },
                      { count: last.scope },
                    ),
                    cls: 'scope',
                  },
                ]),
            {
              y: Y(last.done) + 4,
              text: t(
                { id: 'board.trend.doneCount', defaultMessage: 'Done {count}' },
                { count: last.done },
              ),
              cls: 'done',
            },
          ],
          m.t + 8,
          m.t + ph,
        )
      : [];
  const hovered = hover == null ? undefined : daily[hover];

  return (
    <div className="bp-chart" ref={setBox}>
      {last && pw > 0 && ph > 0 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={
            last.scope == null
              ? t(
                  { id: 'board.trend.label', defaultMessage: 'Completion trend, done {done}' },
                  { done: last.done },
                )
              : t(
                  {
                    id: 'board.trend.labelWithScope',
                    defaultMessage: 'Completion trend, scope {scope}, done {done}',
                  },
                  { scope: last.scope, done: last.done },
                )
          }
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
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
                {v}
              </text>
            </g>
          ))}
          {daily.map((d, i) =>
            (n - 1 - i) % every === 0 ? (
              <text key={d.day} className="bp-ax" x={X(i)} y={m.t + ph + 16} textAnchor="middle">
                {dayTick(d.day)}
              </text>
            ) : null,
          )}
          <path
            className="bpc-area"
            d={`M${X(0)},${Y(0)} ${points.done.map((v, i) => `L${X(i)},${Y(v)}`).join(' ')} L${X(n - 1)},${Y(0)} Z`}
          />
          {points.scope.map((run) =>
            run.length === 1 ? (
              <circle
                key={run[0]!.index}
                className="bpc-pt"
                r="2"
                cx={X(run[0]!.index)}
                cy={Y(run[0]!.value)}
              />
            ) : (
              <polyline key={run[0]!.index} className="bpc-ln scope" points={line(run)} />
            ),
          )}
          <polyline
            className="bpc-ln done"
            points={line(points.done.map((value, index) => ({ index, value })))}
          />
          {labels.map((l) => (
            <text key={l.cls} className={`bpc-elab ${l.cls}`} x={X(n - 1) + 8} y={l.y}>
              {l.text}
            </text>
          ))}
          {hovered && hover != null && (
            <>
              <line className="bp-xh" x1={X(hover)} x2={X(hover)} y1={m.t} y2={m.t + ph} />
              {hovered.scope != null && (
                <circle className="bpc-hd scope" r="3.5" cx={X(hover)} cy={Y(hovered.scope)} />
              )}
              <circle className="bpc-hd done" r="3.5" cx={X(hover)} cy={Y(hovered.done)} />
            </>
          )}
          <rect x="0" y="0" width={W} height={H} fill="transparent" />
          {points.ticks.map((t) => {
            const x = X(t.index);
            const y = Y(daily[t.index]!.scope ?? daily[t.index]!.done);
            return (
              <g key={t.index} className="bpc-tick">
                <title>{t.title}</title>
                {t.added > 0 && <path d={`M${x},${y - 12} l4,6 h-8 z`} />}
                {t.removed > 0 && <path d={`M${x},${y + 12} l4,-6 h-8 z`} />}
              </g>
            );
          })}
        </svg>
      )}
      {tip.node}
    </div>
  );
}

const countText = (n: number | null) => (n == null ? '—' : String(n));

export function TrendPanel({ model }: { model: BoardModel }) {
  const [table, setTable] = useState(false);
  const { daily } = model.task_progress;
  const empty = daily.every((d) => !d.scope && !d.done);
  return (
    <Panel
      title={t({ id: 'board.trend.title', defaultMessage: 'Completion trend' })}
      className="bp-burnp"
      tools={empty ? null : <ViewToggle table={table} onToggle={() => setTable(!table)} />}
    >
      {empty ? (
        <div className="bp-chart">
          <Empty text={t({ id: 'board.trend.empty', defaultMessage: 'Nothing done yet' })} />
        </div>
      ) : (
        <>
          <div className="bp-lgd">
            <span>
              {SCOPE_SWATCH}
              {t({ id: 'board.trend.scope', defaultMessage: 'Scope' })}
            </span>
            <span>
              {DONE_SWATCH}
              {t({ id: 'board.trend.done', defaultMessage: 'Done' })}
            </span>
          </div>
          {table ? (
            <div className="bp-chart">
              <DataTable
                head={[
                  t({ id: 'board.charts.date', defaultMessage: 'Date' }),
                  t({ id: 'board.trend.scope', defaultMessage: 'Scope' }),
                  t({ id: 'board.trend.done', defaultMessage: 'Done' }),
                  t({ id: 'board.trend.added', defaultMessage: 'Added' }),
                  t({ id: 'board.trend.removed', defaultMessage: 'Removed' }),
                ]}
                rows={daily.map((d) => [
                  d.day,
                  countText(d.scope),
                  String(d.done),
                  countText(d.added),
                  countText(d.removed),
                ])}
              />
            </div>
          ) : (
            <BurnupChart daily={daily} />
          )}
        </>
      )}
    </Panel>
  );
}

/* Cycle time histogram */

function Histogram({ cycle }: { cycle: BoardModel['task_progress']['cycle'] }) {
  const [setBox, size] = useSize();
  const { bars, median, p90 } = cycleHistogram(cycle);
  const W = size.w;
  const H = size.h;
  const l = 16,
    r = 16;
  const pw = W - l - r;
  const n = bars.length;
  const step = pw / n;
  const at = (pos: number) => l + pos * step;
  const shown = [median && { ...median, cls: 'med' }, p90 && { ...p90, cls: 'p90' }].filter(
    (mk) => mk != null,
  );
  const placed = markerPlacement(
    shown.map((mk) => ({ x: at(mk.at), label: mk.label })),
    W - r,
  );
  const markers = shown.map((mk, i) => ({ ...mk, ...placed[i]! }));
  // One 14px line per marker label row above the plot.
  const rows = Math.max(1, ...markers.map((mk) => mk.row + 1));
  const m = { l, r, t: 6 + rows * 14, b: 24 };
  const ph = H - m.t - m.b;
  const bw = Math.min(48, step * 0.7);
  const base = m.t + ph;
  // Leaves room above the tallest bar for its count.
  const top = m.t + 16;
  return (
    <div className="bp-chart" ref={setBox}>
      {n > 0 && pw > 0 && ph > 0 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={t(
            { id: 'board.cycle.label', defaultMessage: 'Cycle time distribution, {items}' },
            {
              items: [
                ...bars.map((b) => `${b.label} ${b.count}`),
                ...markers.map((mk) => mk.label),
              ].join(t({ id: 'board.charts.listSeparator', defaultMessage: ', ' })),
            },
          )}
        >
          <line className="bp-axl" x1={m.l} x2={m.l + pw} y1={base} y2={base} />
          {bars.map((b, k) => {
            const h = b.height * (base - top);
            const x = at(k + 0.5);
            return (
              <g key={k}>
                <title>{`${b.label} ${b.count}`}</title>
                <rect className="bpc-hb" x={x - bw / 2} y={base - h} width={bw} height={h} rx="3" />
                {b.count > 0 && (
                  <text className="bpc-hv" x={x} y={base - h - 4} textAnchor="middle">
                    {b.count}
                  </text>
                )}
                <text className="bp-ax" x={x} y={base + 16} textAnchor="middle">
                  {b.label}
                </text>
              </g>
            );
          })}
          {markers.map((mk) => (
            <g key={mk.cls} className={`bpc-mk ${mk.cls}`}>
              <line x1={at(mk.at)} x2={at(mk.at)} y1={m.t - 4} y2={base} />
              <text
                x={at(mk.at) + (mk.anchor === 'start' ? 4 : -4)}
                y={14 + mk.row * 14}
                textAnchor={mk.anchor}
              >
                {mk.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

export function CyclePanel({ model }: { model: BoardModel }) {
  const { cycle } = model.task_progress;
  return (
    <Panel
      title={t({ id: 'board.cycle.title', defaultMessage: 'Cycle time distribution' })}
      className="bp-burnp"
      num={
        <span className="bp-hn">
          {t({ id: 'board.cycle.samples', defaultMessage: 'Samples' })} <b>{cycle.sample_count}</b>
        </span>
      }
    >
      {cycle.sample_count === 0 ? (
        <div className="bp-chart">
          <Empty text={t({ id: 'board.cycle.empty', defaultMessage: 'No finished tasks yet' })} />
        </div>
      ) : (
        <Histogram cycle={cycle} />
      )}
    </Panel>
  );
}

/* Blocked and stalled tasks */

// Getters, so each label is read in the language loaded by then.
const KIND_LABEL = {
  get blocked() {
    return t({ id: 'board.stalls.blocked', defaultMessage: 'Blocked' });
  },
  get stalled() {
    return t({ id: 'board.stalls.stalled', defaultMessage: 'Stalled' });
  },
};

export function StallPanel({
  model,
  onOpenTask,
}: {
  model: BoardModel;
  onOpenTask: (taskId: string) => void;
}) {
  // Stalls grow with time alone, while the model is read again only on events.
  const now = useNow(60_000);
  const rows = stallRows({ tasks: model.tasks, now: Math.max(model.now, now) });
  return (
    <Panel title={t({ id: 'board.stalls.title', defaultMessage: 'Blocked and stalled' })}>
      {rows.length === 0 ? (
        <Empty
          text={t({ id: 'board.stalls.empty', defaultMessage: 'No blocked or stalled tasks' })}
        />
      ) : (
        <>
          <div className="bp-lgd">
            {(['blocked', 'stalled'] as const).map((kind) => (
              <span key={kind}>
                <i className={`bpc-sw bpc-st-${kind}`} />
                {KIND_LABEL[kind]}
              </span>
            ))}
          </div>
          <div className="bpc-stl">
            {rows.map((r) => {
              const text = `${KIND_LABEL[r.kind]} ${durationText(r.ms)}`;
              return (
                <div className="bpc-str" key={r.task.id}>
                  <button type="button" className="bpc-stn" onClick={() => onOpenTask(r.task.id)}>
                    <Clip text={r.task.title} />
                  </button>
                  <span
                    className="bpc-stt"
                    role="img"
                    aria-label={t(
                      { id: 'board.stalls.rowLabel', defaultMessage: '{task}, {state}' },
                      { task: r.task.title, state: text },
                    )}
                  >
                    <Tip content={text}>
                      <i
                        className={`bpc-stb bpc-st-${r.kind}`}
                        style={{ width: `${r.share * 100}%` }}
                      />
                    </Tip>
                  </span>
                  <span className="bpc-std">{durationText(r.ms)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}
