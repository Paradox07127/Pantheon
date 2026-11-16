import type { CSSProperties } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import type { MemoryItem, MemoryRecord } from '@pantheon/domain';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import type { BudgetRefusal } from '../../data/memory-context';
import { t } from '../../i18n';
import { diffLines } from '../../lib/text-diff';
import { numberText } from './AgentContextDialog';
import { shortStamp, versionNumbers } from './EntryActions';
import { kindIcon } from './GraphLegend';
import './entry-actions.css';

export interface PendingCardProps {
  /** The draft. */
  item: MemoryItem;
  /** Every record with the item's key, drafts included, in any order. */
  versions: MemoryItem[];
  /** The directory signature now; a draft proposed against it is still the latest. */
  signature?: string;
  /** The session that proposed the draft. */
  author?: { title: string; runtime: string };
  /** Confirming was refused because the sources changed after the draft was proposed. */
  rejected?: boolean;
  /** Confirming was refused because the confirmed decisions would not fit the context budget. */
  overBudget?: BudgetRefusal;
  busy?: boolean;
  onCommit: () => void;
  onDiscard: () => void;
  onOpen: () => void;
  onRewrite: () => void;
  /** Opens the session that proposed the draft. */
  onOpenSession: () => void;
  /** Opens a record a refusal names. */
  onRecord?: (id: string) => void;
}

export const kindText = (kind: MemoryRecord['kind']) =>
  kind === 'decision'
    ? t({ id: 'memory.pending.kind.decision', defaultMessage: 'Decision' })
    : kind === 'report'
      ? t({ id: 'memory.pending.kind.report', defaultMessage: 'Report' })
      : t({ id: 'memory.pending.kind.note', defaultMessage: 'Note' });

function KindIcon({ kind }: { kind: MemoryRecord['kind'] }) {
  return kindIcon(kind, kindText(kind));
}

