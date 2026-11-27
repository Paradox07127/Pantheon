import { useEffect } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Hourglass, X } from 'lucide-react';
import type { LandingRecord, RoleUsage } from '@pantheon/domain';
import type { ProjectStatusRead } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { useMidnights } from '../../data/needs-you';
import { useProjectQuery } from '../../data/project-read';
import { t } from '../../i18n';
import { tokenText } from '../../lib/number-text';
import { dayText, durationText } from '../../lib/time-text';
import { useShell } from '../../store';
import { ROLE_LABEL, roleBars, roleColor } from '../project/usage-model';
import './status-review.css';

/** The days the recap covers, today included, in the browser's time zone. */
export type ReviewRange = 'today' | 'week' | 'month';

const RANGE_DAYS: Record<ReviewRange, number> = { today: 1, week: 7, month: 30 };

const RANGES: { range: ReviewRange; label: string }[] = [
  {
    range: 'today',
    get label() {
      return t({ id: 'trace.recap.range.today', defaultMessage: 'Today' });
    },
  },
  {
    range: 'week',
    get label() {
      return t({ id: 'trace.recap.range.week', defaultMessage: 'Last 7 days' });
    },
  },
  {
    range: 'month',
    get label() {
      return t({ id: 'trace.recap.range.month', defaultMessage: 'Last 30 days' });
    },
  },
];

/**
 * [from, to) of the range: local midnight of its first day to the coming midnight. The daemon
 * reads nothing past now, so the window stays one query until the day turns.
 */
export function reviewWindow(range: ReviewRange, now: number): { from: number; to: number } {
  const day = new Date(now);
  const at = (days: number) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate() + days).getTime();
  return { from: at(1 - RANGE_DAYS[range]), to: at(1) };
}

/** Landings, the user's answers to approvals, gates and turns. */
const STATUS_KINDS: ReadonlySet<string> = new Set([
  'session.merged',
  'session.merge_blocked',
  'session.merge_cancelled',
  'session.merge_dropped',
  'workspace.repository_changed',
  // A branch landing writes no event of its own; removing its worktree follows its end.
  'workspace.removed',
  'session.gate_started',
  'session.gate_checked',
  'session.gate_run_cancelled',
  'session.gate_run_failed',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.refused',
  'approval.resolved',
  'approval.void',
  'turn.queued',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'agent.usage.updated',
]);

const isStatus = (value: unknown): boolean => {
  const read = value as Partial<ProjectStatusRead> | null;
  return (
    Array.isArray(read?.landings?.records) &&
    Array.isArray(read.waiting?.longest) &&
    Array.isArray(read.time?.roles) &&
    Array.isArray(read.usage)
  );
};

const STATE_TEXT: Partial<Record<LandingRecord['state'], string>> = {
  get landed() {
    return t({ id: 'trace.recap.state.landed', defaultMessage: 'Landed' });
  },
  get blocked() {
    return t({ id: 'trace.recap.state.blocked', defaultMessage: 'Blocked' });
  },
  get no_changes() {
    return t({ id: 'trace.recap.state.noChanges', defaultMessage: 'No changes' });
  },
};

const pct = (share: number) => `${share * 100}%`;

const num = (label: string, value: string) => (
  <div key={label} className="trc-num" role="img" aria-label={`${label} ${value}`}>
    <b aria-hidden="true">{value}</b>
    <span aria-hidden="true">{label}</span>
  </div>
);

const sessionRef = (id: string, title: string, exists: boolean) =>
  exists ? (
    <button type="button" className="rcp-ref" onClick={() => useShell.getState().openSession(id)}>
      <Clip text={title} />
    </button>
  ) : (
    <Clip text={title} />
  );

/**
 * How the project went over a range of days: what landed, how long it waited on the user, where
 * the turn and gate time went and the tokens by role.
 */
