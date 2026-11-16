import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { File } from 'lucide-react';
import type {
  ProjectFactsRead,
  ProjectHead,
  ProjectHeatmap,
  StaleWorkspaces,
  WorkbenchSession,
} from '@pantheon/protocol';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { currentProject, useCurrentProject } from '../../data/current-project';
import { ageText, failureText } from '../../data/needs-you';
import { useProjectHead } from '../../data/runtime-models';
import { useSessionList } from '../../data/workbench-sessions';
import { pruneStale, sizeText, useStaleWorkspaces } from '../../data/worktree-setup';
import { listedTitle } from '../../lib/daemon-text';
import { workstreamRows } from '../projects/facts';
import { WorkstreamBars } from '../projects/WorkstreamBars';
import { WorkstreamDetails } from '../projects/WorkstreamDetails';
import { currentLocale, t } from '../../i18n';
import { Metric } from './KpiTiles';
import {
  DataTable,
  Empty,
  niceScale,
  Panel,
  scaleSteps,
  useFloatTip,
  useSize,
  ViewToggle,
} from './Charts';
import { dayTick } from './progress-model';
import {
  commitDays,
  docRows,
  hotspotRows,
  type CommitDay,
  type RepoFacts,
  type RepoSeries,
} from './repo-model';
import './repo.css';

const Swatch = ({ series }: { series: RepoSeries }) => (
  <i className="bp-swb" style={{ backgroundColor: series.color }} />
);

/* Commit cadence */

function CommitChart({ series, days }: { series: RepoSeries[]; days: CommitDay[] }) {
  const [setBox, size] = useSize();
  const [hover, setHover] = useState<number | null>(null);
  const tip = useFloatTip();
  const W = size.w;
  const H = size.h;
  const m = { l: 32, r: 16, t: 8, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = days.length;
  const scale = niceScale(Math.max(...days.map((d) => d.total)), true);
  const step = pw / n;
  const bw = Math.max(1, step * 0.7);
  const CX = (i: number) => m.l + step * (i + 0.5);
  const Y = (v: number) => m.t + ph - (v / scale.max) * ph;
  const base = Y(0);
  const every = Math.max(1, Math.ceil(52 / step));
  const totals = series.map((s, k) => ({
    label: s.label,
    count: days.reduce((sum, d) => sum + d.parts[k]!.count, 0),
  }));

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const d = days[Math.floor((px - m.l) / step)];
    if (!d) return onLeave();
    setHover(days.indexOf(d));
    tip.show(e, {
      head: d.day,
      rows: [
        ...d.parts.map((p) => ({
          swatch: <Swatch series={p.series} />,
          label: p.series.label,
          value: String(p.count),
        })),
        { label: t({ id: 'board.charts.total', defaultMessage: 'Total' }), value: String(d.total) },
      ],
    });
  };
  const onLeave = () => {
    setHover(null);
    tip.hide();
  };

  return (
    <div className="bp-chart" ref={setBox}>
      {n > 0 && pw > 0 && ph > 0 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={t(
            {
              id: 'board.commits.label',
              defaultMessage:
                'Commit cadence, last {days, plural, one {# day} other {# days}}, {series}',
            },
            {
              days: n,
              series: totals
                .map((t) => `${t.label} ${t.count}`)
                .join(t({ id: 'board.charts.listSeparator', defaultMessage: ', ' })),
            },
          )}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
          {hover != null && (
            <rect className="bp-band on" x={m.l + step * hover} y={m.t} width={step} height={ph} />
          )}
          {scaleSteps(scale).map((v) => (
            <g key={v}>
              <line
                className={v ? 'bp-gln' : 'bp-axl'}
                x1={m.l}
                x2={m.l + pw}
                y1={Y(v)}
                y2={Y(v)}
              />
              <text className="bp-ax" x={m.l - 8} y={Y(v) + 4} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            (n - 1 - i) % every === 0 ? (
              <text key={d.day} className="bp-ax" x={CX(i)} y={base + 16} textAnchor="middle">
                {dayTick(d.day)}
              </text>
            ) : null,
          )}
          {days.map((d, i) => {
            let top = base;
            return (
              <g key={d.day}>
                {d.parts.map((p) => {
                  if (!p.count) return null;
                  const h = (p.count / scale.max) * ph;
                  top -= h;
                  return (
                    <rect
                      key={p.series.key}
                      x={CX(i) - bw / 2}
                      y={top}
                      width={bw}
                      height={h}
                      style={{ fill: p.series.color }}
                    />
                  );
                })}
              </g>
            );
          })}
          <rect x="0" y="0" width={W} height={H} fill="transparent" />
        </svg>
      )}
      {tip.node}
    </div>
  );
}

