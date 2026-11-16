import { Activity, useState, useSyncExternalStore } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Tabs } from '@base-ui/react/tabs';
import type { BoardModel } from '@pantheon/protocol';
import { ReadStatus } from '../../components/ReadStatus';
import { TopBar } from '../../components/TopBar';
import { useBoard } from '../../data/board';
import { useBoardView } from '../../data/board-view';
import { effectiveUsageTargets, settingOf, useProjectDefaults } from '../../data/project-defaults';
import { t } from '../../i18n';
import { useDelayed } from '../../lib/use-delayed';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import {
  Failure,
  HiddenMenu,
  isEmpty,
  laidPanels,
  layoutChanged,
  PanelBoundary,
  RANGES,
  runBoardCommand,
  Skeleton,
  type BoardDays,
  type BoardPanels,
  type ChangeLayout,
} from '../board/BoardScreen';
import { KpiTiles } from '../board/KpiTiles';
import { FindingsPanel, MergesPanel } from '../board/Lists';
import { saveLayout, useBoardLayout } from '../board/panel-layout';
import type { RunBoardCommand, SnapshotSession } from '../board/panels-model';
import {
  GateFailuresPanel,
  GateHistoryPanel,
  QualityKpis,
  ReviewMatrixPanel,
} from '../board/QualityCharts';
import { RetroPanel } from '../board/RetroPanel';
import { TaskDrawer } from '../board/TaskDrawer';
import { QuotaPanel, RoleUsagePanel, UsageRings, UsageStackPanel } from '../board/UsageCharts';
import { localDay } from '../board/usage-model';
import { CollabTab } from './CollabTab';
import { DigestPanel, weekSwitch } from './DigestPanel';
import { IterationsTab } from './IterationsTab';
import { WorkflowTab } from './WorkflowTab';
import '../board/board.css';

export type InsightsSection =
  'iterations' | 'collab' | 'workflow' | 'quality' | 'usage' | 'retro' | 'digest';

// Labels are getters, so each is read in the language loaded by then.
const SECTIONS: { key: InsightsSection; label: string }[] = [
  {
    key: 'iterations',
    get label() {
      return t({ id: 'insights.sections.iterations', defaultMessage: 'Iterations' });
    },
  },
  {
    key: 'collab',
    get label() {
      return t({ id: 'insights.sections.collab', defaultMessage: 'Collaboration' });
    },
  },
  {
    key: 'workflow',
    get label() {
      return t({ id: 'insights.sections.workflow', defaultMessage: 'Workflow' });
    },
  },
  {
    key: 'quality',
    get label() {
      return t({ id: 'board.sections.quality', defaultMessage: 'Quality' });
    },
  },
  {
    key: 'usage',
    get label() {
      return t({ id: 'board.sections.usage', defaultMessage: 'Usage' });
    },
  },
  {
    key: 'retro',
    get label() {
      return t({ id: 'board.panels.retro', defaultMessage: 'Retrospectives' });
    },
  },
  {
    key: 'digest',
    get label() {
      return t({ id: 'insights.digest.label', defaultMessage: 'Weekly digest' });
    },
  },
];
const TABS = SECTIONS.map((s) => s.key);

/** The stored engineering board tab; anything else opens the iterations tab. */
export function readInsightsSection(raw: string | null): InsightsSection {
  return SECTIONS.find((s) => s.key === raw)?.key ?? 'iterations';
}

const sectionKey = (projectId: string) => `pantheon.insights.${projectId}`;

function storedSection(projectId: string): InsightsSection {
  try {
    return readInsightsSection(localStorage.getItem(sectionKey(projectId)));
  } catch {
    return 'iterations';
  }
}

// The tab picked on each project's engineering board while the app runs.
let picked: Readonly<Record<string, InsightsSection>> = {};
const pickListeners = new Set<() => void>();
const subscribePicked = (listener: () => void) => {
  pickListeners.add(listener);
  return () => void pickListeners.delete(listener);
};

export function pickInsightsSection(projectId: string, section: InsightsSection) {
  picked = { ...picked, [projectId]: section };
  pickListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(sectionKey(projectId), section);
  } catch {
    // The choice still holds until the app closes.
  }
}

/** The tab the project's engineering board shows. */
export function useInsightsSection(projectId: string | null): InsightsSection {
  const read = () => (projectId ? picked[projectId] : undefined);
  const chosen = useSyncExternalStore(subscribePicked, read, read);
  return projectId ? (chosen ?? storedSection(projectId)) : 'iterations';
}

export const insightsSectionLabel = (section: InsightsSection) =>
  SECTIONS.find((s) => s.key === section)!.label;