export function StatusReview({
  projectId,
  titleOf,
  hasSession,
  range,
  onRange,
  onClose,
}: {
  projectId: string;
  titleOf: (sessionId: string) => string;
  /** False for a session that was deleted, which records and waits still name. */
  hasSession: (sessionId: string) => boolean;
  range: ReviewRange;
  onRange: (range: ReviewRange) => void;
  onClose: () => void;
}) {
  // A new day moves the window.
  useMidnights();
  const { from, to } = reviewWindow(range, Date.now());
  const status = useProjectQuery<ProjectStatusRead>(
    'project.status.read',
    projectId,
    isStatus,
    { from: String(from), to: String(to) },
    { kinds: STATUS_KINDS },
  );
  const read = status.read;
  // The daemon measures an open wait up to the time of the read, and no event comes while it waits.
  const waitOpen = read?.waiting.longest.some((wait) => wait.open) ?? false;
  const reload = status.reload;
  useEffect(() => {
    if (!waitOpen) return;
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [waitOpen, reload]);
  const now = Date.now();
  const name = t({ id: 'trace.recap.title', defaultMessage: 'Recap' });

  const landings = t({ id: 'trace.recap.landings', defaultMessage: 'Landings' });
  const waiting = t({ id: 'trace.recap.waiting', defaultMessage: 'Waiting on you' });
  const timeName = t({ id: 'trace.recap.time', defaultMessage: 'Where the time went' });
  const usageName = t({ id: 'trace.recap.usage', defaultMessage: 'Tokens by role' });

  const timeRows = read
    ? [
        ...read.time.roles
          .filter((row) => row.turn_ms > 0)
          .map((row) => ({
            key: row.role as string,
            label: ROLE_LABEL[row.role],
            ms: row.role === 'reviewer' ? read.time.review_ms : row.turn_ms,
            color: roleColor(row.role),
            spoken:
              row.role === 'reviewer'
                ? t(
                    { id: 'trace.recap.time.review', defaultMessage: '{role}: {time} reviewing' },
                    { role: ROLE_LABEL[row.role], time: durationText(read.time.review_ms) },
                  )
                : null,
          })),
        ...(read.time.gate_ms > 0
          ? [
              {
                key: 'gate',
                label: t({ id: 'trace.recap.time.gate', defaultMessage: 'Gates' }),
                ms: read.time.gate_ms,
                color: 'var(--chk)',
                spoken: null,
              },
            ]
          : []),
      ].sort((a, b) => b.ms - a.ms)
    : [];
  const longestMs = Math.max(0, ...timeRows.map((row) => row.ms));
  // roleBars reads only the role and its token fields.
  const bars = read
    ? roleBars(read.usage as RoleUsage[]).filter((bar) => bar.input + bar.output > 0)
    : [];

  return (
    <aside className="rcp" aria-label={name} aria-busy={status.loading || undefined}>
      <div className="rcp-h">
        <h2>{name}</h2>
        <RadioGroup<ReviewRange>
          className="seg"
          aria-label={t({ id: 'trace.recap.range', defaultMessage: 'Time range' })}
          value={range}
          onValueChange={(value) => onRange(value)}
        >
          {RANGES.map((r) => (
            <Radio.Root key={r.range} value={r.range}>
              {r.label}
            </Radio.Root>
          ))}
        </RadioGroup>
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'trace.recap.close', defaultMessage: 'Close recap' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      {status.error && <Failure error={status.error} onRetry={status.reload} />}
      {read === null ? (
        !status.error && <Skeleton />
      ) : (
        <>
          <section className="rcp-s" aria-label={landings}>
            <h3>{landings}</h3>
            {read.landings.records.length === 0 ? (
              <EmptyState
                inline
                title={t({
                  id: 'trace.recap.landings.empty',
                  defaultMessage: 'Nothing landed in this period.',
                })}
              />
            ) : (
              <>
                <div className="trc-nums">
                  {num(STATE_TEXT.landed!, String(read.landings.landed))}
                  {num(STATE_TEXT.blocked!, String(read.landings.blocked))}
                  {num(STATE_TEXT.no_changes!, String(read.landings.no_changes))}
                  {num(
                    t({ id: 'trace.recap.firstPass', defaultMessage: 'Gates passed first time' }),
                    read.landings.first_gate_pass_rate === null
                      ? t({ id: 'trace.recap.noGates', defaultMessage: 'No gate runs' })
                      : t(
                          { id: 'trace.recap.rate', defaultMessage: '{percent}%' },
                          { percent: Math.round(read.landings.first_gate_pass_rate * 100) },
                        ),
                  )}
                  {read.landings.mean_review_rounds !== null &&
                    num(
                      t({ id: 'trace.recap.reviewRounds', defaultMessage: 'Mean review rounds' }),
                      String(Math.round(read.landings.mean_review_rounds * 10) / 10),
                    )}
                  {read.landings.median_wall_ms !== null &&
                    num(
                      t({ id: 'trace.recap.medianTime', defaultMessage: 'Median time' }),
                      durationText(read.landings.median_wall_ms),
                    )}
                </div>
                <ul className="rcp-l">
                  {read.landings.records.map((record) => (
                    <li key={record.id}>
                      {record.session_id ? (
                        sessionRef(
                          record.session_id,
                          titleOf(record.session_id),
                          hasSession(record.session_id),
                        )
                      ) : (
                        <Clip text={record.branch ?? record.id} className="mono" />
                      )}
                      <span className="rcp-st" data-state={record.state}>
                        {STATE_TEXT[record.state] ?? record.state}
                      </span>
                      <span className="rcp-at">
                        {dayText(record.ended_at, now, { time: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="rcp-s" aria-label={waiting}>
            <h3>{waiting}</h3>
            {read.waiting.count === 0 ? (
              <EmptyState
                inline
                title={t({
                  id: 'trace.recap.waiting.empty',
                  defaultMessage: 'Nothing waited on you in this period.',
                })}
              />
            ) : (
              <>
                <div className="trc-nums">
                  {num(
                    t({ id: 'trace.recap.waits', defaultMessage: 'Times' }),
                    String(read.waiting.count),
                  )}
                  {num(
                    t({ id: 'trace.recap.waited', defaultMessage: 'Total time' }),
                    durationText(read.waiting.total_ms),
                  )}
                </div>
                <ul
                  className="rcp-l"
                  aria-label={t({ id: 'trace.recap.longest', defaultMessage: 'Longest waits' })}
                >
                  {read.waiting.longest.map((wait, i) => (
                    <li key={i}>
                      {wait.session_id ? (
                        sessionRef(
                          wait.session_id,
                          titleOf(wait.session_id),
                          hasSession(wait.session_id),
                        )
                      ) : (
                        <span className="rcp-none">
                          {t({ id: 'trace.recap.noSession', defaultMessage: 'No session' })}
                        </span>
                      )}
                      <span className="rcp-st">
                        {wait.kind === 'permission'
                          ? t({ id: 'trace.recap.kind.permission', defaultMessage: 'Permission' })
                          : wait.kind}
                      </span>
                      {wait.open && (
                        <Hourglass
                          className="ic-sm rcp-open"
                          role="img"
                          aria-label={t({
                            id: 'trace.recap.open',
                            defaultMessage: 'Still waiting',
                          })}
                        />
                      )}
                      <span className="rcp-at">{durationText(wait.wait_ms)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="rcp-s" aria-label={timeName}>
            <h3>{timeName}</h3>
            {timeRows.length === 0 ? (
              <EmptyState
                inline
                title={t({
                  id: 'trace.recap.time.empty',
                  defaultMessage: 'No turn or gate ran in this period.',
                })}
              />
            ) : (
              <div className="pj-urs">
                {timeRows.map((row) => (
                  <div className="pj-ur" key={row.key}>
                    <span className="pj-url">{row.label}</span>
                    <span
                      className="pj-urb"
                      role="img"
                      aria-label={
                        row.spoken ??
                        t(
                          { id: 'trace.recap.time.row', defaultMessage: '{role}: {time}' },
                          { role: row.label, time: durationText(row.ms) },
                        )
                      }
                    >
                      <i
                        className="rcp-tb"
                        style={{ width: pct(row.ms / longestMs), backgroundColor: row.color }}
                      />
                    </span>
                    <span className="pj-un">{durationText(row.ms)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="rcp-s" aria-label={usageName}>
            <h3>{usageName}</h3>
            {bars.length === 0 ? (
              <EmptyState
                inline
                title={t({
                  id: 'trace.recap.usage.none',
                  defaultMessage: 'No token usage was reported in this period.',
                })}
              />
            ) : (
              <>
                <div className="pj-ulg">
                  <span>
                    <i className="pj-usw pj-usw-in" />
                    {t({ id: 'project.usage.input', defaultMessage: 'Input' })}
                  </span>
                  <span>
                    <i className="pj-usw pj-usw-cache" />
                    {t({ id: 'project.usage.cachedInput', defaultMessage: 'Cached input' })}
                  </span>
                  <span>
                    <i className="pj-usw pj-usw-out" />
                    {t({ id: 'project.usage.output', defaultMessage: 'Output' })}
                  </span>
                </div>
                <div className="pj-urs">
                  {bars.map(({ role, label, input, output, cached, row }) => (
                    <div className="pj-ur" key={role}>
                      <span className="pj-url">{label}</span>
                      <span
                        className="pj-urb"
                        role="img"
                        aria-label={t(
                          {
                            id: 'project.usage.roleLabel',
                            defaultMessage:
                              '{role}: input {input}, cached {cached}, output {output}, {turns, plural, one {# turn} other {# turns}}',
                          },
                          {
                            role: label,
                            input: tokenText(row.input_tokens),
                            cached:
                              row.cached_input_tokens == null
                                ? t({
                                    id: 'project.usage.notReported',
                                    defaultMessage: 'not reported',
                                  })
                                : tokenText(row.cached_input_tokens),
                            output: tokenText(row.output_tokens),
                            turns: row.turns,
                          },
                        )}
                      >
                        {input > 0 && (
                          <i
                            className="pj-uin"
                            style={{ width: pct(input), backgroundColor: roleColor(role) }}
                          >
                            {cached > 0 && (
                              <i className="pj-ucache" style={{ width: pct(cached) }} />
                            )}
                          </i>
                        )}
                        {output > 0 && (
                          <i
                            className="pj-uout"
                            style={{
                              width: pct(output),
                              backgroundColor: `color-mix(in srgb, ${roleColor(role)} 45%, var(--sf))`,
                            }}
                          />
                        )}
                      </span>
                      <span className="pj-un">
                        {tokenText(row.input_tokens + row.output_tokens)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
