import { useMemo, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { currentProject, useCurrentProject } from '../../data/current-project';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { tokenText } from './panels-model';
import { kpis, previousText } from './usage-model';

function Change({ change }: { change: number | null }) {
  if (change === null) return null;
  const pct = `${Math.round(Math.abs(change) * 100)}%`;
  const Arrow = change > 0 ? ArrowUp : change < 0 ? ArrowDown : null;
  return (
    <span
      className="bd-kpi-d"
      role="img"
      aria-label={
        change > 0
          ? t(
              { id: 'board.kpi.up', defaultMessage: '{pct} more than the previous period' },
              { pct },
            )
          : change < 0
            ? t(
                { id: 'board.kpi.down', defaultMessage: '{pct} less than the previous period' },
                { pct },
              )
            : t({ id: 'board.kpi.flat', defaultMessage: 'Same as the previous period' })
      }
    >
      {Arrow && <Arrow aria-hidden="true" />}
      {pct}
    </span>
  );
}

/** The daily values as one line; the box is stretched to the cell, so the stroke is not scaled. */
export function Spark({ bars }: { bars: number[] }) {
  const max = Math.max(0, ...bars);
  // A single day draws as a level line.
  const values = bars.length === 1 ? [bars[0]!, bars[0]!] : bars;
  const step = 100 / Math.max(1, values.length - 1);
  const d = values
    .map((v, i) => {
      const y = 26 - (max ? (v / max) * 24 : 0);
      return `${i ? 'L' : 'M'}${+(i * step).toFixed(2)} ${+y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg
      className="bd-kpi-s"
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      width="72"
      height="24"
      aria-hidden="true"
    >
      {values.length > 0 && <path d={d} />}
    </svg>
  );
}

/** One cell of a metrics strip: the question, the figure, and what the figure counts over. */
export function Metric({
  label,
  text,
  note,
  tip,
  children,
}: {
  label: string;
  text: string;
  note?: string;
  tip?: string;
  children?: ReactNode;
}) {
  return (
    <div className="bd-kpi">
      <span className="bd-kpi-k">{label}</span>
      <span className="bd-kpi-v">
        {tip ? (
          <Tip content={tip}>
            <b tabIndex={0}>{text}</b>
          </Tip>
        ) : (
          <b>{text}</b>
        )}
        {note && <span className="bd-kpi-n">{note}</span>}
        {children}
      </span>
    </div>
  );
}

/** One strip of the range's key usage figures above the usage panels. */
export function KpiTiles({ model }: { model: BoardModel }) {
  const k = useMemo(() => kpis(model), [model]);
  const stored = useCurrentProject((s) => s.projectId);
  const projectId = useBoard((s) => currentProject(s.board, stored)?.id ?? null);
  const listed = useSessionList(projectId).data;
  // Sessions that reported no tokens leave the token sums a known part only.
  const unreported = model.counts.sessions_without_usage ?? 0;
  const plus = unreported > 0 ? '+' : '';
  const tip =
    unreported > 0
      ? t(
          {
            id: 'board.kpi.unreported',
            defaultMessage:
              '{count, plural, one {# session reported no usage} other {# sessions reported no usage}}',
          },
          { count: unreported },
        )
      : undefined;
  const tokens = k.tokens.value ?? 0;
  // No session in the range reported tokens, so the sums are unknown rather than zero.
  const unknown = tokens === 0 && unreported > 0;
  const merged = model.counts.merged;
  const active = listed?.filter((s) => Date.parse(s.last_activity_at) >= model.since) ?? [];
  const compacted = model.counts.compacted_sessions ?? 0;
  const share = (value: number | undefined) =>
    value === undefined ? undefined : `${Math.round(value * 100)}%`;
  const cacheBefore = previousText(k.days.length, share(model.counts.previous?.cache_read_share));
  return (
    <section
      className="bd-kpis"
      aria-label={t({ id: 'board.kpi.label', defaultMessage: 'Usage overview' })}
    >
      <Metric
        label={t({ id: 'board.kpi.tokens', defaultMessage: 'Tokens this period' })}
        text={unknown ? '—' : `${tokenText(tokens)}${plus}`}
        tip={tip}
      >
        {!unknown && <Change change={k.tokens.change} />}
        {!unknown && <Spark bars={k.tokens.bars} />}
      </Metric>
      <Metric
        label={t({ id: 'board.kpi.cacheHits', defaultMessage: 'Cache hits' })}
        text={share(model.counts.cache_read_share) ?? '—'}
        note={cacheBefore}
      />
      <Metric
        label={t({ id: 'insights.kpi.perMerge', defaultMessage: 'Tokens per merge' })}
        text={merged > 0 && !unknown ? `${tokenText(tokens / merged)}${plus}` : '—'}
        note={
          merged > 0
            ? t(
                {
                  id: 'insights.kpi.merges',
                  defaultMessage: '{count, plural, one {of # merge} other {of # merges}}',
                },
                { count: merged },
              )
            : undefined
        }
        tip={merged > 0 ? tip : undefined}
      />
      <Metric
        label={t({ id: 'insights.kpi.compacted', defaultMessage: 'Sessions compacted' })}
        text={active.length > 0 ? String(compacted) : '—'}
        note={
          active.length > 0
            ? t(
                {
                  id: 'insights.kpi.sessions',
                  defaultMessage: '{count, plural, one {of # session} other {of # sessions}}',
                },
                { count: active.length },
              )
            : undefined
        }
      />
    </section>
  );
}
