import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCheck, UserPen } from 'lucide-react';
import type { BoardModel, TaskTraceEntry, TaskTraceKind } from '@pantheon/protocol';
import { MergeBlockedMark, StateGlyph } from '../../components/SessionStateIcon';
import { ModelMark } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { planTaskIds, useTaskTrace } from '../../data/task-trace';
import { t } from '../../i18n';
import { whenText } from './panels-model';
import './timeline.css';

type Task = BoardModel['tasks'][number];
type Merge = BoardModel['merges'][number];

/** Kinds whose text is a message: from the lead (filled) or back from the task (outlined, indented). */
const BUBBLE: Partial<Record<TaskTraceKind, 'in' | 'out'>> = {
  lead_message: 'in',
  handback: 'in',
  report: 'out',
};

/** A glyph is drawn on the 14 × 14 grid; an icon is a whole one other screens draw the same way. */
export const KINDS: Record<
  TaskTraceKind,
  { label: string; tone?: 'ok' | 'bad' } & ({ glyph: ReactNode } | { icon: ReactNode })
> = {
  start_requested: {
    get label() {
      return t({ id: 'board.task.trace.startRequested', defaultMessage: 'Start requested' });
    },
    glyph: <path d="M4.5 2.8v8.4L11 7z" />,
  },
  dispatched: {
    get label() {
      return t({ id: 'board.task.trace.dispatched', defaultMessage: 'Dispatched' });
    },
    glyph: <path d="M2 7h7M6.5 4 9.5 7l-3 3M11.8 3v8" />,
  },
  lead_message: {
    get label() {
      return t({ id: 'board.task.trace.leadMessage', defaultMessage: 'Lead message' });
    },
    glyph: <path d="M2.5 3h9v6h-5L4 11.2V9H2.5z" />,
  },
  report: {
    get label() {
      return t({ id: 'board.task.trace.report', defaultMessage: 'Report' });
    },
    glyph: <path d="M4 2h4.5L11 4.5V12H4zM8.5 2v2.5H11M6 7.5h3M6 9.5h3" />,
  },
  handback: {
    get label() {
      return t({ id: 'board.task.trace.handback', defaultMessage: 'Handed back' });
    },
    glyph: <path d="M11.5 3.5v3a2 2 0 0 1-2 2H3M5.5 6 3 8.5 5.5 11" />,
  },
  accepted: {
    get label() {
      return t({ id: 'board.task.trace.accepted', defaultMessage: 'Accepted' });
    },
    tone: 'ok',
    icon: <CheckCheck aria-hidden="true" />,
  },
  gate_passed: {
    get label() {
      return t({ id: 'board.task.trace.gatePassed', defaultMessage: 'Gates passed' });
    },
    tone: 'ok',
    glyph: (
      <path d="M7 1.8 11.5 3.5v3.3c0 2.7-1.9 4.6-4.5 5.4-2.6-.8-4.5-2.7-4.5-5.4V3.5zM5.2 7l1.3 1.3 2.4-2.6" />
    ),
  },
  gate_failed: {
    get label() {
      return t({ id: 'board.task.trace.gateFailed', defaultMessage: 'Gates failed' });
    },
    tone: 'bad',
    glyph: (
      <path d="M7 1.8 11.5 3.5v3.3c0 2.7-1.9 4.6-4.5 5.4-2.6-.8-4.5-2.7-4.5-5.4V3.5zM5.5 5.5l3 3M8.5 5.5l-3 3" />
    ),
  },
  merge_started: {
    get label() {
      return t({ id: 'board.task.trace.mergeStarted', defaultMessage: 'Merge started' });
    },
    glyph: (
      <>
        <circle cx="4" cy="3" r="1.5" />
        <path d="M4 4.5V12M4 4.8c0 1.8 1.6 2.2 3.2 2.2h3.3M8.8 5.2 10.6 7 8.8 8.8" />
      </>
    ),
  },
  merge_blocked: {
    get label() {
      return t({ id: 'board.task.trace.mergeBlocked', defaultMessage: 'Merge blocked' });
    },
    tone: 'bad',
    icon: <MergeBlockedMark merge={{ state: 'blocked' }} />,
  },
  merged: {
    get label() {
      return t({ id: 'board.task.trace.merged', defaultMessage: 'Merged' });
    },
    tone: 'ok',
    icon: <StateGlyph name="merged" />,
  },
  discarded: {
    get label() {
      return t({ id: 'board.task.trace.discarded', defaultMessage: 'Discarded' });
    },
    icon: <StateGlyph name="discarded" />,
  },
  user_edit: {
    get label() {
      return t({ id: 'board.task.trace.userEdit', defaultMessage: 'Your edit' });
    },
    icon: <UserPen aria-hidden="true" />,
  },
};

/** Entry text clamped to three lines, with a toggle once it overflows them. */
function TraceText({ text, bubble }: { text: string; bubble?: 'in' | 'out' }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, text]);
  return (
    <div className="bd-tl-q" data-bubble={bubble}>
      <p ref={ref} className="bd-tl-x" data-open={open || undefined}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="bd-lnk"
          aria-expanded={open}
          onClick={() => setOpen((now) => !now)}
        >
          {open
            ? t({ id: 'board.task.trace.collapse', defaultMessage: 'Show less' })
            : t({ id: 'board.task.trace.expand', defaultMessage: 'Show more' })}
        </button>
      )}
    </div>
  );
}

