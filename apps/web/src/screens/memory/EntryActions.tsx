import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Check, CircleAlert, Clock, RefreshCw, Share2, Undo2 } from 'lucide-react';
import type { MemoryRecord } from '@pantheon/domain';
import { toast } from '../../components/Toast';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
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
          <AlertDialog.Root>
            <AlertDialog.Trigger className="btn ghost dng" disabled={busy}>
              {t({ id: 'memory.actions.discard', defaultMessage: 'Discard' })}
            </AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Backdrop className="pj-scrim" />
              <AlertDialog.Popup className="pj-dlg pj-rm pop">
                <div className="pj-dh">
                  <AlertDialog.Title className="pj-dt">
                    {t(
                      { id: 'overlays.confirm.discardTitle', defaultMessage: 'Discard “{title}”?' },
                      { title: item.title ?? item.key },
                    )}
                  </AlertDialog.Title>
                </div>
                <div className="pj-df">
                  <span style={{ flex: 1 }} />
                  <AlertDialog.Close className="btn">
                    {t({ id: 'memory.actions.cancel', defaultMessage: 'Cancel' })}
                  </AlertDialog.Close>
                  <AlertDialog.Close className="btn dng" onClick={onDiscard}>
                    {t({ id: 'memory.actions.discard', defaultMessage: 'Discard' })}
                  </AlertDialog.Close>
                </div>
              </AlertDialog.Popup>
            </AlertDialog.Portal>
          </AlertDialog.Root>
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
            <span className="ma-time">{dayText(item.archived_at, Date.now(), { time: true })}</span>
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
