import type { ReactNode } from 'react';
import { Check, File, Globe, User, X } from 'lucide-react';
import type {
  MemoryDirectory,
  MemoryItem,
  MemoryRecord,
  MemoryReference,
  MemorySummary,
} from '@pantheon/domain';
import { Markdown } from '../../components/Markdown';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { t } from '../../i18n';
import { kindIcon } from './GraphLegend';
import { diffLines } from '../../lib/text-diff';
import { dayText } from '../../lib/time-text';
import './entry-detail.css';

export type EntryItem = MemoryItem & {
  reference_status?: (MemoryReference & { status: string })[];
};

export interface EntryDetailProps {
  item: EntryItem;
  /** Every record with the item's key, drafts included, in any order. */
  versions: MemoryItem[];
  dependencies: MemorySummary[];
  dependents: MemorySummary[];
  tasks: MemoryDirectory['facets']['tasks'];
  /** The directory signature now; a draft proposed against it is still the latest. */
  signature?: string;
  /** The session that proposed a draft. */
  author?: { title: string; runtime: string };
  footer: ReactNode;
  onOpen: (memoryId: string) => void;
  /** Sets the list's tag filter to this tag. */
  onTag: (tag: string) => void;
  onClose: () => void;
}

type Tone = 'ok' | 'wait' | 'idle';

const kindText = (kind: MemoryRecord['kind']) =>
  kind === 'decision'
    ? t({ id: 'memory.detail.kind.decision', defaultMessage: 'Decision' })
    : kind === 'report'
      ? t({ id: 'memory.detail.kind.report', defaultMessage: 'Report' })
      : t({ id: 'memory.detail.kind.note', defaultMessage: 'Note' });

const authorityText = (authority: MemoryRecord['authority']) =>
  authority === 'user'
    ? t({ id: 'memory.detail.byUser', defaultMessage: 'You decided' })
    : t({ id: 'memory.detail.byAgent', defaultMessage: 'Agent report' });

const stateTone = (r: Pick<MemoryRecord, 'state'>): Tone =>
  r.state === 'active' ? 'ok' : r.state === 'draft' ? 'wait' : 'idle';

const stateText = (r: Pick<MemoryRecord, 'state' | 'reason' | 'expires_at'>) =>
  r.state === 'active'
    ? t({ id: 'memory.detail.state.active', defaultMessage: 'Current' })
    : r.state === 'draft'
      ? t({ id: 'memory.detail.state.draft', defaultMessage: 'Pending review' })
      : r.reason === 'superseded'
        ? t({ id: 'memory.detail.state.superseded', defaultMessage: 'Replaced' })
        : r.reason === 'expired' && r.expires_at === undefined
          ? // The daemon's idle limit for an agent's note; web does not import control.
            t({ id: 'memory.detail.state.unread', defaultMessage: 'Expired: not read in 90 days' })
          : t({ id: 'memory.detail.state.archived', defaultMessage: 'Archived' });

const sourceStates: Record<string, { tone: Tone | 'bad'; text: () => string }> = {
  unchanged: {
    tone: 'ok',
    text: () => t({ id: 'memory.detail.source.unchanged', defaultMessage: 'Unchanged' }),
  },
  changed: {
    tone: 'wait',
    text: () => t({ id: 'memory.detail.source.changed', defaultMessage: 'Changed' }),
  },
  unversioned: {
    tone: 'idle',
    text: () => t({ id: 'memory.detail.source.unversioned', defaultMessage: 'Not tracked' }),
  },
  unavailable: {
    tone: 'bad',
    text: () => t({ id: 'memory.detail.source.unavailable', defaultMessage: 'Unreadable' }),
  },
  unverified: {
    tone: 'idle',
    text: () => t({ id: 'memory.detail.source.unverified', defaultMessage: 'Not checked' }),
  },
};

const versionText = (n: number) =>
  t({ id: 'memory.detail.version', defaultMessage: 'Version {n}' }, { n });