/** The board merge of the session nearest in time to the trace's merged entry. */
function mergeOf(entry: TaskTraceEntry, merges: readonly Merge[]): Merge | undefined {
  let best: Merge | undefined;
  for (const m of merges)
    if (
      m.session_id === entry.session_id &&
      (!best || Math.abs(m.merged_at - entry.at) < Math.abs(best.merged_at - entry.at))
    )
      best = m;
  return best;
}

export interface TraceListProps {
  entries: readonly TaskTraceEntry[];
  merges: readonly Merge[];
  segments: Task['segments'];
  now: number;
  onOpenSession: (sessionId: string) => void;
  onOpenStory: (sessionId: string) => void;
}

/** The task's trace oldest first: glyph, time, step and text; a merged entry carries its commits. */
export function TraceList({
  entries,
  merges,
  segments,
  now,
  onOpenSession,
  onOpenStory,
}: TraceListProps) {
  if (!entries.length)
    return <div className="mu">{t({ id: 'board.task.trace.empty', defaultMessage: 'None' })}</div>;
  return (
    <ol className="bd-tl">
      {entries.map((entry, i) => {
        const kind = KINDS[entry.kind];
        const segment = segments.find((s) => s.session_id === entry.session_id);
        const merge = entry.kind === 'merged' ? mergeOf(entry, merges) : undefined;
        const sessionId = entry.session_id;
        return (
          <li key={`${entry.at}-${i}`} className="bd-tl-i" data-kind={entry.kind}>
            <time className="bd-tl-t" dateTime={new Date(entry.at).toISOString()}>
              {whenText(entry.at, now)}
            </time>
            <span className="bd-tl-g" data-tone={kind.tone} aria-hidden="true">
              {'icon' in kind ? (
                kind.icon
              ) : (
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  {kind.glyph}
                </svg>
              )}
            </span>
            <div className="bd-tl-b">
              <div className="bd-tl-l">
                {sessionId ? (
                  <button
                    type="button"
                    className="bd-tl-n"
                    aria-label={t(
                      {
                        id: 'board.task.trace.openSession',
                        defaultMessage: '{step}, open session {title}',
                      },
                      { step: kind.label, title: segment?.title ?? sessionId },
                    )}
                    onClick={() => onOpenSession(sessionId)}
                  >
                    {kind.label}
                  </button>
                ) : (
                  <span className="bd-tl-n">{kind.label}</span>
                )}
                {entry.kind === 'dispatched' && segment?.model && (
                  <>
                    <ModelMark model={segment.model} size={14} />
                    <span className="mono">{segment.model}</span>
                  </>
                )}
                {merge && (
                  <>
                    <span className="mono">
                      {merge.from_sha
                        ? `${merge.from_sha.slice(0, 7)}..${merge.sha.slice(0, 7)}`
                        : merge.sha.slice(0, 7)}
                    </span>
                    <span className="bd-dfx">
                      <span className="bd-add" data-zero={merge.additions === 0 || undefined}>
                        +{merge.additions}
                      </span>{' '}
                      <span className="bd-del" data-zero={merge.deletions === 0 || undefined}>
                        −{merge.deletions}
                      </span>
                    </span>
                    {merge.story_id && (
                      <button
                        type="button"
                        className="bd-lnk"
                        aria-label={t(
                          {
                            id: 'board.task.story.openLabel',
                            defaultMessage: 'Open change story {title}',
                          },
                          { title: merge.title },
                        )}
                        onClick={() => onOpenStory(merge.session_id)}
                      >
                        {t({ id: 'board.task.story.open', defaultMessage: 'Change story' })}
                      </button>
                    )}
                  </>
                )}
              </div>
              {entry.text && <TraceText text={entry.text} bubble={BUBBLE[entry.kind]} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface TaskTimelineProps {
  model: BoardModel;
  /** A plan task; its id is `<lead session id>:<task id>`. */
  task: Task;
  onOpenSession: (sessionId: string) => void;
  onOpenStory: (sessionId: string) => void;
}

/** The drawer section with the task's trace from task.trace, its loading and its failure. */
export function TaskTimeline({ model, task, onOpenSession, onOpenStory }: TaskTimelineProps) {
  const lead = planTaskIds(task.id).lead;
  const projectId = useBoard(
    (s) => s.board?.sessions.find((session) => session.id === lead)?.project_id ?? null,
  );
  const sessionIds = task.segments.flatMap((s) => (s.session_id ? [s.session_id] : []));
  const trace = useTaskTrace(projectId, task.id, sessionIds);
  return (
    <section className="bd-dsec" aria-labelledby="bd-tl-h">
      <h3 id="bd-tl-h">{t({ id: 'board.task.trace.heading', defaultMessage: 'Conversation' })}</h3>
      {trace.data ? (
        <TraceList
          entries={trace.data}
          merges={model.merges}
          segments={task.segments}
          now={model.now}
          onOpenSession={onOpenSession}
          onOpenStory={onOpenStory}
        />
      ) : trace.error ? (
        <div className="tr-fail bd-fail" role="alert">
          <span title={trace.error}>{trace.error}</span>
          <button type="button" className="btn" onClick={trace.reload}>
            {t({ id: 'board.task.trace.retry', defaultMessage: 'Retry' })}
          </button>
        </div>
      ) : (
        <div className="bd-sk" aria-busy="true">
          <span className="sk" style={{ height: 10, width: '60%' }} />
          <span className="sk" style={{ height: 10, width: '40%' }} />
        </div>
      )}
    </section>
  );
}
