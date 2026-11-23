import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Eye, FileText, Flag, GitBranch, ShieldCheck, X } from 'lucide-react';
import type { Review } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { EmptyState } from '../../components/EmptyState';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { GateMark, StateGlyph, type GlyphName } from '../../components/SessionStateIcon';
import { TopBar } from '../../components/TopBar';
import {
  CHANGE_FILTERS,
  changeLandingId,
  changeSessionId,
  inFilter,
  reviewGuide,
  sortChanges,
  useProjectChanges,
  useReview,
  type ChangeFilter,
  type ChangeRow,
} from '../../data/changes';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { useSessionGates } from '../../data/session-panel';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { shortcutMatches } from '../../lib/shortcuts';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import { GateResults } from '../sessions/GateResults';
import { aheadText, gateFailing } from '../sessions/inspector-model';
import { GATE_NAME } from '../sessions/SessionHeader';
import { ChangedFiles } from './ChangedFiles';
import { TellBox } from './TellBox';
import './changes.css';

const FILTER_NAME: Record<ChangeFilter, () => string> = {
  all: () => t({ id: 'changes.filter.all', defaultMessage: 'All' }),
  ready: () => t({ id: 'changes.filter.ready', defaultMessage: 'Can land' }),
  needs_you: () => t({ id: 'changes.filter.needsYou', defaultMessage: 'Needs you' }),
  merged: () => t({ id: 'changes.filter.merged', defaultMessage: 'Landed' }),
};

const STATUS_GLYPH: Record<ChangeRow['status'], GlyphName> = {
  running: 'running',
  needs_you: 'approval',
  ready: 'ready',
  merged: 'merged',
  failed: 'failed',
};

/** The gate of a row as words: failed names the checks that failed. */
export function gateText(gate: ChangeRow['gate']): string {
  if (gate.state === 'failed' && gate.failed?.length)
    return t(
      { id: 'changes.gate.failedNames', defaultMessage: 'Failed: {names}' },
      { names: listText(...gate.failed) },
    );
  if (gate.state === 'none') return t({ id: 'changes.gate.none', defaultMessage: 'Not run' });
  return GATE_NAME[gate.state];
}

const verdictText = (runtime: string, verdict: 'pass' | 'fail') =>
  t(
    {
      id: 'changes.review.verdict',
      defaultMessage: '{runtime} {verdict, select, pass {passed} other {failed}}',
    },
    { runtime: runtimeName(runtime), verdict },
  );

const blockingText = (count: number) =>
  t(
    {
      id: 'changes.review.blocking',
      defaultMessage: '{count, plural, one {# blocking} other {# blocking}}',
    },
    { count },
  );

const incompleteText = () =>
  t({ id: 'changes.review.incomplete', defaultMessage: 'Review incomplete' });

/** The landing state of a row, as a chip's tone and words; null while it is not landing. */
function landingOf(row: ChangeRow): { tone: string; text: string } | null {
  if (row.landing === 'queued')
    return {
      tone: 'wait',
      text: t({ id: 'changes.landing.queued', defaultMessage: 'Queued to land' }),
    };
  if (row.landing === 'running')
    return { tone: 'run', text: t({ id: 'changes.landing.running', defaultMessage: 'Landing' }) };
  if (row.status === 'merged')
    return { tone: 'ok', text: t({ id: 'changes.landing.merged', defaultMessage: 'Landed' }) };
  return null;
}

function RowMark({ row }: { row: ChangeRow }) {
  if (row.kind === 'branch')
    return (
      <GitBranch
        className="ic-sm chg-mu"
        role="img"
        aria-label={t({ id: 'changes.row.branch', defaultMessage: 'Branch without a session' })}
      />
    );
  if (!row.runtime) return null;
  return (
    <span className="chg-glyph" role="img" aria-label={runtimeName(row.runtime)}>
      <RuntimeGlyph runtime={row.runtime} />
    </span>
  );
}

