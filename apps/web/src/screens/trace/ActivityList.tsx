import { useMemo, useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  CirclePlay,
  CircleStop,
  Flag,
  GitMerge,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldX,
  type LucideIcon,
} from 'lucide-react';
import { DiffCounts } from '../../components/DiffCounts';
import { reasonText } from '../../data/needs-you';
import { t } from '../../i18n';
import { dayText, durationText } from '../../lib/time-text';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { Empty } from '../../components/ChartParts';

import {
  dayOf,
  eventDays,
  TRACE_EVENT_KINDS,
  type TraceEvent,
  type TraceEventKind,
  type TraceEventWhat,
} from './model';
import './activity.css';

// Labels are getters, so each is read in the language loaded by then.
export const KIND_TEXT: Record<TraceEventKind, string> = {
  get approval() {
    return t({ id: 'trace.eventKind.approval', defaultMessage: 'Approvals' });
  },
  get gate() {
    return t({ id: 'trace.eventKind.gate', defaultMessage: 'Checks' });
  },
  get merge() {
    return t({ id: 'trace.eventKind.merge', defaultMessage: 'Merges' });
  },
  get plan() {
    return t({ id: 'trace.eventKind.plan', defaultMessage: 'Plans and dispatch' });
  },
  get model() {
    return t({ id: 'trace.eventKind.model', defaultMessage: 'Model changes' });
  },
  get session() {
    return t({ id: 'trace.eventKind.session', defaultMessage: 'Session start and end' });
  },
};

/** An icon per event, toned where it names a state: waiting, failed or passed. */
const GLYPH: Record<TraceEventWhat, { icon: LucideIcon; tone?: 'wait' | 'bad' | 'ok' }> = {
  asked: { icon: KeyRound, tone: 'wait' },
  allowed: { icon: KeyRound },
  allowed_session: { icon: KeyRound },
  denied: { icon: KeyRound },
  withdrawn: { icon: KeyRound },
  gate_passed: { icon: ShieldCheck, tone: 'ok' },
  gate_failed: { icon: ShieldX, tone: 'bad' },
  merged: { icon: GitMerge },
  merge_blocked: { icon: GitMerge, tone: 'bad' },
  planned: { icon: Flag },
  dispatched: { icon: Bot },
  question: { icon: MessageSquare },
  model_changed: { icon: RefreshCw },
  opened: { icon: CirclePlay },
  closed: { icon: CircleStop },
};

/** An event's status colour on the replay track: its glyph's tone, a merge passed, a dispatch an agent's. */
export const eventTone = (event: TraceEvent): 'wait' | 'bad' | 'ok' | 'agent' | undefined =>
  event.what === 'merged' ? 'ok' : event.what === 'dispatched' ? 'agent' : GLYPH[event.what].tone;

export function EventGlyph({ event }: { event: TraceEvent }) {
  const { icon: Icon, tone } = GLYPH[event.what];
  return <Icon className="ic-sm trc-eg" data-tone={tone} aria-hidden="true" />;
}

