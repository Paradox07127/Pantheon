import type { CSSProperties, ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Clock, RefreshCw } from 'lucide-react';
import type { MemoryDirectory } from '@pantheon/domain';
import { Equalizer } from '../../components/Equalizer';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import './entries-footer.css';

/** A session of `memory.read`, with the runtime it runs on from the board. */
export type DeliverySession = MemoryDirectory['sessions'][number] & { runtime?: string };

type Delivery = 'delivered' | 'waiting' | 'none';

const deliveryOf = (s: DeliverySession): Delivery =>
  s.delivered ? 'delivered' : s.memory_tool ? 'waiting' : 'none';

const GROUPS: { key: Delivery; glyph: string; label: () => string }[] = [
  {
    key: 'delivered',
    glyph: 'ok',
    label: () => t({ id: 'memory.status.delivery.delivered', defaultMessage: 'Delivered' }),
  },
  {
    key: 'waiting',
    glyph: 'queue',
    label: () => t({ id: 'memory.status.delivery.waiting', defaultMessage: 'Next turn' }),
  },
  {
    key: 'none',
    glyph: 'idle',
    label: () =>
      t({ id: 'memory.status.delivery.none', defaultMessage: 'No memory tool in this session' }),
  },
];

/** The sessions by delivery, each row opening its session. */
export function DeliveryList({
  sessions,
  onOpenSession,
}: {
  sessions: DeliverySession[];
  onOpenSession: (id: string) => void;
}) {
  return (
    <>
      {GROUPS.map((group) => {
        const rows = sessions.filter((s) => deliveryOf(s) === group.key);
        if (!rows.length) return null;
        return [
          <div key={group.key} className="mef-h">
            <span className="mst" data-st={group.glyph} aria-hidden="true" />
            {group.label()}
            <span className="mef-ct">{rows.length}</span>
          </div>,
          ...rows.map((s) => (
            <button
              key={s.id}
              type="button"
              className="mef-row"
              onClick={() => onOpenSession(s.id)}
            >
              {s.runtime && <RuntimeGlyph runtime={s.runtime} />}
              <span className="mef-cut">{s.title ?? s.id}</span>
            </button>
          )),
        ];
      })}
    </>
  );
}

interface EntriesFooterProps {
  directory: Pick<MemoryDirectory, 'signature' | 'jobs' | 'document_ready' | 'index_pending'>;
  sessions: DeliverySession[];
  onOpenSession: (id: string) => void;
  onOpenOverview: () => void;
  onRetryDocument: () => void;
}

/** The entries page's bottom bar: delivery to sessions, the progress document and indexing. */
export function EntriesFooter({
  directory,
  sessions,
  onOpenSession,
  onOpenOverview,
  onRetryDocument,
}: EntriesFooterProps) {
  const now = useNow();
  const count = (key: Delivery) => sessions.filter((s) => deliveryOf(s) === key).length;
  const counts = { delivered: count('delivered'), waiting: count('waiting'), none: count('none') };
  const job = directory.jobs.find(
    (j) => j.signature === directory.signature && j.state !== 'obsolete',
  );
  const at = job?.completed_at;
  const parts: ReactNode[] = [];
  if (sessions.length)
    parts.push(
      <Popover.Root key="delivery">
        <Popover.Trigger
          className="btn ghost sm"
          aria-label={t(
            {
              id: 'memory.status.delivery.label',
              defaultMessage:
                'Delivery: {delivered, plural, one {# session delivered} other {# sessions delivered}}, {waiting} waiting for the next turn, {none} without a memory tool',
            },
            counts,
          )}
        >
          <span
            className="mef-seg"
            role="img"
            aria-label={t(
              {
                id: 'memory.status.delivery.bar',
                defaultMessage: 'Delivered {delivered}, next turn {waiting}, no memory tool {none}',
              },
              counts,
            )}
          >
            {(
              [
                ['ok', counts.delivered],
                ['wait', counts.waiting],
                ['idle', counts.none],
              ] as const
            )
              .filter(([, n]) => n > 0)
              .map(([tone, n]) => (
                <i key={tone} data-tone={tone} style={{ '--n': n } as CSSProperties} />
              ))}
          </span>
          <span className="mef-num">
            {t(
              {
                id: 'memory.status.delivery.summary',
                defaultMessage:
                  '{delivered, plural, one {# session delivered} other {# sessions delivered}}, {waiting} waiting for the next turn',
              },
              counts,
            )}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4} style={{ zIndex: 40 }}>
            <Popover.Popup
              className="pop mef-pop"
              aria-label={t({ id: 'memory.status.delivery.title', defaultMessage: 'Delivery' })}
            >
              <DeliveryList sessions={sessions} onOpenSession={onOpenSession} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>,
    );
  if (directory.document_ready)
    parts.push(
      <button key="document" type="button" className="mef-doc" onClick={onOpenOverview}>
        <span className="mst" data-st="ok" aria-hidden="true" />
        {t({ id: 'memory.status.document.ready', defaultMessage: 'Progress document updated' })}
        {at !== undefined && <span className="mef-time">{dayText(at, now, { time: true })}</span>}
      </button>,
    );
  else if (job?.state === 'pending' || job?.state === 'running')
    parts.push(
      <span key="document" className="mef-doc-run">
        <span className="mst" data-st="run" aria-hidden="true">
          <Equalizer />
        </span>
        <span className="mef-working">
          {t({
            id: 'memory.status.document.working',
            defaultMessage: 'Writing the progress document',
          })}
        </span>
        <span className="mef-num">
          {t(
            {
              id: 'memory.status.document.attempt',
              defaultMessage:
                'Attempt {attempt}, {seconds, plural, one {# second} other {# seconds}}',
            },
            {
              attempt: job.state === 'running' ? job.attempts : job.attempts + 1,
              seconds: Math.max(0, Math.floor((now - job.created_at) / 1000)),
            },
          )}
        </span>
      </span>,
    );
  else if (job?.state === 'failed')
    parts.push(
      <span key="document" className="mef-doc-bad" role="alert">
        <span className="mst" data-st="bad" aria-hidden="true" />
        <span>
          {t(
            {
              id: 'memory.status.document.failed',
              defaultMessage:
                'Progress document failed after {attempts, plural, one {# attempt} other {# attempts}}',
            },
            { attempts: job.attempts },
          )}
        </span>
        {job.error && <span className="mef-err">{job.error}</span>}
        <button type="button" className="btn sm" onClick={onRetryDocument}>
          <RefreshCw aria-hidden="true" />
          {t({ id: 'memory.status.retry', defaultMessage: 'Retry' })}
        </button>
      </span>,
    );
  if (directory.index_pending > 0)
    parts.push(
      <span key="index" className="mef-idx">
        <Clock aria-hidden="true" />
        <span className="mef-num">
          {t(
            {
              id: 'memory.status.indexPending',
              defaultMessage:
                '{count, plural, one {# entry not indexed yet} other {# entries not indexed yet}}',
            },
            { count: directory.index_pending },
          )}
        </span>
      </span>,
    );
  return (
    <div className="mef">
      {parts.flatMap((part, i) =>
        i ? [<span key={`sep-${i}`} className="mef-vsep" aria-hidden="true" />, part] : [part],
      )}
      <span className="mef-keys">
        <span className="kbd">J</span>
        <span className="kbd">K</span>
        {t({ id: 'memory.status.move', defaultMessage: 'Move' })}
      </span>
    </div>
  );
}
