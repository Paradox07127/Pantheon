import { Check, CircleAlert, Clock, RefreshCw, Share2, Undo2 } from 'lucide-react';
import type { MemoryRecord } from '@pantheon/domain';
import { toast } from '../../components/Toast';
import { t } from '../../i18n';
import './entry-actions.css';

export interface EntryActionsProps {
  item: MemoryRecord;
  /** Every record with the item's key, so an archived one can name the version that replaced it. */
  versions: MemoryRecord[];
  busy?: boolean;
  onCommit: () => void;
  onDiscard: () => void;
  onRewrite: () => void;
  onRetract: () => void;
  onRestore: () => void;
  onOpen: (memoryId: string) => void;
  onShowInGraph: () => void;
}

/** Committed versions of one key numbered from 1 by commit time. */
export function versionNumbers(versions: MemoryRecord[]): Map<string, number> {
  return new Map(
    versions
      .filter((v) => v.committed_at !== undefined)
      .sort((a, b) => a.committed_at! - b.committed_at!)
      .map((v, i) => [v.id, i + 1]),
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => d.toDateString();
function dateText(d: Date, today: Date) {
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === today.getFullYear() ? date : `${d.getFullYear()}-${date}`;
}
function relativeDay(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day =
    dayOf(d) === dayOf(today) ? 'today' : dayOf(d) === dayOf(yesterday) ? 'yesterday' : '';
  return { d, today, time, day };
}
/** Today and yesterday with the time, older days by date. */
function stamp(ms: number) {
  const { d, today, time, day } = relativeDay(ms);
  if (day === 'today')
    return t({ id: 'memory.actions.today', defaultMessage: 'Today {time}' }, { time });
  if (day === 'yesterday')
    return t({ id: 'memory.actions.yesterday', defaultMessage: 'Yesterday {time}' }, { time });
  return dateText(d, today);
}
/** The time alone today, then yesterday, then the date. */
export function shortStamp(ms: number) {
  const { d, today, time, day } = relativeDay(ms);
  if (day === 'today') return time;
  if (day === 'yesterday')
    return t({ id: 'memory.actions.yesterdayShort', defaultMessage: 'Yesterday' });
  return dateText(d, today);
}

/** The notice after the current version is retracted; `dependents` counts the entries archived with it. */
export function retractedToast(title: string, dependents: number, undo: () => void) {
  toast({
    title: dependents
      ? t(
          {
            id: 'memory.actions.retractedWith',
            defaultMessage: 'Retracted “{title}” and {count} that rested on it',
          },
          { title, count: dependents },
        )
      : t({ id: 'memory.actions.retracted', defaultMessage: 'Retracted “{title}”' }, { title }),
    action: { label: t({ id: 'memory.actions.undo', defaultMessage: 'Undo' }), run: undo },
  });
}

export function EntryActions({
  item,
  versions,
  busy = false,
  onCommit,
  onDiscard,
  onRewrite,
  onRetract,
  onRestore,
  onOpen,
  onShowInGraph,
}: EntryActionsProps) {
  const graph = (
    <button type="button" className="btn ghost ma-end" disabled={busy} onClick={onShowInGraph}>
      <Share2 aria-hidden="true" />
      {t({ id: 'memory.actions.showInGraph', defaultMessage: 'Show in graph' })}
    </button>
  );
  if (item.state === 'draft')
    return (
      <div className="ma">
        <div className="ma-row">
          <button type="button" className="btn pri" disabled={busy} onClick={onCommit}>
            <Check aria-hidden="true" />
            {t({ id: 'memory.actions.commit', defaultMessage: 'Confirm' })}
          </button>
          <button type="button" className="btn ghost dng" disabled={busy} onClick={onDiscard}>
            {t({ id: 'memory.actions.discard', defaultMessage: 'Discard' })}
          </button>
          {graph}
        </div>
      </div>
    );
  if (item.state === 'active')
    return (
      <div className="ma">
        <div className="ma-row">
          <button type="button" className="btn" disabled={busy} onClick={onRewrite}>
            {t({ id: 'memory.actions.rewrite', defaultMessage: 'Rewrite' })}
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={onRetract}>
            {t({ id: 'memory.actions.retract', defaultMessage: 'Retract' })}
          </button>
          {graph}
        </div>
      </div>
    );
  const replacement = item.superseded_by && versionNumbers(versions).get(item.superseded_by);
  return (
    <div className="ma">
      {item.reason && (
        <div className="ma-why">
          {item.reason === 'superseded' ? (
            <>
              <RefreshCw aria-hidden="true" />
              {item.superseded_by ? (
                <button
                  type="button"
                  className="ma-lnk"
                  onClick={() => onOpen(item.superseded_by!)}
                >
                  {replacement
                    ? t(
                        {
                          id: 'memory.actions.supersededBy',
                          defaultMessage: 'Replaced by version {n}',
                        },
                        { n: replacement },
                      )
                    : t({ id: 'memory.actions.superseded', defaultMessage: 'Replaced' })}
                </button>
              ) : (
                <span>{t({ id: 'memory.actions.superseded', defaultMessage: 'Replaced' })}</span>
              )}
            </>
          ) : item.reason === 'expired' ? (
            <>
              <Clock aria-hidden="true" />
              <span>{t({ id: 'memory.actions.expired', defaultMessage: 'Expired' })}</span>
            </>
          ) : item.reason === 'retracted' ? (
            <>
              <Undo2 aria-hidden="true" />
              <span>{t({ id: 'memory.actions.byYou', defaultMessage: 'You retracted it' })}</span>
            </>
          ) : (
            <>
              <CircleAlert aria-hidden="true" />
              <span>
                {t({
                  id: 'memory.actions.stale',
                  defaultMessage: 'What it rested on was archived',
                })}
              </span>
            </>
          )}
          {item.archived_at !== undefined && (
            <span className="ma-time">{stamp(item.archived_at)}</span>
          )}
        </div>
      )}
      <div className="ma-row">
        <button type="button" className="btn" disabled={busy} onClick={onRestore}>
          {t({ id: 'memory.actions.restore', defaultMessage: 'Restore as draft' })}
        </button>
        <span className="ma-hint">
          {t({
            id: 'memory.actions.restoreHint',
            defaultMessage: 'Takes effect only after another confirm',
          })}
        </span>
        {graph}
      </div>
    </div>
  );
}
