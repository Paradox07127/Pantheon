import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  GitFork,
  KeyRound,
  Minimize2,
  Pencil,
  Route,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { SessionTrace } from '@pantheon/protocol';
import { Equalizer } from '../../components/Equalizer';
import { LeadCrown } from '../../components/LeadCrown';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { elapsedText } from '../../data/transcript';
import { t } from '../../i18n';
import { shortcutMatches, useShortcut, type ShortcutId } from '../../lib/shortcuts';
import { tokenText } from '../../lib/number-text';
import {
  callRows,
  stepRow,
  type CallFilter,
  type CallRow,
  type CallState,
  type CallVerb,
  type CallView,
  type SessionFacts,
} from './call-rows';
import type { RunForest } from './run-tree';
import './call-table.css';

type TraceSpan = SessionTrace['spans'][number];

// Labels are getters, so each is read in the language loaded by then.
const STATE_LABEL: Record<CallState, string> = {
  get run() {
    return t({ id: 'runs.table.state.run', defaultMessage: 'Running' });
  },
  get wait() {
    return t({ id: 'runs.table.state.wait', defaultMessage: 'Waiting' });
  },
  get ok() {
    return t({ id: 'runs.table.state.ok', defaultMessage: 'Done' });
  },
  get bad() {
    return t({ id: 'runs.table.state.bad', defaultMessage: 'Failed' });
  },
  get ready() {
    return t({ id: 'runs.table.state.ready', defaultMessage: 'Ready to merge' });
  },
  get idle() {
    return t({ id: 'runs.table.state.idle', defaultMessage: 'Idle' });
  },
};

export const VERB: Record<CallVerb, { icon: LucideIcon; label: string }> = {
  read: {
    icon: FileText,
    get label() {
      return t({ id: 'runs.table.verb.read', defaultMessage: 'Read' });
    },
  },
  edit: {
    icon: Pencil,
    get label() {
      return t({ id: 'runs.table.verb.edit', defaultMessage: 'Edit' });
    },
  },
  run: {
    icon: Terminal,
    get label() {
      return t({ id: 'runs.table.verb.run', defaultMessage: 'Run' });
    },
  },
  search: {
    icon: Search,
    get label() {
      return t({ id: 'runs.table.verb.search', defaultMessage: 'Search' });
    },
  },
  think: {
    icon: Brain,
    get label() {
      return t({ id: 'runs.table.verb.think', defaultMessage: 'Think' });
    },
  },
  dispatch: {
    icon: Route,
    get label() {
      return t({ id: 'runs.table.verb.dispatch', defaultMessage: 'Dispatch' });
    },
  },
  subagent: {
    icon: Bot,
    get label() {
      return t({ id: 'runs.table.verb.subagent', defaultMessage: 'Subagent' });
    },
  },
  compact: {
    icon: Minimize2,
    get label() {
      return t({ id: 'runs.table.verb.compact', defaultMessage: 'Compact' });
    },
  },
  tool: {
    icon: Wrench,
    get label() {
      return t({ id: 'runs.table.verb.tool', defaultMessage: 'Tool' });
    },
  },
};

/** Left padding of a row's first cell: sessions flush, their calls 24px in, each subagent level 40px more. */
const indent = (depth: number) => (depth === 0 ? 0 : 24 + (depth - 1) * 40);

const Status = ({ state }: { state: CallState }) => (
  <span className="ct-st" data-state={state} role="img" aria-label={STATE_LABEL[state]}>
    {state === 'run' && <Equalizer />}
  </span>
);

