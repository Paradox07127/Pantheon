import type { ReactNode } from 'react';
import { Bell, CircleAlert, MessageCircleQuestionMark, MessageCircleReply } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { LoadError } from '../../components/LoadError';
import { ModelMark } from '../../components/RuntimeGlyph';
import { Skeleton } from '../../components/Skeleton';
import { useBoard } from '../../data/board';
import { ageText, reasonText, useNow } from '../../data/needs-you';
import { planTaskIds } from '../../data/task-trace';
import { useTaskThread, type TaskThreadEntry } from '../../data/task-thread';
import { sessionTitle } from '../../data/transcript';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { KINDS, mergeOf } from './TaskTimeline';
import './timeline.css';

type Task = BoardModel['tasks'][number];

const drawn = (kind: (typeof KINDS)[keyof typeof KINDS]): ReactNode =>
  'icon' in kind ? (
    kind.icon
  ) : (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      {kind.glyph}
    </svg>
  );

/** The label, glyph and tone of an entry; a step of the task's life is a ruled line. */
function look(entry: TaskThreadEntry): {
  label: string;
  glyph: ReactNode;
  tone?: 'ok' | 'bad';
  mark?: true;
} {
  const of = (kind: keyof typeof KINDS, mark?: true) => ({
    label: KINDS[kind].label,
    glyph: drawn(KINDS[kind]),
    tone: KINDS[kind].tone,
    ...(mark && { mark }),
  });
  switch (entry.kind) {
    case 'lead_message':
      return of('lead_message');
    case 'report':
      return of('report');
    case 'gate':
      return of(entry.passed ? 'gate_passed' : 'gate_failed');
    case 'dispatched':
      return of('dispatched', true);
    case 'handed_back':
      return of('handback', true);
    case 'merged':
      return of('merged', true);
    case 'merge_blocked':
      return of('merge_blocked', true);
    case 'tracker_message':
      return {
        label: t({ id: 'board.task.thread.trackerMessage', defaultMessage: 'Pantheon message' }),
        glyph: drawn(KINDS.handback),
      };
    case 'finding':
      return {
        label: t({ id: 'board.task.thread.finding', defaultMessage: 'Finding' }),
        glyph: <CircleAlert aria-hidden="true" />,
        ...(entry.blocking && { tone: 'bad' as const }),
      };
    case 'question':
      return {
        label: t({ id: 'board.task.thread.question', defaultMessage: 'Question' }),
        glyph: <MessageCircleQuestionMark aria-hidden="true" />,
      };
    case 'answer':
      return {
        label: entry.overruled
          ? t({ id: 'board.task.thread.overruled', defaultMessage: 'Overruled the lead' })
          : t({ id: 'board.task.thread.answer', defaultMessage: 'Answer' }),
        glyph: <MessageCircleReply aria-hidden="true" />,
      };
    case 'note':
      return {
        label: t({ id: 'board.task.thread.note', defaultMessage: 'Note' }),
        glyph: <Bell aria-hidden="true" />,
      };
  }
}

export interface TaskThreadProps {
  model: BoardModel;
  /** A plan task; its id is `<lead session id>:<task id>`. */
  task: Task;
  onOpenSession: (sessionId: string) => void;
  onOpenStory: (sessionId: string) => void;
}

