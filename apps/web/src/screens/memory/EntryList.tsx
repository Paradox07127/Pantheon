import type { KeyboardEvent, ReactNode, UIEvent } from 'react';
import type { MemorySummary } from '@pantheon/domain';
import { CircleAlert, Clock, RefreshCw, Search, Undo2 } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import { kindIcon as kindGlyph } from './memory-kind';
import './entry-list.css';

export interface EntryListProps {
  state: 'active' | 'draft' | 'archived';
  /** Every page read so far, in directory order. */
  records: MemorySummary[];
  /** The search words; non-empty turns the rows into search results. */
  query: string;
  total: number;
  pageSize: number;
  indexPending: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** The directory changed under the cursor, so the next page would not follow on. */
  stale: boolean;
  onFirstPage: () => void;
  onRestore: (id: string) => void;
  /** A command is running; restoring waits for it. */
  busy: boolean;
  /** The title of the session that proposed a draft; undefined when it is not known. */
  authorTitle: (sessionId: string) => string | undefined;
}

// Within this many pixels of the end, scrolling reads the next page.
const NEAR_END = 120;
// A row shows this many tags and counts the rest.
const ROW_TAGS = 2;

const KINDS = {
  decision: {
    icon: kindGlyph('decision'),
    get label() {
      return t({ id: 'memory.list.kind.decision', defaultMessage: 'Decision' });
    },
  },
  report: {
    icon: kindGlyph('report'),
    get label() {
      return t({ id: 'memory.list.kind.report', defaultMessage: 'Report' });
    },
  },
  note: {
    icon: kindGlyph('note'),
    get label() {
      return t({ id: 'memory.list.kind.note', defaultMessage: 'Note' });
    },
  },
};

const REASONS = {
  superseded: {
    icon: <RefreshCw aria-hidden="true" />,
    get label() {
      return t({
        id: 'memory.list.reason.superseded',
        defaultMessage: 'Replaced by a newer version',
      });
    },
  },
  expired: {
    icon: <Clock aria-hidden="true" />,
    get label() {
      return t({ id: 'memory.list.reason.expired', defaultMessage: 'Expired' });
    },
  },
  retracted: {
    icon: <Undo2 aria-hidden="true" />,
    get label() {
      return t({ id: 'memory.list.reason.retracted', defaultMessage: 'You withdrew it' });
    },
  },
  stale: {
    icon: <CircleAlert aria-hidden="true" />,
    get label() {
      return t({
        id: 'memory.list.reason.stale',
        defaultMessage: 'A memory it relies on was archived',
      });
    },
  },
};

/** Where the search words were found, read from the directory's match reasons. */
function matchedIn(r: MemorySummary, query: string): string {
  const q = query.trim().toLowerCase();
  const places = new Set<string>();
  const title = t({ id: 'memory.list.match.title', defaultMessage: 'title' });
  for (const reason of r.reasons ?? []) {
    if (reason.startsWith('tag_exact:'))
      places.add(
        t(
          { id: 'memory.list.match.tag', defaultMessage: 'tag {tag}' },
          { tag: reason.slice('tag_exact:'.length) },
        ),
      );
    else if (reason === 'title_exact') places.add(title);
    else if (reason === 'key_exact') places.add('key');
    else if (reason === 'metadata')
      places.add(
        r.title.toLowerCase().includes(q)
          ? title
          : r.summary.toLowerCase().includes(q)
            ? t({ id: 'memory.list.match.summary', defaultMessage: 'summary' })
            : 'key',
      );
    else if (reason === 'fts' || reason === 'literal')
      places.add(t({ id: 'memory.list.match.body', defaultMessage: 'body' }));
  }
  return listText(...places);
}

function lit(title: string, query: string): ReactNode {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return title;
  const pattern = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  );
  return title.split(pattern).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="hit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function kindIcon(r: MemorySummary) {
  const kind = KINDS[r.kind];
  return (
    <Tip content={kind.label}>
      <span className="ml-ic" role="img" aria-label={kind.label}>
        {kind.icon}
      </span>
    </Tip>
  );
}

