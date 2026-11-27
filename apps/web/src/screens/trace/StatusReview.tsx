import { useEffect, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Hourglass, X } from 'lucide-react';
import type { LandingRecord, RoleUsage, SettingProposal } from '@pantheon/domain';
import type {
  LandingStatistics,
  ProjectLandingsCompare,
  ProjectSettingProposals,
  ProjectStatusRead,
} from '@pantheon/protocol';
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

const LANDING_KINDS = [
  'session.merged',
  'session.merge_blocked',
  'session.merge_cancelled',
  'session.merge_dropped',
  'workspace.repository_changed',
  // A branch landing writes no event of its own; removing its worktree follows its end.
  'workspace.removed',
];

/** Landings, the user's answers to approvals, gates and turns. */
const STATUS_KINDS: ReadonlySet<string> = new Set([
  ...LANDING_KINDS,
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

const COMPARE_KINDS: ReadonlySet<string> = new Set(LANDING_KINDS);
const PROPOSAL_KINDS: ReadonlySet<string> = new Set(['setting.proposal_decided']);

/** How many landings on each side of an approval the comparison reads. */
const COMPARE_COUNT = 10;

const isProposals = (value: unknown): boolean =>
  Array.isArray((value as Partial<ProjectSettingProposals> | null)?.proposals);

const isCompare = (value: unknown): boolean => {
  const read = value as Partial<ProjectLandingsCompare> | null;
  return typeof read?.before?.count === 'number' && typeof read.after?.count === 'number';
};

/** The short name of the setting a proposal changes; an unknown command shows as it is. */
function settingName(command: SettingProposal['command']): string {
  switch (command) {
    case 'project.gate.set':
      return t({ id: 'trace.recap.setting.gate', defaultMessage: 'Gate commands' });
    case 'workflow.policy.set':
      return t({ id: 'trace.recap.setting.budget', defaultMessage: 'Budget' });
    case 'project.sessionDefaults.set':
      return t({ id: 'trace.recap.setting.sessionDefaults', defaultMessage: 'Session defaults' });
    case 'project.extensions.set':
      return t({ id: 'trace.recap.setting.extensions', defaultMessage: 'Extensions' });
    default:
      return command;
  }
}

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

const firstPassText = (rate: number | null) =>
  rate === null
    ? t({ id: 'trace.recap.noGates', defaultMessage: 'No gate runs' })
    : t(
        { id: 'trace.recap.rate', defaultMessage: '{percent}%' },
        { percent: Math.round(rate * 100) },
      );

/** One side of the comparison: its landing count heads the numbers. */
const compareSide = (heading: string, stats: LandingStatistics) => {
  const none = t({ id: 'trace.recap.setting.none', defaultMessage: 'None' });
  return (
    <div className="rcp-side" role="group" aria-label={heading}>
      <h4>{heading}</h4>
      <div className="trc-nums">
        {num(STATE_TEXT.landed!, String(stats.landed))}
        {num(STATE_TEXT.blocked!, String(stats.blocked))}
        {num(STATE_TEXT.no_changes!, String(stats.no_changes))}
        {num(
          t({ id: 'trace.recap.firstPass', defaultMessage: 'Gates passed first time' }),
          firstPassText(stats.first_gate_pass_rate),
        )}
        {num(
          t({ id: 'trace.recap.reviewRounds', defaultMessage: 'Mean review rounds' }),
          stats.mean_review_rounds === null
            ? none
            : String(Math.round(stats.mean_review_rounds * 10) / 10),
        )}
        {num(
          t({ id: 'trace.recap.medianTime', defaultMessage: 'Median time' }),
          stats.median_wall_ms === null ? none : durationText(stats.median_wall_ms),
        )}
      </div>
    </div>
  );
};

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
  const approved = useProjectQuery<ProjectSettingProposals>(
    'project.setting_proposals',
    projectId,
    isProposals,
    undefined,
    { kinds: PROPOSAL_KINDS },
  );
  const proposals = approved.read?.proposals ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = (proposals.find((row) => row.id === picked) ?? proposals[0])?.id;
  const compare = useProjectQuery<ProjectLandingsCompare>(
    'project.landings.compare',
    chosen ? projectId : null,
    isCompare,
    { proposal_id: chosen ?? '', count: String(COMPARE_COUNT) },
    { kinds: COMPARE_KINDS },
  );
  const now = Date.now();
  const name = t({ id: 'trace.recap.title', defaultMessage: 'Recap' });

  const landings = t({ id: 'trace.recap.landings', defaultMessage: 'Landings' });
  const waiting = t({ id: 'trace.recap.waiting', defaultMessage: 'Waiting on you' });
  const timeName = t({ id: 'trace.recap.time', defaultMessage: 'Where the time went' });
  const usageName = t({ id: 'trace.recap.usage', defaultMessage: 'Tokens by role' });
  const settingsName = t({
    id: 'trace.recap.settings',
    defaultMessage: 'Before and after a setting change',
  });

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
                    firstPassText(read.landings.first_gate_pass_rate),
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
          {(approved.error || proposals.length > 0) && (
            <section className="rcp-s" aria-label={settingsName}>
              <h3>{settingsName}</h3>
              {approved.error && <Failure error={approved.error} onRetry={approved.reload} />}
              {chosen && (
                <>
                  <RadioGroup<string>
                    className="rcp-pl"
                    aria-label={t({
                      id: 'trace.recap.settings.list',
                      defaultMessage: 'Approved setting changes',
                    })}
                    value={chosen}
                    onValueChange={(value) => setPicked(value)}
                  >
                    {proposals.map((row) => (
                      <Radio.Root key={row.id} value={row.id} className="rcp-pr">
                        <span className="rcp-pn">{settingName(row.command)}</span>
                        <Clip text={row.reason} />
                        {row.decided_at !== undefined && (
                          <span className="rcp-at">
                            {dayText(row.decided_at, now, { time: true })}
                          </span>
                        )}
                      </Radio.Root>
                    ))}
                  </RadioGroup>
                  {compare.error ? (
                    <Failure error={compare.error} onRetry={compare.reload} />
                  ) : compare.read === null ? (
                    <Skeleton />
                  ) : (
                    <div className="rcp-cmp">
                      {compareSide(
                        t(
                          {
                            id: 'trace.recap.settings.before',
                            defaultMessage:
                              '{count, plural, one {# landing before} other {# landings before}}',
                          },
                          { count: compare.read.before.count },
                        ),
                        compare.read.before,
                      )}
                      {compareSide(
                        t(
                          {
                            id: 'trace.recap.settings.after',
                            defaultMessage:
                              '{count, plural, one {# landing after} other {# landings after}}',
                          },
                          { count: compare.read.after.count },
                        ),
                        compare.read.after,
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
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
