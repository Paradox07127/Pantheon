import { useState, type CSSProperties } from 'react';
import { ChevronRight, Pin } from 'lucide-react';
import { StateGlyph, type GlyphName } from '../../components/SessionStateIcon';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import type { Improvement, WorkflowParam } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { ruleParts, scopeParts, statusText } from './learned-model';
import './memory-learned.css';

export interface LearnedListProps {
  /** Every improvement of the project, of every status, newest first. */
  items: Improvement[];
  /** The policy parameters the user pinned. */
  pinned: readonly WorkflowParam[];
  selected: string | null;
  onSelect: (id: string) => void;
}

// Rows after this many enter together with the last of them.
const STAGGER = 6;

const GLYPH: Record<Improvement['status'], GlyphName> = {
  candidate: 'baseline_review',
  trial: 'ready',
  active: 'done',
  reverted: 'idle',
  rejected: 'idle',
};

const GROUPS: { status: Improvement['status']; readonly label: string }[] = [
  {
    status: 'candidate',
    get label() {
      return t({ id: 'memory.learned.group.candidate', defaultMessage: 'Awaiting you' });
    },
  },
  {
    status: 'trial',
    get label() {
      return t({ id: 'memory.learned.group.trial', defaultMessage: 'On trial' });
    },
  },
  {
    status: 'active',
    get label() {
      return t({ id: 'memory.learned.group.active', defaultMessage: 'In force' });
    },
  },
];

const isPinned = (i: Improvement, pinned: readonly WorkflowParam[]) =>
  i.change.type === 'policy_change' &&
  (i.status === 'trial' || i.status === 'active') &&
  pinned.includes(i.change.param);

export function LearnedList(p: LearnedListProps) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  let k = 0;

  const row = (i: Improvement, stagger: boolean) => (
    <button
      key={i.id}
      type="button"
      role="option"
      aria-selected={i.id === p.selected}
      className="lr-row"
      style={stagger ? ({ '--lr-k': Math.min(k++, STAGGER) } as CSSProperties) : undefined}
      onClick={() => p.onSelect(i.id)}
    >
      <span className="lr-st" aria-hidden="true">
        <StateGlyph name={GLYPH[i.status]} />
      </span>
      <span className="lr-rw">
        <span className="lr-rule">
          {ruleParts(i.change).map((part, n) =>
            part.code ? (
              <span key={n} className="lr-inl">
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )}
        </span>
        {isPinned(i, p.pinned) && (
          <span className="chip lr-pin">
            <Pin aria-hidden="true" />
            {t({ id: 'memory.learned.pinned', defaultMessage: 'Pinned' })}
          </span>
        )}
      </span>
      <span className="lr-sc">
        {scopeParts(i.change).map((part, n) =>
          part.kind === 'runtime' ? (
            <span key={n} className="lr-rt">
              <RuntimeGlyph runtime={part.runtime} size={14} />
              {part.text}
            </span>
          ) : (
            <span key={n} className={part.kind === 'tier' ? 'lr-mono' : undefined}>
              {part.text}
            </span>
          ),
        )}
      </span>
      <span className="lr-tm">{statusText(i, now)}</span>
      <span className="lr-n">
        {t(
          {
            id: 'memory.learned.retrospectives',
            defaultMessage: '{count, plural, one {# retrospective} other {# retrospectives}}',
          },
          { count: i.retrospective_ids.length },
        )}
      </span>
    </button>
  );

  const closed = p.items.filter((i) => i.status === 'reverted' || i.status === 'rejected');
  const closedLabel = t({
    id: 'memory.learned.group.closed',
    defaultMessage: 'Reverted and rejected',
  });
  return (
    <section
      className="lr"
      aria-label={t({ id: 'memory.learned.label', defaultMessage: 'Learned rules' })}
    >
      <div className="lr-head">
        <span />
        <span>{t({ id: 'memory.learned.col.rule', defaultMessage: 'Rule' })}</span>
        <span>{t({ id: 'memory.learned.col.scope', defaultMessage: 'Applies to' })}</span>
        <span>{t({ id: 'memory.learned.col.status', defaultMessage: 'Status' })}</span>
        <span className="lr-n">
          {t({ id: 'memory.learned.col.basis', defaultMessage: 'Basis' })}
        </span>
      </div>
      {GROUPS.map((g) => {
        const rows = p.items.filter((i) => i.status === g.status);
        if (!rows.length) return null;
        return [
          <div key={`${g.status}-h`} className="lr-gh">
            <span className="lr-gn">{g.label}</span>
            <span className="lr-ct">{rows.length}</span>
          </div>,
          <div key={g.status} role="listbox" aria-label={g.label} className="lr-grp">
            {rows.map((i) => row(i, true))}
          </div>,
        ];
      })}
      {closed.length > 0 && (
        <>
          <button
            type="button"
            className="lr-gh lr-fold"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight aria-hidden="true" />
            <span className="lr-gn">{closedLabel}</span>
            <span className="lr-ct">{closed.length}</span>
          </button>
          {open && (
            <div role="listbox" aria-label={closedLabel} className="lr-old">
              {closed.map((i) => row(i, false))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
