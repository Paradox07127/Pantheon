import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import type { WorkstreamRow } from './facts';

/** Status and title on the left, done against open items as one bar, counts on the right. */
export function WorkstreamBars({ rows }: { rows: readonly WorkstreamRow[] }) {
  return (
    <div className="ws-list" role="list">
      {rows.map((row) => (
        <div key={row.id} className="ws-row" role="listitem">
          <span className={row.tone ? `tr-st ${row.tone}` : 'tr-st'}>{row.status}</span>
          <Tip content={row.hint}>
            <span className="ws-title">{row.title}</span>
          </Tip>
          <span
            className="ws-bar"
            role="img"
            aria-label={t(
              {
                id: 'projects.workstream.bar',
                defaultMessage: '{title}: {done} done, {open} open',
              },
              { title: row.title, done: row.done, open: row.open },
            )}
          >
            {row.total > 0 && (
              <>
                <i style={{ width: `${(row.done / row.total) * 100}%` }} />
                <i className="op" style={{ width: `${(row.open / row.total) * 100}%` }} />
              </>
            )}
          </span>
          <span className="ws-n">
            {row.total > 0 && row.counts}
            {row.missing && <small>{row.missing}</small>}
          </span>
        </div>
      ))}
    </div>
  );
}
