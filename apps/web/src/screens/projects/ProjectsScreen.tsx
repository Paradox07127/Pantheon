import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Menu } from '@base-ui/react/menu';
import {
  Bot,
  CircleDot,
  Ellipsis,
  Flag,
  Folder,
  Globe,
  Import,
  Lightbulb,
  MessageSquare,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { BoardSnapshot, ProjectSummary, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { NeedsPopover, SessionsPopover } from '../../components/NeedsPopover';
import { PathText } from '../../components/PathText';
import { ProjectMonogram } from '../../components/ProjectMonogram';
import { SessionStateIcon, StateGlyph, type GlyphName } from '../../components/SessionStateIcon';
import { Skeleton } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import { TopBar } from '../../components/TopBar';
import { blocksText, decisionText } from '../../data/attention';
import { useBoard } from '../../data/board';
import { useCurrentProject } from '../../data/current-project';
import { useImportCandidates } from '../../data/import';
import {
  ageText,
  needReasonText,
  useNeedsYou,
  useNow,
  type NeedsYouItem,
} from '../../data/needs-you';
import {
  crossProjectWaiting,
  openPersonalAgent,
  usePersonalOpening,
} from '../../data/personal-agent';
import {
  findProjectByRoots,
  removeProject,
  removeRejectText,
  visibleProjects,
} from '../../data/projects';
import {
  needsByKind,
  projectIdle,
  sortProjects,
  topNeed,
  useProjectsSummary,
} from '../../data/projects-summary';
import { storedUnread } from '../../data/unread';
import { readQuery } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { keyText, shortcutKeys } from '../../lib/shortcuts';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import { durationText } from '../board/panels-model';
import { groupWorkbenchSessions, type SessionGroupKey } from '../sessions/model';
import { ImportDialog } from './ImportFolders';
import { useProjectsView } from './view';
import { Welcome } from './Welcome';
import './projects.css';

type Project = BoardSnapshot['projects'][number];
type CountKey = keyof ProjectSummary['counts'];

// Each session count of a row and the session list group a click on it opens; labels are getters.
const COUNTS: readonly {
  key: CountKey;
  label: string;
  glyph: GlyphName;
  group: SessionGroupKey;
}[] = [
  {
    key: 'running',
    get label() {
      return t({ id: 'projects.count.running', defaultMessage: 'Running' });
    },
    glyph: 'running',
    group: 'working',
  },
  {
    key: 'ready',
    get label() {
      return t({ id: 'projects.count.ready', defaultMessage: 'Ready to merge' });
    },
    glyph: 'ready',
    group: 'inbox',
  },
  {
    key: 'failed',
    get label() {
      return t({ id: 'projects.count.failed', defaultMessage: 'Failed' });
    },
    glyph: 'failed',
    group: 'inbox',
  },
];

// The icon of each decision the user makes on what waits.
const KIND_ICONS: Record<NonNullable<NeedsYouItem['decision']>, LucideIcon> = {
  plan_change: Workflow,
  question: MessageSquare,
  milestone_accept: Flag,
  repeated_failure: TriangleAlert,
  agent_proposal: Bot,
  permission: ShieldCheck,
  budget: Wallet,
  improvement: Lightbulb,
  external: Globe,
  other: CircleDot,
};

// The rows shown before the switch to show all.
const FOLDED_ROWS = 12;

const SPARK_W = 120;
const SPARK_H = 24;

interface ProjectsScreenProps {
  onOpenSettings: (projectId: string) => void;
  /** Makes the project current and shows its sessions. */
  onOpenProject: (projectId: string) => void;
  /** The personal agent's open session; absent until it is first opened. */
  personal?: WorkbenchSession | null;
}

export function ProjectsScreen({
  onOpenSettings,
  onOpenProject,
  personal = null,
}: ProjectsScreenProps) {
  const board = useBoard((s) => s.board);
  const summary = useProjectsSummary();
  const needs = useNeedsYou(null);
  const { setOpening } = useProjectsView();
  const candidates = useImportCandidates();
  const [removing, setRemoving] = useState<Project | null>(null);
  const [importing, setImporting] = useState(false);
  // An import's failures stay on screen after the projects it did open appear.
  const [welcomeHeld, setWelcomeHeld] = useState(false);
  const now = useNow(30_000);
  const personalOpening = usePersonalOpening();
  const [all, setAll] = useState(false);
  // Taken once per opening when both reads are in, so the rows keep their places while it is open.
  const held = useRef<string[] | null>(null);

  const projects = board ? visibleProjects(board.projects) : [];
  const personalWaits = crossProjectWaiting(
    needs.items ?? [],
    projects.map((p) => p.id),
  ).length;
  const personalName = t({ id: 'projects.personalAgent', defaultMessage: 'Personal agent' });
  const summaries = summary.data ?? [];
  const needItems = needs.items ?? [];
  const sorted = sortProjects(projects, summaries);
  if (!held.current && board && !summary.loading && !summary.refreshing && !needs.loading)
    held.current = sorted.map((p) => p.id);
  const order = held.current;
  // A project opened since the order was taken comes last.
  const place = (id: string) => {
    const at = order!.indexOf(id);
    return at < 0 ? projects.length : at;
  };
  const shown = order ? [...sorted].sort((a, b) => place(a.id) - place(b.id)) : sorted;
  const listed = all ? shown : shown.slice(0, FOLDED_ROWS);
  const importable = (candidates.data?.candidates ?? []).filter(
    (c) => !findProjectByRoots(projects, [c.root]),
  );
  const fresh = importable.filter((c) => !c.excluded).length;
  // The summary decides the order, so until it lands the rows stand empty in the places they take.
  const pending = !order;
  const openDialog = () => setOpening(true);
  const oldestWait = new Map<string, number>();
  for (const item of needItems)
    oldestWait.set(
      item.project_id,
      Math.min(item.created_at, oldestWait.get(item.project_id) ?? Infinity),
    );

  return (
    <div className="tb-pg">
      <TopBar title={SCREEN_NAMES.projects} count={board ? projects.length : undefined}>
        <div className="tb-end">
          <button
            type="button"
            className="btn"
            aria-label={
              personalWaits > 0
                ? [
                    personalName,
                    t(
                      {
                        id: 'projects.personalAgentWaits',
                        defaultMessage:
                          '{count, plural, one {# thing waits across projects} other {# things wait across projects}}',
                      },
                      { count: personalWaits },
                    ),
                  ].join(t({ id: 'sessions.screen.separator', defaultMessage: ', ' }))
                : personalName
            }
            aria-busy={personalOpening || undefined}
            onClick={() => void openPersonalAgent()}
          >
            {personalOpening ? (
              <StateGlyph name="starting" />
            ) : personal ? (
              <SessionStateIcon session={personal} place="list" />
            ) : (
              <StateGlyph name="idle" />
            )}
            {personalName}
            {personalWaits > 0 && (
              <span className="ss-rct" aria-hidden="true">
                {personalWaits}
              </span>
            )}
          </button>
          <button type="button" className="btn" onClick={() => setImporting(true)}>
            <Import className="ic-sm" aria-hidden="true" />
            {t({ id: 'projects.import.open', defaultMessage: 'Import' })}
          </button>
          <OpenProjectButton onClick={openDialog} />
        </div>
      </TopBar>
      <main className="pj-home">
        <div className="pj-col">
          {summary.error && projects.length > 0 && (
            <p className="mu pj-none" role="alert">
              {summary.error}
            </p>
          )}
          {board && (projects.length === 0 || welcomeHeld) ? (
            <Welcome onOpenFolder={openDialog} onOpened={onOpenProject} onHold={setWelcomeHeld} />
          ) : (
            <>
              {(pending || summary.data) && (
                <SummaryPanel
                  summaries={
                    pending
                      ? null
                      : summaries.filter((s) => projects.some((p) => p.id === s.project_id))
                  }
                  needs={needItems.filter((i) => projects.some((p) => p.id === i.project_id))}
                />
              )}
              <div
                role="table"
                className="pr-tbl"
                aria-label={t({ id: 'projects.title', defaultMessage: 'All projects' })}
                aria-busy={pending || undefined}
                onKeyDown={moveFocus}
              >
                <div role="row" className="pr-row pr-head">
                  <span role="columnheader" />
                  <span role="columnheader">
                    {t({ id: 'projects.table.project', defaultMessage: 'Project' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'projects.table.goal', defaultMessage: 'Current goal' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'projects.table.sessions', defaultMessage: 'Sessions' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'projects.table.needsYou', defaultMessage: 'Needs you' })}
                  </span>
                  <span role="columnheader" />
                </div>
                {pending
                  ? Array.from({ length: board ? listed.length : 3 }, (_, i) => (
                      <div key={i} role="row" className="pr-row">
                        <span role="cell" />
                        <span role="cell" className="pr-name">
                          <Skeleton className="pr-sk-c" />
                        </span>
                      </div>
                    ))
                  : listed.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        summary={summaries.find((s) => s.project_id === project.id)}
                        needs={needItems.filter((i) => i.project_id === project.id)}
                        oldestWait={oldestWait.get(project.id) ?? null}
                        now={now}
                        onOpenSettings={onOpenSettings}
                        onRemove={setRemoving}
                      />
                    ))}
              </div>
              {shown.length > FOLDED_ROWS && (
                <div className="pr-more">
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-expanded={all}
                    onClick={() => setAll(!all)}
                  >
                    {all
                      ? t({ id: 'projects.showLess', defaultMessage: 'Show less' })
                      : t(
                          {
                            id: 'projects.showAll',
                            defaultMessage:
                              '{count, plural, one {Show all # project} other {Show all # projects}}',
                          },
                          { count: shown.length },
                        )}
                  </button>
                </div>
              )}
              {fresh > 0 && (
                <div className="pr-imp">
                  <Import className="ic-sm" aria-hidden="true" />
                  <span>
                    {t(
                      {
                        id: 'projects.import.hint',
                        defaultMessage:
                          '{count, plural, one {# folder on this computer has Claude Code or Codex sessions} other {# folders on this computer have Claude Code or Codex sessions}}',
                      },
                      { count: fresh },
                    )}
                  </span>
                  <button type="button" className="btn sm" onClick={() => setImporting(true)}>
                    {t({ id: 'projects.import.review', defaultMessage: 'Review and import' })}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
        <ImportDialog
          open={importing}
          candidates={importable}
          onClose={() => setImporting(false)}
        />
      </main>
    </div>
  );
}

export function OpenProjectButton({ onClick }: { onClick: () => void }) {
  const label = t({ id: 'projects.open.title', defaultMessage: 'Open project' });
  const keys = shortcutKeys('open-project');
  return (
    <Tip content={keys ? `${label} ${keyText(keys)}` : label}>
      <button
        type="button"
        className="btn pri"
        aria-keyshortcuts={keys || undefined}
        onClick={onClick}
      >
        <Folder className="ic-sm" aria-hidden="true" />
        {label}
      </button>
    </Tip>
  );
}

/**
 * What needs you and what runs across the listed projects; null while the summary loads. Needs
 * you, running and ready open the list of what they count.
 */
export function SummaryPanel({
  summaries,
  needs,
}: {
  summaries: readonly ProjectSummary[] | null;
  needs: readonly NeedsYouItem[];
}) {
  const read = summaries ?? [];
  const total = (pick: (s: ProjectSummary) => number) => read.reduce((n, s) => n + pick(s), 0);
  const asking = read.filter((s) => s.needs_you > 0).length;
  const queued = total((s) => s.counts.queued);
  const [asks, runs, ready, merged] = [
    {
      label: t({ id: 'projects.summary.needsYou', defaultMessage: 'Needs you' }),
      value: total((s) => s.needs_you),
      note:
        asking > 0
          ? t(
              {
                id: 'projects.summary.across',
                defaultMessage: '{count, plural, one {across # project} other {across # projects}}',
              },
              { count: asking },
            )
          : null,
    },
    {
      label: t({ id: 'projects.summary.running', defaultMessage: 'Running' }),
      value: total((s) => s.counts.running),
      note:
        queued > 0
          ? t(
              { id: 'projects.summary.queued', defaultMessage: '{count} queued' },
              { count: queued },
            )
          : null,
    },
    {
      label: t({ id: 'projects.summary.ready', defaultMessage: 'Ready to merge' }),
      value: total((s) => s.counts.ready),
      note: null,
    },
    {
      label: t({ id: 'projects.summary.mergedToday', defaultMessage: 'Merged today' }),
      value: total((s) => s.merged_today),
      note: null,
    },
  ].map((c) => (
    <>
      <span className="pr-sum-k">{c.label}</span>
      <span className="pr-sum-v">
        {summaries ? <b>{c.value}</b> : <Skeleton className="pr-sum-sk" />}
        {c.note && <span>{c.note}</span>}
      </span>
    </>
  ));
  const counting = (pick: (s: ProjectSummary) => number) =>
    read.filter((s) => pick(s) > 0).map((s) => s.project_id);
  const cell = (body: ReactNode) => (
    <button type="button" className="pr-sum-c pr-sum-b">
      {body}
    </button>
  );
  return (
    <div className="pr-sum" aria-busy={!summaries || undefined}>
      <NeedsPopover items={needs} trigger={cell(asks)} />
      <SessionsPopover
        show="running"
        projectIds={counting((s) => s.counts.running + s.counts.queued)}
        trigger={cell(runs)}
      />
      <SessionsPopover
        show="ready"
        projectIds={counting((s) => s.counts.ready)}
        trigger={cell(ready)}
      />
      <div className="pr-sum-c">{merged}</div>
    </div>
  );
}

// The project is chosen before the one navigation, which would drop a navigation still owed.
function openBoard(projectId: string) {
  useCurrentProject.getState().choose(projectId);
  useShell.getState().followFirstSession();
  useShell.getState().setScreen('board');
}

/** Up and down move the focus from a row's open button to the one above or below it. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const opens = [...e.currentTarget.querySelectorAll<HTMLElement>('.pr-open')];
  const at = opens.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  const next = opens[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

function openGroup(projectId: string, group: SessionGroupKey) {
  useCurrentProject.getState().choose(projectId);
  useShell.getState().openSessionGroup(group);
}

// As projects.summary counts them; the list may put those sessions under snoozed or inbox.
const COUNTED: Partial<Record<WorkbenchSession['state'], CountKey>> = {
  starting: 'running',
  running: 'running',
  merging: 'running',
  waiting: 'waiting',
  ready: 'ready',
  failed: 'failed',
};

/** Opens the first list group holding a session the count counts, else the count's own group. */
async function openCount(projectId: string, key: CountKey, group: SessionGroupKey) {
  const result = await readQuery('session.list', { project_id: projectId });
  const sessions = result.ok && Array.isArray(result.value) ? result.value : [];
  const counted = (sessions as WorkbenchSession[]).filter(
    (s) => !s.archived_at && (s.reconciling ? 'running' : COUNTED[s.state]) === key,
  );
  openGroup(
    projectId,
    groupWorkbenchSessions(counted, 'activity', storedUnread(projectId))[0]?.key ?? group,
  );
}

/** Polyline points of the daily done totals, oldest at the left, scaled to their own range. */
function sparkPoints(days: readonly { done: number }[]): string {
  const values = days.map((d) => d.done);
  const low = Math.min(...values),
    span = Math.max(...values) - low || 1;
  const step = values.length > 1 ? SPARK_W / (values.length - 1) : 0;
  return values
    .map(
      (v, i) => `${+(i * step).toFixed(1)},${+(SPARK_H - ((v - low) / span) * SPARK_H).toFixed(1)}`,
    )
    .join(' ');
}

/** The goal's tasks as merged, running, failed and not started segments, sized by count. */
function milestoneBar(milestone: NonNullable<ProjectSummary['milestone']>) {
  const { done, running, failed } = milestone;
  const rest = Math.max(0, milestone.total - done - running - failed);
  return (
    <span
      className="pr-bar"
      role="img"
      aria-label={t(
        {
          id: 'projects.row.goalBar',
          defaultMessage: '{done} merged, {running} running, {failed} failed, {rest} not started',
        },
        { done, running, failed, rest },
      )}
    >
      {done > 0 && <i className="pr-done" style={{ flexGrow: done }} />}
      {running > 0 && <i className="pr-run" style={{ flexGrow: running }} />}
      {failed > 0 && <i className="pr-bad" style={{ flexGrow: failed }} />}
      {rest > 0 && <i style={{ flexGrow: rest }} />}
    </span>
  );
}

export function ProjectRow(props: {
  project: Project;
  summary: ProjectSummary | undefined;
  /** The project's needs-you items. */
  needs: readonly NeedsYouItem[];
  /** Unix milliseconds of the project's oldest needs-you item; null without one. */
  oldestWait: number | null;
  now: number;
  onOpenSettings: (projectId: string) => void;
  onRemove: (project: Project) => void;
}) {
  const { project, summary } = props;
  const milestone = summary?.milestone;
  const days = summary?.done_daily ?? [];
  const last = summary?.last_activity_at ? Date.parse(summary.last_activity_at) : null;
  const active = summary ? COUNTS.filter(({ key }) => summary.counts[key] > 0) : [];
  const idle = projectIdle(summary);
  const top = topNeed(props.needs);
  const kinds = needsByKind(props.needs);
  const rest = kinds.slice(4);
  const restCount = rest.reduce((n, kind) => n + kind.count, 0);
  const kindName = (item: NeedsYouItem) => decisionText(item.decision) ?? needReasonText(item);
  const kindIcon = (item: NeedsYouItem) => {
    const Icon = KIND_ICONS[item.decision ?? 'other'];
    return <Icon className="ic-sm" aria-hidden="true" />;
  };

  return (
    <div role="row" className={idle ? 'pr-row pr-idle' : 'pr-row'}>
      <span role="cell" className="pr-mark">
        <ProjectMonogram id={project.id} name={project.name} />
      </span>
      <span role="cell" className="pr-name">
        <button type="button" className="pr-open" onClick={() => openBoard(project.id)}>
          {project.name}
        </button>
        {project.roots[0] && <PathText path={project.roots[0]} className="pr-path mono" />}
      </span>
      <span role="cell" className="pr-goal">
        {!summary ? (
          <Skeleton className="pr-sk-c" />
        ) : milestone ? (
          <>
            <span className="pr-mt" title={milestone.title}>
              {milestone.title}
            </span>
            <span className="pr-mn">
              {milestone.done} / {milestone.total}
            </span>
            {milestoneBar(milestone)}
          </>
        ) : (
          <span className="pr-none">
            {idle && last !== null
              ? t(
                  { id: 'projects.row.lastActive', defaultMessage: 'Last active {age}' },
                  { age: ageText(last, props.now) },
                )
              : t({ id: 'projects.row.noGoal', defaultMessage: 'No goal' })}
          </span>
        )}
        {days.length > 0 && (
          <svg
            className="pr-spark"
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t(
              {
                id: 'projects.row.doneTrend',
                defaultMessage: 'Done over the last 14 days, now {count}',
              },
              { count: days.at(-1)!.done },
            )}
          >
            <polyline points={sparkPoints(days)} />
          </svg>
        )}
      </span>
      <span role="cell" className="pr-ses">
        {!summary ? (
          <Skeleton className="pr-sk-c" />
        ) : active.length > 0 ? (
          active.map(({ key, label, glyph, group }) => (
            <button
              key={key}
              type="button"
              className="pr-n"
              aria-label={`${label} ${summary.counts[key]}`}
              onClick={() => openCount(project.id, key, group)}
            >
              <StateGlyph name={glyph} />
              {summary.counts[key]}
            </button>
          ))
        ) : (
          <span className="pr-none">—</span>
        )}
      </span>
      <span role="cell" className="pr-need">
        {!summary ? (
          <Skeleton className="pr-sk-c" />
        ) : summary.needs_you > 0 ? (
          <span className="pr-nd">
            <span className="pr-top">
              <button
                type="button"
                className="pr-n"
                aria-label={t(
                  { id: 'projects.row.needsYou', defaultMessage: 'Needs you {count}' },
                  { count: summary.needs_you },
                )}
                // The sidebar takes the inbox group as its only-waiting filter.
                onClick={() => openGroup(project.id, 'inbox')}
              >
                <StateGlyph name="approval" />
                {summary.needs_you}
              </button>
              {top && (
                <>
                  {kindIcon(top)}
                  <Clip
                    className="pr-tt"
                    text={
                      top.question?.question ??
                      top.lane_title ??
                      top.step_title ??
                      needReasonText(top)
                    }
                  />
                  {blocksText(top.blocks) && (
                    <span className="pr-age">{blocksText(top.blocks)}</span>
                  )}
                </>
              )}
              {/* Under a minute the notice card shows no wait either. */}
              {props.oldestWait !== null && props.now - props.oldestWait >= 60_000 && (
                <span className="pr-age">{durationText(props.now - props.oldestWait)}</span>
              )}
            </span>
            {kinds.length > 0 && (
              <span
                className="pr-c"
                role="group"
                aria-label={t({ id: 'projects.row.byKind', defaultMessage: 'Needs you by kind' })}
              >
                {kinds.slice(0, 4).map((kind) => (
                  <button
                    key={kind.item.source.id}
                    type="button"
                    className="pr-n"
                    aria-label={t(
                      {
                        id: 'projects.row.kindCount',
                        defaultMessage:
                          '{blocks, plural, =0 {{kind} {count}} one {{kind} {count}, blocks # task} other {{kind} {count}, blocks # tasks}}',
                      },
                      { kind: kindName(kind.item), count: kind.count, blocks: kind.blocks },
                    )}
                    onClick={() => openGroup(project.id, 'inbox')}
                  >
                    {kindIcon(kind.item)}
                    {kind.count}
                  </button>
                ))}
                {rest.length > 0 && (
                  <button
                    type="button"
                    className="pr-n"
                    aria-label={t(
                      { id: 'projects.row.otherKinds', defaultMessage: '{count} other: {kinds}' },
                      {
                        count: restCount,
                        kinds: listText(...rest.map((kind) => kindName(kind.item))),
                      },
                    )}
                    onClick={() => openGroup(project.id, 'inbox')}
                  >
                    {t(
                      { id: 'projects.row.other', defaultMessage: '{count} other' },
                      { count: restCount },
                    )}
                  </button>
                )}
              </span>
            )}
          </span>
        ) : (
          <span className="pr-none">—</span>
        )}
      </span>
      <span role="cell" className="pr-act">
        <span className="pr-menu">
          <Menu.Root>
            <Menu.Trigger
              className="ib"
              aria-label={t(
                { id: 'projects.row.more', defaultMessage: 'More actions for {name}' },
                { name: project.name },
              )}
            >
              <Ellipsis aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
                <Menu.Popup className="wmenu pop">
                  <Menu.Item onClick={() => props.onOpenSettings(project.id)}>
                    {t({ id: 'projects.row.settings', defaultMessage: 'Settings' })}
                  </Menu.Item>
                  <Menu.Separator className="pjm-sep" />
                  <Menu.Item className="pj-danger" onClick={() => props.onRemove(project)}>
                    {t({ id: 'projects.row.remove', defaultMessage: 'Remove…' })}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </span>
      </span>
    </div>
  );
}

function RemoveProjectDialog({
  project,
  onClose,
}: {
  project: Project | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A removal's answer reaches the dialog only while it still shows the project removed.
  const opening = useRef(0);
  useEffect(() => {
    opening.current++;
    setBusy(false);
    setError(null);
  }, [project?.id]);

  const remove = async () => {
    if (!project || busy) return;
    const mine = opening.current;
    setBusy(true);
    setError(null);
    const result = await removeProject(project);
    if (result.ok && useCurrentProject.getState().projectId === project.id)
      useCurrentProject.getState().clear();
    if (mine !== opening.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(removeRejectText(result.error));
      return;
    }
    onClose();
  };

  return (
    <AlertDialog.Root
      open={project !== null}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="pj-scrim" />
        <AlertDialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <AlertDialog.Title className="pj-dt">
              {t(
                { id: 'projects.remove.title', defaultMessage: 'Remove “{name}”' },
                { name: project?.name ?? '' },
              )}
            </AlertDialog.Title>
          </div>
          <AlertDialog.Description className="pj-rm-body">
            {t({
              id: 'projects.remove.body',
              defaultMessage:
                'The folders and history stay; open the same folders again to bring the project back.',
            })}
          </AlertDialog.Description>
          {error && (
            <div className="pj-err" role="alert">
              <b>{error}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <AlertDialog.Close className="btn ghost">
              {t({ id: 'projects.cancel', defaultMessage: 'Cancel' })}
            </AlertDialog.Close>
            <button
              type="button"
              className="btn dng"
              disabled={busy}
              aria-disabled={busy || undefined}
              onClick={() => void remove()}
            >
              {t({ id: 'projects.remove.confirm', defaultMessage: 'Remove' })}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