function ReviewCell({ review }: { review: ChangeRow['review'] }) {
  if (!review)
    return (
      <span className="chg-mu">
        {t({ id: 'changes.review.none', defaultMessage: 'Not reviewed' })}
      </span>
    );
  if (review.verdicts.length === 0)
    return (
      <span className="chg-h chg-mu">
        {review.state === 'running'
          ? t({ id: 'changes.review.running', defaultMessage: 'Reviewing' })
          : review.incomplete
            ? incompleteText()
            : t({ id: 'changes.review.noVerdict', defaultMessage: 'No verdict' })}
        {review.blocking_open > 0 && <span>{blockingText(review.blocking_open)}</span>}
      </span>
    );
  return (
    <span className="chg-h">
      {review.verdicts.map((v) => (
        <span
          key={v.runtime}
          className="chg-h"
          role="img"
          aria-label={verdictText(v.runtime, v.verdict)}
        >
          <RuntimeGlyph runtime={v.runtime} />
          <i
            className="chg-dot"
            data-tone={v.verdict === 'fail' ? 'bad' : review.incomplete ? undefined : 'ok'}
          />
        </span>
      ))}
      {review.incomplete && <span className="chg-mu">{incompleteText()}</span>}
      {review.blocking_open > 0 && (
        <span className="chg-mu">{blockingText(review.blocking_open)}</span>
      )}
    </span>
  );
}

/**
 * Every change of the project, newest first, filtered by status; the keys move the highlight and
 * Enter opens the highlighted row beside the list.
 */