/** The drawer section with everything said about the task, from task.thread, oldest first. */
export function TaskThread({ model, task, onOpenSession, onOpenStory }: TaskThreadProps) {
  const lead = planTaskIds(task.id).lead;
  const board = useBoard((s) => s.board);
  const projectId = board?.sessions.find((session) => session.id === lead)?.project_id ?? null;
  const sessionIds = task.segments.flatMap((s) => (s.session_id ? [s.session_id] : []));
  const thread = useTaskThread(projectId, task.id, sessionIds);
  // A question's wait keeps growing between board reads.
  const now = Math.max(model.now, useNow(15_000));
  const entries = thread.data ?? [];
  const answered = new Set(entries.flatMap((e) => (e.kind === 'answer' ? [e.question_id] : [])));
  const blocking = entries.filter((e) => e.kind === 'finding' && e.blocking);
  const rowId = (entry: TaskThreadEntry) => `bd-th-${entry.event_id}`;

  const titleOf = (sessionId: string): string | undefined => {
    const segment = task.segments.find((s) => s.session_id === sessionId);
    if (segment) return segment.title;
    const session = board?.sessions.find((s) => s.id === sessionId);
    return session && sessionTitle(session, board ?? {});
  };
  const sessionSource = (sessionId: string) => {
    const title = titleOf(sessionId);
    return title ? (
      <button
        type="button"
        className="bd-tl-s"
        aria-label={t(
          { id: 'board.task.thread.openSession', defaultMessage: 'Open session {title}' },
          { title },
        )}
        onClick={() => onOpenSession(sessionId)}
      >
        <Clip text={title} />
      </button>
    ) : (
      <span className="bd-tl-s">
        <Clip text={sessionId} />
      </span>
    );
  };
  const plainSource = (text: string) => <span className="bd-tl-s">{text}</span>;
  const source = (entry: TaskThreadEntry): ReactNode => {
    switch (entry.kind) {
      case 'lead_message':
        return sessionSource(lead);
      case 'question':
        return sessionSource(entry.session_id ?? lead);
      case 'finding':
        return sessionSource(entry.reviewer_session_id ?? entry.session_id ?? lead);
      case 'answer':
        return entry.answered_by === 'lead'
          ? sessionSource(lead)
          : plainSource(
              entry.answered_by === 'default'
                ? t({ id: 'board.task.thread.default', defaultMessage: 'Default answer' })
                : t({ id: 'board.task.thread.you', defaultMessage: 'You' }),
            );
      case 'note':
        return entry.session_id
          ? sessionSource(entry.session_id)
          : plainSource(t({ id: 'board.task.thread.pantheon', defaultMessage: 'Pantheon' }));
      default:
        return entry.session_id ? sessionSource(entry.session_id) : null;
    }
  };

  const status = (tone: 'bad' | 'wait' | 'idle', label: string, after?: string) => (
    <span className="chip bd-tl-st" data-tone={tone}>
      {label}
      {after && <span className="bd-tl-age">{after}</span>}
    </span>
  );
  const extra = (entry: TaskThreadEntry): ReactNode => {
    if (entry.kind === 'finding' && entry.blocking)
      return status('bad', t({ id: 'board.task.thread.blocking', defaultMessage: 'Blocking' }));
    if (entry.kind === 'question' && !answered.has(entry.question_id))
      // The needs-you strip answers it; the drawer's footer jumps there.
      return model.needs?.some((n) => n.question?.id === entry.question_id)
        ? status(
            'wait',
            t({ id: 'board.task.thread.waits', defaultMessage: 'Waits for you' }),
            ageText(entry.at, now),
          )
        : status(
            'idle',
            t({ id: 'board.task.thread.notAnswered', defaultMessage: 'Not answered' }),
            ageText(entry.at, now),
          );
    if (entry.kind === 'dispatched') {
      const used = task.segments.find((s) => s.session_id === entry.session_id)?.model;
      return (
        used && (
          <>
            <ModelMark model={used} size={14} />
            <span className="mono">{used}</span>
          </>
        )
      );
    }
    const merge = entry.kind === 'merged' ? mergeOf(entry, model.merges) : undefined;
    return (
      merge && (
        <>
          <span className="mono">
            {merge.from_sha
              ? `${merge.from_sha.slice(0, 7)}..${merge.sha.slice(0, 7)}`
              : merge.sha.slice(0, 7)}
          </span>
          <span className="bd-dfx">
            <DiffCounts additions={merge.additions} deletions={merge.deletions} />
          </span>
          {merge.story_id && (
            <button
              type="button"
              className="bd-lnk"
              aria-label={t(
                { id: 'board.task.story.openLabel', defaultMessage: 'Open change story {title}' },
                { title: merge.title },
              )}
              onClick={() => onOpenStory(merge.session_id)}
            >
              {t({ id: 'board.task.story.open', defaultMessage: 'Change story' })}
            </button>
          )}
        </>
      )
    );
  };
  const body = (entry: TaskThreadEntry): ReactNode => {
    if (
      entry.kind === 'lead_message' ||
      entry.kind === 'tracker_message' ||
      entry.kind === 'report'
    )
      return (
        entry.text && (
          <div className="bd-tl-q" data-bubble={entry.kind === 'report' ? 'out' : 'in'}>
            <Clip text={entry.text} lines={3} as="div" className="bd-tl-p" />
          </div>
        )
      );
    if (entry.kind === 'finding' && entry.location !== undefined)
      return (
        <p className="bd-tl-p">
          <span className="mono">{entry.location}</span> {entry.impact}
        </p>
      );
    if (entry.kind === 'gate') {
      const failed = (entry.commands ?? []).filter((c) => !c.passed);
      return (
        failed.length > 0 && (
          <ul
            className="bd-tl-c"
            aria-label={t({
              id: 'board.task.thread.failedCommands',
              defaultMessage: 'Failed commands',
            })}
          >
            {failed.map((c) => (
              <li key={c.name} className="chip mono">
                {c.name}
              </li>
            ))}
          </ul>
        )
      );
    }
    if (entry.kind === 'dispatched' || entry.kind === 'merged') return null;
    if (entry.kind === 'merge_blocked')
      return entry.text && <p className="bd-tl-p">{reasonText(entry.text)}</p>;
    return entry.text && <p className="bd-tl-p">{entry.text}</p>;
  };

  return (
    <section className="bd-dsec" aria-labelledby="bd-th-h">
      <div className="bd-dsh">
        <h3 id="bd-th-h">{t({ id: 'board.task.thread.heading', defaultMessage: 'Thread' })}</h3>
        {blocking.length > 0 && (
          <button
            type="button"
            className="chip bd-tl-st bd-tl-blk"
            data-tone="bad"
            aria-label={t(
              {
                id: 'board.task.thread.blockingJump',
                defaultMessage:
                  '{count, plural, one {# blocking finding, go to it} other {# blocking findings, go to the first}}',
              },
              { count: blocking.length },
            )}
            onClick={() => document.getElementById(rowId(blocking[0]!))?.focus()}
          >
            {t(
              { id: 'board.task.thread.blockingCount', defaultMessage: '{count} blocking' },
              { count: blocking.length },
            )}
          </button>
        )}
      </div>
      {thread.data ? (
        entries.length === 0 ? (
          <div className="mu">{t({ id: 'board.task.trace.empty', defaultMessage: 'None' })}</div>
        ) : (
          <ol
            className="bd-tl"
            aria-label={t(
              { id: 'board.task.thread.list', defaultMessage: 'Thread of {title}' },
              { title: task.title },
            )}
          >
            {entries.map((entry) => {
              const { label, glyph, tone, mark } = look(entry);
              return (
                <li
                  key={entry.event_id}
                  id={rowId(entry)}
                  className="bd-tl-i"
                  data-kind={entry.kind}
                  data-mark={mark}
                  // The head's blocking count moves focus to the first blocking finding.
                  tabIndex={entry.kind === 'finding' && entry.blocking ? -1 : undefined}
                >
                  <time className="bd-tl-t" dateTime={new Date(entry.at).toISOString()}>
                    {dayText(entry.at, model.now, { time: true })}
                  </time>
                  <span className="bd-tl-g" data-tone={tone} aria-hidden="true">
                    {glyph}
                  </span>
                  <div className="bd-tl-b">
                    <div className="bd-tl-l">
                      <span className="bd-tl-n">{label}</span>
                      {source(entry)}
                      {extra(entry)}
                    </div>
                    {body(entry)}
                  </div>
                </li>
              );
            })}
          </ol>
        )
      ) : thread.error ? (
        <LoadError message={thread.error} onRetry={thread.reload} />
      ) : (
        <div className="bd-sk" aria-busy="true">
          <Skeleton style={{ height: 10, width: '60%' }} />
          <Skeleton style={{ height: 10, width: '40%' }} />
        </div>
      )}
    </section>
  );
}