/** The runs table; the highlighted row moves with the list keys, or with `keys` anywhere in the window. */
export function CallTable({
  forest,
  facts,
  spans,
  view,
  now,
  selected,
  onSelect,
  filter,
  onRespond,
  responding,
  keys,
}: {
  forest: RunForest;
  /** By session id; see boardFacts. */
  facts: ReadonlyMap<string, SessionFacts>;
  /** By session id, the spans forest was built from. */
  spans: ReadonlyMap<string, readonly TraceSpan[]>;
  view: CallView;
  now: number;
  /** The highlighted row's key. */
  selected: string | null;
  onSelect: (row: CallRow | null) => void;
  filter?: CallFilter;
  /** Answers an approval; the now view shows its buttons only with this. */
  onRespond?: (approvalId: string, decision: 'approve' | 'reject') => void;
  /** The approvals whose answer is out; their buttons are disabled. */
  responding?: ReadonlySet<string>;
  /** Window-wide keys that move the highlight down and up. */
  keys?: { next: ShortcutId; previous: ShortcutId };
}) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const { rows, scale } = useMemo(
    () => callRows({ forest, facts, spans, view, now, toggled, filter }),
    [forest, facts, spans, view, now, toggled, filter],
  );
  const toggle = (key: string) =>
    setToggled((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const move = (step: 1 | -1) => {
    const key = stepRow(rows, selected, step);
    const row = rows.find((r) => r.key === key);
    if (row) onSelect(row);
  };
  useShortcut(keys?.next ?? 'list-down', () => move(1), !!keys);
  useShortcut(keys?.previous ?? 'list-up', () => move(-1), !!keys);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected === null) return;
    box.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const current = rows.find((row) => row.key === selected) ?? null;
  const position = t({ id: 'runs.table.position', defaultMessage: 'Position in this turn' });

  const nameCell = (row: CallRow): ReactNode => {
    const fold = (open: boolean) => (
      <button
        type="button"
        className="ct-fold"
        tabIndex={-1}
        aria-label={
          open
            ? t({ id: 'runs.table.collapse', defaultMessage: 'Collapse' })
            : t({ id: 'runs.table.expand', defaultMessage: 'Expand' })
        }
        onClick={(e) => {
          e.stopPropagation();
          toggle(row.key);
        }}
      >
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
    );
    if (row.type === 'session') {
      const { node } = row;
      return (
        <>
          {fold(row.open)}
          <Status state={row.state} />
          <span className="ct-title" data-ended={row.ended || undefined} data-state={row.state}>
            {node.title}
          </span>
          {row.lead && <LeadCrown />}
          {row.forked && (
            <GitFork
              className="ct-fork"
              role="img"
              aria-label={t({ id: 'runs.table.forked', defaultMessage: 'Forked' })}
            />
          )}
          {(node.runtime || row.turn !== null) && (
            <span className="chip">
              {node.runtime && <RuntimeGlyph runtime={node.runtime} size={14} />}
              {row.turn !== null &&
                t({ id: 'runs.table.turn', defaultMessage: 'Turn {count}' }, { count: row.turn })}
            </span>
          )}
          {row.context !== null && (
            <span className="ct-ctx">
              <svg
                className="ct-ring"
                width="14"
                height="14"
                viewBox="0 0 32 32"
                role="img"
                aria-label={t(
                  { id: 'runs.table.context', defaultMessage: 'Context {percent}% used' },
                  { percent: row.context },
                )}
                style={{ '--ct-v': row.context } as CSSProperties}
              >
                <circle className="ct-ring-tr" cx="16" cy="16" r="13" pathLength={100} />
                <circle className="ct-ring-fg" cx="16" cy="16" r="13" pathLength={100} />
              </svg>
              {row.context}%
            </span>
          )}
        </>
      );
    }
    if (row.type === 'approval') {
      const past = view === 'history';
      const Icon = past ? Terminal : KeyRound;
      return (
        <>
          <Icon className="ct-ic" aria-hidden="true" />
          <span className="ct-verb">
            {past
              ? VERB.run.label
              : t({ id: 'runs.table.approval.verb', defaultMessage: 'Wants to run' })}
          </span>
          <span className={past ? 'ct-tg' : 'ct-inl'} data-mono="">
            {row.summary}
          </span>
        </>
      );
    }
    const verb = row.type === 'subagent' ? VERB.subagent : VERB[row.verb];
    const Icon = verb.icon;
    const working = view === 'now' && row.state === 'run';
    return (
      <>
        {row.type === 'subagent' && fold(row.open)}
        <Icon className="ct-ic" aria-hidden="true" />
        <span className={working ? 'ct-verb ct-working' : 'ct-verb'}>{verb.label}</span>
        {row.target !== null && (
          <span className="ct-tg" data-mono={row.type === 'call' ? '' : undefined}>
            {row.type === 'call' && row.more > 0
              ? t(
                  {
                    id: 'runs.table.files',
                    defaultMessage:
                      '{path} + {count, plural, one {# more file} other {# more files}}',
                  },
                  { path: row.target, count: row.more },
                )
              : row.target}
          </span>
        )}
      </>
    );
  };

  const durationText = (row: CallRow): string => {
    if (row.type === 'approval')
      return view === 'history'
        ? t({ id: 'runs.table.approval.pending', defaultMessage: 'Awaiting approval' })
        : t(
            { id: 'runs.table.approval.waitingFor', defaultMessage: 'Waiting {time}' },
            { time: elapsedText(row.duration ?? 0) },
          );
    return row.duration === null ? '' : elapsedText(row.duration);
  };

  const lastCell = (row: CallRow): ReactNode => {
    if (row.type === 'approval' && view === 'now') {
      if (!onRespond) return null;
      const busy = !!responding?.has(row.approvalId);
      return (
        <span className="ct-acts">
          <button
            type="button"
            className="btn sm pri"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onRespond(row.approvalId, 'approve');
            }}
          >
            {t({ id: 'runs.table.approval.allow', defaultMessage: 'Allow once' })}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onRespond(row.approvalId, 'reject');
            }}
          >
            {t({ id: 'runs.table.approval.reject', defaultMessage: 'Reject' })}
          </button>
        </span>
      );
    }
    return (
      <span className="ct-wf" role="img" aria-label={position}>
        {row.bars.map((bar, i) => (
          <i
            key={i}
            data-tone={bar.tone}
            data-faded={bar.faded || undefined}
            data-stripe={bar.stripe || undefined}
            data-live={bar.live || undefined}
            style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
          />
        ))}
      </span>
    );
  };

  return (
    <div
      ref={box}
      className="ct"
      role="treegrid"
      tabIndex={0}
      aria-label={t({ id: 'runs.table.label', defaultMessage: 'Sessions and calls' })}
      aria-activedescendant={current ? `ct-${current.key}` : undefined}
      onKeyDown={(e) => {
        if (shortcutMatches('list-down', e)) move(1);
        else if (shortcutMatches('list-up', e)) move(-1);
        else if (
          shortcutMatches('list-fold', e) &&
          current &&
          (current.type === 'session' || current.type === 'subagent') &&
          current.open
        )
          toggle(current.key);
        else if (
          shortcutMatches('list-unfold', e) &&
          current &&
          (current.type === 'session' || current.type === 'subagent') &&
          !current.open
        )
          toggle(current.key);
        else if (e.key === 'Escape' && selected !== null) onSelect(null);
        else return;
        e.preventDefault();
      }}
    >
      <div className="ct-row ct-head" role="row">
        <span role="columnheader" className="ct-name">
          {t({ id: 'runs.table.label', defaultMessage: 'Sessions and calls' })}
        </span>
        <span role="columnheader" className="ct-num">
          tokens
        </span>
        <span role="columnheader" />
        <span role="columnheader" className="ct-num">
          {t({ id: 'runs.table.duration', defaultMessage: 'Duration' })}
        </span>
        <span role="columnheader" className="ct-ticks">
          <span>0</span>
          <span>{elapsedText(scale / 2)}</span>
          <span>{elapsedText(scale)}</span>
        </span>
      </div>
      {rows.map((row, i) => {
        const on = row.key === selected;
        const foldable = row.type === 'session' || row.type === 'subagent';
        return (
          <div
            key={row.key}
            id={`ct-${row.key}`}
            data-key={row.key}
            data-type={row.type}
            className="ct-row"
            role="row"
            aria-level={row.depth + 1}
            aria-selected={on}
            aria-expanded={foldable ? row.open : undefined}
            style={{ '--ct-k': Math.min(i, 6) } as CSSProperties}
            onClick={() => onSelect(on ? null : row)}
          >
            <span role="gridcell" className="ct-name" style={{ paddingLeft: indent(row.depth) }}>
              {nameCell(row)}
            </span>
            <span role="gridcell" className="ct-num" data-mono="">
              {row.tokens === null ? '' : tokenText(row.tokens)}
            </span>
            <span role="gridcell">{row.type !== 'session' && <Status state={row.state} />}</span>
            <span role="gridcell" className="ct-num" data-mono="">
              {durationText(row)}
            </span>
            <span role="gridcell">{lastCell(row)}</span>
          </div>
        );
      })}
    </div>
  );
}