/** Panels that read their own data, so an empty board model says nothing about them. */
const OWN_READS: ReadonlySet<string> = new Set([
  'gateFailures',
  'matrix',
  'gates',
  'quota',
  'roles',
  'collab',
  'workflow',
  'digest',
]);

/** The weekly digest of the 7 days through the day `week` weeks before today, read on its own. */
function WeeklyDigest({
  projectId,
  bar,
  week,
  onWeek,
}: {
  projectId: string;
  bar: HTMLElement | null;
  week: number;
  onWeek: (week: number) => void;
}) {
  const today = new Date();
  const until =
    week > 0
      ? localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7 * week))
      : undefined;
  const view = useBoardView(projectId, 7, until);
  // A digest already shown that a read is replacing gets its status bar only once that read runs long.
  const slow = useDelayed(!!view.refreshing);
  // The read keeps the last week's board until the picked week's lands; its first day says which week it is.
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6).getTime();
  const shown = view.data ? Math.round((start - view.data.since) / (7 * 86_400_000)) : week;
  if (!view.data && view.error)
    return (
      <>
        <Failure error={view.error} onRetry={view.reload} />
        {bar && weekSwitch({ bar, week, onWeek })}
      </>
    );
  return (
    <>
      {(view.error || !view.refreshing || slow) && (
        <ReadStatus
          label={t({ id: 'insights.digest.label', defaultMessage: 'Weekly digest' })}
          stale={view.stale}
          refreshing={view.refreshing}
          error={view.error}
          readAt={view.readAt}
          reload={view.reload}
        />
      )}
      <DigestPanel
        model={view.data}
        projectId={projectId}
        bar={bar}
        week={shown}
        // The panel steps from the week it shows; the step applies to the picked week.
        onWeek={(next) => onWeek(Math.max(0, week + next - shown))}
      />
    </>
  );
}

interface InsightsViewProps {
  model: BoardModel | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  stale?: boolean;
  readAt?: number | null;
  days: BoardDays;
  onDays: (days: BoardDays) => void;
  section: InsightsSection;
  onSection: (section: InsightsSection) => void;
  /** Reads the review metrics, role usage and repository facts; absent without a project. */
  projectId?: string;
  onOpenSession: (sessionId: string) => void;
  onOpenSessions: () => void;
  onOpenStory: (sessionId: string) => void;
  onStartTask?: (task: BoardModel['tasks'][number]) => void;
  /** Snapshot sessions and the command runner behind the review actions; absent without a project. */
  actions?: { sessions: readonly SnapshotSession[]; run: RunBoardCommand };
  /** The project's token targets by runtime, for the usage rings. */
  usageTargets?: Record<string, number>;
}

