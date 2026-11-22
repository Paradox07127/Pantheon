import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Activity, Search } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { EmptyState } from '../../components/EmptyState';
import { ReadStatus } from '../../components/ReadStatus';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { StateGlyph, type GlyphName } from '../../components/SessionStateIcon';
import { Skeleton } from '../../components/Skeleton';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { failureText, reasonText, useNeedsYou, useNow } from '../../data/needs-you';
import { useRunHistory } from '../../data/run-history';
import { useRunSpans } from '../../data/trace';
import { elapsedText } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { shortcutKeys } from '../../lib/shortcuts';
import { useShell } from '../../store';
import { tokenText } from '../../lib/number-text';
import { CallDetail } from './CallDetail';
import { CallTable } from './CallTable';
import {
  callRows,
  type CallFilter,
  type CallLine,
  type CallRow,
  type SessionFacts,
  type SessionRow,
} from './call-rows';
import { isLive, runForest, type RunForest, type RunStatus } from './run-tree';
import { laneFigures, liveFigures, rangeFigures, type RunFigures } from './run-stats';
import { onlySession, runtimeSessions, sessionFacts, splitEnded } from './runtime-model';
import './runs-page.css';

/** From this long on a call counts as slow, ms, while the diagnostics are unread; the daemon's slow-tool finding starts there too. */
export const SLOW_MS = 5_000;

type Only = CallFilter['only'];

const NONE = '—';
const NO_SESSIONS: readonly never[] = [];
const NO_IDS: readonly string[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_FACTS: ReadonlyMap<string, SessionFacts> = new Map();
const NO_RUN: RunForest = { trees: [], adhoc: [] };
const NO_PARENTS: ReadonlyMap<string, string> = new Map();
const ALL_TIME = { from: 0, to: null };

const ENDED_GLYPH: Record<RunStatus, GlyphName> = {
  running: 'running',
  waiting: 'approval',
  ready: 'ready',
  ok: 'done',
  error: 'failed',
  idle: 'idle',
};

// Labels are getters, so each is read in the language loaded by then.
const ONLY: { only: Only; label: string }[] = [
  {
    only: 'all',
    get label() {
      return t({ id: 'runs.page.only.all', defaultMessage: 'All' });
    },
  },
  {
    only: 'failed',
    get label() {
      return t({ id: 'runs.page.only.failed', defaultMessage: 'Failed only' });
    },
  },
  {
    only: 'slow',
    get label() {
      return t({ id: 'runs.page.only.slow', defaultMessage: 'Slow only' });
    },
  },
];

/** The read failure with the errors behind it, when there are any. */
const traceFailure = (summary: string, errors: string[]): string =>
  errors.length
    ? t(
        { id: 'runtime.trace.failedWith', defaultMessage: '{summary}: {errors}' },
        {
          summary,
          errors: errors.join(t({ id: 'runtime.trace.errorSeparator', defaultMessage: '; ' })),
        },
      )
    : summary;

const percentText = (share: number) =>
  new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(
    share,
  );

const clock = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

/** The call row started last; null without a started call. */
function newestCall(rows: readonly CallRow[]): CallLine | null {
  let newest: CallLine | null = null;
  for (const row of rows)
    if (
      row.type === 'call' &&
      row.call.start !== null &&
      row.call.start >= (newest?.call.start ?? -Infinity)
    )
      newest = row;
  return newest;
}

function Spark({ values, label }: { values: readonly number[]; label: string }) {
  const max = Math.max(1, ...values);
  const step = 100 / Math.max(1, values.length - 1);
  const d = values
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(26 - (v / max) * 24).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      className="rpg-spark"
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      width="56"
      height="24"
      role="img"
      aria-label={label}
    >
      <path pathLength={1} d={d} />
    </svg>
  );
}

/**
 * The runs tab. Now shows the sessions running and just ended; history the range's sessions,
 * each session's calls read once its row is picked or unfolded.
 */
// A session with no lane in the trace ran nothing in the range.
const NO_RUNS: RunFigures = {
  calls: 0,
  failed: 0,
  median: null,
  p95: null,
  tokens: 0,
  unreported: 0,
  cacheHit: null,
  spark: [],
};