export function EntryDetail({
  item,
  versions,
  dependencies,
  dependents,
  tasks,
  signature,
  author,
  footer,
  onOpen,
  onTag,
  onClose,
}: EntryDetailProps) {
  const all = versions.some((v) => v.id === item.id) ? versions : [item, ...versions];
  const numbers = new Map(
    all
      .filter((v) => v.committed_at !== undefined)
      .sort((a, b) => a.committed_at! - b.committed_at!)
      .map((v, i) => [v.id, i + 1]),
  );
  const listed = [...all].sort((a, b) => b.created_at - a.created_at);
  const number = numbers.get(item.id);
  const draft = item.state === 'draft';
  const base = draft ? all.find((v) => v.state === 'active' && v.id !== item.id) : undefined;
  const baseNumber = base && numbers.get(base.id);
  const scope = (task: MemoryRecord['task']) =>
    task
      ? (tasks.find((x) => x.id === task.id)?.title ?? task.id)
      : t({ id: 'memory.detail.project', defaultMessage: 'Project' });
  const sources = item.reference_status ?? [];
  const latest = signature === undefined ? undefined : item.based_on === signature;
  const relatedRow = (s: MemorySummary, end: string) => (
    <button key={s.id} type="button" className="ed-row" data-id={s.id} onClick={() => onOpen(s.id)}>
      {kindIcon(s.kind, kindText(s.kind))}
      <span className="ed-rt">{s.title}</span>
      <span className="ed-ct">{end}</span>
    </button>
  );
  return (
    <aside
      className="ed"
      aria-label={t({ id: 'memory.detail.label', defaultMessage: 'Memory details' })}
    >
      <div className="ed-head">
        <div className="ed-tr">
          {kindIcon(item.kind, kindText(item.kind))}
          <h2 className="ed-t">{item.title ?? item.key}</h2>
          <button
            type="button"
            className="ib ed-x"
            aria-label={t({ id: 'memory.detail.close', defaultMessage: 'Close details' })}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {item.summary && <p className="ed-sum">{item.summary}</p>}
        <div className="ed-chips">
          <span className="chip">
            {kindIcon(item.kind)}
            {kindText(item.kind)}
          </span>
          <span className="chip ed-st" data-st={stateTone(item)}>
            {stateText(item)}
          </span>
          {!(draft && item.author_session_id) && (
            <span className="chip">
              {item.authority === 'user' && <User aria-hidden="true" />}
              {authorityText(item.authority)}
            </span>
          )}
          <span className="chip">{scope(item.task)}</span>
        </div>
        {!!item.tags?.length && (
          <div
            className="ed-chips"
            role="group"
            aria-label={t({ id: 'memory.detail.tags', defaultMessage: 'Tags' })}
          >
            {item.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="chip ed-tag"
                aria-label={t(
                  { id: 'memory.detail.filterTag', defaultMessage: 'Show memory tagged {tag}' },
                  { tag },
                )}
                onClick={() => onTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        <dl className="ed-kv">
          <dt>{t({ id: 'memory.detail.key', defaultMessage: 'key' })}</dt>
          <dd>
            <span className="ed-key">{item.key}</span>
          </dd>
          {number !== undefined && (
            <>
              <dt>{t({ id: 'memory.detail.versionLabel', defaultMessage: 'Version' })}</dt>
              <dd className="ed-num">{versionText(number)}</dd>
            </>
          )}
          {item.committed_at !== undefined && (
            <>
              <dt>{t({ id: 'memory.detail.committed', defaultMessage: 'In effect' })}</dt>
              <dd className="ed-num">{dayText(item.committed_at, Date.now(), { time: true })}</dd>
            </>
          )}
          {item.last_used_at !== undefined && (
            <>
              <dt>{t({ id: 'memory.detail.lastRead', defaultMessage: 'Last read' })}</dt>
              <dd className="ed-num">{dayText(item.last_used_at, Date.now(), { time: true })}</dd>
            </>
          )}
          {draft && (
            <>
              <dt>{t({ id: 'memory.detail.proposed', defaultMessage: 'Proposed' })}</dt>
              <dd>
                {author && <RuntimeGlyph runtime={author.runtime} size={14} />}
                {author && <span className="ed-rt">{author.title}</span>}
                <span className="ed-mu ed-num">
                  {dayText(item.created_at, Date.now(), { time: true })}
                </span>
              </dd>
              <dt>{t({ id: 'memory.detail.basedOn', defaultMessage: 'Based on' })}</dt>
              <dd>
                {baseNumber !== undefined && (
                  <span className="ed-num">{versionText(baseNumber)}</span>
                )}
                <span className="ed-sig">{item.based_on.slice(0, 8)}</span>
                {latest === true && (
                  <>
                    <Check className="ed-ok" aria-hidden="true" />
                    <span className="ed-mu">
                      {t({ id: 'memory.detail.latest', defaultMessage: 'Still the latest' })}
                    </span>
                  </>
                )}
                {latest === false && (
                  <>
                    <span className="ed-dot" aria-hidden="true" />
                    <span className="ed-mu">
                      {t({ id: 'memory.detail.notLatest', defaultMessage: 'No longer the latest' })}
                    </span>
                  </>
                )}
              </dd>
            </>
          )}
        </dl>
      </div>

      {base ? (
        <section className="ed-sec">
          <h3 className="cap">
            {baseNumber !== undefined
              ? t(
                  { id: 'memory.detail.compare', defaultMessage: 'Compared with version {n}' },
                  { n: baseNumber },
                )
              : t({ id: 'memory.detail.compareCurrent', defaultMessage: 'Compared with current' })}
          </h3>
          <div className="ed-diff">
            {diffLines(base.text, item.text).map((line, i) => (
              <div key={i} data-kind={line.kind}>
                <span>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="ed-body">
          <Markdown text={item.text} />
        </div>
      )}

      {sources.length > 0 && (
        <section className="ed-sec">
          <h3 className="cap">
            {t(
              { id: 'memory.detail.sources', defaultMessage: 'Sources {count}' },
              { count: sources.length },
            )}
          </h3>
          {item.verified_commit && (
            <dl className="ed-kv">
              <dt>{t({ id: 'memory.detail.checkedAt', defaultMessage: 'Checked at' })}</dt>
              <dd>
                <span className="ed-sig">{item.verified_commit.slice(0, 7)}</span>
              </dd>
            </dl>
          )}
          {sources.map((s, i) => {
            const state = sourceStates[s.status] ?? sourceStates.unverified!;
            return (
              <div key={`${s.uri}-${i}`} className="ed-src">
                {s.kind === 'url' ? <Globe aria-hidden="true" /> : <File aria-hidden="true" />}
                <span className="ed-uri">{s.uri.replace(/^https?:\/\//, '')}</span>
                <span className="chip ed-st" data-st={state.tone}>
                  {state.text()}
                </span>
              </div>
            );
          })}
        </section>
      )}

      {dependencies.length > 0 && (
        <section className="ed-sec">
          <h3 className="cap">
            {t(
              { id: 'memory.detail.dependencies', defaultMessage: 'Rests on {count}' },
              { count: dependencies.length },
            )}
          </h3>
          {dependencies.map((s) => relatedRow(s, authorityText(s.authority)))}
        </section>
      )}

      {dependents.length > 0 && (
        <section className="ed-sec">
          <h3 className="cap">
            {t(
              { id: 'memory.detail.dependents', defaultMessage: 'Rested on by {count}' },
              { count: dependents.length },
            )}
          </h3>
          {dependents.map((s) => relatedRow(s, scope(s.task)))}
        </section>
      )}

      <section className="ed-sec">
        <h3 className="cap">
          {t(
            { id: 'memory.detail.versions', defaultMessage: 'Versions {count}' },
            { count: listed.length },
          )}
        </h3>
        {listed.map((v) => {
          const n = numbers.get(v.id);
          return (
            <button
              key={v.id}
              type="button"
              className="ed-row"
              data-id={v.id}
              aria-current={v.id === item.id ? 'true' : undefined}
              onClick={() => onOpen(v.id)}
            >
              <span className="ed-vn">
                {n === undefined
                  ? t({ id: 'memory.detail.draft', defaultMessage: 'Draft' })
                  : versionText(n)}
              </span>
              <span className="chip ed-st" data-st={stateTone(v)}>
                {stateText(v)}
              </span>
              <span className="ed-ct">
                {dayText(v.committed_at ?? v.created_at, Date.now(), { time: true })}
              </span>
            </button>
          );
        })}
      </section>

      {footer != null && <div className="ed-foot">{footer}</div>}
    </aside>
  );
}