export function InsightsView(props: InsightsViewProps) {
  const { model, loading, error, onRetry, days, onDays, section, onSection, projectId } = props;
  const { onOpenSession, onOpenSessions, onOpenStory, onStartTask, actions } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState(projectId);
  const [seen, setSeen] = useState<readonly InsightsSection[]>([section]);
  const [digestWeek, setDigestWeek] = useState(0);
  // Each tab's place in the top bar; switching tabs hides the others' in the same commit.
  const [bars, setBars] = useState<Partial<Record<InsightsSection, HTMLElement | null>>>({});
  const [barRefs] = useState(
    () =>
      Object.fromEntries(
        TABS.map((key) => [
          key,
          (bar: HTMLElement | null) =>
            setBars((all) => (all[key] === bar ? all : { ...all, [key]: bar })),
        ]),
      ) as Record<InsightsSection, (bar: HTMLElement | null) => void>,
  );
  if (selectedProject !== projectId) {
    setSelectedProject(projectId);
    setSelected(null);
    setSeen([section]);
    setDigestWeek(0);
  } else if (!seen.includes(section)) setSeen([...seen, section]);
  const scoped = actions && projectId && !props.stale ? { ...actions, projectId } : undefined;
  const pending =
    !model && (error ? <Failure error={error} onRetry={onRetry} /> : loading && <Skeleton />);
  const layout = useBoardLayout(projectId);
  const onLayout: ChangeLayout = (change) => {
    if (projectId) saveLayout(projectId, change(layout));
  };
  const rangeLabel = RANGES.find((r) => r.days === days)!.label;
  const drawer = model && (
    <TaskDrawer
      model={model}
      taskId={selected}
      onSelect={setSelected}
      onOpenSession={onOpenSession}
      onOpenStory={onOpenStory}
      onStartTask={onStartTask}
      tell={scoped && { sessions: scoped.sessions, run: scoped.run }}
    />
  );
  const panels: BoardPanels = model
    ? {
        iterations: {
          title: t({ id: 'insights.sections.iterations', defaultMessage: 'Iterations' }),
          withFailure: drawer,
          node: (
            <>
              <IterationsTab
                model={model}
                projectId={projectId}
                edit={scoped && { projectId: scoped.projectId, run: scoped.run }}
                onOpenTask={setSelected}
                bar={bars.iterations}
              />
              {drawer}
            </>
          ),
        },
        collab: {
          title: t({ id: 'insights.sections.collab', defaultMessage: 'Collaboration' }),
          node: (
            <CollabTab
              model={model}
              projectId={projectId}
              onOpenSession={onOpenSession}
              bar={bars.collab}
              readOnly={props.stale}
            />
          ),
        },
        workflow: projectId
          ? {
              title: t({ id: 'insights.sections.workflow', defaultMessage: 'Workflow' }),
              node: (
                <WorkflowTab
                  projectId={projectId}
                  model={model}
                  onOpenSession={onOpenSession}
                  bar={bars.workflow}
                />
              ),
            }
          : undefined,
        qualityKpis: {
          title: t({ id: 'insights.quality.label', defaultMessage: 'Quality overview' }),
          node: <QualityKpis model={model} />,
        },
        gateFailures: projectId
          ? {
              title: t({
                id: 'insights.gateFailures.title',
                defaultMessage: 'Most failed gate steps',
              }),
              node: (
                <GateFailuresPanel
                  projectId={projectId}
                  since={model.since}
                  range={rangeLabel}
                  flaky={model.gate_failures?.filter((f) => f.flaky).map((f) => f.name) ?? []}
                />
              ),
            }
          : undefined,
        findings: {
          title: t({ id: 'board.findings.title', defaultMessage: 'Review findings' }),
          node: (
            <FindingsPanel
              model={model}
              onOpenSession={onOpenSession}
              onResolve={
                scoped &&
                ((f, outcome) =>
                  scoped.run(
                    'review.finding.resolve',
                    { review_id: f.review_id, finding_id: f.id, outcome },
                    f.review_revision,
                  ))
              }
            />
          ),
        },
        matrix: projectId
          ? {
              title: t({ id: 'board.reviewMatrix.title', defaultMessage: 'Review matrix' }),
              node: <ReviewMatrixPanel projectId={projectId} />,
            }
          : undefined,
        retro: {
          title: t({ id: 'board.panels.retro', defaultMessage: 'Retrospectives' }),
          withFailure: drawer,
          node: (
            <>
              <RetroPanel model={model} projectId={projectId} onOpenTask={setSelected} />
              {drawer}
            </>
          ),
        },
        digest: projectId
          ? {
              title: t({ id: 'insights.digest.label', defaultMessage: 'Weekly digest' }),
              node: (
                <WeeklyDigest
                  projectId={projectId}
                  bar={bars.digest ?? null}
                  week={digestWeek}
                  onWeek={setDigestWeek}
                />
              ),
            }
          : undefined,
        merges: {
          title: t({ id: 'board.merges.title', defaultMessage: 'Local merge history' }),
          node: (
            <MergesPanel model={model} onOpenSession={onOpenSession} onOpenStory={onOpenStory} />
          ),
        },
        gates: projectId
          ? {
              title: t({ id: 'board.gateHistory.title', defaultMessage: 'Gate history' }),
              node: <GateHistoryPanel projectId={projectId} since={model.since} />,
            }
          : undefined,
        quota: {
          title: t({ id: 'insights.quota.title', defaultMessage: 'Subscription quota' }),
          node: <QuotaPanel />,
        },
        runtime: {
          title: t({ id: 'board.panels.byRuntime', defaultMessage: 'By runtime' }),
          node: <UsageRings model={model} targets={props.usageTargets} />,
        },
        usage: {
          title: t({ id: 'board.sections.usage', defaultMessage: 'Usage' }),
          node: <UsageStackPanel model={model} />,
        },
        roles: projectId
          ? {
              title: t({ id: 'board.panels.byRole', defaultMessage: 'By role' }),
              node: <RoleUsagePanel projectId={projectId} />,
            }
          : undefined,
      }
    : {};
  const shown = (tab: InsightsSection) => layout[tab].filter((p) => !p.hidden && panels[p.key]);
  const empty = !!model && isEmpty(model) && !shown(section).some((p) => OWN_READS.has(p.key));
  const laid = (tab: InsightsSection) =>
    model && laidPanels({ places: shown(tab), panels, model, projectId, onRetry, onLayout });
  const hidden = layout[section]
    .filter((p) => p.hidden && panels[p.key])
    .map((p) => ({ key: p.key, title: panels[p.key]!.title }));
  const changed = layoutChanged(layout, TABS);
  return (
    <Tabs.Root
      className="tb-pg"
      value={section}
      onValueChange={(value) => onSection(value as InsightsSection)}
    >
      <TopBar title={SCREEN_NAMES.insights}>
        <Tabs.List
          className="tb-tabs"
          aria-label={t({ id: 'insights.tabs.label', defaultMessage: 'Engineering board' })}
        >
          {SECTIONS.map((s) => (
            <Tabs.Tab key={s.key} className="tb-tab" value={s.key}>
              {s.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <div className="tb-end">
          {projectId && model && (hidden.length > 0 || changed) && (
            <HiddenMenu hidden={hidden} tabs={TABS} onLayout={onLayout} />
          )}
          {section !== 'digest' && (
            <RadioGroup<BoardDays>
              className="tb-seg"
              aria-label={t({ id: 'board.headline.range', defaultMessage: 'Time range' })}
              value={days}
              onValueChange={onDays}
            >
              {RANGES.map((r) => (
                <Radio.Root key={r.days} value={r.days}>
                  {r.label}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {SECTIONS.map(({ key }) => (
            <span key={key} className="ins-bar" hidden={key !== section} ref={barRefs[key]} />
          ))}
        </div>
      </TopBar>
      <main className="bd">
        {model && (
          <ReadStatus
            label={t({ id: 'board.readStatus', defaultMessage: 'Board' })}
            stale={props.stale}
            loading={loading}
            error={error}
            readAt={props.readAt}
            reload={onRetry}
          />
        )}
        <div className="bd-grid">
          {empty ? (
            <div className="bd-empty">
              <button type="button" className="btn pri big" onClick={onOpenSessions}>
                {t({ id: 'board.empty.openSession', defaultMessage: 'Start a session' })}
              </button>
            </div>
          ) : !model ? (
            <section className="bd-pn bd-s12" aria-labelledby="bd-load-h">
              <div className="bd-ph">
                <h2 id="bd-load-h">{insightsSectionLabel(section)}</h2>
              </div>
              {pending}
            </section>
          ) : (
            <>
              {/* A seen tab stays mounted and is hidden in the switch's own commit; Tabs.Panel alone
                  keeps a closed panel on screen until the next animation frame. */}
              {SECTIONS.filter((s) => seen.includes(s.key)).map(({ key }) => (
                <Activity key={key} mode={key === section ? 'visible' : 'hidden'}>
                  <Tabs.Panel className="bd-s12 bd-sub" value={key} keepMounted>
                    {key === 'usage' && (
                      <div className="bd-s12">
                        <PanelBoundary
                          title={t({ id: 'board.kpi.label', defaultMessage: 'Usage overview' })}
                          model={model}
                          onRetry={onRetry}
                        >
                          <KpiTiles model={model} />
                        </PanelBoundary>
                      </div>
                    )}
                    {laid(key)}
                  </Tabs.Panel>
                </Activity>
              ))}
            </>
          )}
        </div>
      </main>
    </Tabs.Root>
  );
}

export function InsightsScreen({
  projectId,
  onOpenSession,
  onOpenSessions,
}: {
  projectId: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenSessions: () => void;
}) {
  const [days, setDays] = useState<BoardDays>(7);
  const view = useBoardView(projectId, days);
  const section = useInsightsSection(projectId);
  const openSession = useShell((s) => s.openSession);
  const openTaskSession = useShell((s) => s.openTaskSession);
  const sessions = useBoard((s) => s.board?.sessions);
  const ownTargets = useBoard(
    (s) => s.board?.projects.find((p) => p.id === projectId)?.usage_targets,
  );
  const defaults = useProjectDefaults();
  const usageTargets =
    ownTargets || settingOf(defaults.data, 'usage_targets')?.global
      ? effectiveUsageTargets({ usage_targets: ownTargets }, defaults.data)
      : undefined;
  return (
    <InsightsView
      model={view.data}
      loading={view.loading || view.refreshing === true}
      error={view.error}
      onRetry={view.reload}
      stale={view.stale}
      readAt={view.readAt}
      days={days}
      onDays={setDays}
      section={section}
      onSection={(next) => {
        if (projectId) pickInsightsSection(projectId, next);
      }}
      onOpenSession={onOpenSession}
      onOpenSessions={onOpenSessions}
      onOpenStory={(sessionId) => openSession(sessionId, 'story')}
      onStartTask={({ id, title, goal }) => openTaskSession({ id, title, goal })}
      {...(projectId && {
        projectId,
        actions: sessions ? { sessions, run: runBoardCommand } : undefined,
        usageTargets,
      })}
    />
  );
}