/** What happened, in words. */
export function eventText(event: TraceEvent): string {
  const tool = event.input ? `${event.detail ?? '—'} ${event.input}` : (event.detail ?? '—');
  switch (event.what) {
    case 'asked':
      return t({ id: 'trace.event.asked', defaultMessage: 'Asked to use {tool}' }, { tool });
    case 'allowed':
      return t({ id: 'trace.event.allowed', defaultMessage: 'You allowed {tool}' }, { tool });
    case 'allowed_session':
      return t(
        {
          id: 'trace.event.allowedSession',
          defaultMessage: 'You allowed {tool} for this session',
        },
        { tool },
      );
    case 'denied':
      return t({ id: 'trace.event.denied', defaultMessage: 'You denied {tool}' }, { tool });
    case 'withdrawn':
      return t(
        { id: 'trace.event.withdrawn', defaultMessage: 'Request for {tool} withdrawn' },
        { tool },
      );
    case 'gate_passed':
      return event.checks && event.checks.passed + event.checks.skipped > 0
        ? t(
            {
              id: 'trace.event.gatePassedCount',
              defaultMessage:
                '{skipped, plural, =0 {Checks: {passed} passed} other {Checks: {passed} passed, # skipped}}',
            },
            { passed: event.checks.passed, skipped: event.checks.skipped },
          )
        : t({ id: 'trace.event.gatePassed', defaultMessage: 'Checks passed' });
    case 'gate_failed':
      if (event.detail && event.checks)
        return t(
          {
            id: 'trace.event.gateFailedCount',
            defaultMessage: 'Checks failed: {check}, {failed} not passed',
          },
          { check: event.detail, failed: event.checks.failed },
        );
      return event.detail
        ? t(
            { id: 'trace.event.gateFailedCheck', defaultMessage: 'Checks failed: {check}' },
            { check: event.detail },
          )
        : t({ id: 'trace.event.gateFailed', defaultMessage: 'Checks failed' });
    case 'merged':
      return event.detail
        ? t({ id: 'trace.event.mergedSha', defaultMessage: 'Merged {sha}' }, { sha: event.detail })
        : t({ id: 'trace.event.merged', defaultMessage: 'Merged' });
    case 'merge_blocked':
      return event.detail
        ? t(
            { id: 'trace.event.mergeBlockedReason', defaultMessage: 'Merge blocked: {reason}' },
            { reason: reasonText(event.detail) },
          )
        : t({ id: 'trace.event.mergeBlocked', defaultMessage: 'Merge blocked' });
    case 'planned':
      return t(
        {
          id: 'trace.event.planned',
          defaultMessage:
            '{count, plural, one {Split the goal into # task} other {Split the goal into # tasks}}',
        },
        { count: event.tasks ?? 0 },
      );
    case 'dispatched':
      return t({ id: 'trace.event.dispatched', defaultMessage: 'Dispatched from the plan' });
    case 'question':
      return t(
        { id: 'trace.event.question', defaultMessage: 'Asked: {question}' },
        { question: event.detail ?? '—' },
      );
    case 'model_changed':
      return event.detail
        ? t(
            { id: 'trace.event.modelChanged', defaultMessage: 'Model changed to {model}' },
            { model: event.detail },
          )
        : t({ id: 'trace.event.modelDefault', defaultMessage: 'Model back to the default' });
    case 'opened':
      return t({ id: 'trace.event.opened', defaultMessage: 'Session started' });
    case 'closed':
      return t({ id: 'trace.event.closed', defaultMessage: 'Session ended' });
  }
}

/** What happened, with the input an approval asked for or the merged commit set as code. */
export function eventWords(event: TraceEvent, className = 'trc-evw') {
  const words = eventText(event);
  const code = event.input ?? (event.what === 'merged' ? event.detail : null);
  const at = code ? words.lastIndexOf(code) : -1;
  if (at < 0) return <span className={className}>{words}</span>;
  return (
    <span className={className}>
      {words.slice(0, at)}
      <code className="act-inl">{code}</code>
      {words.slice(at + code!.length)}
    </span>
  );
}

/**
 * How long an approval or question waited, the lines a merge changed, a gate run after the first,
 * or the headline of a plan.
 */
function Note({ event, now }: { event: TraceEvent; now: number }) {
  if (event.waitedMs !== undefined)
    return (
      <span className="trc-evn">
        {event.waitedMs === null
          ? t(
              { id: 'trace.activity.waiting', defaultMessage: 'Waiting {duration}' },
              { duration: durationText(now - event.at) },
            )
          : t(
              { id: 'trace.activity.waited', defaultMessage: 'Waited {duration}' },
              { duration: durationText(event.waitedMs) },
            )}
      </span>
    );
  if (event.added !== undefined && event.removed !== undefined)
    return (
      <span className="trc-evn">
        <DiffCounts additions={event.added} deletions={event.removed} />
      </span>
    );
  if (event.run !== undefined && event.run > 1)
    return (
      <span className="trc-evn">
        {t({ id: 'trace.activity.run', defaultMessage: 'Run {run}' }, { run: event.run })}
      </span>
    );
  if (event.what === 'planned' && event.detail)
    return <span className="trc-evn act-note">{event.detail}</span>;
  return <span className="trc-evn" />;
}