export function RunsView({
  projectId,
  sessions,
  view = 'now',
  range,
  sessionId = null,
  slowMs = SLOW_MS,
  onShowInTimeline,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
  view?: 'now' | 'history';
  /** The history view's window; a null end runs up to now. */
  range?: { from: number; to: number | null };
  /** The one session shown; null shows every session. */
  sessionId?: string | null;
  /** From this long on a call counts as slow, ms; the diagnostics' threshold. */
  slowMs?: number;
  onShowInTimeline?: (at: {
    lane_key: string;
    turn_id?: string;
    span_id?: string;
    at: number;
  }) => void;
}) {
  const history = view === 'history';
  // Completed work ages out even when the daemon has no new events to publish.
  const windowNow = useNow(15_000);
  const snapshot = useBoard((s) => s.board?.sessions);
  const parents = useMemo(
    () =>
      snapshot
        ? new Map(
            snapshot.flatMap((s) =>
              s.spawned_by ? [[s.id, s.spawned_by.session_id] as const] : [],
            ),
          )
        : NO_PARENTS,
    [snapshot],
  );
  const shown = useMemo(
    () => (sessions && !history ? runtimeSessions(sessions, parents, windowNow) : NO_SESSIONS),
    [sessions, history, parents, windowNow],
  );
  const ids = useMemo(() => {
    if (shown.length === 0) return NO_IDS;
    const all = shown.map((s) => s.id);
    return sessionId === null ? all : all.filter((id) => id === sessionId);
  }, [shown, sessionId]);
  const liveSpans = useRunSpans(projectId, ids);
  // The history lanes whose spans are read, kept per project.
  const [opened, setOpened] = useState<{ projectId: string | null; ids: readonly string[] }>({
    projectId,
    ids: NO_IDS,
  });
  const openIds = history && opened.projectId === projectId ? opened.ids : NO_IDS;
  const past = useRunHistory(projectId, history ? (range ?? ALL_TIME) : null, openIds, sessionId);
  const spans = history ? past.spans : liveSpans;
  const readIds = history ? openIds : ids;
  // Until every trace is read, its calls would count as zero.
  const traced = readIds.every((id) => spans.has(id));
  const traceFailed = readIds.filter((id) => spans.failed?.has(id));
  const traceErrors = [...new Set(traceFailed.flatMap((id) => spans.errors?.get(id) ?? []))];
  const readTimes = readIds.flatMap((id) => spans.readAt?.get(id) ?? []);

  const whole = useMemo(
    () =>
      sessions && !history ? onlySession(runForest(shown, parents, liveSpans), sessionId) : NO_RUN,
    [sessions, history, shown, parents, liveSpans, sessionId],
  );
  const { live, ended } = useMemo(() => splitEnded(whole, shown), [whole, shown]);
  const forest = history ? past.forest : live;
  const now = useNow(!history && isLive(forest) ? 1000 : 15_000);
  const facts = useMemo(() => (shown.length ? sessionFacts(shown) : NO_FACTS), [shown]);
  const recorded = useMemo(() => new Set(sessions?.map((s) => s.id)), [sessions]);

  const [only, setOnly] = useState<Only>('all');
  const [query, setQuery] = useState('');
  const filter = useMemo(() => ({ only, text: query, slowMs }), [only, query, slowMs]);
  // Every row the table can show, sessions unfolded, so a pick or the followed call resolves.
  const rows = useMemo(() => {
    const base = { forest, facts, spans, view, now, filter };
    const folded = callRows({ ...base, toggled: NO_KEYS }).rows;
    if (!history) return folded;
    const open = new Set(folded.filter((row) => row.type === 'session').map((row) => row.key));
    return callRows({ ...base, toggled: open }).rows;
  }, [forest, facts, spans, view, now, filter, history]);

  const scope = `${projectId ?? ''}:${view}`;
  const [picked, setPicked] = useState<{ scope: string; key?: string; session?: string } | null>(
    null,
  );
  const [follow, setFollow] = useState(true);
  const mine =
    picked?.scope === scope
      ? (rows.find((row) =>
          picked.key !== undefined
            ? row.key === picked.key
            : row.type === 'session' && row.session === picked.session,
        ) ?? null)
      : null;
  const selected = !history && follow ? newestCall(rows) : mine;
  const open = (id: string) =>
    setOpened((was) =>
      was.projectId !== projectId
        ? { projectId, ids: [id] }
        : was.ids.includes(id)
          ? was
          : { projectId, ids: [...was.ids, id] },
    );
  const select = (row: CallRow | null) => {
    if (!history) setFollow(false);
    setPicked(row ? { scope, key: row.key } : null);
    if (row && history) open(row.session);
  };
  const showInHistory = (id: string) => {
    setPicked({ scope: `${projectId ?? ''}:history`, session: id });
    open(id);
    useShell.setState({ runsView: 'history' });
  };
  const showHistory = () => useShell.setState({ runsView: 'history' });

  const [respondFailure, setRespondFailure] = useState<string | null>(null);
  // The requests whose answer is out or was accepted.
  const [responding, setResponding] = useState<ReadonlySet<string>>(() => new Set());
  const answering = useRef(new Set<string>());
  const respond = async (
    approvalId: string,
    decision: 'approve' | 'reject',
    answers?: Record<string, string>,
  ) => {
    if (answering.current.has(approvalId)) return;
    answering.current.add(approvalId);
    setResponding(new Set(answering.current));
    setRespondFailure(null);
    const asked = [...facts.values()].find((f) => f.waiting?.approval_id === approvalId)?.waiting;
    const result = await runCommand(
      'approval.respond',
      { approval_id: approvalId, decision, ...(answers && { answers }) },
      asked?.revision ?? null,
    );
    // An accepted answer keeps the row's buttons off until the session stops waiting.
    if (result.ok) return;
    answering.current.delete(approvalId);
    setResponding(new Set(answering.current));
    setRespondFailure(failureText(result.error));
  };

  const needs = useNeedsYou(projectId);
  // Items kept after a failed read are no authority for an answer.
  const questions = useMemo(
    () =>
      new Map(
        (needs.error ? [] : (needs.items ?? [])).flatMap((item) => {
          if (item.source.table !== 'approvals' || !item.questions?.length) return [];
          const action = item.actions.find((a) => a.command === 'approval.respond');
          const reason =
            action && !action.allowed
              ? action.disabled_reason
                ? reasonText(action.disabled_reason)
                : t({ id: 'board.needs.noReason', defaultMessage: 'The backend gave no reason' })
              : null;
          return [[item.source.id, { questions: item.questions, reason }] as const];
        }),
      ),
    [needs.error, needs.items],
  );

  const shownTrace = past.trace.data;
  const shownLane =
    sessionId === null
      ? null
      : (shownTrace?.lanes.find(
          ({ lane }) => lane.key === sessionId || lane.session_id === sessionId,
        ) ?? null);
  const figures: RunFigures | null = history
    ? shownLane
      ? laneFigures(shownLane)
      : !shownTrace
        ? null
        : sessionId === null
          ? rangeFigures(shownTrace, past.stats.data)
          : NO_RUNS
    : liveFigures(whole, liveSpans, now);
  const figuresPending = !history && !traced && !traceFailed.length;
  const figuresFailed = !history && !traced;
  const incomplete = t({ id: 'runtime.stats.incomplete', defaultMessage: 'Data incomplete' });
  const unrecorded = t({ id: 'runs.page.unrecorded', defaultMessage: 'Not recorded' });
  const missing = (
    <span className="kpi" aria-label={unrecorded}>
      {NONE}
    </span>
  );
  const figure = (value: (f: RunFigures) => ReactNode) =>
    figures && !figuresPending && !figuresFailed ? (
      value(figures)
    ) : figuresPending ? (
      <Skeleton className="rpg-fig-sk" />
    ) : (
      <span className="kpi" aria-label={incomplete}>
        {NONE}
      </span>
    );
  const cell = (label: string, body: ReactNode) => (
    <div className="cell rpg-fig">
      <span className="cap">{label}</span>
      <div className="rpg-fig-v">{body}</div>
    </div>
  );

  const detailRow = selected?.type === 'call' ? selected : null;
  const sessionOf = detailRow
    ? (rows.find(
        (row): row is SessionRow => row.type === 'session' && row.session === detailRow.session,
      ) ?? null)
    : null;
  const detailSpan = detailRow
    ? spans.get(detailRow.session)?.find((span) => span.id === detailRow.call.id)
    : undefined;
  const turnId = detailSpan?.turn;
  const turnCost = detailRow
    ? spans.get(detailRow.session)?.find((span) => span.kind === 'turn' && span.id === turnId)
        ?.cost_usd
    : undefined;
  const turnsOf = (id: string) =>
    spans.get(id)?.filter((span) => span.kind === 'turn' && span.parent === null).length ?? 0;
  const viewKeys = shortcutKeys('trace-view');
  const empty =
    !history && !!sessions && forest.trees.length + forest.adhoc.length + ended.length === 0;

  return (
    <main className="rpg" data-detail={detailRow ? '' : undefined}>
      <section
        className="rpg-main"
        aria-label={
          history
            ? t({ id: 'runs.page.historyLabel', defaultMessage: 'Calls in the range' })
            : t({ id: 'runs.page.nowLabel', defaultMessage: 'Sessions running now' })
        }
      >
        {history && <ReadStatus label="Trace" {...past.trace} />}
        <ReadStatus
          label="Trace"
          stale={spans.stale}
          loading={spans.loading}
          error={
            traceFailed.length
              ? traceFailure(
                  t(
                    {
                      id: 'runtime.trace.failed',
                      defaultMessage:
                        '{failed} of {total, plural, one {# session} other {# sessions}} could not be read{partial, select, yes {, totals incomplete} other {}}',
                    },
                    {
                      failed: traceFailed.length,
                      total: readIds.length,
                      partial: traced ? 'no' : 'yes',
                    },
                  ),
                  traceErrors,
                )
              : null
          }
          readAt={readTimes.length ? Math.min(...readTimes) : null}
          reload={spans.reload}
        />
        {empty ? (
          <EmptyState
            graphic={<Activity aria-hidden="true" />}
            title={t({ id: 'runs.page.nowEmpty', defaultMessage: 'No sessions running now' })}
            action={{
              label: t({ id: 'runs.page.seeHistory', defaultMessage: 'See history' }),
              keys: viewKeys,
              onClick: showHistory,
            }}
          />
        ) : !(history ? shownTrace : sessions) ? (
          (!history || past.trace.loading) && <Skeleton className="rpg-skel" />
        ) : (
          <>
            <div
              className="panel rpg-figs"
              role="group"
              aria-label={t({ id: 'runs.page.figures', defaultMessage: 'Run figures' })}
              aria-busy={figuresPending || undefined}
            >
              {cell(
                t({ id: 'runs.page.calls', defaultMessage: 'Calls' }),
                figure((f) => (
                  <>
                    <span className="kpi">{f.calls}</span>
                    {f.spark.length > 1 && (
                      <Spark
                        values={f.spark}
                        label={
                          history
                            ? t({
                                id: 'runs.page.sparkRange',
                                defaultMessage: 'Calls over the range',
                              })
                            : t({
                                id: 'runs.page.sparkNow',
                                defaultMessage: 'Calls per minute, last 10 minutes',
                              })
                        }
                      />
                    )}
                  </>
                )),
              )}
              {cell(
                t({ id: 'runs.page.failed', defaultMessage: 'Failed' }),
                figure((f) =>
                  f.failed === null ? (
                    missing
                  ) : (
                    <>
                      <span className="kpi">{f.failed}</span>
                      {f.calls > 0 && (
                        <span className="rpg-delta">{percentText(f.failed / f.calls)}</span>
                      )}
                    </>
                  ),
                ),
              )}
              {cell(
                t({ id: 'runs.page.median', defaultMessage: 'Median duration' }),
                figure((f) =>
                  f.median === null ? (
                    missing
                  ) : (
                    <>
                      <span className="kpi">{elapsedText(f.median)}</span>
                      <span className="rpg-delta">
                        {t(
                          { id: 'runs.page.p95', defaultMessage: 'p95 {time}' },
                          { time: elapsedText(f.p95 ?? f.median) },
                        )}
                      </span>
                    </>
                  ),
                ),
              )}
              {cell(
                t({ id: 'runs.page.tokens', defaultMessage: 'Tokens' }),
                figure((f) =>
                  f.unreported > 0 && f.tokens === 0 ? (
                    missing
                  ) : f.unreported > 0 ? (
                    <span
                      className="kpi"
                      aria-label={t(
                        {
                          id: 'runtime.stats.unreported',
                          defaultMessage:
                            '{count, plural, one {# turn did not report usage} other {# turns did not report usage}}',
                        },
                        { count: f.unreported },
                      )}
                    >
                      {`${tokenText(f.tokens)}+`}
                    </span>
                  ) : (
                    <span className="kpi">{tokenText(f.tokens)}</span>
                  ),
                ),
              )}
              {cell(
                t({ id: 'runs.page.cacheHit', defaultMessage: 'Cache hit' }),
                figure((f) =>
                  f.cacheHit === null ? (
                    missing
                  ) : (
                    <span className="kpi">{percentText(f.cacheHit)}</span>
                  ),
                ),
              )}
            </div>
            <div className="rpg-filter">
              <RadioGroup<Only>
                className="tb-seg"
                aria-label={t({ id: 'runs.page.scope', defaultMessage: 'Scope' })}
                value={only}
                onValueChange={(value) => setOnly(value)}
              >
                {ONLY.map((o) => (
                  <Radio.Root key={o.only} value={o.only}>
                    {o.label}
                  </Radio.Root>
                ))}
              </RadioGroup>
              <label className="field rpg-search">
                <Search className="ic-sm" aria-hidden="true" />
                <input
                  value={query}
                  placeholder={t({
                    id: 'runs.page.filterPlaceholder',
                    defaultMessage: 'Filter by tool, file or command',
                  })}
                  aria-label={t({ id: 'runs.page.filter', defaultMessage: 'Filter calls' })}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {!history && (
                <label className="rpg-follow">
                  <input
                    type="checkbox"
                    className="ps-sw"
                    checked={follow}
                    aria-label={t({
                      id: 'runs.page.followLabel',
                      defaultMessage: 'Follow the newest call',
                    })}
                    onChange={(e) => setFollow(e.target.checked)}
                  />
                  {t({ id: 'runs.page.follow', defaultMessage: 'Follow' })}
                </label>
              )}
            </div>
            {respondFailure && (
              <p className="rpg-fail" role="alert">
                {respondFailure}
              </p>
            )}
            {history && forest.adhoc.length === 0 ? (
              <EmptyState
                inline
                title={t({
                  id: 'runs.page.historyEmpty',
                  defaultMessage: 'No calls in this range',
                })}
              />
            ) : (
              forest.trees.length + forest.adhoc.length > 0 && (
                // The table folds its rows itself; a session unfolded by its arrow has its calls read.
                <div
                  onClickCapture={
                    history
                      ? (e) => {
                          const key = (e.target as Element)
                            .closest('.ct-fold')
                            ?.closest('[data-key]')
                            ?.getAttribute('data-key');
                          const row = key ? rows.find((r) => r.key === key) : undefined;
                          if (row) open(row.session);
                        }
                      : undefined
                  }
                >
                  <CallTable
                    forest={forest}
                    facts={facts}
                    spans={spans}
                    view={view}
                    now={now}
                    selected={selected?.key ?? null}
                    onSelect={select}
                    filter={filter}
                    onRespond={history ? undefined : (id, decision) => void respond(id, decision)}
                    onAnswer={
                      history ? undefined : (id, answers) => void respond(id, 'approve', answers)
                    }
                    asked={questions}
                    responding={responding}
                    keys={{ next: 'trace-next', previous: 'trace-previous' }}
                  />
                </div>
              )
            )}
            {ended.length > 0 && (
              <div
                className="rpg-ended"
                role="group"
                aria-label={t({ id: 'runs.page.justEnded', defaultMessage: 'Just ended' })}
              >
                <div className="rpg-row rpg-ended-h" aria-hidden="true">
                  <span>{t({ id: 'runs.page.justEnded', defaultMessage: 'Just ended' })}</span>
                </div>
                {ended.map(({ node, at }) => {
                  const turns = turnsOf(node.id);
                  return (
                    <div key={node.id} className="rpg-row">
                      <span className="rpg-name">
                        <StateGlyph name={ENDED_GLYPH[node.status]} />
                        <span className="rpg-title" data-state={node.status}>
                          {node.title}
                        </span>
                        {(node.runtime || turns > 0) && (
                          <span className="chip">
                            {node.runtime && <RuntimeGlyph runtime={node.runtime} size={14} />}
                            {turns > 0 &&
                              t(
                                { id: 'runs.table.turn', defaultMessage: 'Turn {count}' },
                                { count: turns },
                              )}
                          </span>
                        )}
                      </span>
                      <span className="rpg-num">
                        {node.tokens > 0 ? tokenText(node.tokens) : ''}
                      </span>
                      <span />
                      <span className="rpg-num">
                        {node.start !== null && node.end !== null
                          ? elapsedText(node.end - node.start)
                          : ''}
                      </span>
                      <span className="rpg-end">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => showInHistory(node.id)}
                        >
                          {t({ id: 'runs.page.inHistory', defaultMessage: 'Show in history' })}
                        </button>
                        <span className="rpg-at">{clock(at)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
      {detailRow && (
        <CallDetail
          key={detailRow.key}
          call={detailRow.call}
          span={detailSpan}
          turnCost={turnCost}
          session={detailRow.session}
          title={sessionOf?.node.title ?? detailRow.session}
          turn={sessionOf?.turn ?? null}
          projectId={projectId}
          events={recorded.has(detailRow.session)}
          now={now}
          onClose={() => select(null)}
          onShowInTimeline={
            onShowInTimeline &&
            (() =>
              onShowInTimeline({
                lane_key: detailRow.session,
                ...(turnId && { turn_id: turnId }),
                span_id: detailRow.call.id,
                at: detailRow.call.start ?? now,
              }))
          }
        />
      )}
    </main>
  );
}
