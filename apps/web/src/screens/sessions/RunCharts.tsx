import {
  useEffect,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { SessionActivity } from '@pantheon/protocol';
import { elapsedText, type TurnView } from '../../data/transcript';
import { useFloatTip, type TipContent } from '../../components/ChartParts';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { tokenText } from '../../lib/number-text';
import {
  BREAK_SHARE,
  callResult,
  contextRing,
  MIN_SHARE,
  runWaterfall,
  sparkBars,
  type RunTone,
} from './run-model';
import './run.css';

/* Context ring */

const RING = { size: 44, r: 18, stroke: 5 };

const contextLabel = (share: string) =>
  t({ id: 'sessions.run.context.share', defaultMessage: 'Context {share}' }, { share });

/** The separator of a spoken list of values. */
const separator = () => t({ id: 'sessions.run.separator', defaultMessage: ', ' });

const unknownText = () => t({ id: 'sessions.run.unknown', defaultMessage: 'Unknown' });

/** How full the context window is, from the newest usage payload. */
export function ContextMeter({ usage }: { usage: unknown }) {
  const ring = contextRing(usage);
  const c = RING.size / 2;
  const around = 2 * Math.PI * RING.r;
  const tokens =
    ring.used === null
      ? null
      : `${tokenText(ring.used)} / ${ring.window ? tokenText(ring.window) : '—'}`;
  return (
    <span className="rn-ctx">
      <svg
        className={`rn-ring rn-ring-${ring.tone}`}
        width={RING.size}
        height={RING.size}
        role="img"
        aria-label={
          tokens
            ? t(
                {
                  id: 'sessions.run.context.shareTokens',
                  defaultMessage: 'Context {share}, {tokens}',
                },
                { share: ring.text, tokens },
              )
            : contextLabel(ring.text)
        }
      >
        <circle className="rn-ring-trk" cx={c} cy={c} r={RING.r} strokeWidth={RING.stroke} />
        {ring.sweep > 0 && (
          <circle
            className="rn-ring-arc"
            cx={c}
            cy={c}
            r={RING.r}
            strokeWidth={RING.stroke}
            strokeDasharray={`${ring.sweep * around} ${around}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
        <text className="rn-ring-v" x={c} y={c} textAnchor="middle" dominantBaseline="central">
          {ring.text}
        </text>
      </svg>
      {tokens && <span className="rn-ctx-n">{tokens}</span>}
    </span>
  );
}

/* Chart tips */

/** The datum whose tip is open, and the point the tip sits at. */
interface ActiveTip {
  key: string;
  at: { clientX: number; clientY: number };
}

/** The float tip of the active datum with its current content; Escape closes it before other Escape handlers act. */
function useActiveTip(
  active: ActiveTip | null,
  content: TipContent | undefined,
  close: () => void,
): ReactNode {
  const tip = useFloatTip();
  const shown = active && content ? JSON.stringify(content) : null;
  useEffect(() => {
    if (active && content) tip.show(active.at, content);
    else tip.hide();
  }, [active, shown]);
  const open = active !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return tip.node;
}

/* Activity sparkline */

const SPARK = { bar: 10, gap: 2, h: 28 };

/** Tool calls completed in each 5-minute bucket of the last hour; unknown until the activity reads. */
export function ActivitySpark({ activity }: { activity: SessionActivity | null }) {
  const [hover, setHover] = useState<ActiveTip | null>(null);
  const i = hover ? Number(hover.key) : null;
  const tipNode = useActiveTip(
    hover,
    activity && i !== null
      ? {
          head: dayText(Date.parse(activity.from) + i * activity.bucket_ms, Date.now(), {
            time: true,
          }),
          rows: [
            {
              label: t({ id: 'sessions.run.spark.tools', defaultMessage: 'Tools completed' }),
              value: String(activity.tools_completed[i] ?? 0),
            },
          ],
        }
      : undefined,
    () => setHover(null),
  );
  if (!activity) return <span className="rn-spk mu">{unknownText()}</span>;
  const values = activity.tools_completed;
  const { max, heights } = sparkBars(values, SPARK.h - 1);
  const n = values.length;
  const W = n * SPARK.bar;

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
    setHover({ key: String(at), at: { clientX: e.clientX, clientY: e.clientY } });
  };
  const onLeave = () => setHover(null);

  return (
    <span className="rn-spk">
      <svg
        className="rn-spk-svg"
        viewBox={`0 0 ${W} ${SPARK.h}`}
        width="100%"
        height={SPARK.h}
        preserveAspectRatio="none"
        role="img"
        aria-label={t(
          {
            id: 'sessions.run.spark.label',
            defaultMessage: 'Tools completed per 5 minutes over the last hour: {values}',
          },
          { values: values.join(separator()) },
        )}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        {heights.map((h, j) => (
          <rect
            key={j}
            className={i === j ? 'rn-spk-bar rn-on' : 'rn-spk-bar'}
            x={j * SPARK.bar + SPARK.gap / 2}
            y={SPARK.h - 1 - h}
            width={SPARK.bar - SPARK.gap}
            height={h}
          />
        ))}
        <line
          className="rn-spk-base"
          x1="0"
          x2={W}
          y1={SPARK.h - 0.5}
          y2={SPARK.h - 0.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="rn-spk-max">{max}</span>
      {tipNode}
    </span>
  );
}

/* Trace waterfall */

// Labels are getters, so each is read in the language loaded by then.
const TONE_LABEL: Record<RunTone, string> = {
  get ok() {
    return t({ id: 'sessions.run.tone.ok', defaultMessage: 'Done' });
  },
  get bad() {
    return t({ id: 'sessions.run.tone.bad', defaultMessage: 'Failed' });
  },
  get idle() {
    return t({ id: 'sessions.run.tone.idle', defaultMessage: 'Interrupted' });
  },
  get run() {
    return t({ id: 'sessions.run.tone.run', defaultMessage: 'Running' });
  },
  get wait() {
    return t({ id: 'sessions.run.tone.wait', defaultMessage: 'Waiting' });
  },
};
const ROW = 8;
const PAD = 3;

const durationText = () => t({ id: 'sessions.run.waterfall.duration', defaultMessage: 'Duration' });
const resultText = () => t({ id: 'sessions.run.waterfall.result', defaultMessage: 'Result' });

/** The tip of a bar, also read out as its label when the bar has focus. */
const tipLabel = (content: Required<TipContent>) =>
  [content.head, ...content.rows.map((row) => `${row.label} ${row.value}`)].join(separator());

/** One lane per turn on a shared time axis, with the turn's tool calls as nested bars. */
export function TraceWaterfall({ turns, now }: { turns: readonly TurnView[]; now: number }) {
  const [active, setActive] = useState<ActiveTip | null>(null);
  const chart = runWaterfall(turns, now);
  const tips = new Map<string, Required<TipContent>>();
  chart.lanes.forEach((lane, i) => {
    tips.set(lane.id, {
      head: t({ id: 'sessions.run.waterfall.turn', defaultMessage: 'Turn {n}' }, { n: i + 1 }),
      rows: [
        {
          label: durationText(),
          value: lane.unknown ? unknownText() : elapsedText(lane.to - lane.from),
        },
        { label: resultText(), value: TONE_LABEL[lane.tone] },
      ],
    });
    for (const span of lane.spans)
      tips.set(`${lane.id}/${span.id}`, {
        head: span.name || t({ id: 'sessions.run.waterfall.tool', defaultMessage: 'Tool' }),
        rows: [
          {
            label: durationText(),
            value: span.unknown ? unknownText() : elapsedText(span.to - span.from),
          },
          { label: resultText(), value: callResult(span.ok) },
        ],
      });
  });
  const close = () => setActive(null);
  const tipNode = useActiveTip(active, active ? tips.get(active.key) : undefined, close);
  const place = (from: number, to: number) => ({
    left: `${chart.position(from) * 100}%`,
    width: `${Math.max(MIN_SHARE, chart.position(to) - chart.position(from)) * 100}%`,
  });
  const bar = (key: string) => ({
    role: 'img',
    tabIndex: 0,
    'aria-label': tipLabel(tips.get(key)!),
    onPointerMove: (e: ReactPointerEvent) =>
      setActive({ key, at: { clientX: e.clientX, clientY: e.clientY } }),
    onFocus: (e: ReactFocusEvent) => {
      const box = e.currentTarget.getBoundingClientRect();
      setActive({ key, at: { clientX: box.left + box.width / 2, clientY: box.top } });
    },
    onBlur: close,
  });
  const calls = chart.lanes.reduce((a, lane) => a + lane.spans.length, 0);
  const summary = {
    turns: chart.lanes.length,
    calls,
    duration: elapsedText(chart.to - chart.from),
    gaps: chart.breaks.length,
  };

  return (
    <div className="rn-wf">
      <div className="rn-lgd" aria-hidden="true">
        {(Object.keys(TONE_LABEL) as RunTone[]).map((tone) => (
          <span key={tone}>
            <i className={`rn-sw rn-k-${tone}`} />
            {TONE_LABEL[tone]}
          </span>
        ))}
        <span>
          <i className="rn-sw rn-unk" />
          {unknownText()}
        </span>
      </div>
      <div
        className="rn-lanes"
        role="group"
        aria-label={
          summary.gaps
            ? t(
                {
                  id: 'sessions.run.waterfall.labelGaps',
                  defaultMessage:
                    'Trace waterfall, {turns, plural, one {# turn} other {# turns}}, {calls, plural, one {# tool call} other {# tool calls}}, {duration} in all, {gaps, plural, one {# idle stretch} other {# idle stretches}} left out',
                },
                summary,
              )
            : t(
                {
                  id: 'sessions.run.waterfall.label',
                  defaultMessage:
                    'Trace waterfall, {turns, plural, one {# turn} other {# turns}}, {calls, plural, one {# tool call} other {# tool calls}}, {duration} in all',
                },
                summary,
              )
        }
        onPointerLeave={close}
      >
        {chart.lanes.map((lane, i) => (
          <div className="rn-lrow" key={lane.id}>
            <span className="rn-ln" aria-hidden="true">
              {i + 1}
            </span>
            <div className="rn-lane" style={{ height: 2 * PAD + Math.max(1, lane.rows) * ROW }}>
              {chart.breaks.map((gap) => (
                <i
                  key={gap.at}
                  className="rn-brk"
                  style={{ left: `${gap.at * 100}%`, width: `${BREAK_SHARE * 100}%` }}
                />
              ))}
              <i
                {...bar(lane.id)}
                className={`rn-turn rn-k-${lane.tone}${lane.unknown ? ' rn-unk' : ''}`}
                style={place(lane.from, lane.to)}
              />
              {lane.spans.map((span) => (
                <i
                  key={span.id}
                  {...bar(`${lane.id}/${span.id}`)}
                  className={`rn-span${span.ok === false ? ' rn-fail' : ''}${span.unknown ? ' rn-unk' : ''}`}
                  style={{ ...place(span.from, span.to), top: PAD + span.row * ROW }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rn-axis" aria-hidden="true">
        <span>0</span>
        <span>{elapsedText(chart.to - chart.from)}</span>
      </div>
      {tipNode}
    </div>
  );
}