export function ChangesScreen({
  projectId,
  sessions,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
}) {
  const read = useProjectChanges(projectId);
  const [filter, setFilter] = useState<ChangeFilter>('all');
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const all = read.read ? sortChanges(read.read.changes) : null;
  const rows = all?.filter((row) => inFilter(row, filter)) ?? null;
  const count = (f: ChangeFilter) => all?.filter((row) => inFilter(row, f)).length ?? 0;
  const highlighted = rows?.find((row) => row.id === active) ?? rows?.[0] ?? null;
  const opened = rows?.find((row) => row.id === open) ?? null;
  const filteredOut = open !== null && rows !== null && !opened;
  useEffect(() => {
    if (filteredOut) setOpen(null);
  }, [filteredOut]);
  const sessionOf = (row: ChangeRow) => {
    const id = changeSessionId(row);
    return (id && sessions?.find((s) => s.id === id)) || null;
  };
  const gridRef = useRef<HTMLDivElement>(null);
  const choose = (row: ChangeRow) => {
    setActive(row.id);
    setOpen(row.id);
  };
  /** Closes the inspector and gives the focus back to the list, on the row it showed. */
  const close = () => {
    if (open !== null) setActive(open);
    setOpen(null);
    gridRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows?.length) return;
    const at = highlighted ? rows.indexOf(highlighted) : 0;
    const go = (index: number) => {
      const id = rows[Math.max(0, Math.min(rows.length - 1, index))]!.id;
      setActive(id);
      globalThis.document?.getElementById(`chg-${id}`)?.scrollIntoView({ block: 'nearest' });
    };
    if (shortcutMatches('list-down', e) || shortcutMatches('list-next', e)) go(at + 1);
    else if (shortcutMatches('list-up', e) || shortcutMatches('list-previous', e)) go(at - 1);
    else if (shortcutMatches('list-first', e)) go(0);
    else if (shortcutMatches('list-last', e)) go(rows.length - 1);
    else if (shortcutMatches('list-open', e) && highlighted) setOpen(highlighted.id);
    else if (e.key === 'Escape' && open !== null) close();
    else return;
    e.preventDefault();
  };
  const name = SCREEN_NAMES.changes;
  return (
    <Tabs.Root
      className="tb-pg"
      value={filter}
      onValueChange={(value) => setFilter(value as ChangeFilter)}
    >
      <TopBar title={name} count={all?.length}>
        <Tabs.List className="tb-tabs" aria-label={name}>
          {CHANGE_FILTERS.map((f) => (
            <Tabs.Tab key={f} className="tb-tab" value={f}>
              {FILTER_NAME[f]()}
              <span className="tb-ct">{count(f)}</span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </TopBar>
      <Tabs.Panel className="chg" value={filter} data-inspector={opened ? '' : undefined}>
        <div className="chg-main">
          {read.error && <Failure error={read.error} onRetry={read.reload} />}
          {rows === null ? (
            !read.error && <Skeleton />
          ) : rows.length === 0 ? (
            <EmptyState
              inline
              title={
                filter === 'all'
                  ? t({ id: 'changes.empty', defaultMessage: 'No changes yet.' })
                  : t({ id: 'changes.emptyFilter', defaultMessage: 'No changes in this view.' })
              }
            />
          ) : (
            <div
              ref={gridRef}
              className="chg-grid"
              role="grid"
              tabIndex={0}
              aria-label={name}
              aria-activedescendant={highlighted ? `chg-${highlighted.id}` : undefined}
              onKeyDown={onKeyDown}
            >
              <div className="chg-r chg-hd" role="row">
                <span role="columnheader" />
                <span role="columnheader">
                  {t({ id: 'changes.column.change', defaultMessage: 'Change' })}
                </span>
                {!opened && (
                  <>
                    <span role="columnheader">
                      {t({ id: 'changes.column.diff', defaultMessage: 'Diff' })}
                    </span>
                    <span role="columnheader">
                      {t({ id: 'changes.column.branch', defaultMessage: 'Branch' })}
                    </span>
                    <span role="columnheader">
                      {t({ id: 'changes.column.gate', defaultMessage: 'Gate' })}
                    </span>
                    <span role="columnheader">
                      {t({ id: 'changes.column.review', defaultMessage: 'Review' })}
                    </span>
                  </>
                )}
                <span role="columnheader">
                  {t({ id: 'changes.column.landing', defaultMessage: 'Landing' })}
                </span>
              </div>
              {rows.map((row) => {
                const session = sessionOf(row);
                const changed = session?.changes;
                const ahead = aheadText({
                  name: null,
                  ahead: row.ahead ?? session?.ahead ?? 0,
                  behind: row.behind ?? session?.behind ?? 0,
                }).join(' ');
                const landing = landingOf(row);
                return (
                  <div
                    key={row.id}
                    id={`chg-${row.id}`}
                    className="chg-r"
                    role="row"
                    aria-selected={row.id === open}
                    data-active={row.id === highlighted?.id || undefined}
                    onClick={() => choose(row)}
                  >
                    <span role="gridcell">
                      <StateGlyph name={STATUS_GLYPH[row.status]} />
                    </span>
                    <span role="gridcell" className="chg-h">
                      <RowMark row={row} />
                      <Clip text={row.title} />
                    </span>
                    {!opened && (
                      <>
                        <span role="gridcell" className="chg-num">
                          {changed && (
                            <DiffCounts
                              additions={changed.additions}
                              deletions={changed.deletions}
                            />
                          )}
                        </span>
                        <span role="gridcell" className="chg-h chg-num">
                          {row.branch && <Clip text={row.branch} className="mono" />}
                          {ahead && <span className="chg-mu">{ahead}</span>}
                        </span>
                        <span role="gridcell" className="chg-h">
                          <span className="chg-glyph" aria-hidden="true">
                            <GateMark state={row.gate.state} />
                          </span>
                          <Clip text={gateText(row.gate)} className="chg-mu" />
                        </span>
                        <span role="gridcell">
                          <ReviewCell review={row.review} />
                        </span>
                      </>
                    )}
                    <span role="gridcell" className="chg-end">
                      {landing && (
                        <span className="chip chg-chip" data-tone={landing.tone}>
                          {landing.text}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {opened && (
          <ChangeInspector key={opened.id} row={opened} sessions={sessions} onClose={close} />
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/** One change beside the list: its gate, its reviews and the guide to them, and what can be done. */
export function ChangeInspector({
  row,
  sessions,
  onClose,
}: {
  row: ChangeRow;
  sessions?: readonly WorkbenchSession[] | null;
  onClose: () => void;
}) {
  const sessionId = changeSessionId(row);
  const session = (sessionId && sessions?.find((s) => s.id === sessionId)) || null;
  const mainId = session?.spawned_by?.session_id;
  const main = (mainId && sessions?.find((s) => s.id === mainId)) || null;
  const revision = useBoard(
    (s) => s.board?.sessions.find((x) => x.id === sessionId)?.revision ?? null,
  );
  const landingId = row.kind === 'branch' && row.landing ? changeLandingId(row) : null;
  const gates = useSessionGates(sessionId);
  const review = useReview(row.review?.id ?? null);
  const [cancel, setCancel] = useState<{
    busy: boolean;
    accepted: boolean;
    error: string | null;
  }>({ busy: false, accepted: false, error: null });
  const cancelLanding = async () => {
    setCancel({ busy: true, accepted: false, error: null });
    const result = await runCommand('project.landing.cancel', { landing_id: landingId }, null);
    setCancel({
      busy: false,
      accepted: result.ok,
      error: result.ok ? null : failureText(result.error),
    });
  };
  const gateLast = gates.data?.last ?? null;
  const [rerun, setRerun] = useState<{
    busy: boolean;
    from: typeof gates.data;
    error: string | null;
  }>({ busy: false, from: null, error: null });
  // A rerun the daemon took stays off until the gate is read again.
  const rerunTaken = rerun.from !== null && rerun.from === gates.data;
  const rerunFailed = async () => {
    if (!sessionId || rerun.busy || rerunTaken) return;
    setRerun({ busy: true, from: null, error: null });
    const result = await runCommand(
      'session.gates.run',
      { session_id: sessionId, only_failed: true },
      revision,
    );
    setRerun({
      busy: false,
      from: result.ok ? gates.data : null,
      error: result.ok ? null : failureText(result.error),
    });
    if (result.ok) gates.reload();
  };
  const gateName = t({ id: 'changes.inspector.gate', defaultMessage: 'Gate' });
  const reviewName = t({ id: 'changes.inspector.review', defaultMessage: 'Review' });
  return (
    <aside className="chg-insp" aria-label={row.title}>
      <div className="chg-insp-h">
        <StateGlyph name={STATUS_GLYPH[row.status]} />
        <h2>
          <Clip text={row.title} />
        </h2>
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'changes.inspector.close', defaultMessage: 'Close' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="chg-insp-b">
        <section className="chg-sec" aria-label={gateName}>
          <div className="chg-sec-h">
            <ShieldCheck className="ic-sm chg-mu" aria-hidden="true" />
            <b>{gateName}</b>
          </div>
          {sessionId && gates.data && (gateLast || gates.data.commands?.length) ? (
            <>
              {row.gate.state === 'stale' && (
                <div className="chg-h">
                  <GateMark state="stale" />
                  <span>{gateText(row.gate)}</span>
                </div>
              )}
              <GateResults
                last={gateLast}
                planned={gates.data.commands}
                running={gates.data.running}
                readOnly
              />
              {gateLast?.results.some(gateFailing) && (
                <div className="chg-h">
                  <button
                    type="button"
                    className="btn"
                    disabled={gates.data.running || rerun.busy || rerunTaken}
                    aria-busy={rerun.busy || rerunTaken || undefined}
                    onClick={() => void rerunFailed()}
                  >
                    {t({
                      id: 'changes.inspector.rerunFailed',
                      defaultMessage: 'Rerun only the failed',
                    })}
                  </button>
                </div>
              )}
              {rerun.error && (
                <span className="chg-err" role="alert">
                  {rerun.error}
                </span>
              )}
            </>
          ) : (
            <div className="chg-h">
              <GateMark state={row.gate.state} />
              <span>{gateText(row.gate)}</span>
            </div>
          )}
        </section>
        {sessionId && <ChangedFiles sessionId={sessionId} />}
        {row.review && (
          <section className="chg-sec" aria-label={reviewName}>
            <div className="chg-sec-h">
              <Eye className="ic-sm chg-mu" aria-hidden="true" />
              <b>{reviewName}</b>
            </div>
            {review.data && <ReviewGuide review={review.data} sessionId={sessionId} />}
            {!review.data && review.error && (
              <Failure error={review.error} onRetry={review.reload} />
            )}
            {!review.data && !review.error && <Skeleton />}
            {row.review.verdicts.map((v) => (
              <div key={v.runtime} className="chg-h">
                <RuntimeGlyph runtime={v.runtime} />
                <span>{verdictText(v.runtime, v.verdict)}</span>
              </div>
            ))}
            {row.review.incomplete && <span className="chg-mu">{incompleteText()}</span>}
          </section>
        )}
      </div>
      {session && <TellBox row={row} session={session} main={main} />}
      {(landingId || sessionId) && (
        <div className="chg-foot">
          {landingId && (
            <button
              type="button"
              className="btn"
              disabled={cancel.busy || cancel.accepted}
              aria-busy={cancel.busy || undefined}
              onClick={() => void cancelLanding()}
            >
              {cancel.accepted
                ? t({ id: 'changes.inspector.cancelling', defaultMessage: 'Cancelling' })
                : t({ id: 'changes.inspector.cancelLanding', defaultMessage: 'Cancel landing' })}
            </button>
          )}
          {sessionId && (
            <button
              type="button"
              className="btn"
              onClick={() => useShell.getState().openSession(sessionId)}
            >
              {t({ id: 'changes.inspector.openSession', defaultMessage: 'Open session' })}
            </button>
          )}
          {cancel.error && (
            <span className="chg-err" role="alert">
              {cancel.error}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * What to read first in a review: the open blocking findings with where they are and what they
 * break, the reports as a count, then the files by risk.
 */
export function ReviewGuide({
  review,
  sessionId,
}: {
  review: Pick<Review, 'findings'>;
  /** The reviewed session; a finding's location then opens its review. */
  sessionId: string | null;
}) {
  const guide = reviewGuide(review);
  const most = Math.max(1, ...guide.files.map((f) => f.blocking + f.reports));
  const title = t({ id: 'changes.guide.title', defaultMessage: 'Look here first' });
  return (
    <section className="chg-guide" aria-label={title}>
      <div className="chg-h">
        <Flag className="ic-sm chg-mu" aria-hidden="true" />
        <b>{title}</b>
      </div>
      {guide.blocking.length === 0 && guide.reports === 0 && (
        <span className="chg-mu">
          {t({ id: 'changes.guide.clear', defaultMessage: 'No open findings.' })}
        </span>
      )}
      {guide.blocking.length > 0 && (
        <ul className="chg-finds" aria-label={blockingText(guide.blocking.length)}>
          {guide.blocking.map((finding) => (
            <li key={finding.id} className="chg-find">
              <span className="chg-h">
                <StateGlyph name="failed" />
                {sessionId ? (
                  <button
                    type="button"
                    className="chg-loc"
                    onClick={() => useShell.getState().openSession(sessionId, 'review')}
                  >
                    {finding.location}
                  </button>
                ) : (
                  <span className="chg-loc">{finding.location}</span>
                )}
                <span className="chg-glyph" role="img" aria-label={runtimeName(finding.runtime)}>
                  <RuntimeGlyph runtime={finding.runtime} />
                </span>
              </span>
              <span>{finding.impact}</span>
            </li>
          ))}
        </ul>
      )}
      {guide.reports > 0 && (
        <span className="chg-mu">
          {t(
            {
              id: 'changes.guide.reports',
              defaultMessage: '{count, plural, one {# report} other {# reports}}',
            },
            { count: guide.reports },
          )}
        </span>
      )}
      {guide.files.length > 0 && (
        <ul
          className="chg-files"
          aria-label={t({ id: 'changes.guide.files', defaultMessage: 'Risk by file' })}
        >
          {guide.files.map((file) => (
            <li key={file.path} className="chg-file">
              <FileText className="ic-sm chg-mu" aria-hidden="true" />
              <Clip text={file.path} className="mono" />
              <span
                className="meter"
                role="img"
                aria-label={t(
                  {
                    id: 'changes.guide.fileRisk',
                    defaultMessage:
                      '{blocking, plural, one {# blocking} other {# blocking}}, {reports, plural, one {# report} other {# reports}}',
                  },
                  { blocking: file.blocking, reports: file.reports },
                )}
                style={
                  {
                    '--v': `${((file.blocking + file.reports) / most) * 100}%`,
                    '--c': `var(${file.blocking > 0 ? '--bad' : '--wait'})`,
                  } as CSSProperties
                }
              >
                <i />
              </span>
              <span className="chg-num chg-mu">{file.blocking + file.reports}</span>
            </li>
          ))}
          {guide.more > 0 && (
            <li className="chg-mu">
              {t(
                {
                  id: 'changes.guide.moreFiles',
                  defaultMessage: '{count, plural, one {+# more file} other {+# more files}}',
                },
                { count: guide.more },
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