const flip = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

/**
 * The project's approvals, gate runs, merges, plans, model changes and sessions by day, filtered by
 * kind and by words; today open, earlier days closed.
 */
export function ActivityList({
  rows,
  error,
  onRetry,
  titleOf,
  now,
  onOpen,
}: {
  /** Newest first; null until the history is read. */
  rows: readonly TraceEvent[] | null;
  error: string | null;
  onRetry: () => void;
  titleOf: (sessionId: string) => string;
  now: number;
  onOpen: (sessionId: string) => void;
}) {
  const [off, setOff] = useState<ReadonlySet<TraceEventKind>>(() => new Set());
  const [query, setQuery] = useState('');
  // Days whose fold the user flipped from the default.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const kinds = useMemo(
    () => TRACE_EVENT_KINDS.filter((kind) => rows?.some((row) => row.kind === kind)),
    [rows],
  );
  const words = query.trim().toLowerCase();
  const days = useMemo(
    () =>
      eventDays(
        (rows ?? []).filter(
          (row) =>
            !off.has(row.kind) &&
            (!words || `${titleOf(row.sessionId)} ${eventText(row)}`.toLowerCase().includes(words)),
        ),
      ),
    [rows, off, words, titleOf],
  );
  const today = dayOf(now);
  return (
    <div className="trc-act">
      {kinds.length > 0 && (
        <div className="act-bar">
          <div
            className="trc-kinds"
            role="group"
            aria-label={t({ id: 'trace.activity.kinds', defaultMessage: 'Activity kinds' })}
          >
            {kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                className="trc-kc"
                aria-pressed={!off.has(kind)}
                onClick={() => setOff((held) => flip(held, kind))}
              >
                {!off.has(kind) && <Check className="ic-sm" aria-hidden="true" />}
                {KIND_TEXT[kind]}
              </button>
            ))}
          </div>
          <label className="field act-find">
            <Search className="ic-sm" aria-hidden="true" />
            <input
              type="search"
              aria-label={t({ id: 'trace.activity.filter', defaultMessage: 'Filter activity' })}
              placeholder={t({ id: 'trace.activity.filter', defaultMessage: 'Filter activity' })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      )}
      {error && <Failure error={error} onRetry={onRetry} />}
      {rows === null ? (
        !error && <Skeleton />
      ) : days.length === 0 ? (
        <Empty
          text={
            words && rows.length
              ? t({ id: 'trace.activity.noMatch', defaultMessage: 'No matching activity' })
              : t({ id: 'trace.activity.empty', defaultMessage: 'No activity' })
          }
        />
      ) : (
        <div className="trc-days">
          {days.map(({ day, rows }) => {
            const open = (day === today) !== flipped.has(day);
            const title = dayText(rows[0]!.at, now);
            return (
              <section key={day} className="trc-day" aria-label={title}>
                <div className="trc-dh">
                  <h2>{title}</h2>
                  <span className="trc-dn">
                    {t(
                      {
                        id: 'trace.activity.count',
                        defaultMessage: '{count, plural, one {# event} other {# events}}',
                      },
                      { count: rows.length },
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn ghost trc-dt"
                    aria-expanded={open}
                    onClick={() => setFlipped((held) => flip(held, day))}
                  >
                    <ChevronRight className="ic-sm trc-dc" aria-hidden="true" />
                    {open
                      ? t({ id: 'trace.activity.collapse', defaultMessage: 'Collapse' })
                      : t({ id: 'trace.activity.expand', defaultMessage: 'Expand' })}
                  </button>
                </div>
                {open && (
                  <ul className="trc-evl">
                    {rows.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          className="trc-ev"
                          onClick={() => onOpen(row.sessionId)}
                        >
                          {/* The day is the group's, so only the clock. */}
                          <span className="trc-evt">{dayText(row.at, row.at, { time: true })}</span>
                          <EventGlyph event={row} />
                          <span className="trc-evs">{titleOf(row.sessionId)}</span>
                          {eventWords(row)}
                          <Note event={row} now={now} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