export function CommitPanel({ facts }: { facts: RepoFacts }) {
  const [table, setTable] = useState(false);
  const { series, days } = useMemo(() => commitDays(facts), [facts]);
  const empty = series.length === 0;
  return (
    <Panel
      title={t({ id: 'board.commits.title', defaultMessage: 'Commit cadence' })}
      className="bp-burnp"
      tools={empty ? null : <ViewToggle table={table} onToggle={() => setTable(!table)} />}
    >
      {empty ? (
        <div className="bp-chart">
          <Empty text={t({ id: 'board.commits.noRepo', defaultMessage: 'No Git repository' })} />
        </div>
      ) : (
        <>
          <div className="bp-lgd">
            {series.map((s) => (
              <span key={s.key} title={s.key}>
                <Swatch series={s} />
                {s.label}
              </span>
            ))}
          </div>
          {table ? (
            <div className="bp-chart">
              <DataTable
                head={[
                  t({ id: 'board.charts.date', defaultMessage: 'Date' }),
                  ...series.map((s) => s.label),
                  t({ id: 'board.charts.total', defaultMessage: 'Total' }),
                ]}
                rows={days.map((d) => [
                  d.day,
                  ...d.parts.map((p) => String(p.count)),
                  String(d.total),
                ])}
              />
            </div>
          ) : (
            <CommitChart series={series} days={days} />
          )}
        </>
      )}
    </Panel>
  );
}

/* Change hotspots */