function titleCell(r: MemorySummary) {
  if (r.indexed) return <span className="ml-t">{r.title}</span>;
  const pending = t({
    id: 'memory.list.unindexed',
    defaultMessage: 'Not indexed yet; search matches only its title, summary and tags',
  });
  return (
    <span className="ml-tw">
      <span className="ml-t">{r.title}</span>
      <Tip content={pending}>
        <span className="ml-ix" role="img" aria-label={pending}>
          <Clock aria-hidden="true" />
        </span>
      </Tip>
    </span>
  );
}

/** A row that becomes selected scrolls into view, and takes focus when focus was in the list. */
function reveal(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  if (el.closest('[role="listbox"]')?.contains(el.ownerDocument.activeElement))
    el.focus({ preventScroll: true });
}

/** Up and down move focus and the selection to the row above or below the focused one. */
function moveSelection(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  const at = rows.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.click();
}

export function EntryList(p: EntryListProps) {
  const now = Date.now();
  const tabStop = p.records.some((r) => r.id === p.selectedId) ? p.selectedId : p.records[0]?.id;
  const option = (r: MemorySummary, className: string, cells: ReactNode) => (
    <div
      key={r.id}
      ref={r.id === p.selectedId ? reveal : undefined}
      className={className}
      role="option"
      aria-selected={r.id === p.selectedId}
      tabIndex={r.id === tabStop ? 0 : -1}
      onClick={() => p.onSelect(r.id)}
      onKeyDown={(e) => {
        if ((e.key !== 'Enter' && e.key !== ' ') || e.target !== e.currentTarget) return;
        e.preventDefault();
        p.onSelect(r.id);
      }}
    >
      {cells}
    </div>
  );
  const row = (r: MemorySummary) => {
    if (p.query.trim())
      return option(
        r,
        'ml-qrow',
        <>
          {kindIcon(r)}
          <span className="ml-t">{lit(r.title, p.query)}</span>
          <span className="ml-s">{r.summary}</span>
          <span className="ml-r">
            <Search aria-hidden="true" />
            <span className="ml-why">{matchedIn(r, p.query)}</span>
          </span>
          <span className="ml-tm">{dayText(r.created_at, now, { time: true })}</span>
        </>,
      );
    if (r.state === 'archived') {
      const reason = r.reason && REASONS[r.reason];
      // An option cannot hold controls; the details column offers both actions.
      const link = (id: string, label: string) => (
        <button
          type="button"
          className="ml-lnk"
          tabIndex={-1}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            p.onSelect(id);
          }}
        >
          {label}
        </button>
      );
      return option(
        r,
        'ml-arow',
        <>
          {kindIcon(r)}
          <span className="ml-tw">
            <span className="ml-t">{r.title}</span>
            {r.version !== undefined && (
              <span className="ml-v">
                {t(
                  { id: 'memory.list.version', defaultMessage: 'Version {number}' },
                  { number: r.version },
                )}
              </span>
            )}
          </span>
          <span className="ml-r">
            {reason && reason.icon}
            {r.superseded_by ? (
              <>
                {link(r.superseded_by, REASONS.superseded.label)}
                {r.superseded_by_version !== undefined && (
                  <span className="ml-v">
                    {t(
                      { id: 'memory.list.version', defaultMessage: 'Version {number}' },
                      { number: r.superseded_by_version },
                    )}
                  </span>
                )}
              </>
            ) : r.basis_id ? (
              link(r.basis_id, r.basis_title ?? REASONS.stale.label)
            ) : r.reason === 'expired' && r.expires_at !== undefined ? (
              <span className="ml-why">
                {t(
                  { id: 'memory.list.expiredOn', defaultMessage: 'Expired {when}' },
                  { when: dayText(r.expires_at, now, { time: true }) },
                )}
              </span>
            ) : (
              reason && <span className="ml-why">{reason.label}</span>
            )}
          </span>
          <span className="ml-act">
            <button
              type="button"
              className="btn ghost sm"
              tabIndex={-1}
              aria-hidden
              disabled={p.busy}
              onClick={(e) => {
                e.stopPropagation();
                p.onRestore(r.id);
              }}
            >
              {t({ id: 'memory.list.restore', defaultMessage: 'Restore as draft' })}
            </button>
          </span>
          <span className="ml-tm">
            {r.archived_at !== undefined && dayText(r.archived_at, now, { time: true })}
          </span>
        </>,
      );
    }
    return option(
      r,
      'ml-row',
      <>
        {kindIcon(r)}
        {titleCell(r)}
        <span className="ml-s">{r.summary}</span>
        <span className="ml-tg">
          {r.tags.slice(0, ROW_TAGS).map((tag) => (
            <span key={tag} className="chip">
              {tag}
            </span>
          ))}
          {r.tags.length > ROW_TAGS && (
            <Tip content={listText(...r.tags.slice(ROW_TAGS))}>
              <span className="chip">
                {t(
                  { id: 'memory.list.moreTags', defaultMessage: '+{count}' },
                  { count: r.tags.length - ROW_TAGS },
                )}
              </span>
            </Tip>
          )}
        </span>
        <span className="ml-by">
          {(r.state === 'draft' && r.author_session_id && p.authorTitle(r.author_session_id)) ||
            (r.origin
              ? t({ id: 'memory.list.byPlan', defaultMessage: 'Set in the plan' })
              : r.authority === 'user'
                ? t({ id: 'memory.list.byUser', defaultMessage: 'Set by you' })
                : t({ id: 'memory.list.byAgent', defaultMessage: 'Agent report' }))}
        </span>
        <span className="ml-tm">
          {r.state === 'draft' && (
            <span
              className="ml-wait"
              role="img"
              aria-label={t({ id: 'memory.list.pending', defaultMessage: 'Pending review' })}
            />
          )}
          {dayText(r.created_at, now, { time: true })}
        </span>
      </>,
    );
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!p.hasMore || p.loadingMore || p.stale) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) p.onLoadMore();
  };
  return (
    <div className="ml-list" onScroll={onScroll}>
      {!!p.query.trim() && p.indexPending > 0 && (
        <div className="ml-nb">
          <Clock aria-hidden="true" />
          <span className="ml-why">
            {t(
              {
                id: 'memory.list.searchUnindexed',
                defaultMessage:
                  '{count, plural, one {# body is} other {# bodies are}} not indexed yet; a miss does not mean it is not there',
              },
              { count: p.indexPending },
            )}
          </span>
        </div>
      )}
      {p.query.trim() && !p.records.length ? (
        <EmptyState
          graphic={<Search aria-hidden="true" />}
          title={t({ id: 'memory.list.noMatch', defaultMessage: 'No matching memory' })}
        />
      ) : (
        <div
          role="listbox"
          aria-label={
            p.state === 'draft'
              ? t({ id: 'memory.list.label.draft', defaultMessage: 'Memory pending review' })
              : p.state === 'archived'
                ? t({ id: 'memory.list.label.archived', defaultMessage: 'Archived memory' })
                : t({ id: 'memory.list.label.active', defaultMessage: 'Current memory' })
          }
          aria-busy={p.loadingMore || undefined}
          onKeyDown={moveSelection}
        >
          {p.records.map(row)}
        </div>
      )}
      {p.stale ? (
        <div className="ml-nb" role="alert">
          <RefreshCw aria-hidden="true" />
          <span className="ml-why">
            {t({
              id: 'memory.list.stale',
              defaultMessage: 'The memory changed; this page no longer lines up',
            })}
          </span>
          <button type="button" className="btn sm" onClick={p.onFirstPage}>
            {t({ id: 'memory.list.firstPage', defaultMessage: 'Back to the first page' })}
          </button>
        </div>
      ) : (
        p.hasMore && (
          <div className="ml-more">
            <span className="ml-ct">{`${p.records.length} / ${p.total}`}</span>
            <button
              type="button"
              className="btn sm"
              disabled={p.loadingMore}
              onClick={p.onLoadMore}
            >
              {t(
                { id: 'memory.list.more', defaultMessage: 'Read {count} more' },
                { count: Math.min(p.total - p.records.length, p.pageSize) },
              )}
            </button>
          </div>
        )
      )}
    </div>
  );
}
