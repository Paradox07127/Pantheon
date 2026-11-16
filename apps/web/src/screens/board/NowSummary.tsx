import { useId, useMemo, useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { shortId } from '../../data/format';
import { nowSummary } from '../../data/now-summary';
import { t } from '../../i18n';
import { compareRuntimes, durationText, runtimeName, tokenText } from './panels-model';
import './now-summary.css';

export interface NowSummaryProps {
  model: BoardModel;
  onOpenSession: (sessionId: string) => void;
}

const percent = (share: number) => Math.round(share * 100);

function Bars({ values, label }: { values: { value: number; state?: string }[]; label: string }) {
  const top = Math.max(...values.map((v) => v.value));
  return (
    <span className="bns-bars" role="img" aria-label={label}>
      {values.map((v, i) => (
        <i
          key={i}
          data-state={v.state}
          style={{ '--v': `${top ? (v.value / top) * 100 : 0}%` } as CSSProperties}
        />
      ))}
    </span>
  );
}

/** The now view's bottom strip: today's ended sessions, gates, usage and merges. */
export function NowSummary({ model, onOpenSession }: NowSummaryProps) {
  const summary = useMemo(() => nowSummary(model), [model]);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!summary) return null;
  const { ended, gate, usage, merged } = summary;
  const columns = [ended && '1.2fr', gate && '1fr', usage && '1fr', merged && '1fr']
    .filter(Boolean)
    .map((size) => `minmax(0, ${size})`)
    .join(' ');
  const firstPass = gate && percent(gate.first / gate.total);

  return (
    <section
      className="panel bns"
      style={{ gridTemplateColumns: columns }}
      aria-label={t({ id: 'board.summary.label', defaultMessage: 'Summary' })}
    >
      {ended && (
        <button
          type="button"
          className="cell bns-c"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((before) => !before)}
        >
          <span className="bns-h">
            <ChevronRight className="bns-chev" aria-hidden="true" />
            <span className="cap">
              {t({ id: 'board.summary.ended', defaultMessage: 'Ended sessions' })}
            </span>
            <span className="bns-n">{ended.length}</span>
          </span>
          <Bars
            values={ended.map((s) => ({ value: s.ms, state: s.status }))}
            label={t({ id: 'board.summary.ended.bars', defaultMessage: 'Time of each session' })}
          />
        </button>
      )}
      {gate && firstPass !== null && (
        <div className="cell bns-c">
          <span className="cap">
            {t({ id: 'board.summary.gate', defaultMessage: "Today's gates" })}
          </span>
          <span className="bns-h">
            <svg
              className="bns-ring"
              width="32"
              height="32"
              viewBox="0 0 32 32"
              role="img"
              aria-label={t(
                { id: 'board.summary.gate.ring', defaultMessage: 'First-pass rate {percent}%' },
                { percent: firstPass },
              )}
            >
              <circle cx="16" cy="16" r="13" pathLength={100} />
              <circle
                cx="16"
                cy="16"
                r="13"
                pathLength={100}
                strokeDasharray={`${firstPass} 100`}
                transform="rotate(-90 16 16)"
              />
            </svg>
            <span className="bns-n">{firstPass}%</span>
            <span className="bns-mu">
              {t(
                { id: 'board.summary.gate.count', defaultMessage: 'First pass {first} / {total}' },
                { first: gate.first, total: gate.total },
              )}
            </span>
          </span>
        </div>
      )}
      {usage && (
        <div className="cell bns-c">
          <span className="cap">
            {t({ id: 'board.summary.usage', defaultMessage: "Today's usage" })}
          </span>
          {[...usage]
            .sort((a, b) => compareRuntimes(a.runtime, b.runtime))
            .map((u) => (
              <span key={u.runtime} className="bns-h">
                <RuntimeGlyph runtime={u.runtime} />
                <span
                  className="meter bns-meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent(u.share)}
                  aria-label={t(
                    {
                      id: 'board.summary.usage.share',
                      defaultMessage: "{runtime}: {percent}% of today's tokens",
                    },
                    { runtime: runtimeName(u.runtime), percent: percent(u.share) },
                  )}
                  style={{ '--v': `${u.share * 100}%` } as CSSProperties}
                >
                  <i />
                </span>
                <span className="bns-mu">{tokenText(u.tokens)}</span>
              </span>
            ))}
        </div>
      )}
      {merged && (
        <div className="cell bns-c">
          <span className="cap">
            {t({ id: 'board.summary.merged', defaultMessage: 'Merged today' })}
          </span>
          <span className="bns-h">
            <span className="bns-n">{merged.today}</span>
            <Bars
              values={merged.days.map((d) => ({ value: d.count }))}
              label={t(
                {
                  id: 'board.summary.merged.bars',
                  defaultMessage:
                    '{count, plural, one {Merges today} other {Merges per day over the last # days}}',
                },
                { count: merged.days.length },
              )}
            />
          </span>
        </div>
      )}
      {ended && open && (
        <ul
          id={listId}
          className="bns-list"
          aria-label={t({ id: 'board.summary.ended', defaultMessage: 'Ended sessions' })}
        >
          {ended.map((s) => (
            <li key={s.session_id}>
              <button type="button" className="bns-row" onClick={() => onOpenSession(s.session_id)}>
                <span className="bns-title">{s.title || shortId(s.session_id)}</span>
                <span className="bns-mu">{durationText(s.ms)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
