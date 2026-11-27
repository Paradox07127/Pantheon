import type { ChangeRow, ProjectOverlap, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { GateMark, StateGlyph } from '../../components/SessionStateIcon';
import { changeSessionId } from '../../data/changes';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { gateText, RowMark, STATUS_GLYPH } from '../changes/ChangesScreen';
import { overlapText, overlapsOf } from './project-model';

/** One change as a row: status, title, runtime, diff size and gate; a session's row opens it. */
export function ChangeLine({ row, shared = null }: { row: ChangeRow; shared?: string | null }) {
  const sessionId = changeSessionId(row);
  const body = (
    <>
      <StateGlyph name={STATUS_GLYPH[row.status]} />
      <span className="pj-t">
        <Clip text={row.title} />
        {shared && (
          <span className="pj-why">
            <Clip text={shared} />
          </span>
        )}
      </span>
      <RowMark row={row} />
      <span className="pj-diff">
        {row.changes && (
          <DiffCounts additions={row.changes.additions} deletions={row.changes.deletions} />
        )}
      </span>
      <span className="pj-gate">
        <GateMark state={row.gate.state} />
        <Clip text={gateText(row.gate)} />
      </span>
    </>
  );
  return (
    <li>
      {sessionId ? (
        <button
          type="button"
          className="pj-row"
          onClick={() => useShell.getState().openSession(sessionId)}
        >
          {body}
        </button>
      ) : (
        <div className="pj-row">{body}</div>
      )}
    </li>
  );
}

/** The changes no plan item names. */
export function UnplannedList({
  rows,
  sessions = null,
  overlap = null,
}: {
  rows: readonly ChangeRow[] | null;
  sessions?: readonly WorkbenchSession[] | null;
  /** null while the overlap is unread or its read failed. */
  overlap?: ProjectOverlap | null;
}) {
  const title = t({ id: 'project.unplanned.title', defaultMessage: 'Unplanned' });
  return (
    <section className="pj-list" aria-label={title} aria-busy={rows === null || undefined}>
      <div className="pj-lh">
        <h2 className="pj-h2">{title}</h2>
        {rows && <span className="pj-n">{rows.length}</span>}
      </div>
      {rows && rows.length > 0 && (
        <ul className="pj-rows">
          {rows.map((row) => (
            <ChangeLine
              key={row.id}
              row={row}
              shared={overlapText(overlapsOf(overlap, changeSessionId(row)), sessions)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