export function HotspotPanel({ facts }: { facts: RepoFacts }) {
  const rows = hotspotRows(facts);
  return (
    <Panel title={t({ id: 'board.hotspots.title', defaultMessage: 'Change hotspots' })}>
      {rows.length === 0 ? (
        <Empty
          text={t({ id: 'board.hotspots.empty', defaultMessage: 'No commits in the last 30 days' })}
        />
      ) : (
        <div className="rp-list">
          {rows.map((r) => (
            <div className="rp-row" key={r.key}>
              <i className="rp-mk" style={{ backgroundColor: r.series.color }} />
              <span className="rp-path" title={r.label}>
                {r.path}
              </span>
              <span
                className="rp-trk"
                role="img"
                aria-label={t(
                  {
                    id: 'board.hotspots.rowLabel',
                    defaultMessage: '{path}: {count, plural, one {# commit} other {# commits}}',
                  },
                  { path: r.label, count: r.commits },
                )}
              >
                <i
                  className="rp-bar"
                  style={{ width: `${r.share * 100}%`, backgroundColor: r.series.color }}
                />
              </span>
              <span className="rp-n">{r.commits}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* Doc age */

export function DocsPanel({ facts, now }: { facts: RepoFacts; now: number }) {
  const rows = docRows(facts, now);
  return (
    <Panel title={t({ id: 'board.docs.title', defaultMessage: 'Doc age' })}>
      {rows.length === 0 ? (
        <Empty text={t({ id: 'board.docs.empty', defaultMessage: 'No docs' })} />
      ) : (
        <div className="rp-list">
          {rows.map((r) => (
            <div className="rp-row rp-doc" key={r.key}>
              <span className="rp-path" title={r.label}>
                {r.label}
              </span>
              <span className="rp-n">{r.date}</span>
              <span
                className="rp-trk"
                role="img"
                aria-label={t(
                  {
                    id: 'board.docs.rowLabel',
                    defaultMessage:
                      '{path}: unchanged for {days, plural, one {# day} other {# days}}',
                  },
                  { path: r.label, days: r.age_days },
                )}
              >
                <i
                  className={`rp-age${r.stale ? ' rp-age-old' : ''}`}
                  style={{ width: `${r.share * 100}%` }}
                />
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* Merge heat */

const SHARED_FILES = 5;

/**
 * Merges per day over the last `days` days, named `span`, one column per week, each on the day it
 * was recorded. Below them, the files several sessions change.
 */
export function MergeHeat({
  heatmap,
  shared,
  days: shownDays,
  span,
}: {
  heatmap: ProjectHeatmap;
  shared?: StaleWorkspaces['shared_files'];
  days: number;
  span: string;
}) {
  const days = heatmap.days.slice(-shownDays);
  const counts = new Map<string, number>();
  for (const m of heatmap.merges) counts.set(m.day, (counts.get(m.day) ?? 0) + 1);
  const shown = days.map((day) => counts.get(day) ?? 0);
  const total = shown.reduce((sum, n) => sum + n, 0);
  const most = Math.max(0, ...shown);
  const month = new Intl.DateTimeFormat(currentLocale(), { month: 'short' });
  // A week's column takes its month's name when it is the first to start in that month.
  const months = days.flatMap((day, i) =>
    i % 7 === 0 && i > 0 && day.slice(0, 7) !== days[i - 7]!.slice(0, 7)
      ? [{ week: i / 7, text: month.format(new Date(`${day}T00:00:00`)) }]
      : [],
  );
  return (
    <Panel
      title={t({ id: 'insights.mergeHeat.title', defaultMessage: 'Merges' })}
      num={
        <span className="bp-hn">
          {t(
            {
              id: 'insights.mergeHeat.total',
              defaultMessage: '{count, plural, one {# merge} other {# merges}} in {span}',
            },
            { count: total, span },
          )}
        </span>
      }
    >
      <div
        className="rp-heat"
        role="img"
        aria-label={t(
          {
            id: 'insights.mergeHeat.label',
            defaultMessage: 'Merges each day over the last {span}, {count} in all',
          },
          { count: total, span },
        )}
      >
        {days.map((day, i) => (
          <i
            key={day}
            className="rp-hc"
            data-l={shown[i] ? Math.ceil((shown[i]! / most) * 4) : 0}
          />
        ))}
      </div>
      {months.length > 0 && (
        <div className="rp-hm" aria-hidden="true">
          {months.map((m) => (
            <span key={m.week} style={{ gridColumn: m.week + 1 }}>
              {m.text}
            </span>
          ))}
        </div>
      )}
      {shared && shared.total > 0 && (
        <>
          <hr className="rp-sep" />
          <h3 className="rp-sh">
            {t({
              id: 'insights.repo.sharedFiles',
              defaultMessage: 'Changed by several sessions',
            })}
          </h3>
          <div className="rp-sf">
            {shared.files.slice(0, SHARED_FILES).map((f) => (
              <div className="rp-sfr" key={f.path}>
                <File className="ic-sm" aria-hidden="true" />
                <span className="rp-path" title={f.path}>
                  {f.path}
                </span>
                <span className="rp-n">
                  {t(
                    {
                      id: 'insights.repo.sharedSessions',
                      defaultMessage: '{count, plural, one {# session} other {# sessions}}',
                    },
                    { count: f.session_ids.length },
                  )}
                </span>
              </div>
            ))}
            {shared.total > SHARED_FILES && (
              <div className="rp-sfm">
                {t(
                  { id: 'insights.repo.more', defaultMessage: 'and {count} more' },
                  { count: shared.total - Math.min(shared.files.length, SHARED_FILES) },
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/* Worktrees and their branches */

/** Sessions whose own worktree is still kept, newest activity first; a merge or discard removes it. */
const worktreeSessions = (sessions: readonly WorkbenchSession[]) =>
  sessions
    .filter(
      (s) =>
        s.workspace_kind === 'linked_worktree' &&
        !s.archived_at &&
        s.state !== 'merged' &&
        s.state !== 'discarded',
    )
    .sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at));

const conflicted = (s: WorkbenchSession) => (s.predicted_conflicts?.total ?? 0) > 0;

/** The repository tab's key figures: the checked out commit, the worktrees, the branches behind, those that would conflict. */
export function RepoKpis({
  head,
  sessions,
  stale,
  now,
}: {
  head: ProjectHead | null;
  sessions: readonly WorkbenchSession[] | null;
  /** The project's worktree read; null until read. */
  stale: StaleWorkspaces | null;
  now: number;
}) {
  const trees = sessions && worktreeSessions(sessions);
  const behind = trees?.filter((s) => (s.behind ?? 0) > 0) ?? [];
  const measured = !!trees?.some((s) => s.behind !== undefined);
  const disk = stale?.worktree_disk;
  const conflicts = trees?.filter(conflicted) ?? [];
  const firstFile = conflicts[0]?.predicted_conflicts!.files[0];
  return (
    <section
      className="bd-kpis"
      aria-label={t({ id: 'insights.repo.kpis', defaultMessage: 'Repository overview' })}
    >
      <div className="bd-kpi">
        <span className="bd-kpi-k">{head?.branch ?? 'HEAD'}</span>
        <span className="bd-kpi-v">
          <b className="rp-sha">{head ? head.sha.slice(0, 7) : '—'}</b>
          {head && <span className="bd-kpi-n">{ageText(head.committed_at, now)}</span>}
        </span>
      </div>
      <Metric
        label={t({ id: 'insights.repo.worktrees', defaultMessage: 'Worktrees' })}
        text={trees ? String(trees.length) : '—'}
        note={disk && disk.unmeasured === 0 ? sizeText(disk.size_bytes) : undefined}
      />
      <Metric
        label={t({ id: 'insights.repo.behind', defaultMessage: 'Behind their source branch' })}
        text={measured ? String(behind.length) : '—'}
        note={
          behind.length > 0
            ? t(
                { id: 'insights.repo.mostBehind', defaultMessage: 'at most {count} behind' },
                { count: Math.max(...behind.map((s) => s.behind!)) },
              )
            : undefined
        }
      />
      <div className="bd-kpi">
        <span className="bd-kpi-k">
          {t({ id: 'insights.repo.conflicts', defaultMessage: 'Will conflict' })}
        </span>
        <span className="bd-kpi-v">
          <b className={conflicts.length > 0 ? 'rp-bad' : undefined}>
            {trees ? String(conflicts.length) : '—'}
          </b>
          {firstFile && (
            <span className="bd-kpi-n rp-file" title={firstFile}>
              {firstFile}
            </span>
          )}
        </span>
      </div>
    </section>
  );
}

/** The files a branch would conflict in, one per line, and how many more. */
const conflictTitle = ({ files, total }: { files: string[]; total: number }) =>
  [
    ...files,
    ...(total > files.length
      ? [
          t(
            { id: 'insights.repo.more', defaultMessage: 'and {count} more' },
            { count: total - files.length },
          ),
        ]
      : []),
  ].join('\n');

/** Each kept worktree's branch, how far it is from its source branch and its changes, with the cleanup of stale worktrees. */
export function BranchPanel({
  projectId,
  sessions,
  stale,
  base,
}: {
  projectId: string;
  sessions: readonly WorkbenchSession[] | null;
  stale: { read: StaleWorkspaces | null; reload: () => void };
  /** The project's checked out branch, named in a conflict; null or absent while unknown. */
  base?: string | null;
}) {
  const confirm = usePruneConfirm(projectId, stale);
  const count = stale.read?.count ?? 0;
  const rows = sessions ? worktreeSessions(sessions) : null;
  return (
    <Panel
      title={t({ id: 'insights.repo.branches', defaultMessage: 'Branches' })}
      tools={
        <button
          type="button"
          className="btn ghost sm"
          disabled={count === 0 || confirm.pruning}
          onClick={confirm.ask}
        >
          {t({ id: 'insights.repo.prune', defaultMessage: 'Clean up stale worktrees…' })}
        </button>
      }
    >
      {rows &&
        (rows.length === 0 ? (
          <Empty text={t({ id: 'insights.repo.noWorktrees', defaultMessage: 'No worktrees' })} />
        ) : (
          <div className="rp-list">
            {rows.map((s) => (
              <div className="rp-row rp-br" key={s.id}>
                <SessionStateIcon session={s} place="list" />
                {s.branch ? (
                  <span className="rp-path" title={s.branch}>
                    {s.branch}
                  </span>
                ) : (
                  <span className="rp-name" title={listedTitle(s)}>
                    {listedTitle(s)}
                  </span>
                )}
                {conflicted(s) ? (
                  <span className="chip rp-cf" title={conflictTitle(s.predicted_conflicts!)}>
                    {base
                      ? t(
                          {
                            id: 'insights.repo.conflictsWith',
                            defaultMessage: 'Conflicts with {branch}',
                          },
                          { branch: base },
                        )
                      : t({ id: 'insights.repo.conflicts', defaultMessage: 'Will conflict' })}
                  </span>
                ) : (
                  <span className="rp-n">
                    {s.ahead !== undefined &&
                      t(
                        {
                          id: 'insights.repo.aheadBehind',
                          defaultMessage: '{ahead} ahead, {behind} behind',
                        },
                        { ahead: s.ahead, behind: s.behind ?? 0 },
                      )}
                  </span>
                )}
                <span className="rp-diff">
                  {s.changes && (
                    <>
                      <span className="df-add" data-zero={!s.changes.additions || undefined}>
                        +{s.changes.additions}
                      </span>
                      <span className="df-del" data-zero={!s.changes.deletions || undefined}>
                        −{s.changes.deletions}
                      </span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
      {confirm.dialog}
    </Panel>
  );
}

/** The confirmation that deletes the worktrees archived sessions left behind; render `dialog`. */
export function usePruneConfirm(
  projectId: string,
  stale: { read: StaleWorkspaces | null; reload: () => void },
  onPruned?: () => void,
) {
  const [open, setOpen] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const count = stale.read?.count ?? 0;
  const prune = async () => {
    setPruning(true);
    setFailure(null);
    const result = await pruneStale(projectId);
    setPruning(false);
    if (!result.ok) {
      setFailure(failureText(result.error));
      return;
    }
    setOpen(false);
    toast({
      title: t(
        {
          id: 'settings.worktreeSetup.pruned',
          defaultMessage:
            '{count, plural, one {Cleaned up # worktree} other {Cleaned up # worktrees}}',
        },
        { count: (result.value as { removed: number }).removed },
      ),
    });
    stale.reload();
    onPruned?.();
  };
  const dialog = (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pruning) setOpen(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="pj-scrim" />
        <AlertDialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <AlertDialog.Title className="pj-dt">
              {t({ id: 'insights.repo.pruneTitle', defaultMessage: 'Delete stale worktrees?' })}
            </AlertDialog.Title>
          </div>
          <AlertDialog.Description className="pj-rm-body">
            {t(
              {
                id: 'insights.repo.pruneBody',
                defaultMessage:
                  "{count, plural, one {# worktree} other {# worktrees}} left by archived sessions will be deleted, with any uncommitted changes in them. This can't be undone.",
              },
              { count },
            )}
          </AlertDialog.Description>
          {failure && (
            <div className="pj-err" role="alert">
              <b>{failure}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <AlertDialog.Close className="btn" disabled={pruning}>
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </AlertDialog.Close>
            <button
              type="button"
              className="btn dng"
              disabled={pruning}
              aria-disabled={pruning || undefined}
              onClick={() => void prune()}
            >
              {t({ id: 'sessions.screen.delete', defaultMessage: 'Delete' })}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
  return {
    pruning,
    dialog,
    ask: () => {
      setFailure(null);
      setOpen(true);
    },
  };
}

export type StaleRead = ReturnType<typeof useStaleWorkspaces>;

/** Reads the project's head and sessions for the figures and the branch list. */
function RepoWork({ projectId, now, stale }: { projectId: string; now: number; stale: StaleRead }) {
  const head = useProjectHead(projectId);
  const sessions = useSessionList(projectId);
  return (
    <>
      <div className="bd-s12">
        <RepoKpis head={head.read} sessions={sessions.data} stale={stale.read} now={now} />
      </div>
      <div className="bd-s12">
        <BranchPanel
          projectId={projectId}
          sessions={sessions.data}
          stale={stale}
          base={head.read?.branch}
        />
      </div>
    </>
  );
}

/* The repository tab */

export function RepoPanels({
  read,
  now,
  stale,
}: {
  read: ProjectFactsRead | null;
  now: number;
  /** The project's worktree read, shared with the merge heat; absent without a project. */
  stale?: StaleRead;
}) {
  const stored = useCurrentProject((s) => s.projectId);
  const projectId = useBoard((s) => currentProject(s.board, stored)?.id ?? null);
  const work = projectId && stale && <RepoWork projectId={projectId} now={now} stale={stale} />;
  const facts = read?.facts;
  if (!facts)
    return (
      <>
        {work}
        <div className="bd-s12">
          <Panel title={t({ id: 'board.repo.title', defaultMessage: 'Repository' })}>
            <Empty text={t({ id: 'board.repo.noBaseline', defaultMessage: 'No baseline yet' })} />
          </Panel>
        </div>
      </>
    );
  return (
    <>
      {work}
      <div className="bd-s12">
        <CommitPanel facts={facts} />
      </div>
      {read.workstreams.length > 0 && (
        <div className="bd-s12">
          <Panel title={t({ id: 'board.repo.workstreams', defaultMessage: 'Workstream status' })}>
            <WorkstreamBars rows={workstreamRows(read.workstreams)} />
            <WorkstreamDetails rows={read.workstreams} />
          </Panel>
        </div>
      )}
      <div className="bd-s6">
        <HotspotPanel facts={facts} />
      </div>
      <div className="bd-s6">
        <DocsPanel facts={facts} now={now} />
      </div>
    </>
  );
}