export function PendingCard({
  item,
  versions,
  signature,
  author,
  rejected = false,
  overBudget,
  busy = false,
  onCommit,
  onDiscard,
  onOpen,
  onRewrite,
  onOpenSession,
  onRecord,
}: PendingCardProps) {
  const title = item.title ?? item.key;
  if (rejected)
    return (
      <div className="mpc">
        <div className="mpc-h">
          <KindIcon kind={item.kind} />
          <span className="mpc-t">{title}</span>
        </div>
        <div className="mpc-alert" role="alert">
          <X className="mpc-bad ic-sm" aria-hidden="true" />
          <span className="mpc-why">
            <span>
              {t({
                id: 'memory.pending.sourcesChanged',
                defaultMessage:
                  'The sources changed, so this draft did not take effect. Re-read them before confirming.',
              })}
            </span>
            <span className="mpc-sigs">
              <span>{item.based_on.slice(0, 8)}</span>
              {signature !== undefined && (
                <>
                  <ArrowRight aria-hidden="true" />
                  <span>{signature.slice(0, 8)}</span>
                </>
              )}
            </span>
          </span>
        </div>
        <div className="mpc-acts">
          {author && (
            <button type="button" className="btn sm" disabled={busy} onClick={onOpenSession}>
              <RuntimeGlyph runtime={author.runtime} size={14} />
              {t(
                { id: 'memory.pending.openSession', defaultMessage: 'Open {session}' },
                { session: author.title },
              )}
            </button>
          )}
          <button type="button" className="btn sm ghost" disabled={busy} onClick={onRewrite}>
            {t({ id: 'memory.pending.rewrite', defaultMessage: 'Rewrite it yourself' })}
          </button>
          <button type="button" className="btn sm ghost ma-end" disabled={busy} onClick={onDiscard}>
            {t({ id: 'memory.pending.discard', defaultMessage: 'Discard' })}
          </button>
        </div>
      </div>
    );
  if (overBudget) {
    const { used_bytes: used, limit_bytes: limit, largest_records: largest } = overBudget;
    return (
      <div className="mpc">
        <div className="mpc-h">
          <KindIcon kind={item.kind} />
          <span className="mpc-t">{title}</span>
        </div>
        <div className="mo-over-grow">
          <div className="mo-over">
            <div className="mpc-alert" role="alert">
              <X className="mpc-bad ic-sm" aria-hidden="true" />
              <div className="mo-over-why">
                <span>
                  {t({
                    id: 'memory.pending.overBudget',
                    defaultMessage:
                      'The confirmed decisions do not fit, so this draft did not take effect.',
                  })}
                </span>
                {used !== undefined && limit !== undefined && (
                  <div className="mo-over-use">
                    <div
                      className="meter"
                      role="img"
                      aria-label={t(
                        {
                          id: 'memory.pending.overBudgetMeter',
                          defaultMessage: 'Confirmed decisions {used} bytes, budget {limit} bytes',
                        },
                        { used: numberText(used), limit: numberText(limit) },
                      )}
                      style={
                        {
                          '--v': `${Math.min(Math.round((used / limit) * 100), 100)}%`,
                        } as CSSProperties
                      }
                    >
                      <i />
                    </div>
                    <span className="mo-over-num">
                      {numberText(used)} / {numberText(limit)}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {largest.length > 0 && (
              <div className="mo-over-rows">
                {largest.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className="mo-over-row"
                    onClick={() => onRecord?.(record.id)}
                  >
                    {kindIcon('decision')}
                    <span className="mpc-cut">{record.title}</span>
                    <span className="mo-over-num">{numberText(record.bytes)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="mpc-acts">
          <button type="button" className="btn sm" disabled={busy} onClick={onRewrite}>
            {t({ id: 'memory.pending.shorten', defaultMessage: 'Shorten' })}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={onCommit}>
            {t({ id: 'memory.pending.retry', defaultMessage: 'Try again' })}
          </button>
          <button type="button" className="btn sm ghost ma-end" disabled={busy} onClick={onDiscard}>
            {t({ id: 'memory.pending.discard', defaultMessage: 'Discard' })}
          </button>
        </div>
      </div>
    );
  }
  const numbers = versionNumbers(versions);
  // The version in effect when the draft was proposed, not one confirmed since.
  const base = versions.find(
    (v) =>
      v.id !== item.id &&
      v.committed_at !== undefined &&
      v.committed_at <= item.created_at &&
      (v.archived_at === undefined || v.archived_at > item.created_at),
  );
  const baseNumber = base && numbers.get(base.id);
  const latest = signature === undefined ? undefined : item.based_on === signature;
  return (
    <div className="mpc">
      <div className="mpc-h">
        <KindIcon kind={item.kind} />
        <span className="mpc-t">{title}</span>
        <span className="mpc-key">{item.key}</span>
        <span className="chip mpc-st">
          {t({ id: 'memory.pending.state', defaultMessage: 'Pending review' })}
        </span>
      </div>
      <div className="mpc-meta">
        <span className="mpc-g">
          {author && <RuntimeGlyph runtime={author.runtime} size={14} />}
          {author && <span className="mpc-cut">{author.title}</span>}
          <span className="mpc-num">{shortStamp(item.created_at)}</span>
        </span>
        {baseNumber !== undefined && (
          <span className="mpc-num">
            {t(
              { id: 'memory.pending.basedOn', defaultMessage: 'Based on version {n}' },
              { n: baseNumber },
            )}
          </span>
        )}
        <span className="mpc-g">
          <span className="mpc-sig">{item.based_on.slice(0, 8)}</span>
          {latest === true && (
            <>
              <Check className="mpc-ok ic-sm" aria-hidden="true" />
              {t({ id: 'memory.pending.latest', defaultMessage: 'Still the latest' })}
            </>
          )}
          {latest === false && (
            <>
              <span className="mpc-dot" aria-hidden="true" />
              {t({ id: 'memory.pending.notLatest', defaultMessage: 'No longer the latest' })}
            </>
          )}
        </span>
      </div>
      <div className="mpc-diff">
        {diffLines(base?.text ?? '', item.text).map((line, i) => (
          <div key={i} data-kind={line.kind}>
            <span>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
      <div className="mpc-acts">
        <button type="button" className="btn pri" disabled={busy} onClick={onCommit}>
          <Check aria-hidden="true" />
          {t({ id: 'memory.pending.commit', defaultMessage: 'Confirm' })}
        </button>
        <button type="button" className="btn ghost dng" disabled={busy} onClick={onDiscard}>
          {t({ id: 'memory.pending.discard', defaultMessage: 'Discard' })}
        </button>
        <button type="button" className="btn ghost ma-end" onClick={onOpen}>
          {t({ id: 'memory.pending.open', defaultMessage: 'Open details' })}
        </button>
      </div>
    </div>
  );
}
